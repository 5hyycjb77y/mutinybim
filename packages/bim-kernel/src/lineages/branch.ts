import { readAuthorRef } from "../authorship/author";
import type { AuthorRef } from "../authorship/types";
import { UNSIGNED_PROVIDER_ID } from "../authorship/unsigned";
import { BRANCH_SEPARATOR, readBranchState, type BranchRef } from "../branches/types";
import { LINEAGE_RETURN_POLICIES, ROOT_LINEAGE_ID, type Lineage, type LineageReturnPolicy } from "./types";

/**
 * Round 8b branches read as lineages (D1 "Replaces"): role `proposal`,
 * return policy `merge`, parent the base model's first lineage at the
 * branch's base revision. Stored branch rows and `<base>~<branch>` model ids
 * are unchanged; this is a reader only.
 */

/** Who a branch row names (a host's user id, as written): read as an unsigned person. */
function authorOfBranch(createdBy: string): AuthorRef {
  return { provider: UNSIGNED_PROVIDER_ID, subject: createdBy, kind: "person" };
}

export function readBranchAsLineage(branch: BranchRef): Lineage {
  const state = readBranchState(branch.state);
  return {
    id: branch.branchId,
    parent: { lineageId: ROOT_LINEAGE_ID, revision: branch.baseRevision },
    role: "proposal",
    returnPolicy: "merge",
    // `merged` is an event, not a state; a merge proposal is an open copy waiting on approvals.
    state: state === "open" || state === "merge_proposed" ? "open" : "closed",
    name: branch.name,
    createdBy: authorOfBranch(branch.createdBy),
    createdAt: branch.createdAt,
  };
}

/** The first lineage of a model with no lineage rows of its own: its design record. */
export function rootLineageOf(input: { readonly name: string; readonly createdBy: AuthorRef; readonly createdAt: string }): Lineage {
  return { id: ROOT_LINEAGE_ID, parent: null, role: "design_record", returnPolicy: "never", state: "open", name: input.name, createdBy: input.createdBy, createdAt: input.createdAt };
}

/** The model id a lineage is served under: the base model for the first lineage, `<base>~<id>` for every other (any depth: ids are flat, ancestry is the parent). */
export function lineageModelId(baseModelId: string, lineage: Pick<Lineage, "id" | "parent">): string {
  return lineage.parent === null ? baseModelId : `${baseModelId}${BRANCH_SEPARATOR}${lineage.id}`;
}

type Raw = Readonly<Record<string, unknown>>;

function isRecord(v: unknown): v is Raw {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

export type LineageRead = { readonly ok: true; readonly value: Lineage } | { readonly ok: false; readonly reason: string };

/**
 * A stored lineage row (camelCase or a host's snake_case). Unknown roles and
 * states are kept as written; an unknown return policy reads `never` (never
 * wider than what was stored). Unknown fields are not carried: the row is the
 * host's, this is the kernel's view of it.
 */
export function readLineage(raw: unknown): LineageRead {
  if (!isRecord(raw)) return { ok: false, reason: "a copy must be an object" };
  const id = text(raw.id);
  const role = text(raw.role);
  const name = text(raw.name);
  const createdAt = text(raw.createdAt ?? raw.created_at);
  if (!id || !role || !name || !createdAt) return { ok: false, reason: "a copy names its id, purpose, name and when it was made" };
  const p = raw.parent;
  let parent: Lineage["parent"] = null;
  if (p !== null && p !== undefined) {
    if (!isRecord(p)) return { ok: false, reason: `copy ${id}'s parent must be an object` };
    const lineageId = text(p.lineageId ?? p.lineage_id);
    const revision = p.revision;
    if (!lineageId || typeof revision !== "number" || !Number.isInteger(revision) || revision < 0) return { ok: false, reason: `copy ${id}'s parent names a copy and a whole revision` };
    parent = { lineageId, revision };
  }
  const by = readAuthorRef(raw.createdBy ?? raw.created_by);
  if (!by.ok) return { ok: false, reason: `who made copy ${id} can't be read: ${by.reason}` };
  const policyRaw = text(raw.returnPolicy ?? raw.return_policy);
  const returnPolicy: LineageReturnPolicy = LINEAGE_RETURN_POLICIES.find((r) => r === policyRaw) ?? "never";
  const state = text(raw.state) ?? "closed";
  const ownerRaw = raw.owner;
  const party = isRecord(ownerRaw) ? text(ownerRaw.party) : null;
  const termsRaw = raw.terms;
  const disclaimerId = isRecord(termsRaw) ? text(termsRaw.disclaimerId ?? termsRaw.disclaimer_id) : null;
  return {
    ok: true,
    value: {
      id,
      parent,
      role,
      returnPolicy,
      state,
      name,
      createdBy: by.value,
      createdAt,
      ...(party ? { owner: { party } } : {}),
      ...(disclaimerId ? { terms: { disclaimerId } } : {}),
    },
  };
}
