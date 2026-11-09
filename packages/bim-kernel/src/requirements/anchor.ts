import type { LoadPointElement, LoadPointHost } from "../load-points/types";
import { asElementId, type ElementId } from "../types";
import type { LoadAnchor, LoadStage } from "./types";

/**
 * Reading a load's anchor. Every record written before Oct 2026 has `host` and
 * no `anchor`: it reads as a load on that run end. A load moved off a pipe (to a
 * space, a point or a part) keeps its id, `lp:<host>:<port>` included, so the id
 * never says where a load is; its anchor does.
 */

/** A load as stored: `host` is present on every run-end load written before anchors existed. */
export type LoadRecord = LoadPointElement;

export const LEGACY_LOAD_PREFIX = "lp:";

/** The id a load placed on this run end before Oct 2026 has. Still valid forever; new loads get generated ids. */
export function legacyLoadId(hostId: string, port: string): ElementId {
  return asElementId(`${LEGACY_LOAD_PREFIX}${hostId}:${port}`);
}

export function loadAnchorOf(lp: LoadRecord): LoadAnchor {
  if (lp.anchor) return lp.anchor;
  return lp.host ? { kind: "run_end", hostId: lp.host.elementId, port: lp.host.port } : { kind: "none" };
}

/** The run end a load sits on, or null for an estimate, a row, a point or a device load. */
export function runEndOf(lp: LoadRecord): LoadPointHost | null {
  const a = loadAnchorOf(lp);
  return a.kind === "run_end" ? { elementId: a.hostId, port: a.port } : null;
}

/** The element the anchor names (the space, zone, run element or part), or null. */
export function anchorTargetOf(anchor: LoadAnchor): ElementId | null {
  switch (anchor.kind) {
    case "space":
    case "zone":
      return anchor.id;
    case "run_end":
      return anchor.hostId;
    case "part":
      return anchor.partId;
    case "point":
    case "none":
      return null;
  }
}

/** The part a modelled device stands for: attached, or anchored to its connector. */
export function devicePartOf(lp: LoadRecord): ElementId | null {
  if (lp.attachedPartId) return lp.attachedPartId;
  const a = loadAnchorOf(lp);
  return a.kind === "part" ? a.partId : null;
}

/**
 * The stage is derived, never typed (requirements/types.ts):
 * device when a modelled part stands for it, estimate when it is spread over a
 * space or zone or is a bare row, otherwise concentrated.
 */
export function loadStageOf(lp: LoadRecord): LoadStage {
  if (devicePartOf(lp)) return "device";
  const a = loadAnchorOf(lp);
  if (a.kind === "space" || a.kind === "zone" || a.kind === "none") return "estimate";
  return "concentrated";
}

/** An estimate whose value is spread over a space or zone: the side that is "allocated". */
export function isAreaEstimate(lp: LoadRecord): boolean {
  const a = loadAnchorOf(lp);
  return (a.kind === "space" || a.kind === "zone") && !devicePartOf(lp);
}

export function sameAnchor(a: LoadAnchor, b: LoadAnchor): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "none":
      return true;
    case "space":
    case "zone":
      return b.kind === a.kind && a.id === b.id;
    case "run_end":
      return b.kind === "run_end" && a.hostId === b.hostId && a.port === b.port;
    case "point":
      return b.kind === "point" && a.levelId === b.levelId && a.position.x === b.position.x && a.position.y === b.position.y;
    case "part":
      return b.kind === "part" && a.partId === b.partId && (a.connector ?? null) === (b.connector ?? null);
  }
}

/** "on the end of p-12", "in space S-101", "on RTU-1's gas inlet": for summaries and refusals. */
export function anchorWords(anchor: LoadAnchor, name: (id: ElementId) => string): string {
  switch (anchor.kind) {
    case "none":
      return "not placed anywhere yet";
    case "space":
      return `spread over space ${name(anchor.id)}`;
    case "zone":
      return `spread over zone ${name(anchor.id)}`;
    case "run_end":
      return `on the ${anchor.port} of ${name(anchor.hostId)}`;
    case "point":
      return "at a point on the plan";
    case "part":
      return `on ${name(anchor.partId)}${anchor.connector ? ` (${anchor.connector})` : ""}`;
  }
}
