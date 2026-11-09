import { loadPointHostState } from "../load-points/model";
import { defineExtensionPoint } from "../packs/contract";
import { activePackSet } from "../packs/scope";
import type { BimElement, ElementId } from "../types";
import { devicePartOf, loadAnchorOf, type LoadRecord } from "./anchor";
import type { LoadStatus } from "./types";

type Elements = Readonly<Record<string, BimElement>>;

/**
 * A load's fulfilment status, derived from its anchor, its source and the drawn
 * network (KERNEL-REQUIREMENTS-MODEL §3.4). Never typed, so it can't go stale.
 *
 *   open       a row with nowhere to be and no source
 *   assigned   it names its source (servedBy) but nothing is drawn
 *   placed     it is somewhere: a point, a space or zone that exists
 *   connected  on a pipe or duct end ("piped")
 *   attached   a modelled fixture, device or piece of equipment stands for it
 *   mismatch   the drawing disagrees with its source, or its source/anchor is gone
 */

/** Whether the drawn network that reaches a run end comes from `sourceId`. Null: can't tell (no source drawn yet). */
export type DrawnSourceCheck = (elements: Elements, hostId: ElementId, sourceId: ElementId) => boolean | null;

/** One pack's drawn-source check (v1): the add-on that draws a network says whether a run end is fed from a source. */
export interface DrawnSourceRow {
  readonly id: string;
  readonly check: DrawnSourceCheck;
}

/** Drawn-source checks (`kernel.drawn_source`, contract 1.3.0). The first row in set order that can tell answers. */
export const DRAWN_SOURCE_POINT = defineExtensionPoint<DrawnSourceRow>({ id: "kernel.drawn_source", version: 1, label: "Drawn-source checks", idOf: (r) => r.id });

/** The drawn-source check of the set in force, or undefined when no pack in it contributes one. */
export function activeDrawnSource(): DrawnSourceCheck | undefined {
  const set = activePackSet();
  const rows = set.items(DRAWN_SOURCE_POINT);
  if (rows.length === 0) return undefined;
  if (rows.length === 1) return (rows[0] as DrawnSourceRow).check;
  return set.memo("kernel.drawn_source", (): DrawnSourceCheck => (elements, hostId, sourceId) => {
    for (const row of rows) {
      const answer = row.check(elements, hostId, sourceId);
      if (answer !== null) return answer;
    }
    return null;
  });
}

export interface LoadStatusResult {
  readonly status: LoadStatus;
  /** Plain words for a mismatch, else null. */
  readonly why: string | null;
  /** Elements the status read besides the load: re-derive it when one of them changes. */
  readonly reads: readonly ElementId[];
}

export function loadStatusOf(elements: Elements, lp: LoadRecord, drawnSource?: DrawnSourceCheck): LoadStatusResult {
  const reads: ElementId[] = [];
  const source = lp.servedBy;
  if (source) {
    reads.push(source);
    if (elements[source]?.kind !== "part") return { status: "mismatch", why: `its source ${source} is not in the model any more`, reads };
  }
  const part = devicePartOf(lp);
  if (part) {
    reads.push(part);
    if (elements[part]?.kind !== "part") return { status: "mismatch", why: `the fixture or equipment ${part} it stood for has been deleted`, reads };
    return { status: "attached", why: null, reads };
  }
  const a = loadAnchorOf(lp);
  switch (a.kind) {
    case "run_end": {
      reads.push(a.hostId);
      if (loadPointHostState(elements, lp) === "lost") return { status: source ? "assigned" : "open", why: null, reads };
      if (source && drawnSource) {
        const fromSource = drawnSource(elements, a.hostId, source);
        if (fromSource === false) return { status: "mismatch", why: `it is piped, but not from ${source}, the source it names`, reads };
      }
      return { status: "connected", why: null, reads };
    }
    case "point":
      reads.push(a.levelId);
      return elements[a.levelId] ? { status: "placed", why: null, reads } : { status: source ? "assigned" : "open", why: null, reads };
    case "space":
    case "zone": {
      reads.push(a.id);
      const there = elements[a.id];
      if (!there) return { status: "mismatch", why: `the ${a.kind} it was spread over has been deleted`, reads };
      return { status: "placed", why: null, reads };
    }
    case "none":
    case "part":
      return { status: source ? "assigned" : "open", why: null, reads };
  }
}

