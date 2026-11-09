import { z } from "zod";
import { finish, refuse, type AuthoredWrite, type ExecuteResult, type IntentPredicate } from "../command-core";
import { TrackedReader, requireKind } from "../model";
import { systemKindSchema, type SystemKind } from "../parts";
import { DISCIPLINES_REGISTRY_FEATURE } from "../disciplines/types";
import { GLOBAL_PARTITION, PARTITION_DISCIPLINES_FEATURE, storedDiscipline } from "../partition";
import { peerReads } from "../elements/feature";
import { ROUTING_TAP_FACES_FEATURE, ROUTING_TAP_OFFSET_FEATURE } from "../connections/connector-faces";
import { activeServiceRegistry, serviceById } from "../services/registry";
import { draftElements, elementsOfKind } from "../store";
import { asElementId, type BimElement, type ElementId, type Level, type ModelState, type Partition, type Vec2 } from "../types";
import {
  angleBetween,
  connectorAccepts,
  connectorSize,
  dir3,
  dot3,
  hostHalfWidth,
  hostedPoints,
  isVertical,
  len3,
  p3,
  partConnector,
  portInfo,
  round3,
  segmentAxis,
  sub3,
  withLink,
} from "./geometry";
import { elbowTakeoffMm, portWidthAxis, straightPiece, takeoffDepth } from "./fittings/geometry";
import { resolveFitting } from "./fittings/library";
import { hasSides, onItsSide, planDuctFrames } from "./orientation";
import { RunPropagator, linkAt } from "./propagate";
import { systemRules, connectorDomainOf, domainWord, fittingLabel, sameSize, sizeFitsDomain, sizeLabel, transitionReason } from "./rules";
import { PIPE_TURN_TOLERANCE_DEG, partLabelOf, runLabel } from "./validate";
import { pitchNodes } from "./pipe/commands";
import { inPerFtLabel, isGravity, minSlopeFor } from "./pipe/design";
import { branchOrientation, isPitchedOrLevel, turnOrientation } from "./pipe/gravity";
import { FITTING_SLOTS, RUN_DOMAINS, runSizeSchema, type MepSystem, type PortRef, type RunFitting, type RunPoint, type RunPort, type RunSegment, type RunSize } from "./types";
import { runInsulationSchema, insulationIssue, type RunInsulation } from "./run-insulation";
import { withRouteHeight } from "./route-height";
import { systemKindLabel } from "./system-label";
import { refitTouched } from "./fitting-follow";
import { joinParts, joinPartsCommandSchema } from "./join-parts";
import { chooseFitting } from "./follow-core";
import { branchLabelOnFace } from "../registry/fitting-family-point";
import { ductLegPlanIssue, elbowTurnFor } from "./route-angles";
import { isSlopeAt, pipeTurnAngles, runSlopeAngles, turnAnglesWords } from "./pipe/turn-angles";
import { floorForPiece, floorsBetween, frameShiftMm, heightFrameOf, leavesStorey, levelsByHeight, partitionOnFloor, portInfoIn } from "./levels-across";

export { chooseFitting };

const idSchema = z.string().min(1).max(200);
const vec2Schema = z.object({ x: z.number().finite(), y: z.number().finite() });
const portRefSchema = z.object({ elementId: idSchema, port: z.string().min(1).max(40) });

/** Where a route starts or ends: a part's connector, an open end of a run, or the side of a trunk (a new branch). */
export const routeEndpointSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("part"), partId: idSchema, connectorId: z.string().min(1).max(40) }),
  z.object({ kind: z.literal("run_end"), elementId: idSchema, port: z.string().min(1).max(40) }),
  /** The route's first (or last) point is on this trunk's centreline; a tap, tee or wye is placed there. `face` top / bottom: it leaves a level trunk straight up or down. */
  z.object({
    kind: z.literal("run_branch"),
    segmentId: idSchema,
    face: z.enum(["top", "bottom"]).optional(),
    /** With `face`: mm across the face from its centre line (feature `routing:tap_offset`). Absent or 0: on the centre line. */
    t: z.number().finite().min(-2000).max(2000).optional(),
  }),
]);
export type RouteEndpoint = z.infer<typeof routeEndpointSchema>;

export const routingCommandSchemas = [
  z.object({
    type: z.literal("route_run"),
    /** New element ids are this prefix plus -s1, -s2… (segments) and -f1, -f2… (fittings): a retried request routes the same run. */
    idPrefix: z.string().min(1).max(80),
    levelId: idSchema,
    zone: z.string().min(1).max(40).optional(),
    domain: z.enum(RUN_DOMAINS),
    size: runSizeSchema,
    /** Centreline height above the level floor, mm. Absent: the height of what the route starts (else finishes) on — the trunk a branch leaves, the open end or connector it continues. */
    elevationMm: z.number().finite().min(-30_000).max(30_000).optional(),
    /** The run's system. Created (with this kind and name) when the model doesn't have it yet. */
    /** `kind`: any registry-shaped system kind; a kind new to the model must be a row of the service registry in force (services/write-gate.ts), so a pack's (`civil.storm`) routes too. */
    system: z.object({ id: idSchema, kind: systemKindSchema, name: z.string().trim().min(1).max(80).optional() }),
    /**
     * Plan points in order. The connector at either end supplies its own point when it is a part or a run end.
     * A point with `elevationMm` changes the run's height there (a rise or drop), as `riseStyle` says.
     */
    points: z.array(vec2Schema.extend({ elevationMm: z.number().finite().min(-30_000).max(30_000).optional() })).max(200),
    /** How a height change along the run is made: straight up or down (two 90° elbows) or a slope at 45°, 60° or 22½° (two elbows of that angle; pipe only at angles its elbows are made for). */
    riseStyle: z.enum(["vertical", "45", "60", "22.5"]).optional(),
    from: routeEndpointSchema.optional(),
    to: routeEndpointSchema.optional(),
    /** Starting on a straight piece's open end, a first leg that turns gets its elbow right on that end (no straight piece first), when the piece has room for it. Absent: the run has to leave the end straight out. */
    turnAtStart: z.boolean().optional(),
    /** Close a free end with a cap. */
    capEnd: z.boolean().optional(),
    /** Fittings this route places, per slot, over the system's defaults (the elbow or takeoff chosen while drawing). */
    fittings: z.partialRecord(z.enum(FITTING_SLOTS), z.object({ family: z.string().min(1).max(80), params: z.record(z.string().min(1).max(40), z.union([z.number().finite(), z.string().max(40)])).optional() })).optional(),
    /** Gravity drains: inches of fall per foot on level legs. Absent: the system's minimum for the size. */
    slopeInPerFt: z.number().finite().min(0).max(1).optional(),
    /** Gravity drains: which way the water runs. Absent: into the trunk for a branch, else from the first point to the last. */
    flow: z.enum(["with_points", "against_points"]).optional(),
    /** Duct: wrap or liner on every piece routed; null for bare duct. Absent: the system's default (a new system's choice becomes its default). */
    insulation: runInsulationSchema.nullable().optional(),
  }),
  z.object({ type: z.literal("connect_runs"), a: portRefSchema, b: portRefSchema }),
  z.object({ type: z.literal("disconnect_run"), elementId: idSchema, port: z.string().min(1).max(40) }),
  joinPartsCommandSchema,
] as const;

export const routingCommandSchema = z.discriminatedUnion("type", [...routingCommandSchemas]);
export type RoutingCommand = z.infer<typeof routingCommandSchema>;
/** A route with its height resolved (given, or inherited from where it starts). */
type RouteRun = Extract<RoutingCommand, { type: "route_run" }> & { readonly elevationMm: number };

const MM_PER_FT = 304.8;
const NO_INTENTS = (): IntentPredicate[] => [];

function feet(mm: number): string {
  return `${(Math.round((mm / MM_PER_FT) * 100) / 100).toString()} ft`;
}

interface Anchor {
  readonly kind: RouteEndpoint["kind"];
  /** The port the run links to (null for a new branch, created with the run). */
  readonly ref: PortRef | null;
  readonly position: RunPoint;
  /** Direction from the anchor into the run. */
  readonly outward: RunPoint;
  /** Null: the connector takes any size (e.g. an electrical box). */
  readonly size: RunSize | null;
  readonly label: string;
  readonly zone?: string;
  readonly branch?: { readonly host: RunSegment; readonly s: number; readonly side: 1 | -1; readonly dir?: { readonly x: number; readonly y: number }; readonly face?: "top" | "bottom"; readonly t?: number };
}

