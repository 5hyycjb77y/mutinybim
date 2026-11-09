import type { ElementId, ModelElementBase } from "../types";

/**
 * Submittals and divergences (contract 1.5.0, reserved; NEXT-BATCH-8 §10).
 *
 * Three product layers are kept apart, never merged into one record:
 *
 * - **Design basis:** the model's elements and types and the requirements
 *   they meet (the contract documents). Nothing here changes them.
 * - **Submittal:** product data or shop drawings someone offered for named
 *   elements, types or requirements, and how the reviewer answered each item.
 * - **Field:** what was built or observed by others: the requirements graph's
 *   reserved `observation` record.
 *
 * An approved substitution is a `divergence`: the design basis and the
 * approved product side by side, who approved it, the notes, and an optional
 * party responsible for the difference, recorded only when a person sets it.
 * A divergence never changes the design model or the record drawings by
 * itself and never implies the designer owes as-built drawings. Changing the
 * design to match is a deliberate edit on the design that cites the copy's
 * difference ("matched in design", round 11), like any design change.
 *
 * Round 11 (L11): a submittal can be the transmittal over a `submittal`
 * lineage's review: it names that copy (`lineageId`) and the delta digest
 * the review covered (`deltaDigest`). A divergence is then a reviewed
 * difference that was not accepted back (`lineageDivergences`). Submittals
 * without them read exactly as before.
 *
 * Product files stay in the host (`externalRefs`); no vendor text is stored
 * here. Nothing of this release writes either record (`submittals:records`,
 * `submittals:divergence` are never advertised in round 8); readers keep
 * every field, state and kind they don't know.
 */

/** Peers that read and store `submittal` records. Never advertised in round 8. */
export const SUBMITTAL_RECORDS_FEATURE = "submittals:records";

/** Peers that read and store `divergence` records. Never advertised in round 8. */
export const SUBMITTAL_DIVERGENCE_FEATURE = "submittals:divergence";

/** The record kinds, as the store's kind index keys them. Outside the element union until round 9's writers. */
export const SUBMITTAL_KIND = "submittal";
export const DIVERGENCE_KIND = "divergence";

/** The three layers a product moves through, in order. */
export const PRODUCT_LAYERS = ["design_basis", "submittal", "field"] as const;
export type ProductLayer = (typeof PRODUCT_LAYERS)[number];

/**
 * A reviewer's answer to a submittal or one of its items. Open: a workflow
 * may add its own (readers keep a state they don't know).
 */
export type SubmittalReviewState = "pending" | "approved" | "approved_as_noted" | "revise_and_resubmit" | "rejected" | (string & {});

export const SUBMITTAL_REVIEW_STATES = ["pending", "approved", "approved_as_noted", "revise_and_resubmit", "rejected"] as const satisfies readonly SubmittalReviewState[];

/** Plain words for each review state, as a reviewer reads them. */
export const SUBMITTAL_REVIEW_LABELS: Readonly<Record<(typeof SUBMITTAL_REVIEW_STATES)[number], string>> = {
  pending: "Waiting for review",
  approved: "Approved",
  approved_as_noted: "Approved as noted",
  revise_and_resubmit: "Revise and resubmit",
  rejected: "Rejected",
};

/** Opaque to the kernel: the host decides what `provider` and `ref` mean (a file, a workflow's own record). */
export interface SubmittalExternalRef {
  readonly provider: string;
  readonly ref: string;
}

/** What a submittal, an item or a divergence is about in the design basis. Every list is optional; at least one names something. */
export interface DesignBasisRef {
  readonly elementIds?: readonly ElementId[];
  /** Element or part type ids. */
  readonly typeIds?: readonly ElementId[];
  /** Requirement keys or `requirement_state` ids of the requirements graph. */
  readonly requirementRefs?: readonly string[];
}

export interface SubmittalReview {
  readonly state: SubmittalReviewState;
  /** Who reviewed: any person or party, in words. Absent while pending. */
  readonly reviewer?: string;
  /** When, ISO 8601. */
  readonly at?: string;
  readonly notes?: string;
}

/** One product or drawing in a submittal, reviewed on its own. */
export interface SubmittalItem {
  /** Unique within the submittal. */
  readonly id: string;
  /** What people read ("Item 3, product data"). */
  readonly label: string;
  /** What in the design it is offered for; absent: the submittal's own `offeredFor`. */
  readonly offeredFor?: DesignBasisRef;
  readonly review?: SubmittalReview;
  readonly externalRefs?: readonly SubmittalExternalRef[];
}

export interface SubmittalBody {
  /** What people read ("Section 3 product data, rev 1"). */
  readonly title: string;
  readonly offeredFor: DesignBasisRef;
  /** Who submitted it: any person or party, in words. */
  readonly submittedBy?: string;
  /** The submittal's revision as its submitter numbers it ("0", "1", "A"). */
  readonly revision: string;
  /** The overall answer; items carry their own. */
  readonly review: SubmittalReview;
  readonly items: readonly SubmittalItem[];
  /** The product data, drawings and any workflow record, in the host. */
  readonly externalRefs?: readonly SubmittalExternalRef[];
  /** Round 11: the copy (lineage) this submittal transmits, when it is over one. */
  readonly lineageId?: string;
  /** Round 11: the delta digest of that copy the review covers (`lineageDelta`). Present with `lineageId`. */
  readonly deltaDigest?: string;
}

export interface SubmittalElement extends ModelElementBase {
  readonly kind: typeof SUBMITTAL_KIND;
  readonly submittal: SubmittalBody;
  readonly schemaVersion?: number;
}

/** A person or party, in words, with the host's id when there is one. */
export interface DivergenceParty {
  readonly label: string;
  readonly ref?: string;
}

/** The product that was approved in place of the design basis. */
export interface ApprovedProduct {
  /** What people read ("Alternate unit, maker B"). */
  readonly label: string;
  readonly submittalId?: ElementId;
  readonly itemId?: string;
}

export interface DivergenceBody {
  readonly designBasis: DesignBasisRef;
  readonly approvedProduct: ApprovedProduct;
  /** Who approved the difference: any person or party, in words. */
  readonly approvedBy: string;
  /** When, ISO 8601. */
  readonly at: string;
  readonly notes: string;
  /** Who is responsible for the difference, when a person records it (for example the contractor that proposed it). Never inferred. */
  readonly responsibleParty?: DivergenceParty;
  /** Why that party is responsible, in their words. */
  readonly responsibilityNote?: string;
  readonly externalRefs?: readonly SubmittalExternalRef[];
}

export interface DivergenceElement extends ModelElementBase {
  readonly kind: typeof DIVERGENCE_KIND;
  readonly divergence: DivergenceBody;
  readonly schemaVersion?: number;
}
