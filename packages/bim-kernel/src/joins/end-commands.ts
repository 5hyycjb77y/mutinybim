import { z } from "zod";
import { finish, refuse, type AuthoredWrite, type ExecuteResult } from "../command-core";
import { dot, roundVec, sub } from "../geometry";
import type { TrackedReader } from "../model";
import { networkOf } from "../network";
import { hostedIds } from "../qto/hosted";
import { kindRowOf } from "../kinds/rows";
import { asElementId, type BimElement, type ElementId, type ModelState, type Vec2 } from "../types";
import { MIN_WALL_MM } from "../validate";
import { carryJoinedEndsOfReshapeCommand } from "./carry";
import { lineJoinRow } from "./contract";

/**
 * Drag one end of a line-placed element (`kernel.line_join` kinds whose row
 * has `withLine`: walls, and any add-on's). The other end stays put; the lines
 * at a corner with the dragged end go with it and lines stopped on its face
 * stay on it, in the same change, so one Undo puts everything back. Doors and
 * windows hosted in it keep their place in plan (their distance along it is
 * re-measured from its start); one that would no longer fit is refused.
 */

const vec2 = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();

export const lineEndCommandSchemas = [
  z.object({
    type: z.literal("move_line_end"),
    elementId: z.string().min(1).max(200),
    end: z.enum(["start", "end"]),
    /** Where the end goes, plan mm. */
    to: vec2,
    /** Leave the joined lines where they are (Revit's Disjoin); absent: they follow. */
    disjoin: z.boolean().optional(),
  }),
] as const;

export type LineEndCommand = z.infer<(typeof lineEndCommandSchemas)[number]>;

export function isLineEndCommand(command: { readonly type: string }): command is LineEndCommand {
  return command.type === "move_line_end";
}

function nameOf(el: BimElement): string {
  const label = kindRowOf(el.kind)?.label ?? el.kind.replace(/_/g, " ");
  return `${label.charAt(0).toUpperCase()}${label.slice(1).toLowerCase()} ${el.id}`;
}

const sameVec = (a: Vec2, b: Vec2): boolean => a.x === b.x && a.y === b.y;

export function executeLineEndCommand(reader: TrackedReader, working: Record<string, BimElement>, command: LineEndCommand): ExecuteResult {
  const model: ModelState = reader.model;
  const el = reader.get(asElementId(command.elementId));
  const row = lineJoinRow(el.kind);
  const line = row?.line(el, model.elements) ?? null;
  const name = nameOf(el);
  if (!row?.withLine || !line) refuse("wrong_kind", `${name} isn't drawn on a line, so it has no end to drag`, [el.id]);
  const to = roundVec(command.to);
  const moving = command.end === "start" ? line.start : line.end;
  const fixed = command.end === "start" ? line.end : line.start;
  if (sameVec(to, moving)) refuse("invalid_value", `That end of ${name} is already there`, [el.id]);
  const length = Math.hypot(to.x - fixed.x, to.y - fixed.y);
  if (length < MIN_WALL_MM) refuse("invalid_value", `That would make ${name} ${Math.round(length)} mm long, shorter than ${MIN_WALL_MM} mm; drag the end further from its other end`, [el.id]);
  const next = command.end === "start" ? { start: to, end: line.end } : { start: line.start, end: to };
  const reshaped = row.withLine(el, { ...line, ...next }, working);
  working[el.id] = reshaped;
  const touched = new Set<ElementId>([el.id]);
  const authored: AuthoredWrite[] = [];
  const after = row.line(reshaped, working) ?? { ...line, ...next };
  if ("start" in reshaped && "end" in reshaped) authored.push({ elementId: el.id, field: "start", value: after.start }, { elementId: el.id, field: "end", value: after.end });

  // Hosted doors and windows stay where they are in plan, measured again along the new line.
  const u = { x: (after.end.x - after.start.x) / length, y: (after.end.y - after.start.y) / length };
  for (const id of hostedIds(model.elements, el.id)) {
    const o = reader.get(asElementId(id));
    if (o.kind !== "opening") continue;
    const s = Math.round(dot(sub(o.position, after.start), u));
    const what = o.mark ? `${o.openingType.replace(/_/g, " ")} ${o.mark}` : `the ${o.openingType.replace(/_/g, " ")}`;
    if (s - o.width / 2 < 0 || s + o.width / 2 > length) refuse("invalid_value", `${what} would no longer fit in ${name}; drag the end less far, or move ${what} first`, [el.id, o.id]);
    if (s !== o.offset) {
      working[o.id] = { ...o, offset: s };
      touched.add(o.id);
      authored.push({ elementId: o.id, field: "offset", value: s });
    }
  }
  for (const dep of networkOf(model).dependents(el.id)) reader.get(dep);

  const followed = command.disjoin === true ? [] : carryJoinedEndsOfReshapeCommand(model, reader, working, touched, authored, new Map([[el.id as string, after]]));
  const summary = `Moved the ${command.end} of ${name}${followed.length > 0 ? `; ${followed.length} joined ${followed.length === 1 ? "element" : "elements"} followed` : ""}`;
  return finish(reader, working, touched, authored, () => authored.map((a) => ({ kind: "field_equals" as const, elementId: a.elementId, field: a.field, value: a.value })), { summary: [summary] });
}