/** The stored discipline of a run of `kind`: the routing rules' (one of the six), or a pack or firm row's own class discipline (civil) when the peers read it. Built-in rows keep the six. */
function discipline(kind: SystemKind): Partition["discipline"] {
  const fallback = systemRules(kind).discipline;
  // A bare id is a built-in kind (the kernel's or a first-party add-on's row): it keeps the six.
  if (!/[.:]/.test(kind)) return fallback;
  const readsExtra = peerReads(PARTITION_DISCIPLINES_FEATURE);
  // The registry feature implies the class-discipline one: a peer missing the older is treated as missing both.
  return storedDiscipline(serviceById(kind, activeServiceRegistry())?.discipline, fallback, readsExtra, readsExtra && peerReads(DISCIPLINES_REGISTRY_FEATURE));
}

class RouteBuilder {
  readonly reader: TrackedReader;
  readonly working: Record<string, BimElement>;
  readonly touched: ElementId[] = [];
  private readonly tol: number;

  constructor(
    readonly model: ModelState,
    readonly cmd: RouteRun,
  ) {
    this.reader = new TrackedReader(model);
    this.working = draftElements(model.elements);
    this.tol = model.settings.connectorToleranceMm;
  }

  put(el: BimElement): void {
    this.working[el.id] = el;
    if (!this.touched.includes(el.id)) this.touched.push(el.id);
  }

  /** Levels whose connectors this route meets other than its own: a route across floors. */
  readonly otherLevels = new Set<ElementId>();

  /** A connector on `ownLevelId` with its height measured from the route's level instead. */
  inFrame<T extends { readonly position: RunPoint }>(at: T | null, ownLevelId: ElementId, level: Level): T | null {
    if (!at || ownLevelId === level.id) return at;
    this.otherLevels.add(ownLevelId);
    const shift = frameShiftMm(this.working, ownLevelId, level.id);
    return { ...at, position: round3({ ...at.position, z: at.position.z + shift }) };
  }

  system(): MepSystem {
    const { system, domain } = this.cmd;
    const rules = systemRules(system.kind);
    if (rules.domain !== domain) refuse("invalid_value", `${rules.label} is carried in ${domainWord(rules.domain)}, not ${domainWord(domain)}`);
    const id = asElementId(system.id);
    const existing = this.reader.find(id);
    if (existing) {
      const s = requireKind(existing, "mep_system");
      if (s.systemKind !== system.kind) refuse("invalid_value", `${s.name} is ${systemKindLabel(s).toLowerCase()}, not ${rules.label.toLowerCase()}`, [id]);
      return s;
    }
    const inherited = domain === "duct" ? inheritedDuctDesign(this.model, { systemKind: system.kind }) : {};
    // A new system's first route sets its default insulation; otherwise it starts like its siblings.
    const insulation = this.cmd.insulation === undefined ? inherited.insulation : (this.cmd.insulation ?? undefined);
    const seeded = { ...(insulation ? { insulation } : {}), ...(inherited.sizing ? { sizing: inherited.sizing } : {}) };
    const created: MepSystem = {
      id,
      kind: "mep_system",
      version: 0,
      authoredRev: {},
      partition: GLOBAL_PARTITION,
      name: system.name ?? `${rules.label} ${system.id.slice(-4)}`,
      systemKind: system.kind,
      domain,
      entryId: asElementId(`${this.cmd.idPrefix}-s1`),
      ...(Object.keys(seeded).length > 0 ? { design: seeded } : {}),
    };
    this.put(created);
    return created;
  }

  /** `towards`: where the route goes from (or comes into) this end when no plan point says so (the other end's connector). */
  anchor(ep: RouteEndpoint, level: Level, system: MepSystem, which: "start" | "end", towards: Vec2 | null = null): Anchor {
    const size = this.cmd.size;
    switch (ep.kind) {
      case "part": {
        const part = requireKind(this.reader.get(asElementId(ep.partId)), "part");
        const name = partLabelOf(this.working, part);
        const type = requireKind(this.reader.get(part.typeId), "part_type");
        const w = this.inFrame(partConnector(part, type, ep.connectorId), part.levelId, level);
        if (!w) refuse("element_not_found", `${name} has no connector ${ep.connectorId}`, [part.id]);
        const conn = w.connector;
        const cname = `${name}'s ${conn.label.toLowerCase()}`;
        if (part.links?.[ep.connectorId]) refuse("already_exists", `${cname} is already connected`, [part.id]);
        if (conn.domain !== connectorDomainOf(this.cmd.domain)) refuse("profile_incompatible", `${cname} takes ${conn.domain}, not ${domainWord(this.cmd.domain)}`, [part.id]);
        if (conn.systemKind !== system.systemKind) {
          refuse("profile_incompatible", `${cname} is ${systemRules(conn.systemKind).label.toLowerCase()}; this run is ${system.name}`, [part.id]);
        }
        const own = connectorAccepts(conn, size) ? null : connectorSize(conn, size);
        return { kind: "part", ref: { elementId: part.id, port: ep.connectorId }, position: w.position, outward: w.direction, size: own, label: cname, ...(part.partition ? { zone: part.partition.zone } : {}) };
      }
      case "run_end": {
        const el = this.reader.get(asElementId(ep.elementId));
        if (el.kind !== "run_segment" && el.kind !== "run_fitting") refuse("wrong_kind", `${ep.elementId} isn't a duct or pipe run`, [el.id]);
        const name = runLabel(this.working, el);
        if (el.systemId !== system.id) {
          const other = this.working[el.systemId];
          refuse("profile_incompatible", `${name} is on ${other?.kind === "mep_system" ? other.name : "another system"}; continue it on that system`, [el.id]);
        }
        const info = this.inFrame(portInfo(this.working, { elementId: el.id, port: ep.port }), el.levelId, level);
        if (!info) refuse("element_not_found", `${name} has no end called ${ep.port}`, [el.id]);
        if (info.link) refuse("already_exists", `That end of ${name} is already connected`, [el.id]);
        return { kind: "run_end", ref: { elementId: el.id, port: ep.port }, position: info.position, outward: info.direction, size: info.size && sameSize(info.size, size) ? null : info.size, label: `the end of ${name}`, ...(el.partition ? { zone: el.partition.zone } : {}) };
      }
      case "run_branch": {
        const host = requireKind(this.reader.get(asElementId(ep.segmentId)), "run_segment");
        const name = runLabel(this.working, host);
        if (host.levelId !== level.id) {
          const own = this.working[host.levelId];
          refuse("invalid_value", `${name} is on ${own?.kind === "level" ? own.name : "another level"}; a branch leaves its trunk on the trunk's level, so route the branch on that level (it may still drop to a connector on this one)`, [host.id]);
        }
        if (host.systemId !== system.id) {
          const other = this.working[host.systemId];
          refuse("profile_incompatible", `${name} is on ${other?.kind === "mep_system" ? other.name : "another system"}; branch it on that system`, [host.id]);
        }
        const pts = this.cmd.points;
        const onTrunk = which === "start" ? pts[0] : pts[pts.length - 1];
        const next = (which === "start" ? pts[1] : pts[pts.length - 2]) ?? towards ?? undefined;
        if (!onTrunk || !next) refuse("invalid_value", "A branch needs a point on the trunk and at least one point beyond it");
        const axis = segmentAxis(host);
        const planAxis = Math.hypot(axis.x, axis.y);
        // Branches also leave stacks and risers (level, in any plan direction) and sloped drains. A riser with flat sides would need its faces' turn, which this doesn't work out yet.
        if (planAxis < 1e-6) {
          if (hasSides(host.size)) refuse("unsupported_geometry", `A branch leaves a ${sizeLabel(host.size)} riser only from a level stretch for now; tap ${name} where it runs level, or make the riser round`, [host.id]);
          if (Math.hypot(onTrunk.x - host.start.x, onTrunk.y - host.start.y) > this.tol) refuse("unsupported_geometry", `A branch off ${name} starts on its centreline (${Math.round(host.start.x)}, ${Math.round(host.start.y)})`, [host.id]);
          const out = { x: next.x - onTrunk.x, y: next.y - onTrunk.y };
          const outLen = Math.hypot(out.x, out.y);
          if (outLen < this.tol) refuse("unsupported_geometry", `The branch has to leave ${name} level, towards its next point`, [host.id]);
          const dir = { x: Math.round((out.x / outLen) * 1e6) / 1e6, y: Math.round((out.y / outLen) * 1e6) / 1e6 };
          const s = Math.round((this.cmd.elevationMm - host.start.z) * Math.sign(axis.z) * 1000) / 1000;
          const at = hostedPoints(host, s, 1, dir);
          return { kind: "run_branch", ref: null, position: at.branch, outward: at.outward, size: null, label: name, branch: { host, s, side: 1, dir }, ...(host.partition ? { zone: host.partition.zone } : {}) };
        }
        const pitched = host.domain === "pipe" && isPitchedOrLevel(host);
        if (Math.abs(host.start.z - host.end.z) > this.tol && !pitched) refuse("unsupported_geometry", `Branches leave level runs only; ${name} is vertical`, [host.id]);
        const s = Math.round((((onTrunk.x - host.start.x) * axis.x + (onTrunk.y - host.start.y) * axis.y) / (planAxis * planAxis)) * 1000) / 1000;
        if (ep.face) {
          const word = ep.face === "top" ? "top" : "bottom";
          if (!peerReads(ROUTING_TAP_FACES_FEATURE)) refuse("unsupported_geometry", `A branch can't leave the ${word} of ${name} yet: the model server this model is open on is an older version that only takes branches from a run's sides. Tap its side, or try again once the server is updated`, [host.id]);
          // A pitched pipe (a drain at 1/4" per ft) takes a branch on its top too: a stack dropping into a building drain.
          if (Math.abs(host.start.z - host.end.z) > this.tol && !pitched) refuse("unsupported_geometry", `A branch leaves the ${word} of a level run only; ${name} slopes`, [host.id]);
          const t = ep.t ?? 0;
          if (t !== 0) {
            if (!peerReads(ROUTING_TAP_OFFSET_FEATURE)) refuse("unsupported_geometry", `A branch off the ${word} of ${name} can't sit off its centre line yet: the model server this model is open on is an older version. Line it up over the run, or try again once the server is updated`, [host.id]);
            if (Math.abs(t) > hostHalfWidth(host.size)) refuse("unsupported_geometry", `A branch on the ${word} of ${name} starts on that face: keep it within the run's width`, [host.id]);
          }
          // Across the face, on the plan's left of travel: +t on the top, −t on the bottom (`hostedPoints`).
          const across = (onTrunk.x - host.start.x) * -axis.y + (onTrunk.y - host.start.y) * axis.x;
          const wantAcross = ep.face === "top" ? t : -t;
          if (s < 0 || s > Math.hypot(host.end.x - host.start.x, host.end.y - host.start.y) || Math.abs(across / planAxis - wantAcross) > this.tol) {
            refuse("unsupported_geometry", t === 0 ? `A branch on the ${word} of ${name} starts over its centreline; line the branch up over the run` : `A branch on the ${word} of ${name} starts where its offset puts it; line the branch up over that point`, [host.id]);
          }
          const at = hostedPoints(host, s, 1, undefined, ep.face, t);
          return { kind: "run_branch", ref: null, position: at.branch, outward: at.outward, size: null, label: name, branch: { host, s, side: 1, face: ep.face, ...(t !== 0 ? { t } : {}) }, ...(host.partition ? { zone: host.partition.zone } : {}) };
        }
        const zAt = host.start.z + s * axis.z;
        // A sloped drain's branch is re-pitched from the trunk; within a foot of its height is close enough to start from.
        if (Math.abs(zAt - heightAt(this.cmd, which)) > (pitched ? MM_PER_FT : this.tol)) {
          refuse("unsupported_geometry", `A branch leaves ${name} sideways at its height (${feet(zAt)}); route the branch at that height`, [host.id]);
        }
        const left = { x: -axis.y, y: axis.x };
        const along = (next.x - onTrunk.x) * left.x + (next.y - onTrunk.y) * left.y;
        if (Math.abs(along) < this.tol) refuse("unsupported_geometry", `The branch has to leave ${name} from its side`, [host.id]);
        const side: 1 | -1 = along > 0 ? 1 : -1;
        const at = hostedPoints(host, s, side);
        return { kind: "run_branch", ref: null, position: at.branch, outward: at.outward, size: null, label: name, branch: { host, s, side }, ...(host.partition ? { zone: host.partition.zone } : {}) };
      }
    }
  }
}

