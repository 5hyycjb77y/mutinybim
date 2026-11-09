import { z } from "zod";
import type { Command } from "../commands";
import { refuse, type ExecuteResult } from "../command-core";
import { KernelError } from "../model";
import { peerReads } from "../elements/feature";
import type { ConnectFace, SourceCandidate, SourceEndRef, SourcesForFace } from "../connections/faces";
import type { SystemKind } from "../parts";
import type { BimElement, ElementId, ModelState, Vec2 } from "../types";
import { Chain } from "./connect-commands";
import { FLEX_DOMAIN, FLEX_LENGTH_WARNING_MM } from "./flex";
import { connectorSize, isVertical, partConnector, portInfo } from "./geometry";
import { isGravity } from "./pipe/design";
import { isPitchedOrLevel } from "./pipe/gravity";
import { connectorDomainOf } from "./rules";
import { planDistanceToRun, runsNear } from "./run-index";
import { isRoutedDomain } from "./commands";
import { RUN_DOMAINS, type RunFitting, type RunPoint, type RunSegment, type RunSize } from "./types";
import { partLabelOf, runLabel } from "./validate";

/**
 * Connect into (contract 1.13.0): join one or many open ends (a part's
 * connector, or a run's start or end) into a run, or into the nearest run of
 * the same system that takes them, in one action. The answer is a plan per
 * source: which fittings join it, the slope the system's rule asks for, any
 * flexible length, and the commands that build it; or, for that source, a
 * refusal in words. Sources that can join land as one undo step; refused
 * ones are named with the reason and nothing is built for them.
 *
 * Which fitting joins which (a wye into a level run, a tee into an upright
 * one) is the system's fitting preferences, never the kernel's choice.
 * Peers that store what it builds advertise the feature.
 */
export const ROUTING_CONNECT_INTO_FEATURE = "routing:connect_into";

/** What contract 1.13.0's placeholder refused every request with; round 15 builds the planner and nothing returns it now. */
export const CONNECT_INTO_NOT_BUILT = "Connect into isn't built yet";

const idSchema = z.string().min(1).max(200);

/** An open end: a part's connector (its id) or a run's `start` / `end`, as `connect_runs` names one. */
export const connectIntoSourceSchema = z.object({ elementId: idSchema, port: z.string().min(1).max(40) }).strict();
export type ConnectIntoSource = z.infer<typeof connectIntoSourceSchema>;

/** At most this many sources in one request. */
export const MAX_CONNECT_INTO_SOURCES = 200;

export const connectIntoCommandSchemas = [
  z.object({
    type: z.literal("connect_into"),
    /** The ends to join, in the order they are planned. */
    from: z.array(connectIntoSourceSchema).min(1).max(MAX_CONNECT_INTO_SOURCES),
    /** The run they join, or the nearest run of each source's system that takes it. */
    into: z.union([idSchema, z.literal("nearest")]),
    /** New ids start with this (a retried request builds the same elements). */
    idPrefix: z.string().min(1).max(80),
  }),
] as const;

export type ConnectIntoCommand = z.infer<(typeof connectIntoCommandSchemas)[number]>;
/** The request, as the planner and the agent tool take it. */
export type ConnectInto = Omit<ConnectIntoCommand, "type">;

const TYPES: ReadonlySet<string> = new Set(connectIntoCommandSchemas.map((s) => s.shape.type.value));

export function isConnectIntoCommand(command: { readonly type: string }): command is ConnectIntoCommand {
  return TYPES.has(command.type);
}

/** One fitting the plan places, in order from the source to the run. */
export interface ConnectIntoFitting {
  /** The fitting type placed (a catalog or firm library part type id). */
  readonly partDefinitionId: string;
  /** What a person reads ("Wye and 1/8 bend", "Tee"). */
  readonly label: string;
}

/** How one source joins its run. */
export interface ConnectIntoSourcePlan {
  readonly source: ConnectIntoSource;
  /** The run it joins (the named one, or the nearest that takes it). */
  readonly intoRunId: ElementId;
  readonly fittings: readonly ConnectIntoFitting[];
  /** Rise over run the new pieces keep, from the system's slope rule; null when the system has none. */
  readonly slope: { readonly ratio: number } | null;
  /** A flexible length at the source, when the system allows one; null otherwise. */
  readonly flex: { readonly lengthMm: number } | null;
  /** The commands that build this source's connection (they run inside the plan's one batch). */
  readonly commands: readonly Command[];
}

