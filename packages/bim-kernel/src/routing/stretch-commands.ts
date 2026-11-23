import { z } from "zod";
import { finish, guard, refuse, type AuthoredWrite, type ExecuteResult } from "../command-core";
import { KernelError, TrackedReader } from "../model";
import { draftElements } from "../store";
import { asElementId, type BimElement, type ElementId, type ModelState } from "../types";
import { chooseFitting, roomForFittings } from "./commands";
import { refitForSize } from "./fitting-follow";
import { familyMismatch, fittingFamily, paramIssue, resolveParams } from "./fittings/library";
import { straightPiece } from "./fittings/geometry";
import { add3, angleBetween, connectorAccepts, dot3, len3, partConnector, p3, round3, scale3, segmentAxis, sub3, withLink } from "./geometry";
import { RunPropagator } from "./propagate";
import { systemRules, domainWord, fittingLabel, sameSize, sizeFitsDomain, sizeLabel, transitionReason } from "./rules";
import { branchClearance, partLabelOf, runLabel } from "./validate";
import { runSizeSchema, type MepSystem, type PortRef, type RunFitting, type RunPoint, type RunPort, type RunSegment, type RunSize } from "./types";

/**
 * Splitting a run, and changing the size or shape of a stretch of it.
 *
 * - `split_run` cuts one segment in two at a point. The pieces meet end to
 *   end (a plain joint; there is no coupling fitting in the library), keep
 *   the size, the system and every connection, and the branches on either
 *   side stay on the piece they sit on.
 * - `resize_stretch` gives a set of segments (a run, a selection, or the
 *   stretch between two points on one segment) a new size or shape in one
 *   atomic edit. Elbows and caps between them follow; where a neighbour keeps
 *   its size a transition from the fitting library is placed (concentric,
 *   eccentric, rectangular-to-round, or the one given), and a transition left
 *   joining two equal sizes is taken out. A transition that doesn't fit the
 *   straight duct beside it refuses, the way `route_run` refuses a leg too
 *   short for its fittings.
 */

const idSchema = z.string().min(1).max(200);
const paramsSchema = z.record(z.string().min(1).max(40), z.union([z.number().finite(), z.string().max(40)]));

export const stretchCommandSchemas = [
  z.object({
    type: z.literal("split_run"),
    /** The new piece is this prefix plus -s1 (a retried request splits the same way). */
    idPrefix: z.string().min(1).max(80),
    segmentId: idSchema,
    /** Where to cut, along the segment from its start (mm). */
    atMm: z.number().finite().positive(),
  }),
  z.object({
    type: z.literal("resize_stretch"),
    /** New pieces are this prefix plus -s1… and new transitions -f1… */
    idPrefix: z.string().min(1).max(80),
    /** The segments that take the new size. With `fromMm` / `toMm`, exactly one. */
    segmentIds: z.array(idSchema).min(1).max(500),
    /** Only the stretch of the one segment between these distances from its start (mm). */
    fromMm: z.number().finite().min(0).optional(),
    toMm: z.number().finite().positive().optional(),
    size: runSizeSchema,
    /** The transition to place where a neighbour keeps its size; absent: each system's default. */
    transition: z.object({ family: z.string().min(1).max(80), params: paramsSchema.optional() }).optional(),
  }),
  z.object({
    type: z.literal("drag_run"),
    /** A straight piece (moves square to itself or along itself) or an in-line fitting (its corner moves). */
    elementId: idSchema,
    /** Model millimetres; z is up. */
    delta: z.object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() }),
    /** Move only this end of a straight piece (the elbow there, or an open end), e.g. to make a rise taller. */
    grip: z.enum(["start", "end"]).optional(),
    /** A leg pulled back past its elbow turns the other way: its 90° elbows flip, instead of refusing. */
    reroute: z.boolean().optional(),
  }),
] as const;

export const stretchCommandSchema = z.discriminatedUnion("type", [...stretchCommandSchemas]);
export type StretchCommand = z.infer<typeof stretchCommandSchema>;

const STRETCH_COMMAND_TYPES: ReadonlySet<string> = new Set(stretchCommandSchemas.map((s) => s.shape.type.value));

export function isStretchCommand(command: { type: string }): command is StretchCommand {
  return STRETCH_COMMAND_TYPES.has(command.type);
}

const MM_PER_FT = 304.8;
const feet = (mm: number) => `${Math.round((mm / MM_PER_FT) * 100) / 100} ft`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

interface Ctx {
  readonly reader: TrackedReader;
  readonly working: Record<string, BimElement>;
  readonly touched: Set<ElementId>;
  readonly model: ModelState;
  readonly prefix: string;
  segCount: number;
  fitCount: number;
}

function newCtx(model: ModelState, prefix: string): Ctx {
  return { reader: new TrackedReader(model), working: draftElements(model.elements), touched: new Set(), model, prefix, segCount: 0, fitCount: 0 };
}

function put(ctx: Ctx, el: BimElement): void {
  ctx.working[el.id] = el;
  ctx.touched.add(el.id);
}

function current(ctx: Ctx, id: ElementId): BimElement {
  // Pieces made earlier in this command (a split before a resize) aren't in the model yet.
  if (ctx.model.elements[id]) ctx.reader.get(id);
  const el = ctx.working[id];
  if (!el) refuse("element_not_found", `Element ${id} does not exist`, [id]);
  return el;
}

