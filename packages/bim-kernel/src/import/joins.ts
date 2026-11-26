import { resolveConnectors } from "../parts";
import { angleBetween, connectorAccepts, dist3, sub3, worldConnector, type WorldConnector } from "../routing/geometry";
import { connectorDomainOf, sameSize } from "../routing/rules";
import type { PortRef, RunDomain, RunFitting, RunPoint, RunSegment, RunSize } from "../routing/types";
import type { BimElement, ElementId, Level, PartInstance, PartTypeElement } from "../types";
import type { ImportJoin, ImportPoint, ImportPort, ImportProduct, ImportSource } from "./types";

/**
 * Joins between converted records (round 9 I9). A link is two records, each
 * naming the other, so no rule can write one alone: once every rule has run,
 * this pass makes each join the file states on both sides, or leaves both
 * sides open and says why in the report.
 *
 * - A fitting's rule links its openings to the straight pieces they join;
 *   those pieces get the link back here, and the run a branch fitting sits
 *   on lists it.
 * - Two straight pieces the file joins end to end are linked to each other
 *   when they run straight on at one size in one system.
 * - A run's end, or a fitting's opening, on a part is linked to the part's
 *   connector that sits there, and the part to it, when the connector takes
 *   that run (its kind, what it carries, its size), as the model checks.
 * - A join whose far side didn't come in, or has no connection point there,
 *   is counted, with the reason.
 *
 * Nothing is left half made: a link that can't be written on both sides is
 * taken off the side that had it. Reads each connection point once and keeps
 * one entry per join: O(connection points in the file).
 */

type End = "start" | "end";

export interface JoinRunsInput {
  readonly source: ImportSource;
  /** A record of the plan as it stands now (an earlier join may have replaced it). */
  record(id: ElementId): BimElement | undefined;
  /** Put a record with a link added or taken off in place of the one with its id. */
  replace(record: BimElement): void;
  /** The record a product became. */
  converted(sourceId: string): BimElement | null;
  joinedTo(port: ImportPort): readonly ImportJoin[];
  level(product: ImportProduct): Level | null;
  note(text: string): void;
  /** How near two ends must be to be joined, mm: the model's own limit for a connection, which landing checks. */
  readonly toleranceMm: number;
}

/** Two straight pieces joined end to end run straight on: within this of 180° apart. */
const STRAIGHT_DEG = 0.5;

const CROWDED = "the file joins more than one thing to that end of the run";
const NO_CONNECTOR = "one side is a part, and that connection point of it wasn't brought in";
const NO_POINT = "neither side came in as a run, and a join here has a run on one side";
const NOT_READ = "the fitting came in without that join";

function segmentOf(input: JoinRunsInput, id: ElementId): RunSegment | null {
  const r = input.record(id);
  return r?.kind === "run_segment" ? r : null;
}

function fittingOf(input: JoinRunsInput, id: ElementId): RunFitting | null {
  const r = input.record(id);
  return r?.kind === "run_fitting" ? r : null;
}

/** A straight piece's end with its height from the model's zero. */
function endPoint(seg: RunSegment, end: End, floorMm: number): RunPoint {
  const p = end === "start" ? seg.start : seg.end;
  return { x: p.x, y: p.y, z: p.z + floorMm };
}

/** The end of a straight piece nearest a point of the file. */
function nearestEnd(seg: RunSegment, floorMm: number, at: ImportPoint): End {
  return dist3(endPoint(seg, "start", floorMm), at) <= dist3(endPoint(seg, "end", floorMm), at) ? "start" : "end";
}

const pairKey = (a: string, b: string): string => (a < b ? `${a}~${b}` : `${b}~${a}`);

/** A part's connector with its height from the model's zero. */
function connectorFrom(part: PartInstance, connector: WorldConnector["connector"], floorMm: number): WorldConnector {
  const world = worldConnector(part, connector);
  return { ...world, position: { ...world.position, z: world.position.z + floorMm } };
}

/** The connector of a converted part that sits at a point of the file (heights from the model's zero): the nearest within `tolMm`. */
export function partConnectorAt(part: PartInstance, type: PartTypeElement, floorMm: number, at: ImportPoint, tolMm: number): WorldConnector | null {
  let best: WorldConnector | null = null;
  let gap = tolMm;
  for (const connector of resolveConnectors(type.definition, part.values)) {
    const world = connectorFrom(part, connector, floorMm);
    const d = dist3(world.position, at);
    if (d <= gap) [best, gap] = [world, d];
  }
  return best;
}

function floorOf(input: JoinRunsInput, levelId: ElementId): number {
  const level = input.record(levelId);
  return level?.kind === "level" ? level.elevationMm : 0;
}

/** What a run brings to a part's connector: where it ends (heights from the model's zero), its size, and what it is. */
interface RunSide {
  readonly at: RunPoint;
  readonly size: RunSize;
  readonly domain: RunDomain;
  readonly systemId: ElementId;
}

/**
 * Whether a part's connector takes a run's end or a fitting's opening, checked the way the model checks a link when
 * it lands. The part, or why they can't be joined.
 */