/** A source that can't join, and why, in words. */
export interface ConnectIntoSourceRefusal {
  readonly source: ConnectIntoSource;
  readonly refused: string;
}

export type ConnectIntoAnswer = ConnectIntoSourcePlan | ConnectIntoSourceRefusal;

export interface ConnectIntoPlan {
  /** One answer per source, in request order. */
  readonly sources: readonly ConnectIntoAnswer[];
  /** One `batch_edits` building every source that can join; empty when none can. */
  readonly commands: readonly Command[];
}

export function isConnectIntoRefusal(answer: ConnectIntoAnswer): answer is ConnectIntoSourceRefusal {
  return "refused" in answer;
}

type Elements = Readonly<Record<string, BimElement>>;
type Execute = (model: ModelState, command: Command) => ExecuteResult;

type BatchStep = Extract<Command, { type: "batch_edits" }>["commands"][number];
const isBatchStep = (c: Command): c is Command & BatchStep => c.type !== "batch_edits";

/** One `batch_edits` of the steps (none of them is itself a batch). */
function batchOf(steps: readonly Command[]): Command {
  return { type: "batch_edits", label: "Connect into", commands: steps.filter(isBatchStep) };
}

let registeredExecute: Execute | null = null;

/** The kernel's command runner, registered once by `commands.ts` when it loads (it imports this module, so this one can't import it back). */
export function registerConnectIntoExecutor(exec: Execute): void {
  registeredExecute = exec;
}

function executor(): Execute {
  if (!registeredExecute) throw new Error("Connect into has no command runner: load @permitzip/bim-kernel's commands before planning a connection");
  return registeredExecute;
}

const FT = 304.8;
/** How far "nearest" looks for a run, widening: 10 ft, 30 ft, then 100 ft. */
const NEAREST_RADII_MM = [10 * FT, 30 * FT, 100 * FT] as const;
/** Runs tried per source, nearest first, before it is refused. */
const MAX_RUNS_TRIED = 3;
/** A run's end keeps this many shortest straight pieces clear of a new branch (the takeoff and a joint). */
const END_CLEAR_PIECES = 2;

interface SourceEnd {
  readonly source: ConnectIntoSource;
  readonly label: string;
  readonly position: RunPoint;
  readonly direction: RunPoint;
  readonly levelId: ElementId;
  /** What it carries, in the connector domain words its run would use. */
  readonly carries: string;
  /** A run end's own size; a part connector's is read against the run it joins. */
  readonly size: RunSize | null;
  readonly connectorSizeFor: ((like: RunSize) => RunSize | null) | null;
  readonly systemKind: SystemKind | null;
  /** A run end joins only its own system. */
  readonly systemId: ElementId | null;
  readonly part: { readonly partId: ElementId; readonly connectorId: string } | null;
  readonly ownRunId: ElementId | null;
}

function sourceEnd(elements: Elements, source: ConnectIntoSource): SourceEnd | string {
  const el = elements[source.elementId];
  if (!el) return `There is no ${source.elementId} in the model`;
  if (el.kind === "part") {
    const name = partLabelOf(elements, el);
    const type = elements[el.typeId];
    if (type?.kind !== "part_type") return `${name} has no part type to read its connectors from`;
    const w = partConnector(el, type, source.port);
    if (!w) return `${name} has no connector ${source.port}`;
    const label = `${name}'s ${w.connector.label.toLowerCase()}`;
    if (el.links?.[source.port]) return `${label} is already connected`;
    const conn = w.connector;
    return { source, label, position: w.position, direction: w.direction, levelId: el.levelId, carries: conn.domain, size: null, connectorSizeFor: (like) => connectorSize(conn, like), systemKind: conn.systemKind, systemId: null, part: { partId: el.id, connectorId: source.port }, ownRunId: null };
  }
  if (el.kind === "run_segment" || el.kind === "run_fitting") {
    const name = runLabel(elements, el);
    const info = portInfo(elements, { elementId: el.id, port: source.port });
    if (!info) return `${name} has no end called ${source.port}`;
    if (info.link) return `That end of ${name} is already connected`;
    const system = elements[el.systemId];
    const size = info.size ?? (el.kind === "run_segment" ? el.size : null);
    return { source, label: `the end of ${name}`, position: info.position, direction: info.direction, levelId: el.levelId, carries: connectorDomainOf(el.domain), size, connectorSizeFor: null, systemKind: system?.kind === "mep_system" ? system.systemKind : null, systemId: el.systemId, part: null, ownRunId: el.kind === "run_segment" ? el.id : null };
  }
  return `${source.elementId} isn't a part's connector or a run's open end`;
}

