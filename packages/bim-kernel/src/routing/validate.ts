import type { KernelErrorCode } from "../model";
import { resolveConnectors } from "../parts";
import type { BimElement, ElementId, ModelSettings, PartInstance } from "../types";
import { angleBetween, connectorAccepts, dist3, partConnector, segmentLength3 } from "./geometry";
import { domainHasFamilies, familyMismatch, fittingFamily, missingFittingFamilyOwnerWords, paramIssue } from "./fittings/library";
import { systemRules, connectorDomainOf, domainWord, sameSize, sizeFitsDomain, sizeLabel, sizeWidth, transitionReason } from "./rules";
import { hasSides, onItsSide } from "./orientation";
import { planHeadingOk } from "./route-angles";
import { isSlopeAt, planStepsFor, pipeTurnAngles, runSlopeAngles, turnAnglesWords } from "./pipe/turn-angles";
import { isPitchedOrLevel } from "./pipe/gravity";
import { pipeRoutingIssues } from "./pipe/run-checks";
import type { MepSystem, PortRef, RunFitting, RunSegment } from "./types";
import { heightFrameOf, portInfoIn } from "./levels-across";
import { runLabel } from "./run-label";

type Elements = Readonly<Record<string, BimElement>>;

export { runLabel };

/** Elbow turn tolerance on pipe: the pitch limit (1" per ft, 4.8°) plus half a degree. */
export const PIPE_TURN_TOLERANCE_DEG = (Math.atan(1 / 12) * 180) / Math.PI + 0.5;

export interface RunIssue {
  readonly code: KernelErrorCode;
  readonly message: string;
  readonly elementIds: readonly ElementId[];
}

/** Closest a branch may sit to either end of its trunk, and to the next branch. */
export function branchClearance(domain: RunSegment["domain"], settings: ModelSettings): { end: number; spacing: number } {
  return domain === "duct" ? { end: settings.tapEndClearanceMm, spacing: settings.minTapSpacingMm } : { end: 100, spacing: 150 };
}

/** A part as people name it: its mark, else what it is ("Ceiling diffuser", from the family name). */
export function partLabelOf(elements: Elements, part: PartInstance): string {
  if (part.mark) return part.mark;
  const type = elements[part.typeId];
  return type?.kind === "part_type" ? (type.definition.familyName.split(",")[0] ?? type.definition.familyName).trim() : part.id;
}

function systemOf(elements: Elements, el: RunSegment | RunFitting, issues: RunIssue[]): MepSystem | null {
  const level = elements[el.levelId];
  if (!level || level.kind !== "level") {
    issues.push({ code: "element_not_found", message: `${runLabel(elements, el)} is on level ${el.levelId}, which does not exist`, elementIds: [el.id] });
    return null;
  }
  const system = elements[el.systemId];
  if (!system || system.kind !== "mep_system") {
    issues.push({ code: "element_not_found", message: `${runLabel(elements, el)} belongs to system ${el.systemId}, which does not exist`, elementIds: [el.id] });
    return null;
  }
  if (system.domain !== el.domain) {
    issues.push({ code: "invalid_value", message: `${system.name} is a ${domainWord(system.domain)} system; a ${domainWord(el.domain)} can't belong to it`, elementIds: [el.id] });
    return null;
  }
  return system;
}

