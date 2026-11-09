/**
 * Merging a branch back to Main (round 8 step 8b, lane M). The shapes the
 * kernel, the model server and a host share. `MergePart` and `MergeProposal`
 * are fixed by the round's README so every lane builds against them.
 *
 * A merge is never a change order and never carries a cost: a part lands on
 * Main as ordinary revisions attributed to the person who pressed Merge.
 */
import type { BimElement, Connection, ElementId } from "../types";

/** One discipline's share of a merge, and the responsibilities that approve it. */
export interface MergePart {
  readonly discipline: string;
  /** Accepted responsibilities whose scope covers these elements (empty: the project lead approves). */
  readonly responsibilityIds: readonly string[];
  readonly elementIds: readonly ElementId[];
}

/** An element both sides changed differently, in words a person reads. */
export interface MergeConflict {
  readonly elementId: ElementId;
  readonly words: string;
}

export interface MergeProposal {
  readonly branchId: string;
  readonly baseRevision: number;
  readonly branchHead: number;
  readonly mainHead: number;
  readonly parts: readonly MergePart[];
  readonly conflicts: readonly MergeConflict[];
}

/** An element at one revision: the record, `null` when it doesn't exist there. */
export type ElementAt = (id: ElementId) => BimElement | null;

/** Connections a side made and cut since the base revision. */
export interface ConnectionChanges {
  readonly added: readonly Connection[];
  readonly removed: readonly Connection[];
}

/** What the branch brings to Main, per element: the record to write, or `null` to remove it. */
export interface MergeWrite {
  readonly elementId: ElementId;
  readonly record: BimElement | null;
}

export interface ThreeWayMerge {
  /** Branch changes Main doesn't have yet, in the order the branch listed them. */
  readonly writes: readonly MergeWrite[];
  readonly addConnections: readonly Connection[];
  readonly removeConnections: readonly Connection[];
  /** Branch changes Main already has the same way: nothing to do. */
  readonly alreadyOnMain: readonly ElementId[];
  readonly conflicts: readonly MergeConflict[];
}

/** Why a part can't land yet. */
export type PartWait =
  | { readonly kind: "conflict"; readonly elementIds: readonly ElementId[] }
  | { readonly kind: "approval"; readonly waitingFor: readonly string[] }
  | { readonly kind: "no_lead" }
  | { readonly kind: "depends_on"; readonly discipline: string; readonly elementId: ElementId; readonly on: ElementId };

/** A part's verdict in a landing plan. */
export interface PartVerdict {
  readonly part: MergePart;
  readonly lands: boolean;
  readonly waits: readonly PartWait[];
  /** The reason in plain words, when it doesn't land. */
  readonly words: string | null;
}

/** What a merge apply may land, and what waits. */
export interface LandingPlan {
  readonly verdicts: readonly PartVerdict[];
  readonly landingElementIds: readonly ElementId[];
}