const planLength = (seg: Pick<RunSegment, "start" | "end">) => Math.hypot(seg.end.x - seg.start.x, seg.end.y - seg.start.y);

/** Why this run can't take the end, in words; null when it can. */
function runRefusal(elements: Elements, end: SourceEnd, seg: RunSegment): string | null {
  const name = runLabel(elements, seg);
  if (seg.id === end.ownRunId) return `${name} is the run that end belongs to`;
  if (connectorDomainOf(seg.domain) !== end.carries) return `${name} carries ${seg.domain}; ${end.label} takes ${end.carries}`;
  const system = elements[seg.systemId];
  if (system?.kind !== "mep_system") return `${name} has no system`;
  if (end.systemId ? system.id !== end.systemId : system.systemKind !== end.systemKind) return `${name} is on ${system.name}, a different system from ${end.label}`;
  if (seg.levelId !== end.levelId) return `${name} is on another level; a branch joins a run on its own level, so pick a run on ${end.label}'s level`;
  if (seg.flex) return `${name} is flexible; join the rigid run it comes off`;
  if (planLength(seg) >= 1 && Math.abs(seg.end.z - seg.start.z) > 1 && !(seg.domain === "pipe" && isPitchedOrLevel(seg))) return `${name} climbs at an angle; join a level, sloped or upright run`;
  return null;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
type PlanPoint = Vec2 & { elevationMm?: number };

/** One way to join the end to the run: the commands, run in order as one step. */
interface Attempt {
  readonly commands: (model: ModelState) => readonly Command[] | null;
}

function attemptsFor(model: ModelState, end: SourceEnd, trunk: RunSegment, prefix: string): Attempt[] {
  const elements = model.elements;
  const system = elements[trunk.systemId];
  if (system?.kind !== "mep_system") return [];
  const size = end.size ?? end.connectorSizeFor?.(trunk.size) ?? trunk.size;
  const minStraight = model.settings.minStraightMm;
  const from = end.part ? ({ kind: "part", partId: end.part.partId, connectorId: end.part.connectorId } as const) : ({ kind: "run_end", elementId: end.source.elementId, port: end.source.port } as const);
  const base = { type: "route_run" as const, idPrefix: prefix, levelId: trunk.levelId, domain: trunk.domain, size, system: { id: system.id, kind: system.systemKind }, from, to: { kind: "run_branch" as const, segmentId: trunk.id } };
  const route = (points: readonly PlanPoint[], elevationMm?: number): Attempt => ({ commands: () => [{ ...base, points: [...points], ...(elevationMm !== undefined ? { elevationMm: r3(elevationMm) } : {}) }] });
  const P = end.position;
  const d = end.direction;
  const upDown = isVertical(d);
  const gravity = trunk.domain === "pipe" && isGravity(system.systemKind);
  const L = planLength(trunk);

  // An upright run (a stack): the branch leaves it level, towards the end.
  if (L < 1) {
    const H = { x: r3(trunk.start.x), y: r3(trunk.start.y) };
    if (upDown) return d.z < 0 ? [1, 1.5, 2, 3].map((k) => route([H], P.z - k * FT)) : [];
    const P1 = { x: r3(P.x + d.x * minStraight * 2), y: r3(P.y + d.y * minStraight * 2) };
    return [route([H]), route([P1, { x: H.x, y: P1.y }, H]), route([P1, { x: P1.x, y: H.y }, H])];
  }

  const u = { x: (trunk.end.x - trunk.start.x) / L, y: (trunk.end.y - trunk.start.y) / L };
  const margin = Math.min(L / 2, END_CLEAR_PIECES * minStraight);
  const onTrunk = (q: Vec2) => {
    const t = Math.min(L - margin, Math.max(margin, (q.x - trunk.start.x) * u.x + (q.y - trunk.start.y) * u.y));
    return { at: { x: r3(trunk.start.x + u.x * t), y: r3(trunk.start.y + u.y * t) }, z: trunk.start.z + ((trunk.end.z - trunk.start.z) * t) / L };
  };
  const off = (q: Vec2, at: Vec2) => Math.hypot(q.x - at.x, q.y - at.y);
  const clear = 2 * minStraight;
  const out: Attempt[] = [];

  if (upDown) {
    const { at: H, z: zT } = onTrunk(P);
    const dist = off(P, H);
    if (dist < clear) {
      // Right over (or under) a level run or a sloped drain: into its top (or bottom).
      const sloped = Math.abs(trunk.end.z - trunk.start.z) > 1;
      if (sloped && !(gravity && isPitchedOrLevel(trunk))) return [refused(`the ${runLabel(elements, trunk)} slopes, and an end drops only into the top of a level run or a sloped drain. Move ${end.label} off the run and connect it from the side`)];
      const face = d.z < 0 ? "top" : "bottom";
      return [{ commands: () => [{ ...base, to: { kind: "run_branch", segmentId: trunk.id, face }, points: [H], elevationMm: r3(zT + (face === "top" ? halfHeight(trunk) : -halfHeight(trunk))) }] }];
    }
    // A part's connector facing up or down, off a run that flex is made in: a short rigid branch, then flex into the connector.
    if (trunk.domain === FLEX_DOMAIN && end.part) {
      // The rigid piece keeps room for its takeoff and a straight piece; the flex takes the rest, within its usual length.
      const reach = Math.min(dist - 3 * clear, Math.max(0, Math.sqrt(Math.max(0, FLEX_LENGTH_WARNING_MM ** 2 - (zT - P.z) ** 2)) * 0.8));
      if (reach >= FT) {
        const toward = { x: (P.x - H.x) / dist, y: (P.y - H.y) / dist };
        const E = { x: r3(H.x + toward.x * (dist - reach)), y: r3(H.y + toward.y * (dist - reach)) };
        const part = end.part;
        out.push({
          commands: (m) => {
            const branch: Command = { type: "route_run", idPrefix: prefix, levelId: trunk.levelId, domain: trunk.domain, size, system: base.system, from: { kind: "run_branch", segmentId: trunk.id }, points: [H, E], elevationMm: r3(zT) };
            const tried = executor()(m, branch);
            if (!tried.ok) return null;
            const open = openSegmentOf(tried.model, prefix);
            if (!open) return null;
            return [branch, { type: "route_flex", segmentId: `${prefix}-flex`, from: { elementId: open.id, port: "end" }, to: { partId: part.partId, connectorId: part.connectorId } }];
          },
        });
      }
    }
    out.push(route([H], zT));
    return out;
  }

  // Sideways: straight out of the end, then square into the run's side at its height there.
  const P1 = { x: r3(P.x + d.x * clear), y: r3(P.y + d.y * clear) };
  const straight = onTrunk(P);
  const facing = (straight.at.x - P.x) * d.x + (straight.at.y - P.y) * d.y;
  const across = Math.abs((straight.at.x - P.x) * d.y - (straight.at.y - P.y) * d.x);
  const levelWays = (points: readonly PlanPoint[], zT: number, riseAt: readonly Vec2[]): Attempt[] => {
    const ways: Attempt[] = [];
    // A drain's own fall (and the drop it adds by itself) may meet the run with no rise drawn: tried first.
    if (gravity || Math.abs(P.z - zT) <= 1) ways.push(route(points));
    if (Math.abs(P.z - zT) <= 1) return ways;
    for (const q of riseAt) {
      const i = points.findIndex((p) => p.x === q.x && p.y === q.y);
      ways.push(route(i >= 0 ? points.map((p, j) => (j === i ? { ...p, elevationMm: r3(zT) } : p)) : [{ ...q, elevationMm: r3(zT) }, ...points]));
    }
    return ways;
  };
  if (facing > clear && across < 1) {
    // Facing the run square on: one straight leg (with a rise or drop on it when the heights differ).
    const H = straight.at;
    const mid = (k: number) => ({ x: r3(P.x + (H.x - P.x) * k), y: r3(P.y + (H.y - P.y) * k) });
    out.push(...levelWays([H], straight.z, [mid(0.5), mid(0.25), mid(0.75)]));
    return out;
  }
  if (facing < -1 && across < 1) {
    // Facing away from it: out, along the run, and back square into its side.
    const P2 = { x: r3(P1.x + u.x * clear * 2), y: r3(P1.y + u.y * clear * 2) };
    const { at: H, z } = onTrunk(P2);
    out.push(...levelWays([P1, P2, H], z, [P1, P2]));
    return out;
  }
  const { at: H, z } = onTrunk(P1);
  if (off(P1, H) < clear) {
    // An end over the run, facing along it (a connector above the run it joins): out, then straight down into the run's top.
    // The last point is where the branch meets the run, so the drop sits on the point before it.
    const top = z + halfHeight(trunk);
    if (P.z <= top + minStraight) return [refused(`${end.label} sits over the ${runLabel(elements, trunk)} at its height, with no room to drop into it. Place it higher, or route the run below it`)];
    if (Math.abs(trunk.end.z - trunk.start.z) > 1 && !(gravity && isPitchedOrLevel(trunk))) return [refused(`the ${runLabel(elements, trunk)} slopes, and an end drops only into the top of a level run or a sloped drain. Move ${end.label} off the run and connect it from the side`)];
    out.push({ commands: () => [{ ...base, to: { kind: "run_branch", segmentId: trunk.id, face: "top" }, points: [{ ...P1, elevationMm: r3(top) }, H], elevationMm: r3(P.z) }] });
    return out;
  }
  out.push(...levelWays([P1, H], z, [P1]));
  return out;
}

/** Half the run's height: the distance from its centreline to its top. */
function halfHeight(trunk: RunSegment): number {
  return trunk.size.shape === "rect" || trunk.size.shape === "oval" ? trunk.size.height / 2 : trunk.size.shape === "round" ? trunk.size.diameter / 2 : 0;
}

/** A way that can't work, said in words (the planner reports the first one). */
function refused(message: string): Attempt {
  return {
    commands: () => {
      refuse("unsupported_geometry", message);
    },
  };
}

/** The runs a source tries, nearest first: the one named, or the nearest that take it (read through the run index, never the whole model). */
function runsFor(model: ModelState, end: SourceEnd, into: ConnectInto["into"]): { readonly runs: readonly RunSegment[]; readonly refused: string | null } {
  const elements = model.elements;
  if (into !== "nearest") {
    const seg = elements[into];
    if (seg?.kind !== "run_segment") return { runs: [], refused: `There is no straight run ${into} to connect into` };
    const why = runRefusal(elements, end, seg);
    return why ? { runs: [], refused: why } : { runs: [seg], refused: null };
  }
  for (const radius of NEAREST_RADII_MM) {
    const near = runsNear(elements, end.levelId, end.position, radius, (seg) => runRefusal(elements, end, seg) === null);
    if (near.length > 0) return { runs: near.slice(0, MAX_RUNS_TRIED), refused: null };
  }
  return { runs: [], refused: `No run of the same system is within ${Math.round(NEAREST_RADII_MM[2] / FT)} ft of ${end.label} on its level; route one, or pick the run to connect into` };
}

const suffix = (id: string) => Number(id.slice(id.lastIndexOf("-") + 2)) || 0;

/** What one source's connection placed, read off the model it left. */
/** The branch's first segment with a free end, by its ids (`<prefix>-s1`, `-s2`, …), not a pass over the model. */
function openSegmentOf(after: ModelState, prefix: string): RunSegment | undefined {
  for (let i = 1; ; i++) {
    const s = after.elements[`${prefix}-s${i}`];
    if (s?.kind !== "run_segment") return undefined;
    if (!s.links.end) return s;
  }
}

function described(after: ModelState, prefix: string): Pick<ConnectIntoSourcePlan, "fittings" | "slope" | "flex"> {
  const fittings: RunFitting[] = [];
  const segments: RunSegment[] = [];
  for (let i = 1; ; i++) {
    const f = after.elements[`${prefix}-f${i}`];
    if (f?.kind !== "run_fitting") break;
    fittings.push(f);
  }
  for (let i = 1; ; i++) {
    const s = after.elements[`${prefix}-s${i}`];
    if (s?.kind !== "run_segment") break;
    segments.push(s);
  }
  fittings.sort((a, b) => suffix(a.id) - suffix(b.id));
  const system = segments[0] ? after.elements[segments[0].systemId] : undefined;
  const pitched = system?.kind === "mep_system" && isGravity(system.systemKind) ? segments.find((s) => planLength(s) > 1 && Math.abs(s.end.z - s.start.z) > 0.01 && isPitchedOrLevel(s)) : undefined;
  const flexSeg = after.elements[`${prefix}-flex`];
  let flex: ConnectIntoSourcePlan["flex"] = null;
  if (flexSeg?.kind === "run_segment" && flexSeg.flex) {
    const pts = [flexSeg.start, ...flexSeg.flex.path, flexSeg.end];
    let length = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      if (a && b) length += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    }
    flex = { lengthMm: Math.round(length) };
  }
  return {
    fittings: fittings.map((f) => ({ partDefinitionId: f.family ?? f.fittingType, label: f.label ?? f.family ?? f.fittingType })),
    slope: pitched ? { ratio: Math.round((Math.abs(pitched.end.z - pitched.start.z) / planLength(pitched)) * 1e6) / 1e6 } : null,
    flex,
  };
}