/** The route's height where it meets an end: where it starts, or after its last rise or drop. */
function heightAt(cmd: RouteRun, which: "start" | "end"): number {
  if (which === "start") return cmd.elevationMm;
  return [...cmd.points].reverse().find((p) => p.elevationMm !== undefined)?.elevationMm ?? cmd.elevationMm;
}

/**
 * How far a run has to sit below (or above) a down- (up-) facing connector to
 * turn level: the system's 90° elbow plus the shortest straight piece.
 */
function turnDepthMm(system: MepSystem, size: RunSize, domain: RouteRun["domain"], minStraightMm: number): number {
  const choice = chooseFitting(system, "elbow", domain, [size], 90, undefined);
  const rf = resolveFitting(null, { fittingType: "elbow", ports: [], domain, angleDeg: 90, ...choice.fields });
  return (rf ? elbowTakeoffMm(rf, sizeWidthOf(size), 90) : sizeWidthOf(size)) + minStraightMm;
}

/** Nodes of the route in 3D, anchors included, before fittings are chosen. */
function routeNodes(b: RouteBuilder, start: Anchor | null, end: Anchor | null, turnDepth: (a: Anchor) => number, slopeAngles: readonly number[] = [45]): RunPoint[] {
  const { cmd } = b;
  const tol = b.model.settings.connectorToleranceMm;
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  // A height within the connector tolerance of a side-facing connector is that connector's height (not a 0.05 mm slope).
  const snapTo = (a: Anchor | null, h: number): number => (a && a.kind !== "run_branch" && !isVertical(a.outward) && Math.abs(a.position.z - h) <= tol ? a.position.z : h);
  let plan: Array<Vec2 & { elevationMm?: number }> = cmd.points.map((p) => ({ x: r3(p.x), y: r3(p.y), ...(p.elevationMm !== undefined ? { elevationMm: r3(p.elevationMm) } : {}) }));
  const lastRise = [...plan].reverse().find((p) => p.elevationMm !== undefined);
  if (lastRise?.elevationMm !== undefined) lastRise.elevationMm = snapTo(end, lastRise.elevationMm);
  const given = r3(cmd.elevationMm);
  const fromStart = snapTo(start, given);
  // With no rise along the way, the run is one height end to end: either connector can set it.
  const elev = fromStart !== given || lastRise ? fromStart : snapTo(end, given);
  const finalElev = lastRise?.elevationMm ?? elev;
  const nodes: RunPoint[] = [];
  const samePlan = (a: Vec2, q: RunPoint) => Math.hypot(a.x - q.x, a.y - q.y) <= tol;

  const enter = (a: Anchor, elev: number): RunPoint[] => {
    if (a.kind === "run_branch") return [a.position];
    const P = a.position;
    if (isVertical(a.outward)) {
      if (Math.abs(P.z - elev) <= tol || Math.sign(elev - P.z) !== Math.sign(a.outward.z)) {
        const down = a.outward.z < 0;
        const depth = turnDepth(a);
        refuse("unsupported_geometry", `${a.label} faces ${down ? "down, so the run has to be below it" : "up, so the run has to be above it"} (it is at ${feet(P.z)}) by about ${feet(depth)} or more for a 90° elbow plus the shortest straight piece: at ${feet(P.z + Math.sign(a.outward.z) * depth)} or ${down ? "lower" : "higher"}`);
      }
      return [P, round3(p3(P.x, P.y, elev))];
    }
    if (Math.abs(P.z - elev) > tol) refuse("unsupported_geometry", `${a.label} is at ${feet(P.z)} (${Math.round(P.z * 100) / 100} mm); route at that height to meet it, or leave out elevation_ft and the route takes the connector's height`);
    return [P];
  };

  if (start) {
    nodes.push(...enter(start, elev));
    if (start.kind === "run_branch") plan = plan.slice(1);
    const first = nodes[nodes.length - 1];
    if (first && plan[0] && plan[0].elevationMm === undefined && samePlan(plan[0], first)) plan = plan.slice(1);
  }
  let tail: RunPoint[] = [];
  if (end) {
    tail = enter(end, finalElev).reverse();
    if (end.kind === "run_branch") plan = plan.slice(0, -1);
    const meet = tail[0];
    const last = plan[plan.length - 1];
    if (meet && last && last.elevationMm === undefined && samePlan(last, meet)) plan = plan.slice(0, -1);
  }
  // Height changes along the run: straight up / down at the point, or a slope (45°, 60°, 22½°) towards the next point.
  const style = cmd.riseStyle ?? "vertical";
  const slopeDeg = style === "vertical" ? 90 : Number(style);
  if (style !== "vertical" && !slopeAngles.some((a) => Math.abs(a - slopeDeg) < 0.01) && plan.some((p) => p.elevationMm !== undefined)) {
    refuse("unsupported_geometry", `This run's elbows don't turn ${turnAnglesWords([slopeDeg])}, so it can't rise or drop on a ${turnAnglesWords([slopeDeg])} slope; it slopes at ${turnAnglesWords(slopeAngles)}, or rises straight up`);
  }
  const perPlan = 1 / Math.tan((slopeDeg * Math.PI) / 180);
  let cur = elev;
  plan.forEach((p, i) => {
    nodes.push(p3(p.x, p.y, cur));
    const to = p.elevationMm;
    if (to === undefined || Math.abs(to - cur) <= tol) return;
    if (style === "vertical") {
      nodes.push(p3(p.x, p.y, to));
    } else {
      const next = plan[i + 1] ?? tail[0];
      const run = next ? Math.hypot(next.x - p.x, next.y - p.y) : 0;
      const dz = Math.abs(to - cur);
      const reach = Math.round(dz * perPlan * 1000) / 1000;
      const word = turnAnglesWords([slopeDeg]);
      if (!next || run < tol) refuse("unsupported_geometry", `A ${word} ${to > cur ? "rise" : "drop"} at point ${i + 1} needs a point after it to slope towards`);
      if (run < reach - tol) refuse("min_straight_length", `A ${word} ${to > cur ? "rise" : "drop"} of ${feet(dz)} at point ${i + 1} needs ${feet(reach)} of run before the next point; there is ${feet(run)}`);
      nodes.push(round3(p3(p.x + ((next.x - p.x) / run) * reach, p.y + ((next.y - p.y) / run) * reach, to)));
    }
    cur = to;
  });
  nodes.push(...tail);

  const out: RunPoint[] = [];
  for (const n of nodes) {
    const prev = out[out.length - 1];
    if (prev && len3(sub3(n, prev)) <= tol) continue;
    out.push(n);
  }
  return out;
}

