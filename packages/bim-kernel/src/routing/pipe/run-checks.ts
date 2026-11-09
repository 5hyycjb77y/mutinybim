import { defineExtensionPoint } from "../../packs/contract";
import { activePackSet } from "../../packs/scope";
import type { BimElement, ElementId, ModelSettings } from "../../types";
import { straightPiece } from "../fittings/geometry";
import { fittingFamily, resolveFitting } from "../fittings/library";
import { segmentAxis } from "../geometry";
import { runLabel } from "../run-label";
import type { MepSystem, RunFitting, RunSegment } from "../types";
import type { RunIssue } from "../validate";
import { jointIssue } from "./families";
import { hostedHalfLength } from "./geometry";
import { isVerticalLeg } from "./gravity";

type Elements = Readonly<Record<string, BimElement>>;

/**
 * A trade's checks on pipe runs (v1): slope and flow direction on a
 * gravity line, a process pipe's pressure class, … `validateRuns` runs them with the
 * shared pipe checks (hosted items' spacing, accessory placement, joints),
 * in the set's row order: a row's segment issues come before the hosted
 * spacing, its fitting issues after the accessory check and before joints.
 */
export interface PipeRunCheckDef {
  readonly id: string;
  segment?(elements: Elements, seg: RunSegment): readonly RunIssue[];
  fitting?(elements: Elements, fitting: RunFitting): readonly RunIssue[];
}

export const PIPE_RUN_CHECK_POINT = defineExtensionPoint<PipeRunCheckDef>({ id: "kernel.pipe_run_check", version: 1, label: "Pipe run checks", idOf: (c) => c.id });

function systemOf(elements: Elements, el: RunSegment | RunFitting): MepSystem | null {
  const s = elements[el.systemId];
  return s?.kind === "mep_system" ? s : null;
}

/** Hosted pipe items (tees, valves, cleanouts) clear of the fittings at the ends and of each other, by their real lengths. */
export function hostedPipeIssues(elements: Elements, seg: RunSegment, issues: RunIssue[]): void {
  if (seg.branches.length === 0) return;
  const piece = straightPiece(elements, seg);
  const total = piece.lengthMm + piece.cutStart + piece.cutEnd;
  const system = systemOf(elements, seg);
  const spans: Array<{ id: ElementId; lo: number; hi: number; name: string }> = [];
  for (const id of seg.branches) {
    const b = elements[id];
    if (b?.kind !== "run_fitting" || !b.host) continue;
    const rf = resolveFitting(system, b);
    const half = rf?.family.pipe ? hostedHalfLength(elements, b, rf) : 0;
    spans.push({ id: b.id, lo: b.host.s - half, hi: b.host.s + half, name: runLabel(elements, b) });
  }
  const segName = runLabel(elements, seg);
  for (const s of spans) {
    if (s.lo < piece.cutStart - 0.5 || s.hi > total - piece.cutEnd + 0.5) {
      issues.push({ code: "outside_host", message: `The ${s.name} needs ${Math.round(s.hi - s.lo)} mm of straight ${segName}; it runs into the fitting at the end. Slide it along`, elementIds: [s.id, seg.id] });
    }
  }
  spans.sort((a, b) => a.lo - b.lo);
  for (let i = 1; i < spans.length; i++) {
    const a = spans[i - 1];
    const b = spans[i];
    if (a && b && b.lo < a.hi - 0.5) issues.push({ code: "tap_spacing", message: `The ${a.name} and the ${b.name} overlap on the ${segName} by ${Math.round(a.hi - b.lo)} mm; move one along`, elementIds: [a.id, b.id] });
  }
}

/** Accessories: on the right kind of pipe (a test tee on a stack, a trap on a level arm) and with a joint that pipe takes. */
export function accessoryIssue(elements: Elements, f: RunFitting): string | null {
  if (f.fittingType !== "accessory") return null;
  const host = f.host ? elements[f.host.segmentId] : undefined;
  if (host?.kind !== "run_segment") return `${f.label} isn't on a pipe`;
  if (f.ports.length !== 0) return `${f.label} sits inline on its pipe and has no openings of its own`;
  const system = systemOf(elements, f);
  const rf = resolveFitting(system, f);
  const place = rf?.family.pipe?.placement;
  const vertical = isVerticalLeg(segmentAxis(host));
  if (place === "vertical" && !vertical) return `A ${rf?.family.name.toLowerCase()} goes on vertical pipe; ${runLabel(elements, host)} is level`;
  if (place === "horizontal" && vertical) return `A ${rf?.family.name.toLowerCase()} goes on level pipe; ${runLabel(elements, host)} is vertical`;
  return null;
}

/** Pipe-only checks run with the routing checks. */
export function pipeRoutingIssues(elements: Elements, el: RunSegment | RunFitting, _settings: ModelSettings, issues: RunIssue[]): void {
  if (el.domain !== "pipe") return;
  const checks = activePackSet().items(PIPE_RUN_CHECK_POINT);
  if (el.kind === "run_segment") {
    for (const c of checks) if (c.segment) issues.push(...c.segment(elements, el));
    hostedPipeIssues(elements, el, issues);
    return;
  }
  const acc = accessoryIssue(elements, el);
  if (acc) issues.push({ code: "unsupported_geometry", message: acc, elementIds: [el.id] });
  for (const c of checks) if (c.fitting) issues.push(...c.fitting(elements, el));
  if (el.family) {
    const family = fittingFamily(el.family);
    const size = el.fittingType === "accessory" && el.host ? (elements[el.host.segmentId] as RunSegment | undefined)?.size : el.ports[0]?.size;
    const joint = family ? jointIssue(family, el.params ?? {}, size) : null;
    if (joint) issues.push({ code: "profile_incompatible", message: joint, elementIds: [el.id] });
  }
}