function planWith(model: ModelState, request: ConnectInto, exec: Execute): { readonly plan: ConnectIntoPlan; readonly chain: Chain } {
  const chain = new Chain(model, exec);
  const sources: ConnectIntoAnswer[] = [];
  const steps: Command[] = [];
  request.from.forEach((source, i) => {
    const prefix = `${request.idPrefix}-${i + 1}`;
    const end = sourceEnd(chain.current.elements, source);
    if (typeof end === "string") {
      sources.push({ source, refused: end });
      return;
    }
    const { runs, refused } = runsFor(chain.current, end, request.into);
    if (refused !== null) {
      sources.push({ source, refused });
      return;
    }
    let why: string | null = null;
    for (const run of runs) {
      for (const attempt of attemptsFor(chain.current, end, run, prefix)) {
        let commands: readonly Command[] | null;
        try {
          commands = attempt.commands(chain.current);
        } catch (err) {
          if (!(err instanceof KernelError)) throw err;
          why ??= err.message;
          continue;
        }
        const [only, ...more] = commands ?? [];
        if (!only) continue;
        const r = chain.attempt(more.length === 0 ? only : batchOf([only, ...more]));
        if (!r.ok) {
          why ??= r.error.message;
          continue;
        }
        sources.push({ source, intoRunId: run.id, ...described(chain.current, prefix), commands: [only, ...more] });
        steps.push(only, ...more);
        return;
      }
    }
    const first = runs[0];
    const reason = why ?? "no way in fits where it sits (square into its side, with a drop, or into its top). Route the branch from the run by hand";
    sources.push({ source, refused: `${end.label} can't join ${first ? `the ${runLabel(chain.current.elements, first)}` : "a run"}: ${reason}` });
  });
  return { plan: { sources, commands: steps.length > 0 ? [batchOf(steps)] : [] }, chain };
}

