import { z } from "zod";
import { finish, refuse, type AuthoredWrite, type ExecuteResult } from "./command-core";
import { round, roundVec } from "./geometry";
import { TrackedReader, requireKind } from "./model";
import { draftElements, elementsOfKind } from "./store";
import type { Command } from "./commands";
import { Chain } from "./routing/connect-commands";
import { asElementId, type ElementId, type ModelElementBase, type ModelState, type Vec2 } from "./types";

/**
 * A mounting plane: a flat, level surface at a height above a level, covering
 * a plan rectangle, that air devices and other parts are placed on where
 * there is no ceiling to place them on (an open structure, a room the
 * architect hasn't modelled a ceiling in). Parts placed on it remember it, and
 * move up or down with it, with their connected duct following.
 */
export interface MountingPlane extends ModelElementBase {
  readonly kind: "mounting_plane";
  readonly name: string;
  readonly levelId: ElementId;
  /** Height of the plane above its level's floor, mm. Authored. */
  readonly heightMm: number;
  /** Plan rectangle it covers. Authored. */
  readonly min: Vec2;
  readonly max: Vec2;
}

const idSchema = z.string().min(1).max(200);
const vec2Schema = z.object({ x: z.number().finite(), y: z.number().finite() });
const heightSchema = z.number().finite().min(-30_000).max(30_000);

export const mountingPlaneCommandSchemas = [
  z.object({
    type: z.literal("create_mounting_plane"),
    /** Chosen by the sender so a retried request makes the same plane. */
    planeId: idSchema,
    levelId: idSchema,
    name: z.string().trim().min(1).max(60),
    heightMm: heightSchema,
    /** Two opposite corners of the plan rectangle it covers. */
    corner1: vec2Schema,
    corner2: vec2Schema,
  }),
  z.object({
    type: z.literal("set_mounting_plane"),
    planeId: idSchema,
    name: z.string().trim().min(1).max(60).optional(),
    /** A new height above the level: the parts on it move with it. */
    heightMm: heightSchema.optional(),
    corner1: vec2Schema.optional(),
    corner2: vec2Schema.optional(),
  }),
] as const;

export const mountingPlaneCommandSchema = z.discriminatedUnion("type", [...mountingPlaneCommandSchemas]);
export type MountingPlaneCommand = z.infer<typeof mountingPlaneCommandSchema>;

const TYPES: ReadonlySet<string> = new Set(mountingPlaneCommandSchemas.map((s) => s.shape.type.value));

export function isMountingPlaneCommand(command: { readonly type: string }): command is MountingPlaneCommand {
  return TYPES.has(command.type);
}

const MIN_SIDE_MM = 300;
const MM_PER_FT = 304.8;

function feet(mm: number): string {
  return `${Math.round((mm / MM_PER_FT) * 100) / 100} ft`;
}

function rect(a: Vec2, b: Vec2): { min: Vec2; max: Vec2 } {
  const min = roundVec({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) });
  const max = roundVec({ x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) });
  if (max.x - min.x < MIN_SIDE_MM || max.y - min.y < MIN_SIDE_MM) refuse("invalid_value", `A mounting plane needs both sides at least ${feet(MIN_SIDE_MM)}; this one is ${feet(max.x - min.x)} by ${feet(max.y - min.y)}`);
  return { min, max };
}

/** Is a plan point on the plane (its edge counts)? */
export function onMountingPlane(plane: Pick<MountingPlane, "min" | "max">, p: Vec2, tolMm = 1): boolean {
  return p.x >= plane.min.x - tolMm && p.x <= plane.max.x + tolMm && p.y >= plane.min.y - tolMm && p.y <= plane.max.y + tolMm;
}

/** The model's mounting planes, optionally on one level. */
export function mountingPlanes(model: Pick<ModelState, "elements">, levelId?: string): MountingPlane[] {
  return elementsOfKind(model.elements, "mounting_plane").filter((el) => levelId === undefined || el.levelId === levelId);
}

/** A mounting plane under the pointer, and where on it the pointer is. */
export interface MountingPlaneHit {
  readonly plane: MountingPlane;
  /** Plan point on the plane under the pointer. */
  readonly point: Vec2;
  /** The plane's absolute height (its level's floor plus its own height), mm. */
  readonly elevationMm: number;
}

/**
 * The mounting plane under the pointer, offered as the place a part goes. `pointAt(elevationMm)`
 * is where the pointer's ray meets the level plane at that height (null: it never does). A view
 * looks down, so of the planes the ray crosses inside their rectangle the highest is the one seen
 * first. `levelIds` keeps the answer to some levels (a plan offers its own level's planes).
 * Reads the planes through the kind index, never the whole model.
 */
export function mountingPlaneUnder(
  model: Pick<ModelState, "elements">,
  pointAt: (elevationMm: number) => Vec2 | null,
  levelIds?: ReadonlySet<string>,
): MountingPlaneHit | null {
  let best: MountingPlaneHit | null = null;
  for (const plane of mountingPlanes(model)) {
    if (levelIds && !levelIds.has(plane.levelId)) continue;
    const level = model.elements[plane.levelId];
    if (level?.kind !== "level") continue;
    const elevationMm = level.elevationMm + plane.heightMm;
    if (best && best.elevationMm >= elevationMm) continue;
    const point = pointAt(elevationMm);
    if (point && onMountingPlane(plane, point)) best = { plane, point, elevationMm };
  }
  return best;
}

