/**
 * Branches (round 8b): a copy of a model from one of its versions that people
 * and agents edit live while the model it came from ("Main") stays unchanged
 * until a merge lands. A branch is a model of its own, addressed as
 * `<baseModelId>~<branchId>`, so leases, routing, presence, schedules, undo
 * and agent sessions work on it unchanged. Its record says what it came from.
 */

export type BranchState = "open" | "merge_proposed" | "merged" | "closed";

export const BRANCH_STATES: readonly BranchState[] = ["open", "merge_proposed", "merged", "closed"];

export interface BranchRef {
  readonly branchId: string;
  /** `${baseModelId}~${branchId}` */
  readonly modelId: string;
  readonly baseModelId: string;
  /** The base's revision the branch started from. */
  readonly baseRevision: number;
  readonly name: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly state: BranchState;
}

/** A version someone saved with a name; its history is kept until it is deleted. */
export interface SavedVersion {
  readonly versionId: string;
  readonly modelId: string;
  readonly revision: number;
  readonly name: string;
  readonly savedBy: string;
  readonly savedAt: string;
}

/** Separates a base model id from a branch id. Never part of a plain model id. */
export const BRANCH_SEPARATOR = "~";

/** Branch ids: short, URL- and file-safe. */
const BRANCH_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function isBranchId(value: string): boolean {
  return BRANCH_ID.test(value);
}

export function branchModelId(baseModelId: string, branchId: string): string {
  if (baseModelId.length === 0 || baseModelId.includes(BRANCH_SEPARATOR)) throw new Error(`"${baseModelId}" can't be the base of a branch`);
  if (!isBranchId(branchId)) throw new Error(`"${branchId}" is not a usable branch id (letters, digits, - and _, at most 64)`);
  return `${baseModelId}${BRANCH_SEPARATOR}${branchId}`;
}

export function parseBranchModelId(id: string): { readonly baseModelId: string; readonly branchId: string } | null {
  const at = id.indexOf(BRANCH_SEPARATOR);
  if (at <= 0 || at !== id.lastIndexOf(BRANCH_SEPARATOR)) return null;
  const baseModelId = id.slice(0, at);
  const branchId = id.slice(at + 1);
  return isBranchId(branchId) ? { baseModelId, branchId } : null;
}

/** Tolerant reader: a state this release does not know reads as closed (never writable). */
export function readBranchState(value: unknown): BranchState {
  return BRANCH_STATES.find((s) => s === value) ?? "closed";
}

/** Edits are accepted only while a branch is open or waiting on a merge. */
export function branchAcceptsEdits(state: BranchState): boolean {
  return state === "open" || state === "merge_proposed";
}

/** Operator words for a refused edit on a branch that no longer takes them. */
export function branchClosedMessage(state: BranchState): string {
  return state === "merged"
    ? "This branch was merged. Start a new branch to keep working."
    : "This branch was closed. Start a new branch to keep working.";
}