/** One link: the far side exists, points back, meets at the same point, and fits (size, system, kind of connector). */
function linkIssues(elements: Elements, el: BimElement, port: string, link: PortRef, tol: number, issues: RunIssue[]): void {
  // Across floors (a riser to a diffuser below): both sides' heights from this element's floor.
  const frame = heightFrameOf(el);
  const here = portInfoIn(elements, { elementId: el.id, port }, frame);
  const there = portInfoIn(elements, link, frame);
  const other = elements[link.elementId];
  const name = el.kind === "part" ? partLabelOf(elements, el) : el.kind === "run_segment" || el.kind === "run_fitting" ? runLabel(elements, el) : el.id;
  if (!here || !there || !other) {
    issues.push({ code: "disconnected", message: `${name} is connected to ${link.elementId}, which is no longer there`, elementIds: [el.id] });
    return;
  }
  if (there.link?.elementId !== el.id || there.link.port !== port) {
    issues.push({ code: "disconnected", message: `${name} and ${link.elementId} disagree about their connection`, elementIds: [el.id, other.id] });
    return;
  }
  const gap = dist3(here.position, there.position);
  if (gap > tol) {
    issues.push({ code: "disconnected", message: `${name} is ${gap.toFixed(0)} mm away from what it connects to`, elementIds: [el.id, other.id] });
    return;
  }
  if (el.kind === "run_segment" && !el.flex && foldsBack(el, port, other, link)) {
    issues.push({ code: "unsupported_geometry", message: `${name} doubles back on ${other.kind === "run_segment" || other.kind === "run_fitting" ? runLabel(elements, other) : other.id} where they join; the run would fold over itself`, elementIds: [el.id, other.id] });
    return;
  }
  // Size, system and connector kind are checked once, from the run side.
  if (el.kind !== "run_segment" && el.kind !== "run_fitting") return;
  const mine = here.size;
  if (!mine) return;
  if (other.kind === "part") {
    const type = elements[other.typeId];
    if (!type || type.kind !== "part_type") return;
    const conn = resolveConnectors(type.definition, other.values).find((c) => c.id === link.port);
    const system = elements[el.systemId];
    if (!conn || system?.kind !== "mep_system") return;
    const partName = partLabelOf(elements, other);
    if (conn.domain !== connectorDomainOf(el.domain)) {
      issues.push({ code: "profile_incompatible", message: `${partName}'s ${conn.label.toLowerCase()} takes ${conn.domain}, not ${domainWord(el.domain)}`, elementIds: [el.id, other.id] });
    } else if (conn.systemKind !== system.systemKind) {
      issues.push({ code: "profile_incompatible", message: `${partName}'s ${conn.label.toLowerCase()} is ${systemRules(conn.systemKind).label.toLowerCase()}; this run is ${system.name}`, elementIds: [el.id, other.id] });
    } else if (!connectorAccepts(conn, mine)) {
      issues.push({ code: "profile_incompatible", message: `${partName}'s ${conn.label.toLowerCase()} doesn't fit ${sizeLabel(mine)}; it needs a transition`, elementIds: [el.id, other.id] });
    }
    return;
  }
  if (other.kind === "run_segment" || other.kind === "run_fitting") {
    if (other.systemId !== el.systemId) {
      issues.push({ code: "profile_incompatible", message: `${runLabel(elements, el)} and ${runLabel(elements, other)} are on different systems`, elementIds: [el.id, other.id] });
      return;
    }
    if (there.size && !sameSize(mine, there.size)) {
      issues.push({ code: "profile_incompatible", message: `${runLabel(elements, el)} meets ${runLabel(elements, other)} with no transition`, elementIds: [el.id, other.id] });
    }
  }
}

/** Unit direction of a straight piece leaving its `port` end ("start" or "end"), or null for a piece with no length. */
function awayFrom(seg: RunSegment, port: string): { x: number; y: number; z: number } | null {
  const [from, to] = port === "start" ? [seg.start, seg.end] : [seg.end, seg.start];
  const d = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z };
  const len = Math.hypot(d.x, d.y, d.z);
  return len < 1e-6 ? null : { x: d.x / len, y: d.y / len, z: d.z / len };
}

/**
 * A straight piece turned back more than 90° on what it joins (a piece pulled
 * past its other end by a move): with another straight piece, both leave the
 * joint the same way; with a fitting, it runs back into the opening. Checked
 * once per pair (straight pieces from the lower id, fittings from the piece).
 */
function foldsBack(seg: RunSegment, port: string, other: BimElement, link: PortRef): boolean {
  const mine = awayFrom(seg, port);
  if (!mine) return false;
  if (other.kind === "run_segment") {
    if (other.flex || other.id < seg.id) return false;
    const theirs = awayFrom(other, link.port);
    return theirs !== null && mine.x * theirs.x + mine.y * theirs.y + mine.z * theirs.z > 1e-6;
  }
  if (other.kind === "run_fitting") {
    const opening = other.ports.find((p) => p.id === link.port)?.direction;
    return opening !== undefined && mine.x * opening.x + mine.y * opening.y + mine.z * opening.z < -1e-6;
  }
  return false;
}