/** Parts placed on a plane (read through the kind index): only a height change needs them. */
export function partsOnPlane(model: Pick<ModelState, "elements">, planeId: string): ElementId[] {
  return elementsOfKind(model.elements, "part").filter((el) => el.planeId === planeId).map((el) => el.id);
}

function createPlane(model: ModelState, cmd: Extract<MountingPlaneCommand, { type: "create_mounting_plane" }>): ExecuteResult {
  const reader = new TrackedReader(model);
  const id = asElementId(cmd.planeId);
  if (reader.find(id)) refuse("already_exists", `${cmd.planeId} already exists; choose a new id`, [id]);
  const level = requireKind(reader.get(asElementId(cmd.levelId)), "level");
  const clash = mountingPlanes(model, level.id).find((p) => p.name.toLowerCase() === cmd.name.toLowerCase());
  if (clash) refuse("already_exists", `${level.name} already has a mounting plane called ${clash.name}`, [clash.id]);
  const { min, max } = rect(cmd.corner1, cmd.corner2);
  const plane: MountingPlane = {
    id,
    kind: "mounting_plane",
    version: 0,
    authoredRev: {},
    partition: { level: level.name, zone: "Z1", discipline: "architecture" },
    name: cmd.name,
    levelId: level.id,
    heightMm: round(cmd.heightMm),
    min,
    max,
  };
  const working = draftElements(model.elements);
  working[id] = plane;
  return finish(reader, working, [id], [{ elementId: id, field: "heightMm", value: plane.heightMm }], () => []);
}

function updatePlane(model: ModelState, cmd: Extract<MountingPlaneCommand, { type: "set_mounting_plane" }>): ExecuteResult {
  const reader = new TrackedReader(model);
  const plane = requireKind(reader.get(asElementId(cmd.planeId)), "mounting_plane");
  if (cmd.name !== undefined && cmd.name.toLowerCase() !== plane.name.toLowerCase()) {
    const clash = mountingPlanes(model, plane.levelId).find((p) => p.id !== plane.id && p.name.toLowerCase() === cmd.name?.toLowerCase());
    if (clash) refuse("already_exists", `This level already has a mounting plane called ${clash.name}`, [clash.id]);
  }
  if ((cmd.corner1 === undefined) !== (cmd.corner2 === undefined)) refuse("invalid_value", "Give both corners to change the plane's rectangle");
  const area = cmd.corner1 && cmd.corner2 ? rect(cmd.corner1, cmd.corner2) : { min: plane.min, max: plane.max };
  const next: MountingPlane = { ...plane, ...(cmd.name !== undefined ? { name: cmd.name } : {}), ...(cmd.heightMm !== undefined ? { heightMm: round(cmd.heightMm) } : {}), ...area };
  const working = draftElements(model.elements);
  working[plane.id] = next;
  const authored: AuthoredWrite[] = [];
  if (cmd.heightMm !== undefined) authored.push({ elementId: plane.id, field: "heightMm", value: next.heightMm });
  if (cmd.name !== undefined) authored.push({ elementId: plane.id, field: "name", value: next.name });
  return finish(reader, working, [plane.id], authored, () => authored.map((a) => ({ kind: "field_equals" as const, elementId: a.elementId, field: a.field, value: a.value })));
}

type Execute = (model: ModelState, command: Command) => ExecuteResult;

/**
 * A height change moves the plane's parts by the same amount, the way Move
 * moves a part up or down (connected duct follows or the edit is refused with
 * the reason), then the plane itself: one edit, one undo.
 */
function setPlane(model: ModelState, cmd: Extract<MountingPlaneCommand, { type: "set_mounting_plane" }>, exec: Execute): ExecuteResult {
  const plane = model.elements[cmd.planeId];
  if (plane?.kind !== "mounting_plane") return updatePlane(model, cmd);
  const dz = cmd.heightMm === undefined ? 0 : round(cmd.heightMm - plane.heightMm);
  const hosted = dz === 0 ? [] : partsOnPlane(model, plane.id);
  if (hosted.length === 0) return updatePlane(model, cmd);
  const chain = new Chain(model, exec);
  chain.run({ type: "move_elements", ids: hosted, delta: { x: 0, y: 0 }, dzMm: dz }, `Moving the ${hosted.length === 1 ? "part" : `${hosted.length} parts`} on ${plane.name}`);
  chain.step((m) => updatePlane(m, cmd), `Changing ${plane.name}`);
  return chain.result(`${plane.name} is now at ${feet(round(cmd.heightMm ?? plane.heightMm))}; ${hosted.length === 1 ? "the part on it moved" : `the ${hosted.length} parts on it moved`} ${dz > 0 ? "up" : "down"} ${feet(Math.abs(dz))} with it`);
}

export function executeMountingPlaneCommand(model: ModelState, command: MountingPlaneCommand, exec: Execute): ExecuteResult {
  switch (command.type) {
    case "create_mounting_plane":
      return createPlane(model, command);
    case "set_mounting_plane":
      return setPlane(model, command, exec);
  }
}