/** A leg climbing 1:1 (45°) in a vertical plane. */
export function isSlope45(v: RunPoint): boolean {
  const plan = Math.hypot(v.x, v.y);
  return plan > 0.01 && Math.abs(Math.abs(v.z) - plan) < 0.01 * Math.max(1, plan / 1000);
}

function legIssue(i: number, v: RunPoint, minStraight: number, pipe = false, pipeAngles?: readonly number[], riseSlopes?: readonly number[]): string | null {
  // Pipe may be pitched off level up to 1" per ft (a sloped drain).
  const flat = Math.abs(v.z) < 0.01 || (pipe && Math.abs(v.z) <= Math.hypot(v.x, v.y) / 12 + 0.01);
  const plumb = Math.hypot(v.x, v.y) < 0.01;
  const slopes = riseSlopes ?? (pipe && pipeAngles ? pipeAngles.filter((a) => a < 90) : [45]);
  if (!flat && !plumb && !isSlope45(v) && !isSlopeAt(v, slopes)) {
    const at = `at a ${turnAnglesWords(slopes.length > 0 ? slopes : [45])} slope`;
    if (Math.abs(v.z) < 25.4) return `Leg ${i + 1} is ${Math.abs(v.z).toFixed(2)} mm off level, so it reads as a slope; legs run level, straight up and down, or ${at}. Meeting a connector, leave out elevation_ft and the route takes the connector's height`;
    return `Leg ${i + 1} climbs at an angle; legs run level, straight up and down, or ${at}`;
  }
  if (!plumb) {
    const planWhy = ductLegPlanIssue(i, v, pipe, pipeAngles);
    if (planWhy) return planWhy;
  }
  const length = len3(v);
  if (length < minStraight) return `Leg ${i + 1} would be ${length.toFixed(0)} mm; the shortest straight piece is ${minStraight} mm`;
  return null;
}

/** Whether `route_run` routes in this domain (one of the run domains is drawn but not routed yet). */
export function isRoutedDomain(domain: RunSegment["domain"]): boolean {
  return domain !== "conduit";
}

