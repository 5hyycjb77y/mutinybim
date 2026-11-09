import { z } from "zod";
import {
  KernelError,
  TrackedReader,
  TranslateWorkingCopy,
  asElementId,
  finish,
  guard,
  otherEnd,
  refuse,
  requireKind,
  round,
  roundVec,
  runSizeSchema,
  sub,
  treeNetwork,
  type AuthoredWrite,
  type ElementId,
  type ExecuteResult,
  type ModelState,
  type PackCommand,
  type PackCommandDef,
} from "@permitzip/bim-kernel";
import {
  tapPosition,
} from "./types";
import { AirNetworkMove } from "./connections/translate";

/**
 * The duct halves of the three round-1 commands (`slide_branch`,
 * `resize_run`, `move_equipment`), owned by this add-on through
 * `PackCommandDef.claims`: the kernel parses and stores the command under its
 * own name and intents, and dispatches the case for a tap, a duct run or a
 * unit here. Routed runs (`run_fitting`, `run_segment`) stay the kernel's.
 * The logic is round 10's kernel code, moved as it was.
 */

const vec2Schema = z.object({ x: z.number().finite(), y: z.number().finite() });

function field<T>(command: PackCommand, name: string, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(command[name]);
  if (!parsed.success) refuse("invalid_value", `${command.type}: ${name} isn't what it takes`);
  return parsed.data;
}

/** Collect a run: the segment plus connected segments/elbows sharing its profile, stopping at taps, terminals, equipment. */
function collectRun(reader: TrackedReader, segmentId: ElementId): { runIds: ElementId[]; upstreamTapId: ElementId | null } {
  const start = requireKind(reader.get(segmentId), "duct_segment");
  const runIds: ElementId[] = [];
  const seen = new Set<ElementId>();
  const stack: ElementId[] = [start.id];
  let upstreamTapId: ElementId | null = null;
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const el = reader.get(id);
    if (el.kind === "tap") {
      upstreamTapId = el.id;
      continue;
    }
    if (el.kind !== "duct_segment" && el.kind !== "elbow") continue;
    runIds.push(el.id);
    for (const c of reader.connectionsOf(el.id)) {
      const mine = c.a.elementId === el.id ? c.a : c.b;
      stack.push(otherEnd(c, mine).elementId);
    }
  }
  return { runIds, upstreamTapId };
}

function slideBranch(model: ModelState, tapId: string, s: number): ExecuteResult {
  const reader = new TrackedReader(model);
  const tap = requireKind(reader.get(asElementId(tapId)), "tap");
  const host = reader.get(tap.hostId);
  // Which kinds host taps, and where a tap sits on one, are the add-ons' (the tree face of the pack set in force).
  const tree = treeNetwork();
  const from = tree.hostsTaps(host.kind) ? tree.placeTap(host, tap) : null;
  const to = from ? tree.placeTap(host, { s, side: tap.side }) : null;
  if (!from || !to) {
    throw new KernelError("wrong_kind", `${tap.id} hangs on ${host.id}, a ${host.kind}, and no add-on on this model lets a ${host.kind} carry branches, so the branch can't slide along it`, [tap.id, host.id]);
  }
  const d = roundVec(sub(to, from));
  const p = new TranslateWorkingCopy(reader);
  p.set({ ...tap, s: round(s) });
  new AirNetworkMove(p).pushAcross({ elementId: tap.id, end: "branch" }, d);
  return finish(reader, p.working, p.touched, [{ elementId: tap.id, field: "s", value: round(s) }], (m) => {
    const placed = m.elements[tap.id];
    return placed && placed.kind === "tap" ? [{ kind: "tap_at", tapId: tap.id, position: placed.position }] : [];
  });
}

