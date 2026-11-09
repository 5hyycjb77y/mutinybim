import type { TrackedReader } from "../model";
import { asElementId, type BimElement, type ElementId } from "../types";
import { linksOf, portInfo, withLink } from "./geometry";
import { systemRules, fittingLabel } from "./rules";
import type { PortRef, RunFitting } from "./types";

/** A link that a delete cuts: `keep` is the port on the element that stays. */
export interface RunCut {
  readonly keep: PortRef;
  readonly gone: PortRef;
}

export interface RunDeletePlan {
  readonly cuts: readonly RunCut[];
  /** Branch fittings removed from a trunk that stays: the trunk is continuous, so it stays whole. */
  readonly trims: ReadonlyArray<{ readonly hostId: ElementId; readonly branchId: ElementId }>;
}

/** What else a deleted run element or system holds up: a trunk's branches, a system's or level's runs. */
export function runDependents(el: BimElement | undefined): readonly ElementId[] {
  return el?.kind === "run_segment" ? el.branches : [];
}

/** Run elements that belong to any of these systems or levels (one pass over the model; only deleting a system or level needs it). */
export function runsReferencing(ids: ReadonlySet<string>, all: readonly BimElement[]): ElementId[] {
  const out: ElementId[] = [];
  for (const el of all) {
    if ((el.kind === "run_segment" || el.kind === "run_fitting") && (ids.has(el.systemId) || ids.has(el.levelId))) out.push(el.id);
  }
  return out;
}

/** Links from the deleted set to what stays, and branches leaving a trunk that stays. */
export function planRunDelete(reader: TrackedReader, removed: ReadonlySet<ElementId>): RunDeletePlan {
  const model = reader.model;
  const cuts: RunCut[] = [];
  const trims: Array<{ hostId: ElementId; branchId: ElementId }> = [];
  for (const id of removed) {
    const el = model.elements[id];
    if (!el) continue;
    for (const [port, link] of linksOf(el)) {
      if (removed.has(link.elementId)) continue;
      reader.get(link.elementId);
      cuts.push({ keep: link, gone: { elementId: id, port } });
    }
    if (el.kind === "run_fitting" && el.host && !removed.has(el.host.segmentId)) {
      reader.get(el.host.segmentId);
      trims.push({ hostId: el.host.segmentId, branchId: el.id });
    }
  }
  return { cuts, trims };
}

/**
 * Apply the cuts and trims to a working copy. With `cap`, each run end left
 * open gets a cap (parts are never capped: their connector is just free).
 * Returns the elements changed and created, and what happened, in words.
 */
export function applyRunDelete(working: Record<string, BimElement>, plan: RunDeletePlan, cap: boolean): { touched: ElementId[]; summary: string[] } {
  const touched: ElementId[] = [];
  let capped = 0;
  let open = 0;
  let freed = 0;
  for (const cut of plan.cuts) {
    const keep = working[cut.keep.elementId];
    if (!keep) continue;
    const next = withLink(keep, cut.keep.port, null);
    if (!next) continue;
    working[next.id] = next;
    touched.push(next.id);
    if (next.kind === "part") {
      freed += 1;
      continue;
    }
    if (!cap || (next.kind !== "run_segment" && next.kind !== "run_fitting")) {
      open += 1;
      continue;
    }
    const at = portInfo(working, cut.keep);
    const system = working[next.systemId];
    if (!at || !at.size || system?.kind !== "mep_system") {
      open += 1;
      continue;
    }
    let capId = asElementId(`${next.id}-cap-${cut.keep.port}`);
    for (let n = 2; working[capId]; n++) capId = asElementId(`${next.id}-cap-${cut.keep.port}-${n}`);
    const capEl: RunFitting = {
      id: capId,
      kind: "run_fitting",
      version: 0,
      authoredRev: {},
      ...(next.partition ? { partition: next.partition } : {}),
      fittingType: "cap",
      label: fittingLabel("cap", systemRules(system.systemKind), null),
      domain: next.domain,
      systemId: next.systemId,
      levelId: next.levelId,
      position: at.position,
      ports: [{ id: "a", position: at.position, direction: { x: -at.direction.x, y: -at.direction.y, z: -at.direction.z }, size: at.size, link: cut.keep }],
    };
    working[capId] = capEl;
    const linked = withLink(next, cut.keep.port, { elementId: capId, port: "a" });
    if (linked) working[linked.id] = linked;
    touched.push(capId);
    capped += 1;
  }
  for (const t of plan.trims) {
    const host = working[t.hostId];
    if (host?.kind !== "run_segment") continue;
    working[host.id] = { ...host, branches: host.branches.filter((b) => b !== t.branchId) };
    touched.push(host.id);
  }
  const summary: string[] = [];
  if (plan.trims.length > 0) summary.push(`${plan.trims.length === 1 ? "The trunk stays" : "The trunks stay"} whole where ${plan.trims.length === 1 ? "the branch was" : "branches were"} taken off`);
  if (capped > 0) summary.push(`${capped} open ${capped === 1 ? "end was" : "ends were"} capped`);
  if (open > 0) summary.push(`${open} run ${open === 1 ? "end is" : "ends are"} left open`);
  if (freed > 0) summary.push(`${freed} part ${freed === 1 ? "connector is" : "connectors are"} free again`);
  return { touched: [...new Set(touched)], summary };
}