function routeRun(model: ModelState, given: Extract<RoutingCommand, { type: "route_run" }>): ExecuteResult {
  const cmd = withRouteHeight(model, given);
  if (!isRoutedDomain(cmd.domain)) refuse("unsupported_geometry", "Conduit routing isn't available yet; duct and pipe are");
  if (!sizeFitsDomain(cmd.size, cmd.domain)) refuse("invalid_value", `${sizeLabel(cmd.size)} isn't a ${domainWord(cmd.domain)} size`);
  if (cmd.size.shape === "oval" && cmd.size.width < cmd.size.height) refuse("invalid_value", "A flat oval is wider than it is tall; swap the width and height");
  if (cmd.domain !== "duct" && cmd.domain !== "pipe" && cmd.insulation) refuse("invalid_value", "Insulation goes on duct and pipe");
  const b = new RouteBuilder(model, cmd);
  const level = requireKind(b.reader.get(asElementId(cmd.levelId)), "level");
  const system = b.system();
  const rules = systemRules(system.systemKind);
  const insulation = cmd.domain === "duct" || cmd.domain === "pipe" ? routeInsulation(system, cmd.insulation) : undefined;
  // A branch end takes its direction from the next point, or from the other end when there is none.
  const branchFirst = cmd.from?.kind === "run_branch" && cmd.to !== undefined && cmd.to.kind !== "run_branch";
  let start: Anchor | null = null;
  let end: Anchor | null = null;
  if (branchFirst && cmd.to && cmd.from) {
    end = b.anchor(cmd.to, level, system, "end");
    start = b.anchor(cmd.from, level, system, "start", { x: end.position.x, y: end.position.y });
  } else {
    start = cmd.from ? b.anchor(cmd.from, level, system, "start") : null;
    end = cmd.to ? b.anchor(cmd.to, level, system, "end", start && start.kind !== "run_branch" ? { x: start.position.x, y: start.position.y } : null) : null;
  }
  if (start?.ref && end?.ref && start.ref.elementId === end.ref.elementId && start.ref.port === end.ref.port) refuse("invalid_value", "A route can't start and end on the same connector");  if (start?.kind === "run_branch" && end?.kind === "run_branch" && start.branch?.host.id === end.branch?.host.id) refuse("unsupported_geometry", "A route can't leave and rejoin the same trunk");

  const fitSystem: MepSystem = cmd.fittings ? { ...system, fittingDefaults: { ...(system.fittingDefaults ?? {}), ...cmd.fittings } } : system;
  const turnDepth = (a: Anchor) => turnDepthMm(fitSystem, a.size ?? cmd.size, cmd.domain, model.settings.minStraightMm);
  const pipeAngles = cmd.domain === "pipe" ? pipeTurnAngles(system.systemKind, cmd.size.shape === "pipe" ? cmd.size : undefined) : undefined;
  // Rises slope at the angles the run's elbow families are made for (`runSlopeAngles`).
  const riseSlopes = runSlopeAngles(cmd.domain, system.systemKind, cmd.size);
  let nodes = routeNodes(b, start, end, turnDepth, riseSlopes);
  if (nodes.length < 2) refuse("invalid_value", "A route needs at least two points far enough apart");
  const minStraight = model.settings.minStraightMm;
  const pipe = cmd.domain === "pipe";
  const gravity = pipe && isGravity(system.systemKind);

  // Gravity drains: level legs fall towards the downstream end. A fixed connection keeps its height; a branch on a stack finds its own.
  if (gravity && cmd.size.shape === "pipe") {
    const inches = Math.round((cmd.size.nominalMm / 25.4) * 1000) / 1000;
    const need = minSlopeFor(inches, system.design?.pipe);
    const slope = cmd.slopeInPerFt ?? need;
    if (slope + 1e-9 < need) refuse("invalid_value", `${inPerFtLabel(slope)} is flatter than the ${inPerFtLabel(need)} ${system.name} needs for ${inches}" pipe; change the system's slope rule to go flatter`);
    const flowWithPoints = cmd.flow ? cmd.flow === "with_points" : start?.kind !== "run_branch";
    const kindOf = (a: Anchor | null): "rigid" | "slide" | "free" => (!a ? "free" : a.branch?.dir ? "slide" : "rigid");
    const down = flowWithPoints ? end : start;
    const up = flowWithPoints ? start : end;
    const downEnd: "first" | "last" = flowWithPoints ? "last" : "first";
    const upEnd: "first" | "last" = downEnd === "last" ? "first" : "last";
    const fixed = kindOf(down) === "rigid" ? downEnd : kindOf(up) === "rigid" ? upEnd : kindOf(down) === "slide" && kindOf(up) === "free" ? upEnd : "first";
    const other = fixed === downEnd ? kindOf(up) : kindOf(down);
    const pitched = pitchNodes(nodes, { flowWithPoints, inPerFt: slope, fixed, other, tol: model.settings.connectorToleranceMm, minStraightMm: minStraight });
    if ("refusal" in pitched) refuse("unsupported_geometry", pitched.refusal);
    nodes = pitched.nodes;
    // A branch on a stack meets it where the slope brings it.
    const slide = (a: Anchor | null, node: RunPoint | undefined): Anchor | null => {
      if (!a?.branch?.dir || !node) return a;
      const axis = segmentAxis(a.branch.host);
      const s = Math.round((node.z - a.branch.host.start.z) * Math.sign(axis.z) * 1000) / 1000;
      return { ...a, position: node, branch: { ...a.branch, s } };
    };
    start = slide(start, nodes[0]);
    end = slide(end, nodes[nodes.length - 1]);
  }

  // Legs, merging straight-through points.
  const pts: RunPoint[] = [];
  for (const n of nodes) {
    const a = pts[pts.length - 2];
    const m = pts[pts.length - 1];
    if (a && m && angleBetween(sub3(m, a), sub3(n, m)) < 0.5) pts[pts.length - 1] = n;
    else pts.push(n);
  }
  const legs: RunPoint[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const from = pts[i];
    const to = pts[i + 1];
    if (!from || !to) continue;
    const v = sub3(to, from);
    const issue = legIssue(i, v, minStraight, pipe, pipeAngles, riseSlopes);
    if (issue) {
      // A leg turning out of an up- or down-facing connector: say how deep the turn needs, not just this leg.
      const at = i === 0 ? start : i + 2 === pts.length ? end : null;
      const turn = at && at.kind !== "run_branch" && isVertical(at.outward) ? ` ${at.label} faces ${at.outward.z < 0 ? "down" : "up"}: leave about ${feet(turnDepth(at))} between it and the level run (a 90° elbow plus the shortest straight piece)` : "";
      refuse(issue.includes("mm;") ? "min_straight_length" : "unsupported_geometry", turn ? `${issue}.${turn}` : issue);
    }
    legs.push(dir3(v));
  }
  const turns: number[] = [];
  // Pipe turns between pitched legs are a few degrees off square: the fittings are pitched to match.
  const turnTol = pipe ? PIPE_TURN_TOLERANCE_DEG : 0.5;
  for (let i = 0; i + 1 < legs.length; i++) {
    const a = legs[i];
    const c = legs[i + 1];
    if (!a || !c) continue;
    const turn = Math.round(angleBetween(a, c) * 100) / 100;
    const elbow = elbowTurnFor(pipe, turn, turnTol, i + 2, pipeAngles);
    if (typeof elbow === "string") refuse("unsupported_geometry", elbow);
    turns.push(elbow);
  }
  const firstLeg = legs[0];
  const lastLeg = legs[legs.length - 1];
  if (!firstLeg || !lastLeg) refuse("invalid_value", "A route needs at least one straight piece");
  // An elbow right on the straight piece's open end the route starts on: the turn is between that piece and the first leg.
  const turnOn = cmd.turnAtStart && start?.kind === "run_end" && start.ref && b.working[start.ref.elementId]?.kind === "run_segment" && dot3(firstLeg, start.outward) < 0.999 ? start.ref : null;
  let turnAtStartDeg: number | null = null;
  if (turnOn && start) {
    if (start.size) refuse("profile_incompatible", `An elbow right at ${start.label} has to be its size; route straight out first to change size`, [turnOn.elementId]);
    if (hasSides(cmd.size) && (Math.abs(start.outward.z) > 1e-6 || Math.abs(firstLeg.z) > 1e-6)) {
      refuse("unsupported_geometry", `A ${sizeLabel(cmd.size)} run turns up or down from ${start.label} only after a straight piece; turn it sideways here, or route straight out and rise`, [turnOn.elementId]);
    }
    const elbow = elbowTurnFor(pipe, Math.round(angleBetween(start.outward, firstLeg) * 100) / 100, turnTol, 1, pipeAngles);
    if (typeof elbow === "string") refuse("unsupported_geometry", elbow, [turnOn.elementId]);
    turnAtStartDeg = elbow;
  }
  if (start && !turnOn && dot3(firstLeg, start.outward) < 0.999) refuse("unsupported_geometry", `The run has to leave ${start.label} straight out of it`);
  if (end && dot3(lastLeg, end.outward) > -0.999) refuse("unsupported_geometry", `The run has to arrive at ${end.label} straight into it`);
  for (const a of [start, end]) {
    if (!a?.size) continue;
    const why = transitionReason(a.size, cmd.size);
    if (why) refuse("profile_incompatible", why);
  }
  // A duct branch too wide for its trunk is tapped at the widest the trunk takes, with a transition up to the size drawn.
  let tapSize: RunSize | null = null;
  let tapReach = 0;
  if (start?.branch || end?.branch) {
    const host = (start?.branch ?? end?.branch)?.host;
    if (host) {
      const wide = host.size;
      const fits = (size: RunSize) => (rules.branchMayEqualTrunk ? sizeWidthOf(size) <= sizeWidthOf(wide) + 0.5 : sizeWidthOf(size) < sizeWidthOf(wide) - 0.5);
      if (!fits(cmd.size)) {
        const narrowed = cmd.domain === "duct" ? narrowedBranch(cmd.size, sizeWidthOf(wide), rules.branchMayEqualTrunk) : null;
        if (!narrowed || !fits(narrowed)) refuse("profile_incompatible", `A ${sizeLabel(cmd.size)} branch is ${rules.branchMayEqualTrunk ? "larger than" : "as wide as"} the ${sizeLabel(wide)} trunk; make the branch smaller`, [host.id]);
        tapSize = narrowed;
        const choice = chooseFitting(fitSystem, rules.branch, cmd.domain, [narrowed], undefined, wide);
        const rf = resolveFitting(null, { fittingType: rules.branch, ports: [], domain: cmd.domain, ...choice.fields });
        tapReach = rf ? takeoffDepth(rf, narrowed) : 0;
      }
    }
  }

  // Rectangular and flat oval duct: every turn has to be one an elbow makes, and a turn that leaves the duct on its side gets a transition back.
  const sided = cmd.domain === "duct" && (cmd.size.shape === "rect" || cmd.size.shape === "oval");
  const onSideAfter = new Map<number, number>();
  if (sided) {
    const startWidth = start?.ref && isVertical(firstLeg) ? portWidthAxis(b.working, start.ref) : null;
    const frames = planDuctFrames(legs, cmd.size, startWidth);
    if (!frames.ok) refuse("unsupported_geometry", frames.reason);
    const joining = end?.ref && isVertical(lastLeg) && hasSides(cmd.size) ? portWidthAxis(b.working, end.ref) : null;
    if (joining && Math.abs(dot3(joining, frames.widthAtEnd)) < 0.999) {
      refuse("unsupported_geometry", `${end?.label ?? "That riser"} is turned the other way; this ${sizeLabel(cmd.size)} riser would meet it twisted. Rise from a leg running the same way, or join it with square or round duct`);
    }
    for (const turn of frames.onSide) {
      const angle = turns[turn] ?? 90;
      const choice = chooseFitting(fitSystem, "elbow", cmd.domain, [cmd.size, onItsSide(cmd.size)], angle, undefined);
      const rf = resolveFitting(null, { fittingType: "elbow", ports: [], domain: cmd.domain, angleDeg: angle, ...choice.fields });
      onSideAfter.set(turn, rf ? elbowTakeoffMm(rf, sizeWidthOf(cmd.size), angle) : 0);
    }
  }

  // Ids.
  const prefix = cmd.idPrefix;
  const segId = (i: number) => asElementId(`${prefix}-s${i + 1}`);
  let fittingCount = 0;
  const nextFittingId = () => asElementId(`${prefix}-f${++fittingCount}`);
  const partition: Partition = { level: level.name, zone: cmd.zone ?? start?.zone ?? end?.zone ?? "Z1", discipline: discipline(system.systemKind) };
  const base = { version: 0, authoredRev: {}, partition, domain: cmd.domain, systemId: system.id, levelId: level.id, ...(insulation ? { insulation } : {}) } as const;

  // Straight pieces, and what joins each to the next: the elbow at a turn, or the transition that sets a duct on its side back upright.
  const segments: RunSegment[] = [];
  const legOf: number[] = [];
  // A transition's body grows from its `near` side, so the piece beyond it gives up the length.
  const joints: Array<{ kind: "elbow"; angle: number; leg: number } | { kind: "transition"; nearIsBefore: boolean } | { kind: "straight" }> = [];
  // A route across floors (to a connector on another one, or down through its own floor): its risers are cut where they pass a floor, so each piece is filed under the floor it runs through.
  const levels = levelsByHeight(model);
  const crossing = levels.length > 1 && (b.otherLevels.size > 0 || pts.some((p) => leavesStorey(levels, level, p.z)));
  // A piece next to an elbow needs the elbow's takeoff plus the shortest straight piece.
  const riserPieceMin = crossing ? turnDepthMm(fitSystem, cmd.size, cmd.domain, minStraight) : 0;
  const floorCuts = (a: RunPoint, z: RunPoint): RunPoint[] => {
    if (!crossing || Math.hypot(z.x - a.x, z.y - a.y) > 0.01) return [];
    const lo = Math.min(a.z, z.z) + level.elevationMm;
    const hi = Math.max(a.z, z.z) + level.elevationMm;
    const up = z.z > a.z;
    const cuts = floorsBetween(levels, lo, hi).map((f) => round3(p3(a.x, a.y, f.elevationMm - level.elevationMm)));
    if (!up) cuts.reverse();
    const kept: RunPoint[] = [];
    let last = a;
    for (const c of cuts) {
      if (Math.abs(c.z - last.z) >= riserPieceMin && Math.abs(z.z - c.z) >= riserPieceMin) {
        kept.push(c);
        last = c;
      }
    }
    return kept;
  };
  const addSegment = (from: RunPoint, to: RunPoint, size: RunSize, leg: number) => {
    const id = segId(segments.length);
    if (b.reader.find(id)) refuse("already_exists", `${id} already exists; choose a new id prefix`, [id]);
    const tooThick = insulation ? insulationIssue(size, insulation) : null;
    if (tooThick) refuse("invalid_value", tooThick);
    segments.push({ ...base, id, kind: "run_segment", start: round3(from), end: round3(to), size, links: {}, branches: [], flow: 0 });
    legOf.push(leg);
  };
  const lastLegIndex = pts.length - 2;
  for (let i = 0; i + 1 < pts.length; i++) {
    const from = pts[i];
    const to = pts[i + 1];
    const leg = legs[i];
    if (!from || !to || !leg) continue;
    const along = (p: RunPoint, d: number) => round3(p3(p.x + leg.x * d, p.y + leg.y * d, p.z + leg.z * d));
    // Out of an elbow that leaves the duct on its side, or out of a narrowed tap: a short piece, then the transition to the size drawn.
    // The short piece is at least the shortest straight piece, even when the fitting before it reaches less far.
    const head = onSideAfter.has(i - 1) ? { reach: Math.max(minStraight, onSideAfter.get(i - 1) ?? 0), size: onItsSide(cmd.size), why: `Out of the riser at point ${i + 1}, the duct lies on its side and needs a transition back to ${sizeLabel(cmd.size)}` } : i === 0 && start?.branch && tapSize ? { reach: Math.max(minStraight, tapReach), size: tapSize, why: `The ${sizeLabel(cmd.size)} branch is tapped at ${sizeLabel(tapSize)} and needs a transition` } : null;
    const tail = i === lastLegIndex && end?.branch && tapSize ? { reach: Math.max(minStraight, tapReach), size: tapSize, why: `The ${sizeLabel(cmd.size)} branch is tapped at ${sizeLabel(tapSize)} and needs a transition` } : null;
    const a = head ? along(from, head.reach) : from;
    const z = tail ? along(to, -tail.reach) : to;
    if ((head || tail) && dot3(sub3(z, a), leg) < minStraight) {
      refuse("min_straight_length", `${(head ?? tail)?.why ?? ""}; leg ${i + 1} is too short for it. Make the leg longer${head && !tail && onSideAfter.has(i - 1) ? ", or rise from a leg running the same way" : ""}`);
    }
    if (head) {
      addSegment(from, a, head.size, i);
      joints.push({ kind: "transition", nearIsBefore: true });
    }
    let pieceStart = a;
    for (const cut of floorCuts(a, z)) {
      addSegment(pieceStart, cut, cmd.size, i);
      joints.push({ kind: "straight" });
      pieceStart = cut;
    }
    addSegment(pieceStart, z, cmd.size, i);
    if (tail) {
      joints.push({ kind: "transition", nearIsBefore: false });
      addSegment(z, to, tail.size, i);
    }
    const angle = turns[i];
    if (angle !== undefined) joints.push({ kind: "elbow", angle, leg: i });
  }
  const linkSeg = (i: number, port: "start" | "end", ref: PortRef) => {
    const s = segments[i];
    if (s) segments[i] = { ...s, links: { ...s.links, [port]: ref } };
  };
  const fittings: RunFitting[] = [];
  const fitting = (f: Omit<RunFitting, "id" | "version" | "authoredRev" | "partition" | "domain" | "systemId" | "levelId" | "kind">): RunFitting => {
    const id = nextFittingId();
    if (b.reader.find(id)) refuse("already_exists", `${id} already exists; choose a new id prefix`, [id]);
    const host = f.host ? b.working[f.host.segmentId] : undefined;
    // Drainage picks its turns and branches by which way the flow changes direction.
    const [pa, pb] = f.ports;
    const orientation = !gravity || !pa ? undefined : host?.kind === "run_segment" ? branchOrientation(segmentAxis(host), pa.direction) : pb ? turnOrientation(pa.direction, pb.direction) : undefined;
    const choice = chooseFitting(fitSystem, f.fittingType, cmd.domain, f.ports.map((p) => p.size), f.angleDeg, host?.kind === "run_segment" ? host.size : undefined, orientation);
    const label = choice.branchLabel ? branchLabelOnFace(choice.fields.family, choice.branchLabel, f.host?.face) : null;
    const made: RunFitting = { ...base, id, kind: "run_fitting", ...f, ...choice.fields, ...(label ? { label } : {}) };
    fittings.push(made);
    return made;
  };
  const port = (id: string, position: RunPoint, direction: RunPoint, size: RunSize, link?: PortRef): RunPort => ({ id, position: round3(position), direction: dir3(direction), size, ...(link ? { link } : {}) });
  const elbowAt = (position: RunPoint, angleDeg: number, ports: RunFitting["ports"]): RunFitting => fitting({ fittingType: "elbow", label: fittingLabel("elbow", rules, null, angleDeg), position, angleDeg, ports });

  // Elbows at every turn; transitions where a duct on its side is stood back up.
  joints.forEach((joint, i) => {
    const before = segments[i];
    const after = segments[i + 1];
    if (!before || !after) return;
    if (joint.kind === "straight") {
      linkSeg(i, "end", { elementId: after.id, port: "start" });
      linkSeg(i + 1, "start", { elementId: before.id, port: "end" });
      return;
    }
    const at = before.end;
    const c = dir3(sub3(after.end, after.start));
    const a = dir3(sub3(before.end, before.start));
    const f =
      joint.kind === "elbow"
        ? elbowAt(at, joint.angle, [port("a", at, p3(-a.x, -a.y, -a.z), before.size, { elementId: before.id, port: "end" }), port("b", at, c, after.size, { elementId: after.id, port: "start" })])
        : fitting({
            fittingType: "transition",
            label: fittingLabel("transition", rules, null),
            position: at,
            ports: joint.nearIsBefore
              ? [port("a", at, p3(-a.x, -a.y, -a.z), before.size, { elementId: before.id, port: "end" }), port("b", at, c, after.size, { elementId: after.id, port: "start" })]
              : [port("a", at, c, after.size, { elementId: after.id, port: "start" }), port("b", at, p3(-a.x, -a.y, -a.z), before.size, { elementId: before.id, port: "end" })],
          });
    const nearIsBefore = joint.kind === "elbow" || joint.nearIsBefore;
    linkSeg(i, "end", { elementId: f.id, port: nearIsBefore ? "a" : "b" });
    linkSeg(i + 1, "start", { elementId: f.id, port: nearIsBefore ? "b" : "a" });
  });

  // Each end: straight onto the connector, through a transition, as a new branch, capped, or left open.
  const edits = new Map<ElementId, BimElement>();
  const anchorEdit = (ref: PortRef, link: PortRef) => {
    const current = edits.get(ref.elementId) ?? b.working[ref.elementId];
    if (!current) refuse("element_not_found", `${ref.elementId} does not exist`, [ref.elementId]);
    const next = withLink(current, ref.port, link);
    if (!next) refuse("element_not_found", `${ref.elementId} has no connector ${ref.port}`, [ref.elementId]);
    edits.set(ref.elementId, next);
  };
  const close = (a: Anchor | null, which: "start" | "end") => {
    const i = which === "start" ? 0 : segments.length - 1;
    const seg = segments[i];
    const leg = which === "start" ? firstLeg : lastLeg;
    if (!seg) return;
    const at = which === "start" ? seg.start : seg.end;
    const intoRun = which === "start" ? leg : p3(-leg.x, -leg.y, -leg.z);
    if (!a) {
      if (which === "end" && cmd.capEnd) {
        const f = fitting({ fittingType: "cap", label: fittingLabel("cap", rules, null), position: at, ports: [port("a", at, intoRun, cmd.size, { elementId: seg.id, port: which })] });
        linkSeg(i, which, { elementId: f.id, port: "a" });
      }
      return;
    }
    if (a.branch) {
      const type = rules.branch;
      const f = fitting({
        fittingType: type,
        label: fittingLabel(type, rules, cmd.size),
        position: hostedPoints(a.branch.host, a.branch.s, a.branch.side, a.branch.dir, a.branch.face, a.branch.t).onAxis,
        ports: [port("branch", a.position, a.outward, seg.size, { elementId: seg.id, port: which })],
        host: { segmentId: a.branch.host.id, s: a.branch.s, side: a.branch.side, ...(a.branch.dir ? { dir: a.branch.dir } : {}), ...(a.branch.face ? { face: a.branch.face } : {}), ...(a.branch.t ? { t: a.branch.t } : {}) },
      });
      linkSeg(i, which, { elementId: f.id, port: "branch" });
      const host = (edits.get(a.branch.host.id) ?? b.working[a.branch.host.id]) as RunSegment;
      edits.set(host.id, { ...host, branches: [...host.branches, f.id] });
      return;
    }
    if (!a.ref) return;
    if (which === "start" && turnOn && turnAtStartDeg !== null) {
      const f = elbowAt(at, turnAtStartDeg, [port("a", at, p3(-a.outward.x, -a.outward.y, -a.outward.z), cmd.size, a.ref), port("b", at, leg, seg.size, { elementId: seg.id, port: which })]);
      linkSeg(i, which, { elementId: f.id, port: "b" });
      anchorEdit(a.ref, { elementId: f.id, port: "a" });
      return;
    }
    if (a.size) {
      const f = fitting({
        fittingType: "transition",
        label: fittingLabel("transition", rules, null),
        position: at,
        ports: [port("a", at, p3(-intoRun.x, -intoRun.y, -intoRun.z), a.size, a.ref), port("b", at, intoRun, cmd.size, { elementId: seg.id, port: which })],
      });
      linkSeg(i, which, { elementId: f.id, port: "b" });
      anchorEdit(a.ref, { elementId: f.id, port: "a" });
      return;
    }
    linkSeg(i, which, a.ref);
    anchorEdit(a.ref, { elementId: seg.id, port: which });
  };
  close(start, "start");
  close(end, "end");

  if (crossing) {
    const floorOf = (zMm: number) => floorForPiece(levels, level, level.elevationMm + zMm);
    segments.forEach((s, k) => {
      segments[k] = { ...s, partition: partitionOnFloor(partition, floorOf((s.start.z + s.end.z) / 2)) };
    });
    fittings.forEach((f, k) => {
      fittings[k] = { ...f, partition: partitionOnFloor(partition, floorOf(f.position.z)) };
    });
  }
  for (const s of segments) b.put(s);
  for (const f of fittings) b.put(f);
  for (const el of edits.values()) b.put(el);
  // Real fittings take real length: a leg too short for the fittings at its ends is refused, and nothing is created.
  segments.forEach((s, i) => {
    const short = legTooShort(b.working, s, legOf[i] ?? i);
    if (short) refuse("min_straight_length", short, [s.id]);
  });
  if (turnOn && start) {
    const piece = b.working[turnOn.elementId];
    const why = piece?.kind === "run_segment" ? roomForFittings(b.working, piece) : null;
    if (why) refuse("min_straight_length", `No room for an elbow right at ${start.label}: that straight piece ${why}`, [turnOn.elementId]);
  }
  const authored: AuthoredWrite[] = segments.map((s) => ({ elementId: s.id, field: "size", value: s.size }));
  return finish(b.reader, b.working, b.touched, authored, NO_INTENTS);
}

