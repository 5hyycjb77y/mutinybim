import {
  branchModelId,
  readAuthorRef,
  type BranchRef,
} from "@permitzip/bim-kernel";
import {
  lineageChain,
  lineageLookup,
  lineageModelId,
  readBranchAsLineage,
  type Lineage,
} from "@permitzip/bim-kernel/lineages";
import {
  BRANCH_NAME_TAKEN,
  BranchRefusal,
  firstLineage,
  lineageRowOf,
  NO_SUCH_BRANCH,
  type StoredLineageMeta,
} from "@permitzip/bim-sync";
import {
  COPY_OF_COPY_UNAVAILABLE,
  type ChildLineageInput,
  type ChildLineageRegistry,
  type LineageEditScope,
  type LineageRow,
  type LineageStore,
} from "@permitzip/bim-sync/lineages";
import { randomUUID } from "node:crypto";
import type { PgBranchRegistry } from "../pg-branches";
import type { Sql } from "../pg-store";

/**
 * Copies with a purpose on the model server's database (round 11 W11):
 * db/migrations/20261103100000_bim_lineages.sql. A copy is still a bim.models
 * row (`<base>~<id>`, round 8b); bim.lineages adds its parent copy, purpose,
 * return policy, owner and who edits it. A branch row with no bim.lineages
 * row reads as a round 8b proposal whose parent is the first copy, edited by
 * whoever edits it (expand only: nothing is backfilled).
 *
 * A database the migration hasn't reached reads every branch that way and
 * refuses to make a copy of a copy, in words.
 */

interface LineageRowDb {
  model_id: string;
  parent_lineage_id: string;
  role: string;
  return_policy: string;
  edit_scope: string;
  owner_party: string | null;
  terms_disclaimer_id: string | null;
  created_by: unknown;
}

function metaOf(row: LineageRowDb): StoredLineageMeta | null {
  const by = readAuthorRef(row.created_by);
  if (!by.ok) {
    console.error("[bim-authority] a copy row names its maker in a shape this release can't read; it reads as a branch", { modelId: row.model_id, reason: by.reason });
    return null;
  }
  const policy: Lineage["returnPolicy"] = row.return_policy === "merge" || row.return_policy === "review_only" || row.return_policy === "accept_back" ? row.return_policy : "never";
  const editScope: LineageEditScope = row.edit_scope === "parent_editors" ? "parent_editors" : "named";
  return {
    parentLineageId: row.parent_lineage_id,
    role: row.role,
    returnPolicy: policy,
    editScope,
    createdBy: by.value,
    ...(row.owner_party ? { owner: { party: row.owner_party } } : {}),
    ...(row.terms_disclaimer_id ? { terms: { disclaimerId: row.terms_disclaimer_id } } : {}),
  };
}

function newCopyId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "23505";
}

export class PgLineageStore implements LineageStore, ChildLineageRegistry {
  private hasTable: Promise<boolean> | null = null;

  constructor(
    private readonly sql: Sql,
    private readonly branches: PgBranchRegistry,
  ) {}

  /** Whether this database has reached the lineage migration (read once per process; a deploy restarts it). */
  private stored(): Promise<boolean> {
    const known = this.hasTable;
    if (known) return known;
    const asked = this.sql<{ ok: boolean }[]>`select to_regclass('bim.lineages') is not null as ok`.then(
      (rows: readonly { ok: boolean }[]) => rows[0]?.ok === true,
      (err: unknown) => {
        this.hasTable = null;
        throw err;
      },
    );
    this.hasTable = asked;
    return asked;
  }

  private async metas(baseModelId: string): Promise<Map<string, StoredLineageMeta>> {
    const out = new Map<string, StoredLineageMeta>();
    if (!(await this.stored())) return out;
    const rows = await this.sql<LineageRowDb[]>`
      select model_id, parent_lineage_id, role, return_policy, edit_scope, owner_party, terms_disclaimer_id, created_by
      from bim.lineages where base_model_id = ${baseModelId}`;
    for (const row of rows) {
      const meta = metaOf(row);
      if (meta) out.set(row.model_id, meta);
    }
    return out;
  }

  async rows(baseModelId: string): Promise<readonly LineageRow[]> {
    const [refs, metas, created] = await Promise.all([
      this.branches.list(baseModelId),
      this.metas(baseModelId),
      this.sql<{ created_at: string }[]>`select created_at::text as created_at from bim.models where id = ${baseModelId}`,
    ]);
    const first = firstLineage(created[0]?.created_at ?? new Date(0).toISOString());
    return [{ lineage: first, editScope: "named" }, ...[...refs].reverse().map((ref) => lineageRowOf(ref, metas.get(ref.modelId)))];
  }