/** The plan for a request: each source's fittings, slope and flex, or its refusal in words. Nothing is changed. */
export function planConnectInto(model: ModelState, request: ConnectInto): ConnectIntoPlan {
  return planWith(model, request, executor()).plan;
}

/** Run `connect_into`: every source that can join, as one edit (one undo); the ones that can't are named with the reason. */
export function executeConnectIntoCommand(model: ModelState, command: ConnectIntoCommand, exec: Execute = executor()): ExecuteResult {
  if (!peerReads(ROUTING_CONNECT_INTO_FEATURE)) {
    refuse("unsupported_geometry", "Connect into can't run on this model yet: the model server it is open on is an older version. Route each connection by hand, or try again once the server is updated");
  }
  const { plan, chain } = planWith(model, command, exec);
  const refusals = plan.sources.filter(isConnectIntoRefusal);
  const joined = plan.sources.length - refusals.length;
  if (joined === 0) {
    refuse("unsupported_geometry", refusals.length === 1 ? (refusals[0]?.refused ?? "Nothing could be connected") : `None could be connected. ${refusals.map((r) => r.refused).join(". ")}`);
  }
  const done = chain.result(`Connected ${joined} of ${plan.sources.length}`);
  return { ...done, summary: [`Connected ${joined} of ${plan.sources.length}${refusals.length > 0 ? `; ${refusals.length} not connected` : ""}`, ...refusals.map((r) => r.refused)] };
}