const FITTING_WORD: Readonly<Record<RunFitting["fittingType"], string>> = { elbow: "elbow", transition: "transition", tap: "tap", tee: "tee", wye: "wye", cap: "cap", offset: "offset", accessory: "accessory" };

/** "Leg 3 is 0.51 ft long, but the elbow and transition there need 1.27 ft. Move the point or pick a shorter fitting." — or null when it fits. */
function legTooShort(elements: Readonly<Record<string, BimElement>>, seg: RunSegment, i: number): string | null {
  if (seg.domain === "conduit") return null;
  const piece = straightPiece(elements, seg);
  if (piece.lengthMm >= -0.5) return null;
  const words: string[] = [];
  for (const [end, cut] of [["start", piece.cutStart], ["end", piece.cutEnd]] as const) {
    const f = seg.links[end] ? elements[seg.links[end].elementId] : undefined;
    if (f?.kind === "run_fitting" && cut > 0) words.push(FITTING_WORD[f.fittingType]);
  }
  const what = words.length === 2 && words[0] === words[1] ? `two ${words[0]}s` : words.join(" and ");
  const need = piece.cutStart + piece.cutEnd;
  return `Leg ${i + 1} is ${feet(need + piece.lengthMm)} long, but the ${what} there ${words.length > 1 ? "need" : "needs"} ${feet(need)}. Move the point or pick a shorter fitting.`;
}