function segmentIssues(elements: Elements, el: RunSegment, settings: ModelSettings, issues: RunIssue[]): void {
  const system = systemOf(elements, el, issues);
  if (!system) return;
  if (!sizeFitsDomain(el.size, el.domain)) {
    issues.push({ code: "invalid_value", message: `${sizeLabel(el.size)} is not a ${domainWord(el.domain)} size`, elementIds: [el.id] });
    return;
  }
  const d = { x: el.end.x - el.start.x, y: el.end.y - el.start.y, z: el.end.z - el.start.z };
  const flat = Math.abs(d.z) < 0.01;
  const plumb = Math.hypot(d.x, d.y) < 0.01;
  // A pipe turns, slopes and heads at the angles its elbows are made for (45° / 90° unless a family in force makes others).
  const pipeAngles = el.domain === "pipe" && el.size.shape === "pipe" ? pipeTurnAngles(system.systemKind, el.size) : undefined;
  const slopeAngles = runSlopeAngles(el.domain, system.systemKind, el.size);
  const sloped = !flat && !plumb && (Math.abs(Math.abs(d.z) - Math.hypot(d.x, d.y)) < 0.01 * Math.max(1, Math.hypot(d.x, d.y) / 1000) || isSlopeAt(d, slopeAngles));
  // Pipe may also be pitched a little off level (a drain at 1/4" per ft), up to the pitch limit.
  const pitched = el.domain === "pipe" && !flat && !plumb && isPitchedOrLevel(el);
  if (el.flex) {
    if (el.domain !== "duct" || el.size.shape !== "round") issues.push({ code: "invalid_value", message: `${runLabel(elements, el)} is flex, which is round duct`, elementIds: [el.id] });
    if (el.branches.length > 0) issues.push({ code: "unsupported_geometry", message: `Branches can't leave flex; ${runLabel(elements, el)} has some`, elementIds: [el.id, ...el.branches] });
  } else if (!(plumb || ((flat || sloped || pitched) && planHeadingOk(el.domain, d, pipeAngles)))) {
    const steps = pipeAngles ? planStepsFor(pipeAngles) : [45];
    const plan = el.domain === "duct" ? "level" : steps.length === 1 && steps[0] === 45 ? "level and square to the plan (or at 45°)" : `level and at a multiple of ${turnAnglesWords(steps)} in plan`;
    issues.push({ code: "unsupported_geometry", message: `${runLabel(elements, el)} isn't ${plan}, straight up and down, or at a ${turnAnglesWords(slopeAngles.length > 0 ? slopeAngles : [45])} slope; routing supports those only`, elementIds: [el.id] });
  }
  const len = segmentLength3(el);
  if (len < settings.minStraightMm) {
    issues.push({ code: "min_straight_length", message: `${runLabel(elements, el)} would be ${len.toFixed(0)} mm long, shorter than the ${settings.minStraightMm} mm minimum straight piece`, elementIds: [el.id] });
  }
  for (const [port, link] of [["start", el.links.start], ["end", el.links.end]] as const) if (link) linkIssues(elements, el, port, link, settings.connectorToleranceMm, issues);
  // Pipe: slope, and hosted tees / valves by their real lengths (a stack or a pitched drain hosts branches too).
  if (el.domain === "pipe") {
    pipeRoutingIssues(elements, el, settings, issues);
    for (const id of el.branches) {
      const b = elements[id];
      if (!b || b.kind !== "run_fitting" || b.host?.segmentId !== el.id) issues.push({ code: "disconnected", message: `${runLabel(elements, el)} lists a branch ${id} that isn't on it`, elementIds: [el.id] });
    }
    return;
  }
  if (el.branches.length === 0) return;
  // A round riser takes branches along its height, spaced as on a level run; one with flat sides doesn't yet.
  if (!flat && !(plumb && !hasSides(el.size))) {
    issues.push({ code: "unsupported_geometry", message: `Branches can only leave a level run or a round riser; ${runLabel(elements, el)} is ${plumb ? "a riser with flat sides" : "sloped"}`, elementIds: [el.id, ...el.branches] });
    return;
  }
  const clear = branchClearance(el.domain, settings);
  const placed: Array<{ id: ElementId; s: number }> = [];
  for (const id of el.branches) {
    const b = elements[id];
    if (!b || b.kind !== "run_fitting" || b.host?.segmentId !== el.id) {
      issues.push({ code: "disconnected", message: `${runLabel(elements, el)} lists a branch ${id} that isn't on it`, elementIds: [el.id] });
      continue;
    }
    if (b.host.s < clear.end || b.host.s > len - clear.end) {
      issues.push({ code: "outside_host", message: `${runLabel(elements, b)} would be within ${clear.end} mm of the end of ${runLabel(elements, el)}`, elementIds: [b.id, el.id] });
    }
    placed.push({ id: b.id, s: b.host.s });
  }
  placed.sort((a, b) => a.s - b.s);
  for (let i = 1; i < placed.length; i++) {
    const prev = placed[i - 1];
    const cur = placed[i];
    if (prev && cur && cur.s - prev.s < clear.spacing) {
      issues.push({ code: "tap_spacing", message: `Two branches would be closer than ${clear.spacing} mm on ${runLabel(elements, el)}`, elementIds: [prev.id, cur.id] });
    }
  }
}

