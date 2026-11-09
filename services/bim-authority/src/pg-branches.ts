import {
  asBranchState,
  branchModelId,
  forkState,
  readBranchState,
  readModelSettings,
  type BranchRef,
  type Changeset,
  type ModelState,
  type SavedVersion,
} from "@permitzip/bim-kernel";
import { BRANCH_NAME_TAKEN, BRANCH_NOT_OPEN, BranchRefusal, NO_SUCH_BRANCH, type BranchRegistry } from "@permitzip/bim-sync";
import { openLineageHead } from "@permitzip/bim-sync/lineages";
import { PgLineageCheckpointStore } from "./lineages/checkpoints";
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import type { Sql } from "./pg-store";

type Tx = postgres.TransactionSql;

/**
 * Branches and saved versions in the model server's database
 * (db/migrations/20261101040000_bim_branches.sql). A branch is a bim.models
 * row of its own; creating it writes that row and a history pin in one
 * statement and copies no elements.
 */

interface BranchRow {
  id: string;
  base_model_id: string;
  base_revision: string;
  branch_name: string;
  branch_state: string;
  branch_created_by: string;
  branch_created_at: string;
}

function toRef(row: BranchRow): BranchRef {
  const sep = row.id.indexOf("~");
  return {
    branchId: row.id.slice(sep + 1),
    modelId: row.id,
    baseModelId: row.base_model_id,
    baseRevision: Number(row.base_revision),
    name: row.branch_name,
    createdBy: row.branch_created_by,
    createdAt: row.branch_created_at,
    state: readBranchState(row.branch_state),
  };
}

interface VersionRow {
  version_id: string;
  model_id: string;
  revision: string;
  name: string;
  saved_by: string;
  saved_at: string;
}

function toVersion(row: VersionRow): SavedVersion {
  return { versionId: row.version_id, modelId: row.model_id, revision: Number(row.revision), name: row.name, savedBy: row.saved_by, savedAt: row.saved_at };
}

function branchColumns(sql: Sql | Tx) {
  return sql`id, base_model_id, base_revision::text as base_revision, branch_name, branch_state, branch_created_by, branch_created_at::text as branch_created_at`;
}

/** Branch ids: short, URL-safe, unique enough per base (the primary key decides). */
function newBranchId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "23505";
}

export class PgBranchRegistry implements BranchRegistry {
  constructor(private readonly sql: Sql) {}

  async list(baseModelId: string): Promise<readonly BranchRef[]> {
    const rows = await this.sql<BranchRow[]>`
      select ${branchColumns(this.sql)} from bim.models
      where base_model_id = ${baseModelId} order by branch_created_at desc`;
    return rows.map(toRef);
  }

  async get(id: string): Promise<BranchRef | null> {
    const [row] = await this.sql<BranchRow[]>`
      select ${branchColumns(this.sql)} from bim.models where id = ${id} and base_model_id is not null`;
    return row ? toRef(row) : null;
  }

  /** The records of the branches this machine serves, in one read (a close or merge on another machine shows up here). */
  async getMany(ids: readonly string[]): Promise<readonly BranchRef[]> {
    if (ids.length === 0) return [];
    const rows = await this.sql<BranchRow[]>`
      select ${branchColumns(this.sql)} from bim.models where id = any(${this.sql.array([...ids])}) and base_model_id is not null`;
    return rows.map(toRef);
  }

  async create(input: { readonly baseModelId: string; readonly name: string; readonly baseRevision: number; readonly createdBy: string }): Promise<BranchRef> {
    const id = branchModelId(input.baseModelId, newBranchId());
    try {
      // One statement: the branch row (same project and settings as its base, at the base revision) and its pin.
      const [row] = await this.sql<BranchRow[]>`
        with base as (
          select m.id, m.project_id, m.host_project_id, m.settings from bim.models m
          where m.id = ${input.baseModelId} and m.base_model_id is null and m.revision >= ${input.baseRevision}
        ), made as (
          insert into bim.models (id, project_id, host_project_id, revision, lease_generation, settings,
                                  base_model_id, base_revision, branch_name, branch_state, branch_created_by, branch_created_at)
          select ${id}, b.project_id, b.host_project_id, ${input.baseRevision}, 0, b.settings,
                 b.id, ${input.baseRevision}, ${input.name}, 'open', ${input.createdBy}, now()
          from base b
          returning ${branchColumns(this.sql)}
        ), pin as (
          insert into bim.history_pins (model_id, revision, pinned_by)
          select ${input.baseModelId}, ${input.baseRevision}, 'branch:' || ${id} from made
          returning 1
        )
        select * from made`;
      if (!row) throw new BranchRefusal("This model can't be branched at that version (it is a branch itself, or the version is newer than the model).");
      return toRef(row);
    } catch (err) {
      if (isUniqueViolation(err)) throw new BranchRefusal(BRANCH_NAME_TAKEN);
      throw err;
    }
  }

  async close(id: string): Promise<BranchRef> {
    return this.setState(id, "closed");
  }