// ------------------------------------------------------------------ the "+" grip on physical networks

/** Connector domains a run is routed in (what the grip can offer runs for). */
const ROUTED_CONNECTOR_DOMAINS: ReadonlySet<string> = new Set(RUN_DOMAINS.filter(isRoutedDomain).map(connectorDomainOf));
/** Runs the grip lists for one end, nearest first. */
const GRIP_CANDIDATES = 5;
export const PHYSICAL_SOURCE_WORD = "run";
export const PHYSICAL_SOURCE_PROMPT = "Needs connecting. Drag to a run of its system";

/** The end the grip serves: the one named, else a part's first open connector a run can take. */
function gripPort(elements: Elements, ref: SourceEndRef): string | null {
  if (ref.end !== undefined) return ref.end;
  const el = elements[ref.elementId];
  if (el?.kind !== "part") return null;
  const type = elements[el.typeId];
  if (type?.kind !== "part_type") return null;
  for (const c of type.definition.connectors) {
    if (!ROUTED_CONNECTOR_DOMAINS.has(c.domain) || el.links?.[c.id]) continue;
    return c.id;
  }
  return null;
}

/**
 * The "+" grip's sources for a physical network (any service whose runs are
 * routed, an add-on's included): the nearest runs of the end's own system, through the run
 * index. An add-on's network adapter row names it as its `sourcesFor`; null
 * for an end that is served already or that no run takes.
 */