function fittingIssues(elements: Elements, el: RunFitting, settings: ModelSettings, issues: RunIssue[]): void {
  const system = systemOf(elements, el, issues);
  if (!system) return;
  for (const p of el.ports) if (p.link) linkIssues(elements, el, p.id, p.link, settings.connectorToleranceMm, issues);
  const [a, b] = el.ports;
  if (el.family !== undefined) {
    const family = fittingFamily(el.family);
    if (!family) {
      // With no add-on for the domain here, the family is kept as stored and checked where its add-on is loaded.
      const owner = missingFittingFamilyOwnerWords(el.family, `${el.label} (${el.family}) is kept as stored and isn't checked`);
      const message = owner ?? (domainHasFamilies(el.domain) ? `${el.label} is a ${el.family}, which isn't in the fitting library` : null);
      if (message) issues.push({ code: "invalid_value", message, elementIds: [el.id] });
      return;
    }
    const host = el.host ? elements[el.host.segmentId] : undefined;
    const sizes = el.fittingType === "accessory" && host?.kind === "run_segment" ? [host.size] : el.ports.map((p) => p.size);
    const why = familyMismatch(family, { fittingType: el.fittingType, domain: el.domain, sizes, systemKind: system.systemKind, ...(el.angleDeg !== undefined ? { angleDeg: el.angleDeg } : {}), ...(host?.kind === "run_segment" ? { main: host.size } : {}) });
    if (why) issues.push({ code: "profile_incompatible", message: why, elementIds: [el.id] });
    const bad = paramIssue(family, el.params);
    if (bad) issues.push({ code: "invalid_value", message: `${family.name}: ${bad}`, elementIds: [el.id] });
  }
  if (el.domain === "pipe") pipeRoutingIssues(elements, el, settings, issues);
  switch (el.fittingType) {
    case "accessory":
      return;
    case "elbow": {
      if (!a || !b || el.ports.length !== 2) break;
      const turn = 180 - angleBetween(a.direction, b.direction);
      // Pipe fittings are pitched for the slope of the drain they join: allow the pitch limit on top.
      if (Math.abs(turn - (el.angleDeg ?? 90)) > (el.domain === "pipe" ? PIPE_TURN_TOLERANCE_DEG : 0.5)) {
        issues.push({ code: "unsupported_geometry", message: `${el.label} turns ${turn.toFixed(0)}° but is made for ${el.angleDeg ?? 90}°; swap or reroute it`, elementIds: [el.id] });
      }
      // An elbow out of a riser that turns the duct on its width leaves it on its side (24x12 reads 12x24).
      if (!sameSize(a.size, b.size) && !sameSize(onItsSide(a.size), b.size)) issues.push({ code: "profile_incompatible", message: `${el.label} changes size; that needs a transition`, elementIds: [el.id] });
      return;
    }
    case "transition": {
      if (!a || !b || el.ports.length !== 2) break;
      if (angleBetween(a.direction, b.direction) < 179.5) {
        issues.push({ code: "unsupported_geometry", message: `${el.label} has to be straight; turn with an elbow next to it`, elementIds: [el.id] });
      }
      if (sameSize(a.size, b.size)) issues.push({ code: "profile_incompatible", message: `${el.label} would join two runs of the same size; delete it instead`, elementIds: [el.id] });
      const why = transitionReason(a.size, b.size);
      if (why) issues.push({ code: "profile_incompatible", message: why, elementIds: [el.id] });
      return;
    }
    case "cap":
      if (el.ports.length !== 1) break;
      return;
    case "offset": {
      if (!a || !b || el.ports.length !== 2) break;
      if (angleBetween(a.direction, b.direction) < 179.5) issues.push({ code: "unsupported_geometry", message: `${el.label}'s ends have to stay parallel`, elementIds: [el.id] });
      if (!sameSize(a.size, b.size)) issues.push({ code: "profile_incompatible", message: `${el.label} changes size; that needs a transition`, elementIds: [el.id] });
      return;
    }
    case "tap":
    case "tee":
    case "wye": {
      const host = el.host ? elements[el.host.segmentId] : undefined;
      if (!el.host || !host || host.kind !== "run_segment" || !host.branches.includes(el.id) || el.ports.length !== 1 || !a) {
        issues.push({ code: "disconnected", message: `${el.label} isn't on a trunk`, elementIds: [el.id] });
        return;
      }
      const rules = systemRules(system.systemKind);
      const narrower = rules.branchMayEqualTrunk ? sizeWidth(a.size) <= sizeWidth(host.size) + 0.5 : sizeWidth(a.size) < sizeWidth(host.size) - 0.5;
      if (!narrower) {
        issues.push({
          code: "profile_incompatible",
          message: `A ${sizeLabel(a.size)} branch is ${rules.branchMayEqualTrunk ? "larger than" : "as wide as"} its ${sizeLabel(host.size)} trunk`,
          elementIds: [el.id, host.id],
        });
      }
      return;
    }
  }
  issues.push({ code: "invalid_value", message: `${el.label} has the wrong number of openings`, elementIds: [el.id] });
}