  /** Lane M's merge apply marks the branch merged through the same statement shape. */
  async markMerged(id: string): Promise<BranchRef> {
    return this.setState(id, "merged");
  }

  private async setState(id: string, state: "closed" | "merged"): Promise<BranchRef> {
    const [row] = await this.sql<BranchRow[]>`
      with changed as (
        update bim.models set branch_state = ${state}
        where id = ${id} and base_model_id is not null and branch_state in ('open', 'merge_proposed')
        returning ${branchColumns(this.sql)}
      ), unpinned as (
        delete from bim.history_pins p using changed c
        where p.model_id = c.base_model_id and p.pinned_by = 'branch:' || c.id
        returning 1
      )
      select * from changed`;
    if (row) return toRef(row);
    const existing = await this.get(id);
    throw new BranchRefusal(existing ? BRANCH_NOT_OPEN : NO_SUCH_BRANCH);
  }

  async versions(modelId: string): Promise<readonly SavedVersion[]> {
    const rows = await this.sql<VersionRow[]>`
      select version_id::text, model_id, revision::text, name, saved_by, saved_at::text
      from bim.saved_versions where model_id = ${modelId} order by revision desc, saved_at desc
      limit 500`; // a model's saved versions are named by people; 500 is far past any real list
    return rows.map(toVersion);
  }

  async saveVersion(input: { readonly modelId: string; readonly revision: number; readonly name: string; readonly savedBy: string }): Promise<SavedVersion> {
    const [row] = await this.sql<VersionRow[]>`
      with saved as (
        insert into bim.saved_versions (model_id, revision, name, saved_by)
        select m.id, ${input.revision}, ${input.name}, ${input.savedBy} from bim.models m
        where m.id = ${input.modelId} and m.revision >= ${input.revision}
        returning version_id, model_id, revision, name, saved_by, saved_at
      ), pin as (
        insert into bim.history_pins (model_id, revision, pinned_by)
        select s.model_id, s.revision, 'version:' || s.version_id::text from saved s
        returning 1
      )
      select version_id::text, model_id, revision::text, name, saved_by, saved_at::text from saved`;
    if (!row) throw new BranchRefusal(`Version ${input.revision} is newer than this model.`);
    return toVersion(row);
  }

  async deleteVersion(modelId: string, versionId: string): Promise<void> {
    const rows = await this.sql`
      with gone as (
        delete from bim.saved_versions where model_id = ${modelId} and version_id::text = ${versionId} returning version_id
      ), unpinned as (
        delete from bim.history_pins p using gone g where p.model_id = ${modelId} and p.pinned_by = 'version:' || g.version_id::text returning 1
      )
      select 1 from gone`;
    if (rows.length !== 1) throw new BranchRefusal("That version was already deleted.");
  }
}

/** What a branch is opened from: its base's state (in memory when this machine serves the base) and the changesets after a revision. */
export interface BaseSource {
  head(): Promise<ModelState>;
  changesSince(revision: number): Promise<readonly Changeset[]>;
}

/**
 * A copy's head: its parent's state at the fork pin (copy on write over the
 * parent's head; `base` is the parent, at any depth), plus its newest
 * checkpoint's net change (round 11 W11), plus only its own changesets after
 * that checkpoint. Without a checkpoint it replays its own changesets from
 * the fork, as round 8b did.
 */
export async function loadBranchHead(tx: Sql | Tx, branchId: string, baseRevision: number, base: BaseSource): Promise<{ model: ModelState; epoch: string }> {
  const [row] = await tx<{ revision: string; settings: unknown; epoch: string }[]>`
    select revision::text, settings, created_at::text as epoch from bim.models where id = ${branchId}`;
  if (!row) throw new Error(`Branch ${branchId} not found`);
  const baseHead = await base.head();
  const at = forkState(baseHead, baseRevision, baseRevision < baseHead.revision ? await base.changesSince(baseRevision) : []);
  const fork: ModelState = { ...asBranchState(at, branchId), settings: readModelSettings(row.settings) };
  const checkpoint = await new PgLineageCheckpointStore(tx).latest(branchId, Number(row.revision));
  const usable = checkpoint && checkpoint.forkRevision === baseRevision ? checkpoint : null;
  if (checkpoint && !usable) console.error("[bim-authority] a copy checkpoint was made for another fork; replaying from the fork", { branchId, checkpointFork: checkpoint.forkRevision, baseRevision });
  const since = usable ? usable.checkpoint.revision : baseRevision;
  const own = await tx<{ body: Changeset }[]>`
    select body from bim.changesets where model_id = ${branchId} and revision > ${since} order by revision`;
  const { model } = openLineageHead({ fork, checkpoint: usable, own: own.map((r: { body: Changeset }) => r.body) });
  if (model.revision !== Number(row.revision)) {
    throw new Error(`Branch ${branchId} is at revision ${row.revision} but its changesets rebuild revision ${model.revision}`);
  }
  return { model, epoch: row.epoch };
}