  /** The chain a model id is served under, nearest first (null: no such copy of its base). */
  async chainOf(baseModelId: string, modelId: string): Promise<readonly LineageRow[] | null> {
    const rows = await this.rows(baseModelId);
    const row = modelId === baseModelId ? rows[0] : rows.find((r) => lineageModelId(baseModelId, r.lineage) === modelId);
    if (!row) return null;
    const byId = new Map(rows.map((r) => [r.lineage.id, r]));
    return lineageChain(lineageLookup(rows.map((r) => r.lineage)), row.lineage.id).flatMap((l) => byId.get(l.lineage.id) ?? []);
  }

  /** The model id of a copy's parent (the base for a round 8b branch). */
  async parentModelIdOf(ref: BranchRef): Promise<string> {
    const parent = (await this.chainOf(ref.baseModelId, ref.modelId))?.[1];
    return parent ? lineageModelId(ref.baseModelId, parent.lineage) : ref.baseModelId;
  }

  async createCopy(input: { readonly baseModelId: string; readonly lineage: Omit<Lineage, "id">; readonly editScope: LineageEditScope }): Promise<LineageRow> {
    if (!(await this.stored())) throw new BranchRefusal(COPY_OF_COPY_UNAVAILABLE);
    const parent = input.lineage.parent;
    if (!parent) throw new BranchRefusal("A copy names the copy it starts from.");
    const rows = await this.rows(input.baseModelId);
    const parentRow = rows.find((r) => r.lineage.id === parent.lineageId);
    if (!parentRow) throw new BranchRefusal(NO_SUCH_BRANCH);
    const parentModelId = lineageModelId(input.baseModelId, parentRow.lineage);
    const id = branchModelId(input.baseModelId, newCopyId());
    const l = input.lineage;
    try {
      // One statement: the copy's model row (same project and settings as its base), its copy row, and the pin on its parent's line.
      const [made] = await this.sql<{ id: string }[]>`
        with base as (
          select m.id, m.project_id, m.host_project_id, m.settings from bim.models m where m.id = ${input.baseModelId} and m.base_model_id is null
        ), parent as (
          select p.id from bim.models p where p.id = ${parentModelId} and p.revision >= ${parent.revision}
        ), made as (
          insert into bim.models (id, project_id, host_project_id, revision, lease_generation, settings,
                                  base_model_id, base_revision, branch_name, branch_state, branch_created_by, branch_created_at)
          select ${id}, b.project_id, b.host_project_id, ${parent.revision}, 0, b.settings,
                 b.id, ${parent.revision}, ${l.name}, 'open', ${l.createdBy.subject}, now()
          from base b, parent
          returning id
        ), copy as (
          insert into bim.lineages (model_id, base_model_id, lineage_id, parent_lineage_id, parent_revision, role, return_policy, edit_scope, owner_party, terms_disclaimer_id, created_by)
          select m.id, ${input.baseModelId}, substr(m.id, char_length(${input.baseModelId}) + 2), ${parent.lineageId}, ${parent.revision}, ${l.role}, ${l.returnPolicy}, ${input.editScope},
                 ${l.owner?.party ?? null}, ${l.terms?.disclaimerId ?? null}, ${this.sql.json({ provider: l.createdBy.provider, subject: l.createdBy.subject, kind: l.createdBy.kind })}
          from made m
          returning 1
        ), pin as (
          insert into bim.history_pins (model_id, revision, pinned_by)
          select ${parentModelId}, ${parent.revision}, 'branch:' || m.id from made m
          returning 1
        )
        select id from made`;
      if (!made) throw new BranchRefusal(`Version ${parent.revision} is newer than the copy it would start from.`);
    } catch (err) {
      if (isUniqueViolation(err)) throw new BranchRefusal(BRANCH_NAME_TAKEN);
      throw err;
    }
    const ref = await this.branches.get(id);
    if (!ref) throw new Error(`Copy ${id} vanished after it was made`);
    return lineageRowOf(ref, (await this.metas(input.baseModelId)).get(id));
  }

  /** `branch_create` on a branch session (L11's interface): a proposal copy of that copy, edited by its parent's editors. */
  async createChild(input: ChildLineageInput): Promise<BranchRef> {
    const asLineage = readBranchAsLineage({ ...input.parent, name: input.name, baseRevision: input.baseRevision, createdBy: input.createdBy, state: "open" });
    const row = await this.createCopy({ baseModelId: input.parent.baseModelId, lineage: { ...asLineage, parent: { lineageId: input.parent.branchId, revision: input.baseRevision } }, editScope: "parent_editors" });
    const ref = await this.branches.get(lineageModelId(input.parent.baseModelId, row.lineage));
    if (!ref) throw new Error("A copy vanished after it was made");
    return ref;
  }
}
