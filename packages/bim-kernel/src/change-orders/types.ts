import type { QuantityDelta } from "../graph/types";

/**
 * Change significance and change orders (round 8b, lane O).
 *
 * A design change is never a change order. What kind of change a version
 * range or a branch was is a separate classification, set by a responsible
 * professional whose scope covers the change, default "not classified". A
 * change order is a separate, deliberate record that someone opens and
 * addresses to a party; that party accepts it, refuses it or marks it no
 * cost, each with a reason. Nothing creates one by itself, and none of these
 * shapes carries money: prices stay in each company's own book (cost
 * sources), in the reader's process.
 */

/** What a classification or a change order is about. */
export type ChangeTarget =
  /** Everything changed in (fromRevision, toRevision] on one model. */
  | { readonly kind: "version_range"; readonly modelId: string; readonly fromRevision: number; readonly toRevision: number }
  /** A branch against Main: everything it changes, as of `branchHead`. */
  | { readonly kind: "branch"; readonly modelId: string; readonly branchId: string; readonly branchHead: number };

/** A built-in or contributed kind of change ("Owner requested"). */
export interface ChangeSignificanceKindDef {
  /** Built-ins are bare (`owner_requested`); a pack's or firm's carry its namespace (`acme.allowance`). */
  readonly id: string;
  /** Operator words ("Owner requested"). */
  readonly label: string;
  /** One sentence on when to pick it. */
  readonly description: string;
  /** Picking it needs a citation: the requirement or specification section. */
  readonly needsCitation?: boolean;
  /**
   * Whether a change order can follow from this kind. Informational only:
   * nothing opens a change order because of a classification.
   */
  readonly mayLeadToChangeOrder?: boolean;
}

/** One classification of a target. The newest per target is the current one; earlier ones are history. */
export interface ChangeSignificance {
  readonly id: string;
  readonly target: ChangeTarget;
  /** A registered kind id; an id this release doesn't know is kept as written. */
  readonly kind: string;
  readonly reason: string;
  /** The requirement or specification section cited. */
  readonly citation?: string;
  /** The responsibility the classifier set it under. */
  readonly responsibilityId: string;
  /** The host's person id. */
  readonly classifiedBy: string;
  readonly classifiedAt: string;
  /** `sha256:<hex>` of the quantity delta the classifier saw (`deltaDigest`). */
  readonly deltaDigest?: string;
}

export type ChangeOrderStatus = "draft" | "sent" | "accepted" | "refused" | "no_cost";

export const CHANGE_ORDER_STATUSES: readonly ChangeOrderStatus[] = ["draft", "sent", "accepted", "refused", "no_cost"];

/** The party a change order is for: a CRM contact or an organization, exactly one. */
export type ChangeOrderAddressee =
  | { readonly kind: "contact"; readonly ref: string; readonly label: string }
  | { readonly kind: "organization"; readonly ref: string; readonly label: string };

export interface ChangeOrder {
  readonly id: string;
  readonly target: ChangeTarget;
  readonly title: string;
  readonly description?: string;
  readonly addressee: ChangeOrderAddressee;
  /** A status this release doesn't know reads as `draft` for actions (nothing can be decided on it) but is shown as written. */
  readonly status: ChangeOrderStatus;
  readonly openedBy: string;
  readonly openedAt: string;
  /** The newest decision's reason and citation. */
  readonly reason?: string;
  readonly citation?: string;
  /** Computed from the model when shown, never typed; no money. */
  readonly quantityDeltas?: readonly QuantityDelta[];
}

/** One status change, append-only. */
export interface ChangeOrderEvent {
  readonly changeOrderId: string;
  readonly from: ChangeOrderStatus | null;
  readonly to: ChangeOrderStatus;
  readonly reason?: string;
  readonly citation?: string;
  readonly by: string;
  readonly at: string;
}

/** Plain words for every operator surface (Nielsen 2). */
export const CHANGE_WORDS = {
  notAChangeOrder: "Design change. Not a change order.",
  notClassified: "Not classified",
  whoClassifies: "Only a responsible professional whose area covers this change can say what kind of change it was. Ask them in Manage › Responsibilities.",
  noResponsibility: "You aren't named responsible for any part of this change, so you can't classify it.",
  reasonRequired: "Say why, so the record explains the decision.",
  citationRequired: "This kind needs a citation: the requirement or specification section.",
  onlyAddressee: "Only the party this change order is addressed to can accept it, refuse it or mark it no cost.",
  needsLogin: (name: string) => `Waiting for ${name}. They need a login to this app to answer.`,
  waitingFor: (name: string) => `Waiting for ${name} to answer.`,
} as const;