function resizeRun(model: ModelState, segmentId: string, size: z.infer<typeof runSizeSchema>): ExecuteResult {
  const reader = new TrackedReader(model);
  if (size.shape !== "rect" && size.shape !== "round") {
    throw new KernelError("invalid_value", `This duct takes rectangular or round sizes; ${size.shape} isn't one`, [asElementId(segmentId)]);
  }
  const profile = size;
  const { runIds, upstreamTapId } = collectRun(reader, asElementId(segmentId));
  const p = new TranslateWorkingCopy(reader);
  const air = new AirNetworkMove(p);
  const authored: AuthoredWrite[] = [];
  for (const id of runIds) {
    const el = reader.get(id);
    if (el.kind === "duct_segment" || el.kind === "elbow") {
      p.set({ ...el, profile });
      authored.push({ elementId: id, field: "profile", value: profile });
    }
  }
  if (upstreamTapId) {
    const tap = requireKind(reader.get(upstreamTapId), "tap");
    p.set({ ...tap, profile });
    authored.push({ elementId: tap.id, field: "profile", value: profile });
  }
  // A wider or narrower host moves the face its taps sit on; push that into each branch.
  for (const id of runIds) {
    const resized = p.working[id];
    if (!resized || resized.kind !== "duct_segment") continue;
    // Values as they stood when this host's pass began (later sets do not feed back in).
    const hosted = reader.hostedOn(id).map((tapId) => p.working[tapId]);
    for (const other of hosted) {
      if (!other || other.kind !== "tap" || other.hostId !== id) continue;
      reader.get(other.id);
      const moved = roundVec(tapPosition(resized, other));
      p.set({ ...other, position: moved });
      air.pushAcross({ elementId: other.id, end: "branch" }, roundVec(sub(moved, other.position)));
    }
  }
  return finish(reader, p.working, p.touched, authored, () => authored.map((a) => ({ kind: "field_equals" as const, elementId: a.elementId, field: a.field, value: a.value })));
}

function moveEquipment(model: ModelState, equipmentId: string, delta: z.infer<typeof vec2Schema>): ExecuteResult {
  const reader = new TrackedReader(model);
  const eq = requireKind(reader.get(asElementId(equipmentId)), "equipment");
  const p = new TranslateWorkingCopy(reader);
  new AirNetworkMove(p).moveUnit(eq.id, roundVec(delta));
  return finish(reader, p.working, p.touched, p.authored, () => p.authored.map((a) => ({ kind: "field_equals" as const, elementId: a.elementId, field: a.field, value: a.value })));
}

/** The branch on a tap slides along its host. */
export const SLIDE_TAP_BRANCH: PackCommandDef = {
  type: "slide_branch.tap",
  schema: z.object({ type: z.literal("slide_branch.tap"), tapId: z.string().min(1), s: z.number().finite() }).strict(),
  claims: { command: "slide_branch", kinds: ["tap"] },
  execute: (model, command) => guard(() => slideBranch(model, field(command, "tapId", z.string()), field(command, "s", z.number().finite()))),
};

/** A duct run, its elbows and the tap feeding it take one size; branches on it follow the moved face. */
export const RESIZE_DUCT_RUN: PackCommandDef = {
  type: "resize_run.duct_segment",
  schema: z.object({ type: z.literal("resize_run.duct_segment"), segmentId: z.string().min(1), profile: runSizeSchema }).strict(),
  claims: { command: "resize_run", kinds: ["duct_segment"] },
  execute: (model, command) => guard(() => resizeRun(model, field(command, "segmentId", z.string()), field(command, "profile", runSizeSchema))),
};

/** A unit moves; the run off its outlet follows. */
export const MOVE_UNIT: PackCommandDef = {
  type: "move_equipment.equipment",
  schema: z.object({ type: z.literal("move_equipment.equipment"), equipmentId: z.string().min(1), delta: vec2Schema }).strict(),
  claims: { command: "move_equipment", kinds: ["equipment"] },
  execute: (model, command) => guard(() => moveEquipment(model, field(command, "equipmentId", z.string()), field(command, "delta", vec2Schema))),
};

export const MECHANICAL_LEGACY_COMMANDS: readonly PackCommandDef[] = [SLIDE_TAP_BRANCH, RESIZE_DUCT_RUN, MOVE_UNIT];
