import type { BimElement, ElementId } from "@permitzip/bim-kernel";
import { pipeSegmentOf } from "@permitzip/bim-kernel";
import { pipeSystemReportOf, type DrainageReport } from "../routing/pipe/hydraulics";

type Elements = Readonly<Record<string, BimElement>>;

/**
 * Drawn drains against the firm's drainage-unit table (round 12 P12, the
 * Oct 26 review's "4 in drain carrying 394 DFU against a 180 limit"). The
 * drainage solve walks the drawn pipe from every fixture down to the outfall
 * once per system per model state and reads the capacity the system's
 * design table gives each size and slope (`design.pipe.capacityTable`, the
 * firm's or project's own values: no code table in the add-on). A drain with
 * no table row is not judged.
 */

const reports = new WeakMap<Elements, Map<string, DrainageReport | null>>();

function drainageReportOf(elements: Elements, systemId: string): DrainageReport | null {
  let bySystem = reports.get(elements);
  if (!bySystem) {
    bySystem = new Map();
    reports.set(elements, bySystem);
  }
  if (!bySystem.has(systemId)) {
    const r = pipeSystemReportOf(elements, systemId);
    bySystem.set(systemId, r?.kind === "drainage" ? r : null);
  }
  return bySystem.get(systemId) ?? null;
}

export interface DrainOverLimit {
  readonly elementId: ElementId;
  readonly dfu: number;
  readonly maxDfu: number;
  readonly nominalIn: number;
  readonly slopeInPerFt: number | null;
  /** `1/8"`, `1/4"`; "level" for a stack. */
  readonly slopeText: string;
}

const SLOPE_WORDS: Readonly<Record<string, string>> = { "0.0625": '1/16"', "0.125": '1/8"', "0.25": '1/4"', "0.5": '1/2"' };

/** The drawn drain over its table limit, or null (within it, no table row, or not a drain). */
export function drainOverDrainageUnits(elements: Elements, segmentId: ElementId): DrainOverLimit | null {
  const seg = pipeSegmentOf(elements, segmentId);
  if (!seg) return null;
  const report = drainageReportOf(elements, seg.systemId);
  const row = report?.segments.find((s) => s.elementId === segmentId);
  if (!row || row.tableMaxDfu === null || row.fixtureUnits <= row.tableMaxDfu + 1e-9) return null;
  const slope = row.slopeInPerFt;
  return {
    elementId: segmentId,
    dfu: row.fixtureUnits,
    maxDfu: row.tableMaxDfu,
    nominalIn: row.nominalIn,
    slopeInPerFt: slope,
    slopeText: slope === null ? "level" : (SLOPE_WORDS[String(slope)] ?? `${slope}"`),
  };
}
