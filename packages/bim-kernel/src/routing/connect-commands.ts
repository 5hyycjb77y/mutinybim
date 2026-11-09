import { z } from "zod";
import { refuse, type AuthoredWrite, type CommandError, type ExecuteOk, type ExecuteResult, type IntentPredicate } from "../command-core";
import type { KernelErrorCode } from "../model";
import type { SystemKind } from "../parts";
import { asElementId, type Connection, type ElementId, type ModelState, type Vec2 } from "../types";
import type { Command } from "../commands";
import { hostHalfHeight, isVertical, portInfo } from "./geometry";
import { ROUTING_TAP_FACES_FEATURE } from "../connections/connector-faces";
import { peerReads } from "../elements/feature";
import { serviceOf } from "./pipe/design";
import { isPitchedOrLevel } from "./pipe/gravity";
import { sizeLabel } from "./rules";
import type { RunPoint, RunSegment, RunSize } from "./types";
import { runLabel } from "./validate";
import { systemKindLabelOf } from "./system-label";
import { heightFrameOf, portInfoIn } from "./levels-across";
import { routingCommandSchemas } from "./commands";

/**
 * Connecting existing duct and pipe to itself, each as one edit made of the
 * plain routing commands (all or nothing, one undo step):
 *
 * - `elbow_to_tee`: the "+" on an elbow's free side. One leg runs straight
 *   through the corner and ends open there (to route on from); the other leg
 *   joins it as a branch with the system's takeoff.
 * - `auto_connect_runs`: two open ends that don't meet face to face are joined
 *   by a route that leaves each end straight out, turns square, and rises or
 *   drops once on a straight stretch. Refused with the reason when no such
 *   route fits.
 * - `stretch_to_side`: an open end dragged onto another run's side continues
 *   straight into it as a tap (the trunk's height and system); an end facing
 *   down onto a run below (or up into one above) taps its top (or bottom) face.
 *
 * - `route_into_flex`: a route whose last stretch, into a part's connector, is
 *   flex: the rigid run is drawn to its last point and left open, then flex
 *   curves from that end into the connector.
 *
 * Each step runs under the same rules as when sent alone; the operation is the
 * one the person picked, only the path is worked out.
 */

/**
 * The "+" on every kind of run (Nov 2026): an elbow whose other leg meets a
 * fitting or part becomes a tee, a round riser runs on through its corner, a
 * continued route turns right at the open end (`route_run.turnAtStart`), and
 * `route_into_flex`. Nothing new is stored; a client offers these only to a
 * model server that advertises it, so an older one never refuses them.
 */
export const ROUTING_PLUS_EVERY_RUN_FEATURE = "routing:plus_every_run";

const routeRunSchema = routingCommandSchemas[0].omit({ type: true, to: true, capEnd: true });

const idSchema = z.string().min(1).max(200);
const portRefSchema = z.object({ elementId: idSchema, port: z.string().min(1).max(40) });

export const connectCommandSchemas = [
  z.object({
    type: z.literal("elbow_to_tee"),
    /** A level two-way elbow between two straight pieces. */
    fittingId: idSchema,
    /** The elbow port whose leg runs straight through the corner (its far side becomes the open end). */
    through: z.string().min(1).max(40),
    idPrefix: z.string().min(1).max(80),
    /** A level leg and a leg that rises (`top`) or drops (`bottom`) from it: the rising or dropping leg joins the level one's top or bottom (feature `routing:tap_faces`). Absent: both legs level. */
    face: z.enum(["top", "bottom"]).optional(),
  }),
  z.object({ type: z.literal("auto_connect_runs"), a: portRefSchema, b: portRefSchema, idPrefix: z.string().min(1).max(80) }),
  z.object({
    type: z.literal("route_into_flex"),
    /** The rigid run, as `route_run` draws it, left open at its last point. */
    route: routeRunSchema,
    /** The part connector the last stretch, flex, goes into. */
    to: z.object({ partId: idSchema, connectorId: z.string().min(1).max(40) }),
  }),
  z.object({
    type: z.literal("stretch_to_side"),
    /** The open end that was dragged. */
    from: portRefSchema,
    /** The level straight run it was dragged onto (its side, or its top / bottom for an end facing down / up). */
    onto: idSchema,
    idPrefix: z.string().min(1).max(80),
  }),
] as const;