function newId(ctx: Ctx, kind: "s" | "f"): ElementId {
  const id = asElementId(`${ctx.prefix}-${kind}${kind === "s" ? ++ctx.segCount : ++ctx.fitCount}`);
  if (ctx.reader.find(id) || ctx.working[id]) refuse("already_exists", `${id} already exists; choose a new id prefix`, [id]);
  return id;
}

function systemOf(ctx: Ctx, el: RunSegment | RunFitting): MepSystem {
  const s = ctx.working[el.systemId];
  if (s?.kind !== "mep_system") refuse("element_not_found", `${el.id} belongs to system ${el.systemId}, which does not exist`, [el.id]);
  return s;
}

function segment(ctx: Ctx, id: string): RunSegment {
  const el = current(ctx, asElementId(id));
  if (el.kind !== "run_segment") refuse("wrong_kind", el.kind === "run_fitting" ? `The ${runLabel(ctx.working, el)} is a fitting; pick the straight duct or pipe beside it` : `${id} isn't a duct or pipe run`, [el.id]);
  return el;
}

// ------------------------------------------------------------------ split

/** Cut `seg` at `s` (mm from its start). The head keeps the id; returns both pieces. */
function splitAt(ctx: Ctx, seg: RunSegment, s: number): { head: RunSegment; tail: RunSegment } {
  const { model, working } = ctx;
  const name = runLabel(working, seg);
  const total = len3(sub3(seg.end, seg.start));
  const minStraight = model.settings.minStraightMm;
  const at = Math.round(s * 1000) / 1000;
  if (at <= 0 || at >= total) refuse("invalid_value", `The ${name} is ${feet(total)} long; split it somewhere along it, not at ${feet(at)}`, [seg.id]);
  if (at < minStraight || total - at < minStraight) {
    refuse("min_straight_length", `Splitting the ${name} at ${feet(at)} leaves a piece shorter than ${minStraight} mm; split at least that far from each end`, [seg.id]);
  }
  const u = segmentAxis(seg);
  const P = round3(add3(seg.start, scale3(u, at)));
  const clear = branchClearance(seg.domain, model.settings).end;
  const staying: ElementId[] = [];
  const moving: RunFitting[] = [];
  for (const id of seg.branches) {
    const b = current(ctx, id);
    if (b.kind !== "run_fitting" || !b.host) continue;
    if (b.host.s <= at - clear) staying.push(b.id);
    else if (b.host.s >= at + clear) moving.push(b);
    else refuse("outside_host", `The ${runLabel(working, b)} at ${feet(b.host.s)} is where the split goes; split clear of it or slide it first`, [b.id, seg.id]);
  }
  const tailId = newId(ctx, "s");
  const tail: RunSegment = {
    ...seg,
    id: tailId,
    version: 0,
    authoredRev: {},
    start: P,
    links: { start: { elementId: seg.id, port: "end" }, ...(seg.links.end ? { end: seg.links.end } : {}) },
    branches: moving.map((b) => b.id),
  };
  const head: RunSegment = { ...seg, end: P, links: { ...seg.links, end: { elementId: tailId, port: "start" } }, branches: staying };
  put(ctx, head);
  put(ctx, tail);
  if (seg.links.end) {
    const far = current(ctx, seg.links.end.elementId);
    const relinked = withLink(far, seg.links.end.port, { elementId: tailId, port: "end" });
    if (relinked) put(ctx, relinked);
  }
  for (const b of moving) {
    if (!b.host) continue;
    put(ctx, { ...b, host: { ...b.host, segmentId: tailId, s: Math.round((b.host.s - at) * 1000) / 1000 } });
  }
  return { head, tail };
}

function splitRun(model: ModelState, cmd: Extract<StretchCommand, { type: "split_run" }>): ExecuteResult {
  const ctx = newCtx(model, cmd.idPrefix);
  const seg = segment(ctx, cmd.segmentId);
  if (seg.links.end) ctx.reader.get(seg.links.end.elementId);
  const { head, tail } = splitAt(ctx, seg, cmd.atMm);
  for (const piece of [head, tail]) {
    const room = roomForFittings(ctx.working, piece);
    if (room) refuse("min_straight_length", `Split there and the piece ${room}`, [seg.id]);
  }
  const summary = [`Split the ${runLabel(model.elements, seg)} at ${feet(cmd.atMm)} into two pieces that keep its size and connections`];
  return finish(ctx.reader, ctx.working, ctx.touched, [], () => [], { summary });
}

// ------------------------------------------------------------------ resize a stretch

const ELBOW_FITTING_TYPE = "elbow" as const;
const BODY_FITTINGS: ReadonlySet<RunFitting["fittingType"]> = new Set([ELBOW_FITTING_TYPE, "offset", "cap"]);
const TAKEOFFS: ReadonlySet<RunFitting["fittingType"]> = new Set(["tap", "tee", "wye"]);