function partTakes(input: JoinRunsInput, partId: ElementId, connectorId: string, run: RunSide, from: PortRef): PartInstance | string {
  const part = input.record(partId);
  if (part?.kind !== "part") return NO_POINT;
  const type = input.record(part.typeId);
  const connector = type?.kind === "part_type" ? resolveConnectors(type.definition, part.values).find((c) => c.id === connectorId) : undefined;
  if (!connector) return NO_CONNECTOR;
  const have = part.links?.[connectorId];
  if (have && (have.elementId !== from.elementId || have.port !== from.port)) return "the file joins more than one thing to that connection point of the part";
  if (dist3(connectorFrom(part, connector, floorOf(input, part.levelId)).position, run.at) > input.toleranceMm) return "the run doesn't end at the part's connection point";
  if (connector.domain !== connectorDomainOf(run.domain)) return "the part's connection point there is for a different kind of run";
  const system = input.record(run.systemId);
  if (system?.kind !== "mep_system" || connector.systemKind !== system.systemKind) return "the part's connection point there carries something other than the run's system does";
  if (!connectorAccepts(connector, run.size)) return "the run is a different size from the part's connection point, with no fitting between them";
  return part;
}

function linkPart(input: JoinRunsInput, part: PartInstance, connectorId: string, to: PortRef): void {
  input.replace({ ...part, links: { ...(part.links ?? {}), [connectorId]: to } });
}

/**
 * Make a converted fitting's links mutual: each straight piece an opening names gets the link back, and the run a
 * branch fitting sits on lists it. An opening whose piece can't take the link is left open, with the reason kept for
 * the pair.
 */
function closeFittingLinks(input: JoinRunsInput, fittingId: ElementId, unmade: Map<string, string>): void {
  const fitting = fittingOf(input, fittingId);
  if (!fitting) return;
  let changed = false;
  const floor = floorOf(input, fitting.levelId);
  const ports = fitting.ports.map((port) => {
    if (!port.link) return port;
    const open = { id: port.id, position: port.position, direction: port.direction, size: port.size };
    if (input.record(port.link.elementId)?.kind === "part") {
      // An opening on a part: the part's connector there gets the link back, when it takes this opening.
      const own = { elementId: fitting.id, port: port.id };
      const at = { x: port.position.x, y: port.position.y, z: port.position.z + floor };
      const part = partTakes(input, port.link.elementId, port.link.port, { at, size: port.size, domain: fitting.domain, systemId: fitting.systemId }, own);
      if (typeof part !== "string") {
        linkPart(input, part, port.link.port, own);
        return port;
      }
      changed = true;
      unmade.set(pairKey(fitting.id, port.link.elementId), part);
      return open;
    }
    const seg = segmentOf(input, port.link.elementId);
    const end = port.link.port === "start" || port.link.port === "end" ? port.link.port : null;
    const back = seg && end ? seg.links[end] : undefined;
    if (seg && end && back?.elementId === fitting.id && back.port === port.id) return port;
    if (seg && end && !back) {
      input.replace({ ...seg, links: { ...seg.links, [end]: { elementId: fitting.id, port: port.id } } });
      return port;
    }
    changed = true;
    unmade.set(pairKey(fitting.id, port.link.elementId), seg ? CROWDED : NO_POINT);
    return open;
  });
  if (changed) input.replace({ ...fitting, ports });
  if (!fitting.host) return;
  const host = segmentOf(input, fitting.host.segmentId);
  if (host && !host.branches.includes(fitting.id)) input.replace({ ...host, branches: [...host.branches, fitting.id] });
}

/** Whether a fitting and another record are joined now: an opening linked to it, or the fitting sitting on it. */
function fittingOn(fitting: RunFitting, other: BimElement): boolean {
  return fitting.host?.segmentId === other.id || fitting.ports.some((p) => p.link?.elementId === other.id);
}

/** Link a straight piece's end to the part's connector the file joins it to, on both records, or say why not. */
function joinSegmentToPart(input: JoinRunsInput, segId: ElementId, segProduct: ImportProduct, at: ImportPoint | null, partId: ElementId, connectorId: string | null | undefined): string | null {
  const seg = segmentOf(input, segId);
  if (!seg) return NO_POINT;
  if (!connectorId) return NO_CONNECTOR;
  if (!at) return "the file doesn't say where they meet";
  const floor = input.level(segProduct)?.elevationMm ?? 0;
  const end = nearestEnd(seg, floor, at);
  if (seg.links[end]) return CROWDED;
  const own = { elementId: seg.id, port: end };
  const part = partTakes(input, partId, connectorId, { at: endPoint(seg, end, floor), size: seg.size, domain: seg.domain, systemId: seg.systemId }, own);
  if (typeof part === "string") return part;
  input.replace({ ...seg, links: { ...seg.links, [end]: { elementId: part.id, port: connectorId } } });
  linkPart(input, part, connectorId, own);
  return null;
}