export const physicalSourcesFor: SourcesForFace = (model, ref) => {
  const elements = model.elements;
  const port = gripPort(elements, ref);
  if (port === null) return null;
  const end = sourceEnd(elements, { elementId: ref.elementId, port });
  if (typeof end === "string" || !ROUTED_CONNECTOR_DOMAINS.has(end.carries)) return null;
  const candidates: SourceCandidate[] = [];
  for (const radius of NEAREST_RADII_MM) {
    for (const seg of runsNear(elements, end.levelId, end.position, radius, (s) => runRefusal(elements, end, s) === null).slice(0, GRIP_CANDIDATES)) {
      const distanceMm = Math.round(planDistanceToRun(end.position, seg));
      candidates.push({ sourceId: seg.id, label: runLabel(elements, seg), distanceMm, note: `${runLabel(elements, seg)}, ${Math.round((distanceMm / FT) * 10) / 10} ft` });
    }
    if (candidates.length > 0) break;
  }
  return { sourceWord: PHYSICAL_SOURCE_WORD, prompt: PHYSICAL_SOURCE_PROMPT, candidates, refused: [] };
};

/** The grip's drop on a physical network: `connect_into` the run dropped on (one edit), or the reason it can't, in words. */
export const physicalConnect: ConnectFace = (model, ref, source, newId) => {
  const elements = model.elements;
  const port = gripPort(elements, ref);
  const seg = elements[source.sourceId];
  if (port === null || seg?.kind !== "run_segment") return null;
  const from = [{ elementId: ref.elementId, port }];
  const answer = planConnectInto(model, { from, into: seg.id, idPrefix: newId }).sources[0];
  if (!answer) return null;
  if (isConnectIntoRefusal(answer)) return { ok: false, reason: answer.refused };
  const end = sourceEnd(elements, from[0] ?? { elementId: ref.elementId, port });
  const who = typeof end === "string" ? ref.elementId : end.label;
  return { ok: true, commands: [{ type: "connect_into", from, into: seg.id, idPrefix: newId }], labels: [`Connect ${who} into the ${runLabel(elements, seg)}`] };
};
