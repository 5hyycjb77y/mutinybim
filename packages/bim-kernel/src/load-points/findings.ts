import { runEndOf } from "../requirements/anchor";
import { connectionTypeOfLoadPoint, loadPointHostState, loadPointLabel } from "./model";
import { elementsOfKind } from "../store";
import type { BimElement, ElementId } from "../types";
import type { LoadPointElement } from "./types";

type Elements = Readonly<Record<string, BimElement>>;

/**
 * Findings about load points, for the Properties panel and the plumbing
 * checks (bim-lint). They never block an edit: deleting a pipe leaves its
 * load point "lost" rather than refusing the delete, and undoing the delete
 * puts the point back on its pipe (its id names the host).
 */
export type LoadPointFindingCode = "host_lost" | "host_continued" | "connection_type_missing" | "fixture_missing";

export interface LoadPointFinding {
  readonly code: LoadPointFindingCode;
  readonly message: string;
  readonly elementIds: readonly ElementId[];
}

export function loadPointFindingsFor(elements: Elements, lp: LoadPointElement): LoadPointFinding[] {
  const out: LoadPointFinding[] = [];
  const label = loadPointLabel(elements, lp);
  const state = loadPointHostState(elements, lp);
  if (state === "lost") out.push({ code: "host_lost", message: `${label} lost its pipe (it was deleted), so it counts nowhere. Place it on another open end, or delete it`, elementIds: [lp.id] });
  const at = runEndOf(lp);
  if (state === "continued" && at) out.push({ code: "host_continued", message: `${label} is where the pipe now continues; move it to the new open end`, elementIds: [lp.id, at.elementId] });
  if (lp.connectionType && !connectionTypeOfLoadPoint(elements, lp)) out.push({ code: "connection_type_missing", message: `${label} names connection type ${lp.connectionType}, which the project doesn't have; only its own values count`, elementIds: [lp.id] });
  if (lp.attachedPartId && elements[lp.attachedPartId]?.kind !== "part") out.push({ code: "fixture_missing", message: `${label} was attached to a fixture that has been deleted; the point keeps its loads`, elementIds: [lp.id] });
  return out;
}

/** Every load point finding in a model. Scans: checks and reports, not edits. */
export function loadPointFindings(elements: Elements): LoadPointFinding[] {
  const out: LoadPointFinding[] = [];
  for (const el of elementsOfKind(elements, "load_point")) out.push(...loadPointFindingsFor(elements, el));
  return out;
}