/** Null when a segment's straight piece is long enough for the fittings at its ends; else the reason, starting with a verb. */
export function roomForFittings(elements: Readonly<Record<string, BimElement>>, seg: RunSegment): string | null {
  if (seg.domain === "conduit") return null;
  const piece = straightPiece(elements, seg);
  if (piece.lengthMm >= -0.5) return null;
  const need = piece.cutStart + piece.cutEnd;
  return `is ${feet(need + piece.lengthMm)} long, but the fittings at its ends need ${feet(need)} (${Math.round(need)} mm); make it longer or choose tighter fittings`;
}

/** The widest branch of `size`'s shape a trunk `trunkWidth` wide takes, to whole inches (null when none does). */
function narrowedBranch(size: RunSize, trunkWidth: number, mayEqual: boolean): RunSize | null {
  const IN = 25.4;
  const most = Math.floor((mayEqual ? trunkWidth + 0.5 : trunkWidth - 0.6) / IN) * IN;
  if (most < 4 * IN) return null;
  switch (size.shape) {
    case "round":
      return { shape: "round", diameter: Math.min(size.diameter, most) };
    case "rect":
      return { shape: "rect", width: Math.min(size.width, most), height: size.height };
    default:
      return null;
  }
}

function sizeWidthOf(size: RunSize): number {
  switch (size.shape) {
    case "rect":
    case "oval":
      return size.width;
    case "round":
      return size.diameter;
    case "pipe":
      return size.nominalMm;
    case "conduit":
      return size.tradeSizeMm;
  }
}