export const connectCommandSchema = z.discriminatedUnion("type", [...connectCommandSchemas]);
export type ConnectCommand = z.infer<typeof connectCommandSchema>;

const CONNECT_TYPES: ReadonlySet<string> = new Set(connectCommandSchemas.map((s) => s.shape.type.value));

export function isConnectCommand(command: { readonly type: string }): command is ConnectCommand {
  return CONNECT_TYPES.has(command.type);
}

type Execute = (model: ModelState, command: Command) => ExecuteResult;

/** A step's refusal code as this edit's own (commit-level codes never come out of a dry step). */
const stepCode = (code: CommandError["code"]): KernelErrorCode => (code === "conflict" || code === "stale_base" || code === "forbidden" ? "unsupported_geometry" : code);

const connectionKey = (c: Connection) => `${c.a.elementId}:${c.a.end}|${c.b.elementId}:${c.b.end}`;
const intentKey = (i: IntentPredicate) => (i.kind === "tap_at" ? `tap_at:${i.tapId}` : `field:${i.elementId}:${i.field}`);

/** Steps run one after another on the result of the ones before; the result is the union, as one command's. */
export class Chain {
  current: ModelState;
  private readonly changed = new Set<ElementId>();
  private readonly removed = new Set<ElementId>();
  private readonly removedConnections = new Map<string, Connection>();
  private readonly addedConnections = new Map<string, Connection>();
  private readonly readSet: Record<string, number> = {};
  private readonly authored = new Map<string, AuthoredWrite>();
  private readonly intents = new Map<string, IntentPredicate>();
  private openIssues: ExecuteOk["openIssues"];

  constructor(
    private readonly start: ModelState,
    private readonly exec: Execute,
  ) {
    this.current = start;
  }

  /** Try a step; on refusal nothing is kept and the result says why. */
  attempt(command: Command): ExecuteResult {
    const r = this.exec(this.current, command);
    if (r.ok) this.keep(r);
    return r;
  }

  /** A step that must succeed; its refusal is the whole edit's. */
  run(command: Command, what: string): ExecuteOk {
    const r = this.attempt(command);
    if (!r.ok) refuse(stepCode(r.error.code), `${what}: ${r.error.message}`, r.error.elementIds);
    return r;
  }

  /** A step that isn't a command of its own (the edit's own change after its commands); it must succeed. */
  step(work: (model: ModelState) => ExecuteResult, what: string): ExecuteOk {
    const r = work(this.current);
    if (!r.ok) refuse(stepCode(r.error.code), `${what}: ${r.error.message}`, r.error.elementIds);
    this.keep(r);
    return r;
  }

  private keep(r: ExecuteOk) {
    this.current = r.model;
    this.openIssues = r.openIssues;
    for (const id of r.changedIds) this.changed.add(id);
    for (const id of r.removedIds) this.removed.add(id);
    for (const c of r.removedConnections) this.removedConnections.set(connectionKey(c), c);
    for (const c of r.addedConnections) this.addedConnections.set(connectionKey(c), c);
    for (const [id, version] of Object.entries(r.readSet)) {
      const before = this.start.elements[id];
      if (before && this.readSet[id] === undefined) this.readSet[id] = Math.min(before.version, version);
    }
    for (const a of r.authored) this.authored.set(`${a.elementId}\u0000${a.field}`, a);
    for (const p of r.intents) this.intents.set(intentKey(p), p);
  }

  result(summary: string): ExecuteOk {
    const elements = this.current.elements;
    return {
      ok: true,
      model: this.current,
      changedIds: [...this.changed].filter((id) => elements[id] !== undefined),
      removedIds: [...this.removed].filter((id) => elements[id] === undefined && this.start.elements[id] !== undefined),
      removedConnections: [...this.removedConnections.values()],
      addedConnections: [...this.addedConnections.values()],
      readSet: this.readSet,
      authored: [...this.authored.values()],
      intents: [...this.intents.values()],
      summary: [summary],
      ...(this.openIssues && this.openIssues.length > 0 ? { openIssues: this.openIssues } : {}),
    };
  }
}

function segment(model: ModelState, id: string, what: string): RunSegment {
  const el = model.elements[asElementId(id)];
  if (el?.kind !== "run_segment") refuse("wrong_kind", `${what} isn't a straight piece of duct or pipe`, el ? [el.id] : []);
  return el;
}

