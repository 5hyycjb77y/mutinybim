import { z } from "zod";
import { finish, guard, refuse, type ExecuteResult } from "../command-core";
import { roundVec } from "../geometry";
import { TrackedReader, openingPosition, requireKind } from "../model";
import { draftElements } from "../store";
import { strictCommands } from "../strict-commands";
import { asElementId, type Component, type ElementId, type ModelState, type Opening, type Partition, type Room, type Wall } from "../types";

/**
 * Rooms traced from the architect's plan: walls, doors and windows on them,
 * the room outlines, and counters or fixtures inside. One edit, so a unit
 * traced (or imported) in one go undoes in one go. These are what the
 * receptacle proposer measures when the project has no linked model with
 * rooms. Nothing here is electrical.
 */

const idSchema = z.string().min(1).max(200);
const vec2Schema = z.object({ x: z.number().finite(), y: z.number().finite() });
const MAX = 500;

export const architectureCommandSchemas = strictCommands([
  z.object({
    type: z.literal("add_architecture"),
    /** The level they are on. */
    levelId: idSchema,
    walls: z
      .array(
        z
          .object({
            wallId: idSchema,
            start: vec2Schema,
            end: vec2Schema,
            thicknessMm: z.number().positive().max(2000),
            heightMm: z.number().positive().max(30_000).optional(),
            wallType: z.string().trim().min(1).max(120).optional(),
          })
          .strict(),
      )
      .max(MAX)
      .default([]),
    openings: z
      .array(
        z
          .object({
            openingId: idSchema,
            /** A wall in this command or already in the model. */
            wallId: idSchema,
            kind: z.enum(["door", "window"]),
            /** Centre distance from the wall's start. */
            offsetMm: z.number().min(0).max(1_000_000),
            widthMm: z.number().positive().max(20_000),
            heightMm: z.number().positive().max(10_000).optional(),
            mark: z.string().max(40).optional(),
          })
          .strict(),
      )
      .max(MAX)
      .default([]),
    rooms: z
      .array(
        z
          .object({
            roomId: idSchema,
            number: z.string().trim().max(40),
            name: z.string().trim().min(1).max(120),
            /** Corners in order (either direction); on wall centrelines or wall faces. */
            outline: z.array(vec2Schema).min(3).max(200),
          })
          .strict(),
      )
      .max(MAX)
      .default([]),
    /** Counters, cabinets and fixtures (a sink, range, lavatory, washer) as plan rectangles. */
    casework: z
      .array(
        z
          .object({
            componentId: idSchema,
            typeName: z.string().trim().min(1).max(120),
            position: vec2Schema,
            size: vec2Schema,
            rotationDeg: z.number().finite().min(-3600).max(3600).optional(),
          })
          .strict(),
      )
      .max(MAX)
      .default([]),
  }),
]);

export type ArchitectureCommand = z.infer<(typeof architectureCommandSchemas)[number]>;

export function isArchitectureCommand(command: { readonly type: string }): command is ArchitectureCommand {
  return command.type === "add_architecture";
}

function area(outline: readonly { x: number; y: number }[]): number {
  let s = 0;
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % outline.length];
    if (a && b) s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s / 2);
}

export function executeArchitectureCommand(model: ModelState, command: ArchitectureCommand): ExecuteResult {
  return guard(() => {
    const reader = new TrackedReader(model);
    const level = requireKind(reader.get(asElementId(command.levelId)), "level");
    const partition: Partition = { level: level.name, zone: "Z1", discipline: "architecture" };
    const working = draftElements(model.elements);
    const touched: ElementId[] = [];
    const base = { version: 0, authoredRev: {}, partition };
    const fresh = (id: string): ElementId => {
      const eid = asElementId(id);
      if (reader.find(eid) || working[eid]) refuse("already_exists", `${id} already exists; choose a new id`, [eid]);
      touched.push(eid);
      return eid;
    };
    for (const w of command.walls) {
      if (Math.hypot(w.end.x - w.start.x, w.end.y - w.start.y) < 1) refuse("invalid_value", `Wall ${w.wallId} has no length`);
      const wall: Wall = { ...base, id: fresh(w.wallId), kind: "wall", start: roundVec(w.start), end: roundVec(w.end), thickness: w.thicknessMm, height: w.heightMm ?? 3048, wallType: w.wallType ?? "Traced wall" };
      working[wall.id] = wall;
    }
    for (const o of command.openings) {
      const hostEl = working[o.wallId] ?? reader.find(asElementId(o.wallId));
      if (hostEl?.kind !== "wall") refuse("element_not_found", `Opening ${o.openingId}: ${o.wallId} isn't a wall in this model or this edit`);
      const len = Math.hypot(hostEl.end.x - hostEl.start.x, hostEl.end.y - hostEl.start.y);
      if (o.offsetMm - o.widthMm / 2 < -1 || o.offsetMm + o.widthMm / 2 > len + 1) refuse("invalid_value", `Opening ${o.openingId} doesn't fit on wall ${o.wallId} (${Math.round(len)} mm long)`);
      const opening: Opening = { ...base, id: fresh(o.openingId), kind: "opening", openingType: o.kind, mark: o.mark ?? "", hostId: hostEl.id, offset: o.offsetMm, width: o.widthMm, height: o.heightMm ?? (o.kind === "door" ? 2134 : 1219), position: roundVec(openingPosition(hostEl, o.offsetMm)) };
      working[opening.id] = opening;
    }
    for (const r of command.rooms) {
      const outline = r.outline.map(roundVec);
      const sqmm = area(outline);
      if (sqmm < 1) refuse("invalid_value", `Room ${r.roomId} has no area`);
      const room: Room = { ...base, id: fresh(r.roomId), kind: "room", number: r.number, name: r.name, outline, areaSqM: Math.round((sqmm / 1e6) * 100) / 100 };
      working[room.id] = room;
    }
    for (const c of command.casework) {
      const comp: Component = { ...base, id: fresh(c.componentId), kind: "component", category: "casework", typeName: c.typeName, position: roundVec(c.position), size: roundVec(c.size), rotationDeg: c.rotationDeg ?? 0 };
      working[comp.id] = comp;
    }
    if (touched.length === 0) refuse("invalid_value", "Nothing to add: send walls, openings, rooms or casework");
    const n = (k: number, w: string) => `${k} ${w}${k === 1 ? "" : "s"}`;
    const summary = [command.rooms.length ? n(command.rooms.length, "room") : "", command.walls.length ? n(command.walls.length, "wall") : "", command.openings.length ? n(command.openings.length, "door or window") : "", command.casework.length ? n(command.casework.length, "counter or fixture") : ""].filter(Boolean);
    return finish(reader, working, touched, [], () => [], { summary: [`Traced ${summary.join(", ")} on ${level.name}`] });
  });
}