function connectRuns(model: ModelState, cmd: Extract<RoutingCommand, { type: "connect_runs" }>): ExecuteResult {
  const reader = new TrackedReader(model);
  const working = draftElements(model.elements);
  const tol = model.settings.connectorToleranceMm;
  const a = reader.get(asElementId(cmd.a.elementId));
  const c = reader.get(asElementId(cmd.b.elementId));
  if (a.id === c.id) refuse("invalid_value", "Pick two different things to connect");
  // Two parts, or a part and a load point, join end to end with no run between them.
  if ((a.kind === "part" || a.kind === "load_point") && (c.kind === "part" || c.kind === "load_point")) return joinParts(model, cmd);
  const ra: PortRef = { elementId: a.id, port: cmd.a.port };
  const rb: PortRef = { elementId: c.id, port: cmd.b.port };
  const ia = portInfoIn(working, ra, heightFrameOf(a));
  const ib = portInfoIn(working, rb, heightFrameOf(a));
  if (!ia || !ib) refuse("element_not_found", "One of those connectors doesn't exist", [a.id, c.id]);
  if (ia.link || ib.link) refuse("already_exists", "One of those ends is already connected; disconnect it first", [a.id, c.id]);
  const gap = len3(sub3(ia.position, ib.position));
  if (gap > tol) refuse("disconnected", `They're ${feet(gap)} apart; route between them instead`, [a.id, c.id]);
  if (dot3(ia.direction, ib.direction) > -0.999) refuse("unsupported_geometry", "Those ends don't face each other; route between them with an elbow", [a.id, c.id]);
  const na = withLink(a, ra.port, rb);
  const nb = withLink(c, rb.port, ra);
  if (!na || !nb) refuse("wrong_kind", "Only runs and part connectors can be connected", [a.id, c.id]);
  working[na.id] = na;
  working[nb.id] = nb;
  return finish(reader, working, [na.id, nb.id], [], NO_INTENTS);
}

function disconnectRun(model: ModelState, cmd: Extract<RoutingCommand, { type: "disconnect_run" }>): ExecuteResult {
  const reader = new TrackedReader(model);
  const working = draftElements(model.elements);
  const el = reader.get(asElementId(cmd.elementId));
  const link = linkAt(el, cmd.port);
  if (!link) refuse("disconnected", "That end isn't connected to anything", [el.id]);
  const other = reader.get(link.elementId);
  const na = withLink(el, cmd.port, null);
  const nb = withLink(other, link.port, null);
  if (!na || !nb) refuse("wrong_kind", "Only runs and part connectors can be disconnected", [el.id]);
  working[na.id] = na;
  working[nb.id] = nb;
  return finish(reader, working, [na.id, nb.id], [], NO_INTENTS);
}

/**
 * Resize a run: the segment and every segment and elbow joined to it at the
 * same size, stopping at transitions, branches and parts. Fittings on the
 * boundary take the new size on their side (a transition, a branch's
 * takeoff); a part connector that doesn't fit refuses. Branches on a trunk
 * that gets wider or narrower move out or in with its face.
 */
export function resizeRoutedRun(model: ModelState, segmentId: ElementId, size: RunSize): ExecuteResult {
  const reader = new TrackedReader(model);
  const start = requireKind(reader.get(segmentId), "run_segment");
  if (!sizeFitsDomain(size, start.domain)) refuse("invalid_value", `${sizeLabel(size)} isn't a ${domainWord(start.domain)} size`, [start.id]);
  if (sameSize(start.size, size)) refuse("invalid_value", `${runLabel(model.elements, start)} is already ${sizeLabel(size)}`, [start.id]);
  const old = start.size;
  const working = draftElements(model.elements);
  const touched = new Set<ElementId>();
  const runSegments: RunSegment[] = [];
  const seen = new Set<ElementId>();
  const stack: ElementId[] = [start.id];
  const boundary: Array<{ ref: PortRef }> = [];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const el = reader.get(id);
    if (el.kind === "run_segment") {
      if (!sameSize(el.size, old)) continue;
      runSegments.push(el);
      for (const link of [el.links.start, el.links.end]) {
        if (!link) continue;
        const other = reader.get(link.elementId);
        if (other.kind === "run_segment" || (other.kind === "run_fitting" && (other.fittingType === "elbow" || other.fittingType === "cap" || other.fittingType === "offset"))) stack.push(other.id);
        else boundary.push({ ref: link });
      }
    } else if (el.kind === "run_fitting" && (el.fittingType === "elbow" || el.fittingType === "cap" || el.fittingType === "offset")) {
      working[el.id] = { ...el, ports: el.ports.map((p) => ({ ...p, size })) };
      touched.add(el.id);
      for (const p of el.ports) if (p.link) stack.push(p.link.elementId);
    }
  }
  const authored: AuthoredWrite[] = [];
  for (const seg of runSegments) {
    working[seg.id] = { ...seg, size };
    touched.add(seg.id);
    authored.push({ elementId: seg.id, field: "size", value: size });
  }
  for (const { ref } of boundary) {
    const other = working[ref.elementId];
    if (other?.kind !== "run_fitting") continue;
    // A transition or branch takeoff on the edge of the run takes the new size on this side.
    working[other.id] = { ...other, ports: other.ports.map((p) => (p.id === ref.port ? { ...p, size } : p)) };
    touched.add(other.id);
  }
  const prop = new RunPropagator(reader, working, touched);
  for (const seg of runSegments) {
    const resized = working[seg.id];
    if (resized?.kind === "run_segment" && resized.branches.length > 0) prop.rehost(resized);
  }
  const refits = refitTouched(working, touched);
  return finish(reader, working, touched, authored, () => authored.map((a) => ({ kind: "field_equals" as const, elementId: a.elementId, field: a.field, value: a.value })), refits.length > 0 ? { summary: refits } : {});
}

/** Slide a tap, tee or wye along its trunk; its branch follows (stretching where it runs along the slide, refusing at fixed parts). */
export function slideRoutedBranch(model: ModelState, fittingId: ElementId, s: number): ExecuteResult {
  const reader = new TrackedReader(model);
  const f = requireKind(reader.get(fittingId), "run_fitting");
  if (!f.host) refuse("wrong_kind", `${f.label} isn't on a trunk, so it doesn't slide`, [f.id]);
  const working = draftElements(model.elements);
  const touched = new Set<ElementId>();
  const target = Math.round(s * 1000) / 1000;
  new RunPropagator(reader, working, touched).slide(f, target);
  const authored: AuthoredWrite[] = [{ elementId: f.id, field: "s", value: target }];
  return finish(reader, working, touched, authored, () => [{ kind: "field_equals", elementId: f.id, field: "s", value: target }]);
}

export function executeRoutingCommand(model: ModelState, command: RoutingCommand): ExecuteResult {
  switch (command.type) {
    case "route_run":
      return routeRun(model, command);
    case "connect_runs":
      return connectRuns(model, command);
    case "disconnect_run":
      return disconnectRun(model, command);
    case "join_parts":
      return joinParts(model, command);
  }
}

export function isRoutingCommand(command: { type: string }): command is RoutingCommand {
  return command.type === "route_run" || command.type === "connect_runs" || command.type === "disconnect_run" || command.type === "join_parts";
}

/** The insulation a route gets: what it asks for (null: none), else its system's default. */
export function routeInsulation(system: MepSystem | undefined, asked: RunInsulation | null | undefined): RunInsulation | undefined {
  if (asked === null) return undefined;
  return asked ?? system?.design?.insulation;
}

/**
 * A new duct system's design starts from another system of the same kind in
 * the model (the first by id), so a project's choice for, say, supply air
 * carries to the next supply system. Only insulation and sizing carry.
 */
export function inheritedDuctDesign(model: ModelState, system: Pick<MepSystem, "systemKind">): DuctDefaults {
  return siblingDuctDesign(elementsOfKind(model.elements, "mep_system"), system.systemKind);
}

export type DuctDefaults = Pick<NonNullable<MepSystem["design"]>, "insulation" | "sizing">;

/** The same rule over a list of systems (the Route panel's), so a new system shows what it will start with. */
export function siblingDuctDesign(systems: Iterable<{ readonly id: string } & Pick<MepSystem, "systemKind" | "domain" | "design">>, systemKind: SystemKind): DuctDefaults {
  let sibling: ({ readonly id: string } & Pick<MepSystem, "design">) | undefined;
  for (const s of systems) {
    if (s.systemKind !== systemKind || s.domain !== "duct" || (!s.design?.insulation && !s.design?.sizing)) continue;
    if (!sibling || s.id < sibling.id) sibling = s;
  }
  const d = sibling?.design;
  return { ...(d?.insulation ? { insulation: d.insulation } : {}), ...(d?.sizing ? { sizing: d.sizing } : {}) };
}
export { JOIN_PARTS_FEATURE, LOAD_POINT_PORT, joinParts, joinPartsCommandSchema, type JoinPartsCommand } from "./join-parts";