/** The widest side of a size, mm. */
function across(size: RunSize): number {
  switch (size.shape) {
    case "rect":
    case "oval":
      return Math.max(size.width, size.height);
    case "round":
      return size.diameter;
    case "pipe":
      return size.nominalMm;
    default:
      return size.tradeSizeMm;
  }
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Steepest a leg can fall (or rise) and still count as horizontal for a tee: a drain at 1/2" per ft is 4%. */
const MAX_TEE_PITCH = 0.1;
const levelOrPitched = (d: RunPoint): boolean => !isVertical(d) && Math.abs(d.z) <= MAX_TEE_PITCH * Math.hypot(d.x, d.y);

function systemOf(model: ModelState, seg: RunSegment): { id: string; kind: SystemKind } {
  const sys = model.elements[seg.systemId];
  if (sys?.kind !== "mep_system") refuse("element_not_found", `The ${runLabel(model.elements, seg)} has no system`, [seg.id]);
  return { id: sys.id, kind: sys.systemKind };
}

// ------------------------------------------------------------------ elbow → tee

function elbowToTee(model: ModelState, cmd: Extract<ConnectCommand, { type: "elbow_to_tee" }>, exec: Execute): ExecuteResult {
  const elbow = model.elements[asElementId(cmd.fittingId)];
  if (elbow?.kind !== "run_fitting" || elbow.fittingType !== "elbow" || elbow.host || elbow.ports.length !== 2) {
    refuse("wrong_kind", `${cmd.fittingId} isn't a two-way elbow`, elbow ? [elbow.id] : []);
  }
  const name = runLabel(model.elements, elbow);
  const through = elbow.ports.find((p) => p.id === cmd.through);
  const other = elbow.ports.find((p) => p.id !== cmd.through);
  if (!through || !other) refuse("element_not_found", `The ${name} has no opening ${cmd.through}`, [elbow.id]);
  if (cmd.face) {
    const word = cmd.face === "top" ? "top" : "bottom";
    if (!peerReads(ROUTING_TAP_FACES_FEATURE)) refuse("unsupported_geometry", `A branch can't leave the ${word} of a run yet: the model server this model is open on is an older version that only takes branches from a run's sides. Tap its side, or try again once the server is updated`, [elbow.id]);
    const rises = isVertical(other.direction) && (cmd.face === "top" ? other.direction.z > 0 : other.direction.z < 0);
    // The leg that runs on is level, or pitched like a drain (a stack base: the drain runs on back through the corner, the stack drops into its top).
    if (!levelOrPitched(through.direction) || !rises) {
      refuse("unsupported_geometry", `The ${name} doesn't turn ${cmd.face === "top" ? "up" : "down"} from a level run, so its leg can't join that run's ${word}`, [elbow.id]);
    }
  } else if (!levelOrPitched(other.direction) || !(levelOrPitched(through.direction) || isVertical(through.direction))) {
    // An elbow that turns up or down may run its vertical leg on through the corner (a riser or stack): the level leg joins it as a branch.
    refuse("unsupported_geometry", `Only a level elbow turns into a tee (or an elbow whose riser runs on up or down through the corner); the ${name} turns up or down`, [elbow.id]);
  }
  if (!through.link || !other.link) refuse("unsupported_geometry", `Both openings of the ${name} have to be connected to make a tee there`, [elbow.id]);
  const trunk = segment(model, through.link.elementId, `What runs on through the ${name}`);
  // The branch leg may meet a straight piece, another fitting (a transition) or a part's connector: the branch is routed to whatever it met.
  const met = model.elements[asElementId(other.link.elementId)];
  if (met?.kind !== "run_segment" && met?.kind !== "run_fitting" && met?.kind !== "part") refuse("wrong_kind", `What the ${name} meets on its other side can't take a branch`, [elbow.id]);
  const branch = met.kind === "run_segment" ? met : null;
  const branchSize = branch?.size ?? other.size;
  const branchLabel = met.kind === "part" ? "connector it met" : runLabel(model.elements, met);
  const trunkEnd = through.link.port === "start" ? "start" : "end";
  const branchEnd = other.link.port;
  const branchRef = { elementId: other.link.elementId, port: other.link.port };
  const corner = elbow.position;
  const minStraight = model.settings.minStraightMm;
  const chain = new Chain(model, exec);
  chain.run({ type: "delete_elements", ids: [elbow.id], policy: "disconnect" }, `Taking out the ${name}`);
  // The trunk runs on through the corner, past where the branch leaves, and stays open there.
  const stub = Math.max(minStraight, across(branchSize)) + across(trunk.size) / 2;
  // A pitched drain runs on at its own fall.
  const onward = { x: -through.direction.x, y: -through.direction.y, z: -through.direction.z };
  const trunkNow = segment(chain.current, trunk.id, "The trunk");
  const endAt = trunkEnd === "start" ? trunkNow.start : trunkNow.end;
  const target = { x: corner.x + onward.x * stub, y: corner.y + onward.y * stub, z: corner.z + onward.z * stub };
  chain.run({ type: "drag_run", elementId: trunk.id, grip: trunkEnd, delta: { x: r3(target.x - endAt.x), y: r3(target.y - endAt.y), z: r3(target.z - endAt.z) } }, `Running the ${runLabel(model.elements, trunk)} through the corner`);
  // The other leg joins it as a branch, pulled back from the corner as far as the takeoff needs.
  const system = systemOf(model, trunk);
  // A drain is drawn the way it flows (routing falls from where it starts): from the branch leg down into the trunk.
  const gravity = trunk.domain === "pipe" && serviceOf(system.kind) === "drainage";
  const onTrunk = { kind: "run_branch", segmentId: trunk.id, ...(cmd.face ? { face: cmd.face } : {}) } as const;
  const onBranch = met.kind === "part" ? ({ kind: "part", partId: met.id, connectorId: branchRef.port } as const) : ({ kind: "run_end", elementId: branchRef.elementId, port: branchRef.port } as const);
  const branchPoint = branch ? (branchEnd === "start" ? branch.start : branch.end) : other.position;
  const route = (prefix: string): Command => ({
    type: "route_run",
    idPrefix: prefix,
    levelId: trunk.levelId,
    domain: trunk.domain,
    size: branchSize,
    system,
    points: [{ x: r3(corner.x), y: r3(corner.y) }],
    // Onto a face the route comes down (or up) from the leg's end to the face, as dragging an end onto it does.
    ...(cmd.face ? { elevationMm: r3(corner.z + (cmd.face === "top" ? 1 : -1) * hostHalfHeight(trunk.size)) } : {}),
    // Leaving a riser, a pressure branch has no trunk height to take: it runs at its own leg's height (a drain starts on that leg and takes it from there).
    ...(!cmd.face && !gravity && isVertical(through.direction) ? { elevationMm: r3(branchPoint.z) } : {}),
    from: gravity || cmd.face ? onBranch : onTrunk,
    to: gravity || cmd.face ? onTrunk : onBranch,
    ...(trunk.domain === "duct" || trunk.domain === "pipe" ? { insulation: (branch ?? trunk).insulation ?? null } : {}),
  });
  const away = { x: other.direction.x, y: other.direction.y, z: other.direction.z };
  let last: ExecuteResult | null = null;
  // A branch as big as the trunk needs a transition after its takeoff: room for both.
  const step = Math.max(minStraight, across(branchSize));
  // A straight piece is pulled back by its end, an in-line fitting (a transition) by its corner; a part stays where it is.
  const pull = branch ? ({ elementId: branch.id, grip: branchEnd === "start" ? "start" : "end" } as const) : met.kind === "run_fitting" ? ({ elementId: met.id } as const) : null;
  const backs = pull ? [0, 0.5, 1, 2, 3, 4].map((k) => k * step) : [0];
  for (const back of backs) {
    if (back > 0 && pull) {
      const pulled = chain.attempt({ type: "drag_run", ...pull, delta: { x: r3(away.x * back), y: r3(away.y * back), z: r3(away.z * back) } });
      if (!pulled.ok) break;
    }
    last = chain.attempt(route(`${cmd.idPrefix}-b`));
    if (last.ok) break;
    if (back > 0 && pull) {
      // Put the branch leg back before pulling it further.
      chain.attempt({ type: "drag_run", ...pull, delta: { x: r3(-away.x * back), y: r3(-away.y * back), z: r3(-away.z * back) } });
    }
  }
  if (!last?.ok) refuse(last ? stepCode(last.error.code) : "unsupported_geometry", `The ${branchLabel} can't join as a branch there: ${last?.error.message ?? "no room for the takeoff"}`, [elbow.id, met.id]);
  return chain.result(`The ${name} became a tee: the ${runLabel(model.elements, trunk)} runs on through the corner and ends open there`);
}

// ------------------------------------------------------------------ route, then flex into a connector

function routeIntoFlex(model: ModelState, cmd: Extract<ConnectCommand, { type: "route_into_flex" }>, exec: Execute): ExecuteResult {
  const chain = new Chain(model, exec);
  const prefix = cmd.route.idPrefix;
  chain.run({ type: "route_run", ...cmd.route }, "Routing up to the flex");
  // The route's own pieces are `<prefix>-s1`, `-s2`… in order (looked up by id, never a scan of the model); the flex leaves the last one, open at the last point.
  let open: RunSegment | null = null;
  for (let i = 1; ; i++) {
    const piece = chain.current.elements[asElementId(`${prefix}-s${i}`)];
    if (piece?.kind !== "run_segment") break;
    open = piece;
  }
  if (open?.links.end) open = null;
  if (!open) refuse("unsupported_geometry", "The run has no open end at its last point for the flex to leave from");
  chain.run({ type: "route_flex", segmentId: `${prefix}-flex`, from: { elementId: open.id, port: "end" }, to: cmd.to }, "Then flex into the connector");
  return chain.result(`Routed the ${runLabel(chain.current.elements, open)} and finished it with flex into the connector`);
}

// ------------------------------------------------------------------ auto connect

/** Plan point lists (with one rise or drop) a route between two open ends could take, simplest first. */
export function autoRoutePaths(a: { at: RunPoint; out: RunPoint }, b: { at: RunPoint; out: RunPoint }, clearMm: number): Array<Array<Vec2 & { elevationMm?: number }>> {
  const p1 = { x: a.at.x + a.out.x * clearMm, y: a.at.y + a.out.y * clearMm };
  const q1 = { x: b.at.x + b.out.x * clearMm, y: b.at.y + b.out.y * clearMm };
  const same = (u: Vec2, v: Vec2) => Math.hypot(u.x - v.x, u.y - v.y) < 1;
  const plans: Vec2[][] = [
    [p1, q1],
    [p1, { x: q1.x, y: p1.y }, q1],
    [p1, { x: p1.x, y: q1.y }, q1],
    [p1, { x: (p1.x + q1.x) / 2, y: p1.y }, { x: (p1.x + q1.x) / 2, y: q1.y }, q1],
    [p1, { x: p1.x, y: (p1.y + q1.y) / 2 }, { x: q1.x, y: (p1.y + q1.y) / 2 }, q1],
  ].map((plan) => plan.filter((p, i, all) => i === 0 || !same(p, all[i - 1] as Vec2)));
  const dz = Math.abs(b.at.z - a.at.z) > 1;
  const out: Array<Array<Vec2 & { elevationMm?: number }>> = [];
  for (const plan of plans) {
    const pts = plan.map((p) => ({ x: r3(p.x), y: r3(p.y) }));
    if (!dz) {
      out.push(pts);
      continue;
    }
    // One rise or drop, on a straight stretch: at the middle of each leg in turn, then at the first point.
    for (let i = 0; i + 1 < pts.length; i++) {
      const u = pts[i] as Vec2;
      const v = pts[i + 1] as Vec2;
      const mid = { x: r3((u.x + v.x) / 2), y: r3((u.y + v.y) / 2), elevationMm: r3(b.at.z) };
      out.push([...pts.slice(0, i + 1), mid, ...pts.slice(i + 1)]);
    }
    out.push(pts.map((p, i) => (i === 0 ? { ...p, elevationMm: r3(b.at.z) } : p)));
  }
  return out;
}

function autoConnect(model: ModelState, cmd: Extract<ConnectCommand, { type: "auto_connect_runs" }>, exec: Execute): ExecuteResult {
  const frame = heightFrameOf(model.elements[cmd.a.elementId]);
  const ia = portInfoIn(model.elements, { elementId: asElementId(cmd.a.elementId), port: cmd.a.port }, frame);
  const ib = portInfoIn(model.elements, { elementId: asElementId(cmd.b.elementId), port: cmd.b.port }, frame);
  if (!ia || !ib) refuse("element_not_found", "Pick two open ends of duct or pipe to connect");
  if (ia.link || ib.link) refuse("already_exists", "One of those ends is already connected");
  const segA = segment(model, cmd.a.elementId, "The first end");
  segment(model, cmd.b.elementId, "The second end");
  const upDownA = isVertical(ia.direction);
  const upDownB = isVertical(ib.direction);
  if (upDownA && upDownB) refuse("unsupported_geometry", "Both ends face up or down; route on from one of them to a level run, then connect");
  const size = ia.size ?? segA.size;
  const clear = Math.max(model.settings.minStraightMm, across(size) * 1.5);
  // An end facing down (a part's outlet) or up leaves straight out of it to the other end's height, then runs level: the route takes that height.
  const height = upDownA ? { elevationMm: r3(ib.position.z) } : upDownB ? { elevationMm: r3(ia.position.z) } : {};
  const level = (p: RunPoint, other: RunPoint, vertical: boolean): RunPoint => (vertical ? { x: p.x, y: p.y, z: other.z } : p);
  const at = { a: level(ia.position, ib.position, upDownA), b: level(ib.position, ia.position, upDownB) };
  const base = {
    type: "route_run" as const,
    idPrefix: cmd.idPrefix,
    ...height,
    levelId: segA.levelId,
    domain: segA.domain,
    size,
    system: systemOf(model, segA),
    from: { kind: "run_end" as const, elementId: cmd.a.elementId, port: cmd.a.port },
    to: { kind: "run_end" as const, elementId: cmd.b.elementId, port: cmd.b.port },
    ...(segA.domain === "duct" || segA.domain === "pipe" ? { insulation: segA.insulation ?? null } : {}),
  };
  // Face to face already: the plain route joins them.
  const direct = exec(model, { ...base, points: [] });
  if (direct.ok) return { ...direct, summary: [`Connected the two ends: ${sizeLabel(size)} ${systemKindLabelOf(model.elements, base.system.id, base.system.kind).toLowerCase()}`] };
  let first: string | null = null;
  for (const clearMm of [clear, clear * 2]) {
    for (const points of autoRoutePaths({ at: at.a, out: ia.direction }, { at: at.b, out: ib.direction }, clearMm)) {
      const r = exec(model, { ...base, points });
      if (r.ok) return { ...r, summary: [`Connected the two ends with a route of ${points.length + 1} legs`] };
      first ??= r.error.message;
    }
  }
  refuse("unsupported_geometry", `No square route joins those two ends (legs east-west, north-south or up and down, one rise): ${first ?? direct.error.message}`, [asElementId(cmd.a.elementId), asElementId(cmd.b.elementId)]);
}

// ------------------------------------------------------------------ stretch onto a side

function stretchToSide(model: ModelState, cmd: Extract<ConnectCommand, { type: "stretch_to_side" }>, exec: Execute): ExecuteResult {
  const info = portInfo(model.elements, { elementId: asElementId(cmd.from.elementId), port: cmd.from.port });
  if (!info) refuse("element_not_found", "That end isn't on a duct or pipe");
  if (info.link) refuse("already_exists", "That end is already connected");
  const piece = segment(model, cmd.from.elementId, "The dragged end");
  const trunk = segment(model, cmd.onto, "What it was dragged onto");
  if (trunk.id === piece.id) refuse("invalid_value", "A run can't tap into itself");
  // A sloped pipe (a drain at its fall) takes a branch on its side at its height where the branch meets it.
  const sloped = Math.abs(trunk.start.z - trunk.end.z) > 1;
  if (sloped && (trunk.domain !== "pipe" || !isPitchedOrLevel(trunk))) refuse("unsupported_geometry", `The ${runLabel(model.elements, trunk)} runs up and down; drag the end onto a level or sloped run`, [trunk.id]);
  if (isVertical(info.direction)) {
    if (sloped) refuse("unsupported_geometry", `The ${runLabel(model.elements, trunk)} slopes, so a branch joins its side, not its top or bottom; turn the end level first, or connect it with Connect into`, [piece.id, trunk.id]);
    return stretchOntoFace(model, cmd, exec, info, piece, trunk);
  }
  const ax = trunk.end.x - trunk.start.x;
  const ay = trunk.end.y - trunk.start.y;
  const out = info.direction;
  // Where the end's line meets the trunk's centreline in plan.
  const denom = out.x * ay - out.y * ax;
  if (Math.abs(denom) < 1e-6) refuse("unsupported_geometry", `The end runs alongside the ${runLabel(model.elements, trunk)}; drag it onto the side it faces`, [trunk.id]);
  const t = ((trunk.start.x - info.position.x) * ay - (trunk.start.y - info.position.y) * ax) / denom;
  if (t <= 0) refuse("unsupported_geometry", `The ${runLabel(model.elements, trunk)} is behind that end`, [trunk.id]);
  const hit = { x: r3(info.position.x + out.x * t), y: r3(info.position.y + out.y * t) };
  const s = ((hit.x - trunk.start.x) * ax + (hit.y - trunk.start.y) * ay) / (ax * ax + ay * ay);
  if (s < 0 || s > 1) refuse("unsupported_geometry", `That end doesn't line up with the ${runLabel(model.elements, trunk)}; drag it onto the duct itself`, [trunk.id]);
  const system = systemOf(model, piece);
  const base = {
    type: "route_run" as const,
    idPrefix: cmd.idPrefix,
    levelId: piece.levelId,
    domain: piece.domain,
    size: info.size ?? piece.size,
    system,
    from: { kind: "run_end" as const, elementId: piece.id, port: cmd.from.port },
    to: { kind: "run_branch" as const, segmentId: trunk.id },
    ...(piece.domain === "duct" || piece.domain === "pipe" ? { insulation: piece.insulation ?? null } : {}),
  };
  // The trunk's height where the end meets it (a sloped drain is lower downstream).
  const trunkZ = trunk.start.z + (trunk.end.z - trunk.start.z) * s;
  const rises = [0.25, 0.5, 0.75].map((k) => [{ x: r3(info.position.x + out.x * t * k), y: r3(info.position.y + out.y * t * k), elevationMm: r3(trunkZ) }, hit]);
  // At the trunk's height: straight on into it. Otherwise rise or drop on the way (to the trunk's height, which a tap needs).
  // A sloped trunk: the branch's own fall may bring it there with no drop, so that is tried first.
  const attempts: Array<Array<Vec2 & { elevationMm?: number }>> = Math.abs(info.position.z - trunkZ) <= 1 ? [[hit]] : sloped ? [[hit], ...rises] : rises;
  let first: string | null = null;
  for (const points of attempts) {
    const r = exec(model, { ...base, points });
    if (r.ok) return { ...r, summary: [`Continued into the ${runLabel(model.elements, trunk)} with a tap`] };
    first ??= r.error.message;
  }
  refuse("unsupported_geometry", `It can't tap into the ${runLabel(model.elements, trunk)} from there: ${first ?? "no room"}`, [piece.id, trunk.id]);
}

/** An end facing down onto a run below it taps its top face; facing up into a run above it, its bottom face. */
function stretchOntoFace(model: ModelState, cmd: Extract<ConnectCommand, { type: "stretch_to_side" }>, exec: Execute, info: NonNullable<ReturnType<typeof portInfo>>, piece: RunSegment, trunk: RunSegment): ExecuteResult {
  const name = runLabel(model.elements, trunk);
  const face = info.direction.z < 0 ? "top" : "bottom";
  const trunkZ = trunk.start.z;
  if (face === "top" ? info.position.z <= trunkZ : info.position.z >= trunkZ) {
    refuse("unsupported_geometry", `That end faces ${face === "top" ? "down" : "up"} but the ${name} is ${face === "top" ? "above" : "below"} it; drag it onto a run it points at`, [piece.id, trunk.id]);
  }
  const ax = trunk.end.x - trunk.start.x;
  const ay = trunk.end.y - trunk.start.y;
  const len2 = ax * ax + ay * ay;
  const k = ((info.position.x - trunk.start.x) * ax + (info.position.y - trunk.start.y) * ay) / len2;
  const off = Math.abs((info.position.x - trunk.start.x) * ay - (info.position.y - trunk.start.y) * ax) / Math.sqrt(len2);
  if (k < 0 || k > 1 || off > model.settings.connectorToleranceMm) {
    refuse("unsupported_geometry", `That end isn't over the ${name}'s centreline; move it over the run, then drag it onto the ${face}`, [piece.id, trunk.id]);
  }
  const hit = { x: r3(trunk.start.x + ax * k), y: r3(trunk.start.y + ay * k) };
  const half = hostHalfHeight(trunk.size);
  const r = exec(model, {
    type: "route_run",
    idPrefix: cmd.idPrefix,
    levelId: piece.levelId,
    domain: piece.domain,
    size: info.size ?? piece.size,
    system: systemOf(model, piece),
    elevationMm: r3(trunkZ + (face === "top" ? half : -half)),
    points: [hit],
    from: { kind: "run_end", elementId: piece.id, port: cmd.from.port },
    to: { kind: "run_branch", segmentId: trunk.id, face },
    ...(piece.domain === "duct" || piece.domain === "pipe" ? { insulation: piece.insulation ?? null } : {}),
  });
  if (!r.ok) refuse(stepCode(r.error.code), `It can't tap the ${face} of the ${name} from there: ${r.error.message}`, [piece.id, trunk.id]);
  return { ...r, summary: [`Continued into the ${face} of the ${name} with a tap`] };
}

/**
 * A straight piece's drag that is partly along it and partly up or down (east
 * and down on an east-west duct; a riser moved in plan and up): the along part,
 * then the square part. Null when it is one or the other (a single drag does
 * it), when it is at an angle in plan (still refused), or for a fitting.
 */
export function splitDragRun(model: ModelState, cmd: { readonly elementId: string; readonly delta: RunPoint; readonly grip?: "start" | "end" | undefined; readonly reroute?: boolean | undefined }): [Command, Command] | null {
  const el = model.elements[asElementId(cmd.elementId)];
  if (el?.kind !== "run_segment") return null;
  const v = { x: el.end.x - el.start.x, y: el.end.y - el.start.y, z: el.end.z - el.start.z };
  const len = Math.hypot(v.x, v.y, v.z);
  if (len < 1) return null;
  const axis = { x: v.x / len, y: v.y / len, z: v.z / len };
  const k = cmd.delta.x * axis.x + cmd.delta.y * axis.y + cmd.delta.z * axis.z;
  const along = { x: r3(axis.x * k), y: r3(axis.y * k), z: r3(axis.z * k) };
  const square = { x: r3(cmd.delta.x - along.x), y: r3(cmd.delta.y - along.y), z: r3(cmd.delta.z - along.z) };
  const tol = model.settings.connectorToleranceMm;
  if (Math.hypot(along.x, along.y, along.z) <= tol || Math.hypot(square.x, square.y, square.z) <= tol) return null;
  // One part level and the other plumb: a level piece along itself and up or down, or a riser in plan and along itself.
  const plumb = (q: RunPoint) => Math.hypot(q.x, q.y) <= tol;
  const flat = (q: RunPoint) => Math.abs(q.z) <= tol;
  if (!((flat(along) && plumb(square)) || (plumb(along) && flat(square)))) return null;
  const rest = { ...(cmd.grip ? { grip: cmd.grip } : {}), ...(cmd.reroute ? { reroute: true } : {}) };
  return [
    { type: "drag_run", elementId: cmd.elementId, delta: along, ...rest },
    { type: "drag_run", elementId: cmd.elementId, delta: square, ...rest },
  ];
}

/** Run `splitDragRun`'s two moves as one edit. */
export function executeSplitDrag(model: ModelState, steps: readonly [Command, Command], exec: Execute): ExecuteResult {
  const chain = new Chain(model, exec);
  chain.run(steps[0], "Moving it along itself");
  chain.run(steps[1], "Then moving it square to itself");
  return chain.result("Moved it along itself and square to itself in one step; what it meets followed");
}

export function executeConnectCommand(model: ModelState, command: ConnectCommand, exec: Execute): ExecuteResult {
  switch (command.type) {
    case "elbow_to_tee":
      return elbowToTee(model, command, exec);
    case "auto_connect_runs":
      return autoConnect(model, command, exec);
    case "route_into_flex":
      return routeIntoFlex(model, command, exec);
    case "stretch_to_side":
      return stretchToSide(model, command, exec);
  }
}