function partLinkIssues(elements: Elements, el: PartInstance, settings: ModelSettings, issues: RunIssue[]): void {
  const type = elements[el.typeId];
  if (!type || type.kind !== "part_type") return;
  for (const [connector, link] of Object.entries(el.links ?? {})) {
    if (!partConnector(el, type, connector)) {
      issues.push({ code: "disconnected", message: `${partLabelOf(elements, el)} has no connector ${connector} any more, but a run is connected to it`, elementIds: [el.id] });
      continue;
    }
    const target = elements[link.elementId];
    if (target?.kind === "load_point") {
      // Served end to end (join_parts): a load point has no position of its own, only the joint back.
      if (target.joinedTo?.elementId !== el.id || target.joinedTo.port !== connector) issues.push({ code: "disconnected", message: `${partLabelOf(elements, el)} and ${link.elementId} disagree about their connection`, elementIds: [el.id, target.id] });
      continue;
    }
    linkIssues(elements, el, connector, link, settings.connectorToleranceMm, issues);
  }
}

/** Checks for routed runs and the parts they connect to. Local: reads only the element and what it links to. */
export function routingIssues(elements: Elements, el: BimElement, settings: ModelSettings, issues: RunIssue[]): void {
  switch (el.kind) {
    case "run_segment":
      segmentIssues(elements, el, settings, issues);
      return;
    case "run_fitting":
      fittingIssues(elements, el, settings, issues);
      return;
    case "part":
      if (el.links) partLinkIssues(elements, el, settings, issues);
      return;
    default:
      return;
  }
}

/** Elements whose routing checks can change when `el` changes: what it links to, its host and its branches. */
export function routingNeighbours(el: BimElement | undefined): ElementId[] {
  if (!el) return [];
  const out: ElementId[] = [];
  if (el.kind === "run_segment") {
    if (el.links.start) out.push(el.links.start.elementId);
    if (el.links.end) out.push(el.links.end.elementId);
    out.push(...el.branches);
  } else if (el.kind === "run_fitting") {
    for (const p of el.ports) if (p.link) out.push(p.link.elementId);
    if (el.host) out.push(el.host.segmentId);
  } else if (el.kind === "part") {
    for (const link of Object.values(el.links ?? {})) out.push(link.elementId);
  } else if (el.kind === "load_point" && el.joinedTo) {
    out.push(el.joinedTo.elementId);
  }
  return out;
}