/** Link two straight pieces at the ends the file joins, or say why not. */
function joinSegments(input: JoinRunsInput, aId: ElementId, aProduct: ImportProduct, aPort: ImportPort, bId: ElementId, far: ImportJoin): string | null {
  const a = segmentOf(input, aId);
  const b = segmentOf(input, bId);
  if (!a || !b) return NO_POINT;
  if (a.id === b.id) return "the file joins a run to itself";
  const aFloor = input.level(aProduct)?.elevationMm ?? 0;
  const bFloor = input.level(far.product)?.elevationMm ?? 0;
  const at = aPort.position ?? far.port.position;
  let aEnd: End;
  let bEnd: End;
  if (at) {
    aEnd = nearestEnd(a, aFloor, at);
    bEnd = nearestEnd(b, bFloor, far.port.position ?? at);
  } else {
    // The file doesn't say where: the two ends that are nearest each other.
    const ends: readonly End[] = ["start", "end"];
    let best = Infinity;
    aEnd = "start";
    bEnd = "start";
    for (const x of ends) {
      for (const y of ends) {
        const gap = dist3(endPoint(a, x, aFloor), endPoint(b, y, bFloor));
        if (gap < best) [best, aEnd, bEnd] = [gap, x, y];
      }
    }
  }
  if (dist3(endPoint(a, aEnd, aFloor), endPoint(b, bEnd, bFloor)) > input.toleranceMm) return "their ends don't meet where the file joins them";
  if (a.links[aEnd] || b.links[bEnd]) return "one of those ends is already joined to something else";
  if (a.systemId !== b.systemId) return "the file puts them in different systems";
  const away = (seg: RunSegment, end: End) => (end === "start" ? sub3(seg.end, seg.start) : sub3(seg.start, seg.end));
  if (180 - angleBetween(away(a, aEnd), away(b, bEnd)) > STRAIGHT_DEG) return "the file joins them where they turn, with no fitting between them";
  if (!sameSize(a.size, b.size)) return "the file joins them where they change size, with no fitting between them";
  input.replace({ ...a, links: { ...a.links, [aEnd]: { elementId: b.id, port: bEnd } } });
  input.replace({ ...b, links: { ...b.links, [bEnd]: { elementId: a.id, port: aEnd } } });
  return null;
}

export function joinRuns(input: JoinRunsInput): void {
  // What converted and has connection points the file joins to something: everything else is passed over once.
  const joined: Array<{ readonly product: ImportProduct; readonly id: ElementId }> = [];
  const fittings: ElementId[] = [];
  for (const product of input.source.products) {
    if (product.ports.length === 0) continue;
    const record = input.converted(product.sourceId);
    if (!record) continue;
    if (record.kind === "run_fitting") fittings.push(record.id);
    if (product.ports.some((port) => port.connectedTo.length > 0)) joined.push({ product, id: record.id });
  }
  if (joined.length === 0 && fittings.length === 0) return;

  // Why a fitting's link was taken off again, by the pair of records.
  const stripped = new Map<string, string>();
  for (const id of fittings) closeFittingLinks(input, id, stripped);

  // Every join the file states with at least one side converted, each once.
  let stayed = 0;
  const unmade = new Map<string, number>();
  const count = (why: string) => unmade.set(why, (unmade.get(why) ?? 0) + 1);
  const seen = new Set<string>();
  for (const { product, id } of joined) {
    for (const port of product.ports) {
      if (port.connectedTo.length === 0) continue;
      const far = input.joinedTo(port);
      // A point on a product the reader left out.
      stayed += port.connectedTo.length - far.length;
      for (const other of far) {
        const key = pairKey(port.id, other.port.id);
        if (seen.has(key)) continue;
        seen.add(key);
        const here = input.record(id);
        const there = input.converted(other.product.sourceId);
        if (!here) continue;
        if (!there) {
          stayed += 1;
          continue;
        }
        if (here.kind === "run_segment" && there.kind === "run_segment") {
          const why = joinSegments(input, here.id, product, port, there.id, other);
          if (why) count(why);
        } else if (here.kind === "run_fitting" || there.kind === "run_fitting") {
          // A fitting's own rule read this join; its links were made mutual above.
          const made = (here.kind === "run_fitting" && fittingOn(here, there)) || (there.kind === "run_fitting" && fittingOn(there, here));
          if (!made) count(stripped.get(pairKey(here.id, there.id)) ?? NOT_READ);
        } else if (here.kind === "run_segment" && there.kind === "part") {
          const why = joinSegmentToPart(input, here.id, product, port.position ?? other.port.position, there.id, other.connector);
          if (why) count(why);
        } else if (here.kind === "part" && there.kind === "run_segment") {
          // Seen from the part: which of its connectors this point is comes from the run's side of the join.
          const mine = input.joinedTo(other.port).find((j) => j.port.id === port.id);
          const why = joinSegmentToPart(input, there.id, other.product, other.port.position ?? port.position, here.id, mine?.connector);
          if (why) count(why);
        } else count(NO_POINT);
      }
    }
  }
  const lead = (n: number) => (n === 1 ? "1 join in the file wasn't made" : `${n} joins in the file weren't made`);
  for (const [why, n] of unmade) input.note(`${lead(n)} (${why}); the ends there are open, so join them by hand`);
  if (stayed > 0) input.note(`${lead(stayed)} (one side stayed on the linked model); the end that came in is open there`);
}
