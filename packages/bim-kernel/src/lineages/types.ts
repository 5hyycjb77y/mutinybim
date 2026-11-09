import type { AuthorRef } from "../authorship/types";

/**
 * Lineages (round 11 lane L11, D1): a long-lived copy of a model with a
 * purpose, a parent and a return policy. Main is a lineage. A lineage may
 * live for decades and may never merge. Crossing lineages is always one of
 * three explicit, signed acts (`LineageAct`): merge (round 8b), review (an
 * outcome on a child's delta; the parent is untouched) and accept back
 * (chosen records land on the parent, or any ancestor, citing the child's
 * delta digest).
 *
 * Lineages form a parent chain of any depth. Nothing here special-cases the
 * root, a depth or a parent's role: fork, compare, review, accept back and
 * merge walk the chain with one code path.
 *
 * Revisions: a lineage's history is one continuous revision line. At and
 * below its fork pin the revisions are its parent's line (recursively); its
 * own changesets are numbered after the pin. So the same revision number
 * names the same state on every lineage whose chain passes through it.
 *
 * Stored shapes are read tolerantly: a role, state or return policy this
 * release doesn't know is kept as written and never widens what it allows.
 */

/** Peers that read lineage rows with a role, a return policy and a parent at any depth. Unadvertised until a writer lands (W11). */
export const LINEAGES_ROLES_FEATURE = "lineages:roles";
/** Peers that read review acts and submittals over a copy's delta (`lineageId`, `deltaDigest`). Unadvertised until a writer lands. */
export const LINEAGES_REVIEW_FEATURE = "lineages:review";
/** Peers that read accept-back acts and land them. Unadvertised until a writer lands. */
export const LINEAGES_ACCEPT_BACK_FEATURE = "lineages:accept_back";

/** The id a model's first lineage has (a model with no branches, and every branch's base). Data, not a special case: chain code never compares against it. */
export const ROOT_LINEAGE_ID = "main";

/** First-party roles (`LINEAGE_ROLE_POINT` rows). Open: a firm or add-on registers its own. */
export type LineageRoleId = "design_record" | "option" | "proposal" | "coordination" | "shop" | "submittal" | "external_author" | "as_built" | "operations" | (string & {});

/** What may cross from a lineage back to its ancestors. */
export type LineageReturnPolicy = "merge" | "review_only" | "accept_back" | "never";

export const LINEAGE_RETURN_POLICIES: readonly LineageReturnPolicy[] = ["merge", "review_only", "accept_back", "never"];

/** `merged` is an event (a merge act), not a state. */
export type LineageState = "open" | "frozen" | "closed" | (string & {});

/** A lineage at one revision of its line: what a child forked from, the base of a compare. */
export interface LineageAnchor {
  readonly lineageId: string;
  readonly revision: number;
}

export interface Lineage {
  /** Unique within its model. Main is a lineage too. */
  readonly id: string;
  /** What it forked from; null for the model's first lineage. */
  readonly parent: LineageAnchor | null;
  readonly role: LineageRoleId;
  readonly returnPolicy: LineageReturnPolicy;
  readonly state: LineageState;
  readonly name: string;
  readonly createdBy: AuthorRef;
  /** ISO 8601. */
  readonly createdAt: string;
  /** The party whose copy it is: the contractor, fabricator, owner's operator (host's id or words). */
  readonly owner?: { readonly party: string };
  /** Host-stored text the forker accepted (a licence or disclaimer); never stored here. */
  readonly terms?: { readonly disclaimerId?: string };
}

/** A reviewer's answer on a child's delta. Open: a workflow may add its own. */
export type ReviewOutcomeId = "approved" | "approved_as_noted" | "revise_and_resubmit" | "rejected" | (string & {});

export const REVIEW_OUTCOMES = ["approved", "approved_as_noted", "revise_and_resubmit", "rejected"] as const satisfies readonly ReviewOutcomeId[];

/** Plain words for each review outcome. */
export const REVIEW_OUTCOME_LABELS: Readonly<Record<(typeof REVIEW_OUTCOMES)[number], string>> = {
  approved: "Approved",
  approved_as_noted: "Approved as noted",
  revise_and_resubmit: "Revise and resubmit",
  rejected: "Rejected",
};

/**
 * The three acts across lineages, each a signed sign-off chain event
 * (`acts.ts`). `to` is the parent or any ancestor of `from`; the delta is
 * computed against that ancestor at the revision the chain pins.
 */
