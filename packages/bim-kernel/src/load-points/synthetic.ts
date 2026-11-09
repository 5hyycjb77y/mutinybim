import type { MepSystem, RunFitting, RunSegment, RunSize } from "../routing/types";
import { asElementId, type BimElement, type ElementId } from "../types";
import { hostedPoints } from "../routing/geometry";
import { loadPointId } from "./model";
import type { LoadPointElement } from "./types";

/**
 * A synthetic domestic cold water system for the perf gate
 * (scripts/perf/mutinybim/plumbing.ts): `trunks` straight trunk pieces in a
 * line, each hosting `branchesPerTrunk` tees with a short branch and a load
 * point on its open end. The service is the first trunk's open start. Laid
 * out with the kernel's hosted-branch geometry, so the model validates clean. Built as elements (not commands) so a
 * 5,000-point system lays onto a 250k-element model in milliseconds.
 */
export interface SyntheticPlumbingOptions {
  readonly levelId: string;
  readonly trunks: number;
  readonly branchesPerTrunk: number;
  /** Cold water fixture units on every point. */
  readonly wsfu?: number;
  readonly prefix?: string;
}

const FT = 304.8;

export function syntheticPlumbing(o: SyntheticPlumbingOptions): { readonly elements: Record<string, BimElement>; readonly systemId: ElementId; readonly loadPointIds: ElementId[]; readonly trunkIds: ElementId[] } {
  const prefix = o.prefix ?? "synp";
  const systemId = asElementId(`${prefix}-cw`);
  const levelId = asElementId(o.levelId);
  const elements: Record<string, BimElement> = {};
  const trunk: RunSize = { shape: "pipe", nominalMm: 4 * 25.4, material: "copper" };
  const branch: RunSize = { shape: "pipe", nominalMm: 0.5 * 25.4, material: "copper" };
  const len = (o.branchesPerTrunk + 1) * 3 * FT;
  const base = { version: 1, authoredRev: {} };
  const trunkIds: ElementId[] = [];
  const loadPointIds: ElementId[] = [];
  const system: MepSystem = { ...base, id: systemId, kind: "mep_system", name: "Synthetic cold water", systemKind: "domestic_cold_water", domain: "pipe", entryId: asElementId(`${prefix}-t0`) };
  elements[systemId] = system;
  for (let t = 0; t < o.trunks; t++) {
    const id = asElementId(`${prefix}-t${t}`);
    trunkIds.push(id);
    const x0 = t * len;
    const branches: ElementId[] = [];
    const host: RunSegment = { ...base, id, kind: "run_segment", domain: "pipe", systemId, levelId, start: { x: x0, y: 0, z: 0 }, end: { x: x0 + len, y: 0, z: 0 }, size: trunk, links: {}, branches: [], flow: 0 };
    for (let b = 0; b < o.branchesPerTrunk; b++) {
      const fid = asElementId(`${prefix}-t${t}-f${b}`);
      const sid = asElementId(`${prefix}-t${t}-b${b}`);
      const along = (b + 1) * 3 * FT;
      const at = hostedPoints(host, along, 1);
      branches.push(fid);
      const tee: RunFitting = {
        ...base,
        id: fid,
        kind: "run_fitting",
        fittingType: "tee",
        label: "Tee",
        domain: "pipe",
        systemId,
        levelId,
        position: at.onAxis,
        ports: [{ id: "branch", position: at.branch, direction: at.outward, size: branch, link: { elementId: sid, port: "end" } }],
        host: { segmentId: id, s: along, side: 1 },
      };
      const far = { x: at.branch.x + at.outward.x * 6 * FT, y: at.branch.y + at.outward.y * 6 * FT, z: at.branch.z + at.outward.z * 6 * FT };
      const seg: RunSegment = { ...base, id: sid, kind: "run_segment", domain: "pipe", systemId, levelId, start: far, end: at.branch, size: branch, links: { end: { elementId: fid, port: "branch" } }, branches: [], flow: 0 };
      const lp: LoadPointElement = { ...base, id: loadPointId(sid, "start"), kind: "load_point", host: { elementId: sid, port: "start" }, connectionType: "", values: { wsfu_cold: o.wsfu ?? 2 }, mark: `SYN-${t}-${b}` };
      elements[fid] = tee;
      elements[sid] = seg;
      elements[lp.id] = lp;
      loadPointIds.push(lp.id);
    }
    const links: { start?: { elementId: ElementId; port: string }; end?: { elementId: ElementId; port: string } } = {};
    if (t > 0) links.start = { elementId: asElementId(`${prefix}-t${t - 1}`), port: "end" };
    if (t < o.trunks - 1) links.end = { elementId: asElementId(`${prefix}-t${t + 1}`), port: "start" };
    elements[id] = { ...host, links, branches };
  }
  return { elements, systemId, loadPointIds, trunkIds };
}