function widthOf(size: RunSize): number {
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

/** The branch rule: an air branch is narrower than its trunk; water and drain branches may match it. */
function branchTooBig(system: MepSystem, branch: RunSize, trunk: RunSize): string | null {
  const rules = systemRules(system.systemKind);
  const ok = rules.branchMayEqualTrunk ? widthOf(branch) <= widthOf(trunk) + 0.5 : widthOf(branch) < widthOf(trunk) - 0.5;
  if (ok) return null;
  return `a ${sizeLabel(branch)} branch would be ${rules.branchMayEqualTrunk ? "larger than" : "as wide as"} its ${sizeLabel(trunk)} trunk`;
}

/** Point where a segment end sits, and the direction out of the segment there. */
function endFrame(seg: RunSegment, end: "start" | "end"): { at: RunPoint; out: RunPoint } {
  const u = segmentAxis(seg);
  return end === "start" ? { at: seg.start, out: scale3(u, -1) } : { at: seg.end, out: u };
}

interface TransitionChoice {
  readonly family: string;
  readonly params?: Readonly<Record<string, number | string>>;
}

/** Place a transition at `seg`'s `end`, between it (taking `size`) and what it was linked to (keeping `outside`). */
function insertTransition(ctx: Ctx, seg: RunSegment, end: "start" | "end", outside: RunSize, size: RunSize, choice: TransitionChoice | undefined): RunFitting {
  const link = seg.links[end];
  const why = transitionReason(outside, size);
  if (why) refuse("profile_incompatible", why, [seg.id]);
  const system = systemOf(ctx, seg);
  const { at, out } = endFrame(seg, end);
  const id = newId(ctx, "f");
  let fields: Pick<RunFitting, "family" | "params">;
  if (choice) {
    const family = fittingFamily(choice.family);
    if (!family) refuse("element_not_found", `There is no fitting type ${choice.family} in the library`, [seg.id]);
    const mismatch = familyMismatch(family, { fittingType: "transition", domain: seg.domain, sizes: [outside, size] });
    if (mismatch) refuse("profile_incompatible", `A ${family.name} can't join ${sizeLabel(outside)} to ${sizeLabel(size)}: ${mismatch}`, [seg.id]);
    const bad = paramIssue(family, choice.params);
    if (bad) refuse("invalid_value", `${family.name}: ${bad}`, [seg.id]);
    const params = resolveParams(family, choice.params);
    fields = { family: family.id, ...(Object.keys(params).length > 0 ? { params } : {}) };
  } else {
    fields = chooseFitting(system, "transition", seg.domain, [outside, size], undefined, undefined).fields;
  }
  const port = (pid: string, direction: RunPoint, s: RunSize, l?: PortRef): RunPort => ({ id: pid, position: at, direction, size: s, ...(l ? { link: l } : {}) });
  // Fittings take the insulation of the duct or pipe they join, as routed ones do.
  const beside = link ? ctx.working[link.elementId] : undefined;
  const insulation = seg.insulation ?? (beside?.kind === "run_segment" || beside?.kind === "run_fitting" ? beside.insulation : undefined);
  const f: RunFitting = {
    id,
    version: 0,
    authoredRev: {},
    ...(seg.partition ? { partition: seg.partition } : {}),
    kind: "run_fitting",
    fittingType: "transition",
    label: fittingLabel("transition", systemRules(system.systemKind), null),
    domain: seg.domain,
    systemId: seg.systemId,
    levelId: seg.levelId,
    position: at,
    // Port a faces what keeps its size; the body grows from it into the resized piece on port b.
    ports: [port("a", out, outside, link), port("b", p3(-out.x, -out.y, -out.z), size, { elementId: seg.id, port: end })],
    ...fields,
    ...(insulation && (seg.domain === "duct" || seg.domain === "pipe") ? { insulation } : {}),
  };
  put(ctx, f);
  if (link) {
    const other = current(ctx, link.elementId);
    const relinked = withLink(other, link.port, { elementId: id, port: "a" });
    if (relinked) put(ctx, relinked);
  }
  const fresh = ctx.working[seg.id];
  if (fresh?.kind === "run_segment") put(ctx, { ...fresh, links: { ...fresh.links, [end]: { elementId: id, port: "b" } } });
  return f;
}

function resizeStretch(model: ModelState, cmd: Extract<StretchCommand, { type: "resize_stretch" }>): ExecuteResult {
  const ctx = newCtx(model, cmd.idPrefix);
  const size = cmd.size;
  if (size.shape === "oval" && size.width < size.height) refuse("invalid_value", "A flat oval is wider than it is tall; swap the width and height");
  const ids = [...new Set(cmd.segmentIds)];
  const removed: ElementId[] = [];
  const summary: string[] = [];

  // Between two points on one segment: cut there first; the middle piece is the stretch.
  if (cmd.fromMm !== undefined || cmd.toMm !== undefined) {
    if (ids.length !== 1) refuse("invalid_value", "A stretch between two points is on one segment; pick one");
    const seg = segment(ctx, ids[0] ?? "");
    if (seg.links.end) ctx.reader.get(seg.links.end.elementId);
    const total = len3(sub3(seg.end, seg.start));
    const from = cmd.fromMm ?? 0;
    const to = cmd.toMm ?? total;
    if (to <= from) refuse("invalid_value", `The stretch has to end after it starts (${feet(from)} to ${feet(to)})`, [seg.id]);
    let stretch = seg;
    const tol = model.settings.connectorToleranceMm;
    if (from > tol) stretch = splitAt(ctx, stretch, from).tail;
    if (to < total - tol) stretch = splitAt(ctx, stretch, to - from).head;
    ids.splice(0, ids.length, stretch.id);
    summary.push(`Split the ${runLabel(model.elements, seg)} at ${[from > tol ? feet(from) : null, to < total - tol ? feet(to) : null].filter(Boolean).join(" and ")}`);
  }

  const stretch = new Set<ElementId>();
  for (const id of ids) {
    const seg = segment(ctx, id);
    if (!sizeFitsDomain(size, seg.domain)) refuse("invalid_value", `${sizeLabel(size)} isn't a ${domainWord(seg.domain)} size; the ${runLabel(ctx.working, seg)} is ${domainWord(seg.domain)}`, [seg.id]);
    stretch.add(seg.id);
  }
  const before = new Map<ElementId, RunSize>();
  for (const id of stretch) {
    const seg = segment(ctx, id);
    before.set(seg.id, seg.size);
  }
  if ([...before.values()].every((s) => sameSize(s, size))) {
    const first = [...stretch][0];
    const el = first ? ctx.working[first] : undefined;
    refuse("invalid_value", stretch.size === 1 && el?.kind === "run_segment" ? `The ${runLabel(ctx.working, el)} is already ${sizeLabel(size)}` : `Every selected piece is already ${sizeLabel(size)}`, [...stretch]);
  }

  // New size on every piece first, so fittings between two resized pieces see both sides changed.
  const authored: AuthoredWrite[] = [];
  for (const id of stretch) {
    const seg = segment(ctx, id);
    if (sameSize(seg.size, size)) continue;
    put(ctx, { ...seg, size });
    authored.push({ elementId: seg.id, field: "size", value: size });
  }
  const inStretch = (id: ElementId | undefined) => id !== undefined && stretch.has(id);

  let added = 0;
  let dropped = 0;
  const transitionFamilies = new Set<string>();
  const hosts: RunSegment[] = [];
  const refits: string[] = [];
  const follow = (f: RunFitting, main?: RunSize): RunFitting => {
    const r = refitForSize(ctx.working, systemOf(ctx, f), f, main);
    if (r.note) refits.push(r.note);
    return r.fitting;
  };
  for (const id of stretch) {
    for (const end of ["start", "end"] as const) {
      const seg = segment(ctx, id);
      const link = seg.links[end];
      const old = before.get(seg.id) ?? seg.size;
      if (!link) continue;
      const other = current(ctx, link.elementId);
      if (other.kind === "run_segment") {
        if (inStretch(other.id) || sameSize(other.size, size)) continue;
        const f = insertTransition(ctx, seg, end, other.size, size, cmd.transition);
        added += 1;
        if (f.family) transitionFamilies.add(f.family);
        continue;
      }
      if (other.kind === "part") {
        const type = current(ctx, other.typeId);
        if (type.kind !== "part_type") continue;
        const conn = partConnector(other, type, link.port);
        if (!conn || connectorAccepts(conn.connector, size)) continue;
        const f = insertTransition(ctx, seg, end, old, size, cmd.transition);
        added += 1;
        if (f.family) transitionFamilies.add(f.family);
        continue;
      }
      if (other.kind !== "run_fitting") continue;
      if (TAKEOFFS.has(other.fittingType) && other.host) {
        const host = current(ctx, other.host.segmentId);
        if (host.kind === "run_segment") {
          const issue = branchTooBig(systemOf(ctx, seg), size, host.size);
          if (issue) refuse("profile_incompatible", `The ${runLabel(ctx.working, seg)} can't be ${sizeLabel(size)}: ${issue}; make the branch smaller or the trunk bigger`, [seg.id, host.id]);
        }
        put(ctx, follow({ ...other, ports: other.ports.map((p) => (p.id === link.port ? { ...p, size } : p)) }, host.kind === "run_segment" ? host.size : undefined));
        continue;
      }
      if (other.fittingType === "transition") {
        const ports = other.ports.map((p) => (p.id === link.port ? { ...p, size } : p));
        const [pa, pb] = ports;
        const bothSegments = pa?.link && pb?.link && ctx.working[pa.link.elementId]?.kind === "run_segment" && ctx.working[pb.link.elementId]?.kind === "run_segment";
        if (pa && pb && sameSize(pa.size, pb.size) && bothSegments && pa.link && pb.link) {
          // Equal on both sides now: take it out and join the two pieces end to end.
          const la = pa.link;
          const lb = pb.link;
          const a = withLink(current(ctx, la.elementId), la.port, lb);
          if (a) put(ctx, a);
          const b = withLink(current(ctx, lb.elementId), lb.port, la);
          if (b) put(ctx, b);
          delete ctx.working[other.id];
          ctx.touched.delete(other.id);
          removed.push(other.id);
          dropped += 1;
          continue;
        }
        put(ctx, follow({ ...other, ports }));
        continue;
      }
      if (BODY_FITTINGS.has(other.fittingType)) {
        // An elbow or offset between two resized pieces (or a cap on one) takes the new size; one with a neighbour that keeps its size gets a transition on this side.
        const outside = other.ports.some((p) => p.link && p.link.elementId !== seg.id && !inStretch(p.link.elementId));
        if (!outside) {
          put(ctx, follow({ ...other, ports: other.ports.map((p) => ({ ...p, size })) }));
          continue;
        }
        const port = other.ports.find((p) => p.id === link.port);
        const f = insertTransition(ctx, seg, end, port?.size ?? old, size, cmd.transition);
        added += 1;
        if (f.family) transitionFamilies.add(f.family);
      }
    }
    const seg = segment(ctx, id);
    if (seg.branches.length > 0) {
      for (const bid of seg.branches) {
        const b = current(ctx, bid);
        if (b.kind !== "run_fitting") continue;
        const branchSize = b.ports[0]?.size;
        if (!branchSize) continue;
        const issue = branchTooBig(systemOf(ctx, seg), branchSize, size);
        if (issue) refuse("profile_incompatible", `The ${runLabel(ctx.working, seg)} can't be ${sizeLabel(size)}: ${issue} (the ${runLabel(ctx.working, b)})`, [seg.id, b.id]);
        const refit = follow(b, size);
        if (refit !== b) put(ctx, refit);
      }
      hosts.push(seg);
    }
  }

  const prop = new RunPropagator(ctx.reader, ctx.working, ctx.touched);
  for (const host of hosts) {
    const fresh = ctx.working[host.id];
    if (fresh?.kind === "run_segment") prop.rehost(fresh);
  }

  // Real fittings take real length: a new or changed transition that doesn't fit refuses, and nothing changes.
  const check = new Set<ElementId>(stretch);
  for (const id of ctx.touched) {
    const el = ctx.working[id];
    if (el?.kind === "run_fitting" && el.fittingType === "transition") for (const p of el.ports) if (p.link) check.add(p.link.elementId);
  }
  for (const id of check) {
    const el = ctx.working[id];
    if (el?.kind !== "run_segment") continue;
    const room = roomForFittings(ctx.working, el);
    if (room) refuse("min_straight_length", `The new size doesn't fit: the ${runLabel(ctx.working, el)} ${room}. Resize a longer stretch, or pick a transition with a steeper wall angle`, [el.id]);
  }

  const resized = authored.length;
  summary.push(`${resized === 1 ? "One piece is" : `${resized} pieces are`} now ${sizeLabel(size)}`);
  if (added > 0) {
    const names = [...transitionFamilies].map((f) => fittingFamily(f)?.name.toLowerCase() ?? f);
    summary.push(`Added ${plural(added, "transition")}${names.length > 0 ? ` (${names.join(", ")})` : ""}`);
  }
  if (dropped > 0) summary.push(`Removed ${plural(dropped, "transition")} no longer needed`);
  summary.push(...refits);
  return finish(
    ctx.reader,
    ctx.working,
    ctx.touched,
    authored,
    () => authored.map((a) => ({ kind: "field_equals" as const, elementId: a.elementId, field: a.field, value: a.value })),
    { removedIds: removed, summary },
  );
}

// ------------------------------------------------------------------ direct drag

type DragCommand = Extract<StretchCommand, { type: "drag_run" }>;

/** Propagate a drag without judging the result: the working copy and what moved. */
function propagateDrag(model: ModelState, cmd: DragCommand): { ctx: Ctx; el: RunSegment | RunFitting; d: RunPoint } {
  const ctx = newCtx(model, "drag");
  const el = current(ctx, asElementId(cmd.elementId));
  if (el.kind !== "run_segment" && el.kind !== "run_fitting") refuse("wrong_kind", `${cmd.elementId} isn't a duct or pipe run; move parts with Move`, [el.id]);
  if (cmd.grip && el.kind !== "run_segment") refuse("invalid_value", `The ${runLabel(ctx.working, el)} has no ends to grab; drag it whole`, [el.id]);
  const d = round3(p3(cmd.delta.x, cmd.delta.y, cmd.delta.z));
  if (len3(d) < model.settings.connectorToleranceMm) refuse("invalid_value", "Drag it further to move it");
  const prop = new RunPropagator(ctx.reader, ctx.working, ctx.touched, new Set([el.id]));
  prop.drag(el.id, d, cmd.grip);
  return { ctx, el, d };
}

/** A touched piece's length measured along the way it ran before the drag (negative once it has been pulled back past its far end). */
function signedLength(before: RunSegment, after: RunSegment): number {
  return dot3(sub3(after.end, after.start), segmentAxis(before));
}

/** Fittings at either end of a piece that take some of its length, by name. */
function fittingsTakingLength(elements: Readonly<Record<string, BimElement>>, seg: RunSegment): { names: string[]; needMm: number } {
  const piece = straightPiece(elements, seg);
  const names: string[] = [];
  for (const end of ["start", "end"] as const) {
    const cut = end === "start" ? piece.cutStart : piece.cutEnd;
    const link = seg.links[end];
    const f = link ? elements[link.elementId] : undefined;
    if (cut > 0.5 && f?.kind === "run_fitting") names.push(f.fittingType === ELBOW_FITTING_TYPE ? `${f.angleDeg ?? 90}° elbow` : runLabel(elements, f));
  }
  return { names: [...new Set(names)], needMm: piece.cutStart + piece.cutEnd };
}

/** Turn a leg pulled back past its end the other way: each 90° elbow it meets faces it from the other side. */
function flipLeg(ctx: Ctx, seg: RunSegment): void {
  const name = runLabel(ctx.working, seg);
  if (seg.branches.length > 0) refuse("unsupported_geometry", `The ${name} carries ${plural(seg.branches.length, "branch")}, so it can't be turned the other way; drag it less, or move the branches off it first`, [seg.id]);
  for (const end of ["start", "end"] as const) {
    const link = seg.links[end];
    if (!link) continue;
    const other = current(ctx, link.elementId);
    if (other.kind !== "run_fitting" || other.fittingType !== ELBOW_FITTING_TYPE || other.host || other.ports.length !== 2) {
      refuse("unsupported_geometry", `The ${name} would run backwards into the ${runLabelOrPart(ctx, other)}, which can't turn the other way; drag it less`, [seg.id, other.id]);
    }
    const ports = other.ports.map((p) => (p.id === link.port ? { ...p, direction: p3(-p.direction.x, -p.direction.y, -p.direction.z) } : p));
    const [a, b] = ports;
    const turn = a && b ? 180 - angleBetween(a.direction, b.direction) : 0;
    if (Math.abs(turn - (other.angleDeg ?? 90)) > 0.5) {
      refuse("unsupported_geometry", `Turning the ${name} the other way would make the ${runLabel(ctx.working, other)} turn ${Math.round(turn)}°; only a square turn can flip. Drag it less`, [seg.id, other.id]);
    }
    put(ctx, { ...other, ports });
  }
}

function runLabelOrPart(ctx: Ctx, el: BimElement): string {
  if (el.kind === "part") return partLabelOf(ctx.working, el);
  if (el.kind === "run_segment" || el.kind === "run_fitting") return runLabel(ctx.working, el);
  return el.id;
}

/**
 * When a perpendicular drag on a straight segment hits an anchored part or a
 * hosted takeoff fitting that cannot move off its trunk, insert a clean 90°
 * jog (two elbows + connecting straight leg along `d`) at the blocked end(s)
 * so the segment moves freely while staying connected.
 */
function tryAutoJogDrag(model: ModelState, cmd: DragCommand): ExecuteResult | null {
  if (!cmd.reroute || cmd.grip) return null;
  const rawEl = model.elements[cmd.elementId];
  if (rawEl?.kind !== "run_segment") return null;
  const d = round3(p3(cmd.delta.x, cmd.delta.y, cmd.delta.z));
  const dist = len3(d);
  if (dist < model.settings.minStraightMm) return null;
  const u = segmentAxis(rawEl);
  if (Math.abs(dot3(u, scale3(d, 1 / dist))) > 1e-3) return null;

  const blockedEnds: Array<"start" | "end"> = [];
  for (const end of ["start", "end"] as const) {
    const link = rawEl.links[end];
    if (!link) continue;
    const neighbor = model.elements[link.elementId];
    if (!neighbor) continue;
    const canJog =
      neighbor.kind === "part" ||
      neighbor.kind === "run_segment" ||
      (neighbor.kind === "run_fitting" && (neighbor.host !== undefined || neighbor.fittingType === "transition"));
    if (!canJog) continue;
    const probeCtx = newCtx(model, "jog-probe");
    const probe = new RunPropagator(probeCtx.reader, probeCtx.working, probeCtx.touched, new Set([rawEl.id]));
    try {
      probe.translateInto(link, d);
    } catch (err) {
      if (err instanceof KernelError && (err.code === "anchored_would_move" || err.code === "unsupported_geometry")) {
        blockedEnds.push(end);
      }
    }
  }
  if (blockedEnds.length === 0) return null;

  // Deterministic full-ID hash + collision-free suffix so long segment IDs and multi-step batch_edits never collide.
  let h = 2166136261;
  for (let i = 0; i < rawEl.id.length; i++) {
    h ^= rawEl.id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const basePrefix = `jog-${rawEl.id.slice(0, 16)}-${(h >>> 0).toString(36)}-r${model.revision}`;
  let prefix = basePrefix;
  let attempt = 0;
  while (model.elements[`${prefix}-s1`] !== undefined || model.elements[`${prefix}-f1`] !== undefined) {
    attempt += 1;
    prefix = `${basePrefix}-${attempt}`;
  }
  const ctx = newCtx(model, prefix);
  const seg = segment(ctx, rawEl.id);
  const sys = systemOf(ctx, seg);
  const rules = systemRules(sys.systemKind);
  const uJog = scale3(d, 1 / dist);
  const movedStart = round3(add3(seg.start, d));
  const movedEnd = round3(add3(seg.end, d));
  const prop = new RunPropagator(ctx.reader, ctx.working, ctx.touched, new Set([seg.id]));

  const nextLinks: { start?: PortRef; end?: PortRef } = {
    ...(seg.links.start ? { start: seg.links.start } : {}),
    ...(seg.links.end ? { end: seg.links.end } : {}),
  };

  for (const end of ["start", "end"] as const) {
    const link = seg.links[end];
    if (!link) continue;
    if (!blockedEnds.includes(end)) {
      prop.translateInto(link, d);
      continue;
    }
    const pOld = end === "start" ? seg.start : seg.end;
    const pNew = end === "start" ? movedStart : movedEnd;
    const uOut = end === "start" ? scale3(u, -1) : u;
    const jogSegId = newId(ctx, "s");
    const elbow1Id = newId(ctx, "f");
    const elbow2Id = newId(ctx, "f");

    const choice = chooseFitting(sys, ELBOW_FITTING_TYPE, seg.domain, [seg.size, seg.size], 90, undefined);
    const label = fittingLabel(ELBOW_FITTING_TYPE, rules, null, 90);
    const inheritedPartition = seg.partition ? { partition: seg.partition } : {};
    const elbow1: RunFitting = {
      id: elbow1Id,
      kind: "run_fitting",
      domain: seg.domain,
      levelId: seg.levelId,
      ...inheritedPartition,
      systemId: seg.systemId,
      version: 0,
      authoredRev: {},
      fittingType: ELBOW_FITTING_TYPE,
      label,
      position: round3(pOld),
      angleDeg: 90,
      ports: [
        { id: "a", position: round3(pOld), direction: round3(uOut), size: seg.size, link },
        { id: "b", position: round3(pOld), direction: round3(uJog), size: seg.size, link: { elementId: jogSegId, port: "start" } },
      ],
      ...choice.fields,
    };
    const elbow2: RunFitting = {
      id: elbow2Id,
      kind: "run_fitting",
      domain: seg.domain,
      levelId: seg.levelId,
      ...inheritedPartition,
      systemId: seg.systemId,
      version: 0,
      authoredRev: {},
      fittingType: ELBOW_FITTING_TYPE,
      label,
      position: round3(pNew),
      angleDeg: 90,
      ports: [
        { id: "a", position: round3(pNew), direction: round3(scale3(uJog, -1)), size: seg.size, link: { elementId: jogSegId, port: "end" } },
        { id: "b", position: round3(pNew), direction: round3(scale3(uOut, -1)), size: seg.size, link: { elementId: seg.id, port: end } },
      ],
      ...choice.fields,
    };
    const jogSeg: RunSegment = {
      id: jogSegId,
      kind: "run_segment",
      domain: seg.domain,
      levelId: seg.levelId,
      ...inheritedPartition,
      systemId: seg.systemId,
      version: 0,
      authoredRev: {},
      start: round3(pOld),
      end: round3(pNew),
      size: seg.size,
      flow: seg.flow,
      links: {
        start: { elementId: elbow1Id, port: "b" },
        end: { elementId: elbow2Id, port: "a" },
      },
      branches: [],
      ...(seg.insulation ? { insulation: seg.insulation } : {}),
    };
    const neighbor = current(ctx, link.elementId);
    const updatedNeighbor = withLink(neighbor, link.port, { elementId: elbow1Id, port: "a" });
    if (!updatedNeighbor) return null;
    put(ctx, updatedNeighbor);
    put(ctx, elbow1);
    put(ctx, jogSeg);
    put(ctx, elbow2);
    nextLinks[end] = { elementId: elbow2Id, port: "b" };
  }

  // Move hosted branches along with `seg` and push `d` into their downstream legs.
  for (const bid of seg.branches) {
    const b = current(ctx, bid);
    if (b.kind !== "run_fitting") continue;
    put(ctx, {
      ...b,
      position: round3(add3(b.position, d)),
      ports: b.ports.map((p) => ({ ...p, position: round3(add3(p.position, d)) })),
    });
    for (const p of b.ports) if (p.link) prop.translateInto(p.link, d);
  }

  put(ctx, { ...seg, start: movedStart, end: movedEnd, links: nextLinks });

  for (const id of ctx.touched) {
    const piece = ctx.working[id];
    if (piece?.kind !== "run_segment") continue;
    const length = len3(sub3(piece.end, piece.start));
    if (length < model.settings.minStraightMm) {
      refuse("min_straight_length", `That would shrink the ${runLabel(ctx.working, piece)} to ${feet(length)}; the shortest straight piece is ${model.settings.minStraightMm} mm`, [piece.id]);
    }
    const room = roomForFittings(ctx.working, piece);
    if (room) refuse("min_straight_length", `That would leave the ${runLabel(ctx.working, piece)} too short: it ${room}`, [piece.id]);
  }

  const name = runLabel(model.elements, rawEl);
  return finish(ctx.reader, ctx.working, ctx.touched, [], () => [], {
    summary: [`Offset the ${name} ${feet(dist)} with ${plural(blockedEnds.length, "90° jog")}`],
  });
}

function dragRun(model: ModelState, cmd: DragCommand): ExecuteResult {
  let propagated: { ctx: Ctx; el: RunSegment | RunFitting; d: RunPoint };
  try {
    propagated = propagateDrag(model, cmd);
  } catch (err) {
    if (cmd.reroute && err instanceof KernelError && (err.code === "anchored_would_move" || err.code === "unsupported_geometry")) {
      const jogged = tryAutoJogDrag(model, cmd);
      if (jogged) return jogged;
    }
    throw err;
  }
  const { ctx, el, d } = propagated;
  const tol = model.settings.connectorToleranceMm;
  const flipped: string[] = [];
  for (const id of [...ctx.touched]) {
    const seg = ctx.working[id];
    const before = model.elements[id];
    if (seg?.kind !== "run_segment" || before?.kind !== "run_segment") continue;
    if (signedLength(before, seg) > tol) continue;
    const name = runLabel(ctx.working, seg);
    if (!cmd.reroute) {
      const { names } = fittingsTakingLength(model.elements, before);
      refuse("unsupported_geometry", `That would pull the ${name} back past ${names.length > 0 ? `the ${names.join(" and ")}` : "its other end"}; drag it less, or reroute it so the elbows turn the other way`, [seg.id]);
    }
    flipLeg(ctx, seg);
    flipped.push(name);
  }
  for (const id of ctx.touched) {
    const seg = ctx.working[id];
    if (seg?.kind !== "run_segment") continue;
    const before = model.elements[id];
    const wasLength = before?.kind === "run_segment" ? len3(sub3(before.end, before.start)) : 0;
    const length = len3(sub3(seg.end, seg.start));
    const wasFlipped = before?.kind === "run_segment" && signedLength(before, seg) <= tol;
    if (length < model.settings.minStraightMm && (length < wasLength || wasFlipped)) refuse("min_straight_length", `That would shrink the ${runLabel(ctx.working, seg)} to ${feet(length)}; the shortest straight piece is ${model.settings.minStraightMm} mm`, [seg.id]);
    const room = roomForFittings(ctx.working, seg);
    if (room && before?.kind === "run_segment" && (wasFlipped || !roomForFittings(model.elements, before))) refuse("min_straight_length", `That would leave the ${runLabel(ctx.working, seg)} too short: it ${room}`, [seg.id]);
  }
  const name = runLabel(model.elements, el);
  const summary = [`Moved the ${cmd.grip ? `${cmd.grip} of the ` : ""}${name} ${feet(len3(d))}; what it meets followed`];
  if (flipped.length > 0) summary.push(`Rerouted the ${flipped.join(" and ")} to run the other way; the elbows there turn the other way now`);
  return finish(ctx.reader, ctx.working, ctx.touched, [], () => [], { summary });
}

export interface DragLimit {
  /** The furthest the drag can go toward the request and stay valid; null when it can't move at all. */
  readonly accepted: RunPoint | null;
  /** `accepted` as a share of the request (1 = all of it). */
  readonly fraction: number;
  /** Why it stops short, in the operator's words; null when the whole drag is fine. */
  readonly binding: { readonly code: string; readonly message: string; readonly elementIds: readonly string[] } | null;
  /** Share of the request at which a leg would be pulled back past its elbow (the point `reroute` takes over); null when none would. */
  readonly flipsAt: number | null;
}

/**
 * How far a drag can go. The lengths of every piece it touches change in
 * proportion to the drag, so the first piece to hit what its fittings need
 * (or the shortest straight piece) sets the stop, solved directly; any other
 * refusal is found by bisection. Never returns an invalid position.
 */
export function dragLimit(model: ModelState, cmd: DragCommand): DragLimit {
  const full = guard(() => executeStretchCommand(model, cmd));
  if (full.ok) return { accepted: round3(p3(cmd.delta.x, cmd.delta.y, cmd.delta.z)), fraction: 1, binding: null, flipsAt: null };
  let ctx: Ctx;
  try {
    ctx = propagateDrag(model, { ...cmd, reroute: false }).ctx;
  } catch (err) {
    if (err instanceof KernelError) return { accepted: null, fraction: 0, binding: { code: err.code, message: err.message, elementIds: err.elementIds }, flipsAt: null };
    throw err;
  }
  let stop = 1;
  let flipsAt: number | null = null;
  let binding: DragLimit["binding"] = null;
  for (const id of ctx.touched) {
    const seg = ctx.working[id];
    const before = model.elements[id];
    if (seg?.kind !== "run_segment" || before?.kind !== "run_segment") continue;
    const l0 = len3(sub3(before.end, before.start));
    const l1 = signedLength(before, seg);
    if (l1 >= l0 - 1e-6) continue;
    const zero = l0 / (l0 - l1);
    if (zero <= 1) flipsAt = Math.min(flipsAt ?? 1, zero);
    const fit = fittingsTakingLength(ctx.working, seg);
    const need = Math.max(model.settings.minStraightMm, fit.needMm);
    const t = Math.max(0, (l0 - need) / (l0 - l1));
    if (t >= stop) continue;
    stop = t;
    const name = runLabel(model.elements, before);
    const message =
      fit.needMm >= model.settings.minStraightMm && fit.names.length > 0
        ? `the ${fit.names.join(" and ")} need${fit.names.length === 1 ? "s" : ""} ${feet(fit.needMm)} of the ${name}`
        : `the ${name} can't be shorter than ${feet(need)}`;
    binding = { code: "min_straight_length", message, elementIds: [seg.id] };
  }
  const at = (t: number) => round3(scale3(p3(cmd.delta.x, cmd.delta.y, cmd.delta.z), t));
  const fits = (t: number) => t > 0 && len3(at(t)) >= model.settings.connectorToleranceMm && guard(() => executeStretchCommand(model, { ...cmd, delta: at(t), reroute: false })).ok;
  // Back off a hair from the solved stop so rounding never lands on the wrong side of it.
  let lo = 0;
  let hi = binding ? stop : 1;
  const nudged = hi * (1 - 1e-6) - 0.01 / Math.max(1, len3(cmd.delta));
  if (binding && fits(nudged)) lo = nudged;
  else {
    for (let i = 0; i < 16 && hi - lo > 1e-4; i += 1) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) lo = mid;
      else hi = mid;
    }
  }
  if (!binding) binding = { code: full.error.code, message: full.error.message, elementIds: full.error.elementIds };
  return { accepted: lo > 0 ? at(lo) : null, fraction: lo, binding, flipsAt };
}

export function executeStretchCommand(model: ModelState, command: StretchCommand): ExecuteResult {
  switch (command.type) {
    case "split_run":
      return splitRun(model, command);
    case "resize_stretch":
      return resizeStretch(model, command);
    case "drag_run":
      return dragRun(model, command);
  }
}