export type LineageAct =
  | { readonly kind: "merge"; readonly from: string; readonly to: string; readonly deltaDigest: string; readonly parts: readonly string[] }
  /** `to`: the ancestor the delta was computed against; absent means the parent. The parent is never changed. */
  | { readonly kind: "review"; readonly lineageId: string; readonly to?: string; readonly deltaDigest: string; readonly outcome: ReviewOutcomeId; readonly reason?: string }
  | { readonly kind: "accept_back"; readonly from: string; readonly to: string; readonly deltaDigest: string; readonly recordIds: readonly string[] };

export type LineageActKind = LineageAct["kind"];

/** One field of a record that differs between the two sides. `before` is side a's value, `after` side b's (undefined: absent). */
export interface LineageFieldDifference {
  readonly key: string;
  readonly before: unknown;
  readonly after: unknown;
}

/**
 * One record in the overlay read (`compareLineages(a, b)`): how side b's
 * record differs from side a's, against their common ancestor. Only records
 * either side touched since the ancestor are listed; a record both sides
 * left alone, or changed to the same content, reads `unchanged`.
 */
export interface LineageDifference {
  /** Stable for this ancestor, record and side-b content: what a citing edit or an accept back names. */
  readonly id: string;
  readonly recordId: string;
  /** The record's kind (side b's, else side a's, else the ancestor's). */
  readonly kind: string;
  readonly change: "added" | "removed" | "changed" | "unchanged";
  /** For `changed`: the top-level fields that differ, with both values. */
  readonly fields?: readonly LineageFieldDifference[];
  /** Which side changed it since the ancestor. */
  readonly changedOn: "a" | "b" | "both";
  readonly ancestor: LineageAnchor;
  /** Accepted back onto side a, or matched by a design edit on side a that cites this difference. */
  readonly settled?: { readonly by: "accepted_back" | "matched_in_design"; readonly actRef: string };
}

/**
 * What someone may do on a lineage. Open: a host may add its own. Enforced by
 * the authorizer (W11); the kernel only shapes it and gives role defaults.
 *
 * - `read`: open it and compare it.
 * - `propose`: copy it and send changes back for review, comment on differences.
 * - `review`: record a review outcome on its delta.
 * - `edit`: change its records.
 */
export type LineageCapability = "read" | "propose" | "review" | "edit" | (string & {});

export const LINEAGE_CAPABILITIES = ["read", "propose", "review", "edit"] as const satisfies readonly LineageCapability[];

/**
 * A lineage's state at one revision, so a decades-long copy never replays
 * from its fork. `stateDigest` is `lineageStateDigest` of that state.
 */
export interface LineageCheckpoint {
  readonly lineageId: string;
  readonly revision: number;
  readonly stateDigest: string;
}

/** Refusals in words a person can act on (a broken chain, an act its policy doesn't allow). */
export class LineageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LineageError";
  }
}

/** Operator words. Never "sealed"; never a price on a copy, review or merge. */
export const LINEAGE_WORDS = {
  unknownLineage: (id: string) => `There is no copy "${id}" on this model.`,
  brokenChain: (id: string) => `The copy "${id}" names a parent this model doesn't have, so its history can't be read.`,
  cycle: (id: string) => `The copy "${id}" is recorded as its own ancestor, so its history can't be read.`,
  notAncestor: (from: string, to: string) => `"${to}" isn't a copy "${from}" came from, so nothing can go back to it from there.`,
  noCommonAncestor: (a: string, b: string) => `"${a}" and "${b}" don't share an earlier copy, so they can't be compared.`,
  sameLineage: (id: string) => `Both sides are the copy "${id}". Pick two different copies to compare.`,
  policyRefuses: (name: string, act: string, policy: string) => `${name} is a copy whose changes ${policy === "never" ? "never go back" : "only go back by review"}, so it can't be ${act}.`,
  notOpen: (name: string) => `${name} is no longer open, so nothing can be done on it. Start a new copy to keep working.`,
  forkTooNew: (revision: number, head: number) => `Version ${revision} is newer than the copy it would start from (it is at version ${head}).`,
  noRecords: "Pick at least one record to accept back.",
  notInDelta: (id: string) => `${id} wasn't changed on this copy since it started, so there is nothing to accept back for it.`,
  staleDigest: "This copy changed after its changes were shown. Look at the differences again, then accept back.",
  staleReview: "This copy changed after its changes were shown. Look at the differences again, then record the review.",
} as const;
