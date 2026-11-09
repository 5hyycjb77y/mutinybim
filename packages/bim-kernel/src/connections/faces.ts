import type { Command } from "../commands";
import type { BimElement, ConnectorEnd, ElementId, ModelState, Vec2 } from "../types";

/**
 * Two network adapter faces added in contract 1.10.0, on the same row as the
 * link rules (`NetworkAdapterItem` in `connections/model.ts`).
 *
 * - `sourcesFor`: an element end with nothing serving it, and which sources
 *   could take it, nearest first, each refusal with its reason. Any network
 *   answers it (a device and its board, a terminal and its unit, a head and
 *   its branch, a detector and its loop), so the "drag to a source" grip is
 *   one generic piece of screen.
 * - `translate`: moving an element of the network and what follows it (a
 *   run that absorbs or passes the move on). The kernel's move command asks
 *   each adapter in turn; the first that takes the element moves it.
 */

/** The element end a person wants served. `end` absent: the element's only or first end. */
export interface SourceEndRef {
  readonly elementId: ElementId;
  readonly end?: ConnectorEnd;
}

export interface SourceCandidate {
  readonly sourceId: ElementId;
  /** How a person names it ("P1"). */
  readonly label: string;
  /** Plan distance from the end to the source, mm (candidates are listed nearest first). */
  readonly distanceMm: number;
  /** Free positions it would land on (spaces, ports), when the network has positions. */
  readonly positions?: readonly number[];
  /** One line on hover ("P1: 6 spare, 120/208 V"). */
  readonly note?: string;
}

export interface SourceRefusal {
  readonly sourceId: ElementId;
  readonly label: string;
  /** Why it can't take this end, in words ("P2 is full: 0 spare poles"). */
  readonly reason: string;
}

export interface SourceCandidates {
  /** The add-on's word for a source ("board", "unit", "main", "loop"). */
  readonly sourceWord: string;
  /** The grip's tooltip ("Needs a source. Drag to a unit"). */
  readonly prompt: string;
  readonly candidates: readonly SourceCandidate[];
  readonly refused: readonly SourceRefusal[];
}

/**
 * Null when this network has nothing to say about the end (it is served
 * already, or it isn't this network's element).
 */
export type SourcesForFace = (model: ModelState, end: SourceEndRef) => SourceCandidates | null;

/** One value the person set by the move (what a later edit keeps). */
export interface TranslateAuthoredWrite {
  readonly elementId: ElementId;
  readonly field: string;
  readonly value: unknown;
}

/** The working copy a move writes into: reads see earlier writes in the same move. */
export interface TranslateContext {
  readonly model: ModelState;
  /** The element as this move has left it so far; throws the kernel's not-found error when absent. */
  current(id: ElementId): BimElement;
  set(el: BimElement): void;
  author(write: TranslateAuthoredWrite): void;
}

/**
 * Move `id` by `delta` (plan mm) with whatever this network carries along.
 * Returns true when it moved the element, false when the element isn't this
 * network's (the kernel asks the next adapter). Refuses in words by throwing
 * the kernel's error (`KernelError`) when the move can't be made.
 */
export type TranslateFace = (ctx: TranslateContext, id: ElementId, delta: Vec2) => boolean;

/** What connecting an end to a source writes: the edits in order (one change the person can undo) and an undo label for each; or why it can't. */
export type ConnectPlan =
  | { readonly ok: true; readonly commands: readonly Command[]; readonly labels: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Contract 1.10.0 (round 12): connect an unserved end to one of the sources
 * `sourcesFor` offered (the "+" grip's drop). `newId` is a fresh element id
 * the host made for anything the network creates (a link). Null when the end
 * or the source isn't this network's, so the next adapter is asked.
 */
export type ConnectFace = (model: ModelState, end: SourceEndRef, source: SourceCandidate, newId: string) => ConnectPlan | null;
