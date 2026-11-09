import { builtinPartType, partConnector, resolveConnectors, type Command, type ElementId, type ModelState, type RunSegment } from "@permitzip/bim-kernel";
import { drainageParts, sewerConnectionOf } from "./read";

/**
 * Plumbing › Systems › Sewer connection (round 13 P13): from the selected
 * building drain's open end to a manhole, picked or entered. A new manhole is
 * Plumbing's starter "Sanitary manhole (existing)" with its invert and rim
 * typed in; the drain is routed on from its open end to the manhole's inlet,
 * so the walk reaches it. Commands only: every step is undoable and the same
 * one an agent sends.
 */

export const SEWER_MANHOLE_TYPE_ID = "builtin:plumbing-sanitary-manhole-existing@1";
const MANHOLE_INLET = "in";
const MM_PER_FT = 304.8;
/** How far past the drain's open end a new manhole is placed, along the drain. */
const NEW_MANHOLE_OFFSET_MM = 5 * MM_PER_FT;

export type OutfallConnectionChoice =
  | { readonly kind: "existing"; readonly manholeId: ElementId }
  | { readonly kind: "new"; readonly partId: string; readonly mark: string; readonly invertMm: number | null; readonly rimMm: number | null };

/** The drain's open end (end first), or null when both ends meet something. */
export function openDrainEnd(seg: RunSegment): "start" | "end" | null {
  if (seg.links.end === undefined) return "end";
  if (seg.links.start === undefined) return "start";
  return null;
}

/** Why the selection can't start a sewer connection, in words; null when it can. */
export function outfallConnectionBlocked(model: ModelState, selectedIds: readonly string[]): string | null {
  const seg = selectedIds.length === 1 ? model.elements[selectedIds[0] ?? ""] : undefined;
  if (seg?.kind !== "run_segment" || seg.domain !== "pipe") return "Select the building drain where it leaves the building, then press Sewer connection.";
  if (openDrainEnd(seg) === null) return "Both ends of this pipe already connect: select the pipe whose end leaves the building.";
  return null;
}

/** The sewer connections in the model a drain can be taken to, by id and mark. */
export function outfallConnectionChoices(model: ModelState): readonly { readonly id: ElementId; readonly label: string; readonly invertMm: number | null; readonly rimMm: number | null }[] {
  return drainageParts(model.elements).sewerConnections.flatMap((id) => {
    const c = sewerConnectionOf(model.elements, id);
    return c ? [{ id: c.id, label: c.label, invertMm: c.invertMm, rimMm: c.rimMm }] : [];
  });
}

/** The pipes a `route_run` with this id prefix made (`<prefix>-s1`, `-s2`, …), by id. */
export function routedSegmentsOf(model: ModelState, routeIdPrefix: string): RunSegment[] {
  const out: RunSegment[] = [];
  for (let i = 1; ; i += 1) {
    const el = model.elements[`${routeIdPrefix}-s${i}`];
    if (el?.kind !== "run_segment") return out;
    out.push(el);
  }
}

/** A sewer connection in steps: the first commands, then (for a new manhole) the commands read off the model they made. */
export interface OutfallConnectionPlan {
  readonly first: readonly Command[];
  readonly next?: (after: ModelState) => readonly Command[] | { readonly refused: string };
}

/**
 * The commands that take the selected drain to the manhole; or why not, in
 * words. An existing manhole is routed to through its free inlet. A new one
 * comes after the drain is routed on (pitched at its system's slope, open
 * ended): it is placed with its inlet on that open end, facing it, and joined.
 */
export function outfallConnectionCommands(model: ModelState, drainId: string, choice: OutfallConnectionChoice, routeIdPrefix: string): OutfallConnectionPlan | { readonly refused: string } {
  const blocked = outfallConnectionBlocked(model, [drainId]);
  if (blocked) return { refused: blocked };
  const seg = model.elements[drainId];
  if (seg?.kind !== "run_segment" || seg.size.shape !== "pipe") return { refused: "Select a drawn pipe." };
  const port = openDrainEnd(seg) ?? "end";
  const from = port === "end" ? seg.end : seg.start;
  const back = port === "end" ? seg.start : seg.end;
  const system = model.elements[seg.systemId];
  if (system?.kind !== "mep_system") return { refused: "This pipe isn't on a system: give it one in Plumbing › Systems." };
  const route = (to: { readonly x: number; readonly y: number }, end?: { readonly partId: string }): Command => ({
    type: "route_run",
    idPrefix: routeIdPrefix,
    levelId: seg.levelId,
    domain: "pipe",
    size: seg.size,
    elevationMm: from.z,
    system: { id: system.id, kind: system.systemKind, name: system.name },
    points: [
      { x: from.x, y: from.y },
      { x: to.x, y: to.y },
    ],
    from: { kind: "run_end", elementId: seg.id, port },
    ...(end ? { to: { kind: "part" as const, partId: end.partId, connectorId: MANHOLE_INLET } } : {}),
  });

  if (choice.kind === "existing") {
    const manhole = model.elements[choice.manholeId];
    if (manhole?.kind !== "part" || !sewerConnectionOf(model.elements, manhole.id)) return { refused: "That isn't a sewer connection in this model any more: pick another, or enter a new manhole." };
    const type = model.elements[manhole.typeId];
    const inlet = type?.kind === "part_type" ? partConnector(manhole, type, MANHOLE_INLET) : null;
    const name = manhole.mark.trim() || manhole.id;
    if (!inlet) return { refused: `${name} has no inlet to connect a drain to: enter a new manhole instead, or use a manhole type with an inlet.` };
    if (manhole.links?.[MANHOLE_INLET]) return { refused: `${name}'s inlet already takes a drain: pick another manhole, or enter a new one.` };
    return { first: [route(inlet.position, { partId: manhole.id })] };
  }

  const starter = builtinPartType(SEWER_MANHOLE_TYPE_ID)?.definition;
  if (!starter) return { refused: "The manhole comes from Plumbing and gas's starter library, which isn't on here: turn on Plumbing and gas." };
  // The manhole's inlet takes the drain it receives: one type per drain size, the starter's with that inlet.
  const inches = Math.round((seg.size.nominalMm / 25.4) * 1000) / 1000;
  const typeId = `plumbing-sewer-manhole-${String(inches).replace(".", "_")}in`;
  const pinned = model.elements[typeId];
  const definition = pinned?.kind === "part_type" ? pinned.definition : { ...starter, typeName: `${starter.typeName}, ${inches}" inlet`, typeValues: { ...starter.typeValues, connection_size: seg.size.nominalMm } };
  const values: Record<string, number> = {};
  if (choice.invertMm !== null) values.sewer_invert = choice.invertMm;
  if (choice.rimMm !== null) values.sewer_rim = choice.rimMm;
  const local = resolveConnectors(definition, values).find((c) => c.id === MANHOLE_INLET);
  if (!local) return { refused: "The starter manhole has no inlet: update Plumbing and gas." };
  const dx = from.x - back.x;
  const dy = from.y - back.y;
  const len = Math.hypot(dx, dy) || 1;
  const toward = { x: from.x + (dx / len) * NEW_MANHOLE_OFFSET_MM, y: from.y + (dy / len) * NEW_MANHOLE_OFFSET_MM };
  const next = (after: ModelState): readonly Command[] | { readonly refused: string } => {
    const made = routedSegmentsOf(after, routeIdPrefix).find((e) => e.links.end === undefined);
    if (!made) return { refused: "The drain wasn't routed on: route it toward the manhole, then press Sewer connection again." };
    const ux = made.end.x - made.start.x;
    const uy = made.end.y - made.start.y;
    const ul = Math.hypot(ux, uy) || 1;
    const u = { x: ux / ul, y: uy / ul };
    // The inlet sits on the open end and faces back up the drain: the type's local x turns onto the drain's direction.
    const [cx, cy, cz] = local.position;
    const centre = { x: made.end.x - (u.x * cx - u.y * cy), y: made.end.y - (u.y * cx + u.x * cy) };
    const place: Command = { type: "place_part", partId: choice.partId, typeId, ...(after.elements[typeId]?.kind === "part_type" ? {} : { partType: definition }), levelId: made.levelId, position: centre, offsetMm: made.end.z - cz, rotationDeg: (Math.atan2(u.y, u.x) * 180) / Math.PI, mark: choice.mark, values };
    return [place, { type: "connect_runs", a: { elementId: made.id, port: "end" }, b: { elementId: choice.partId, port: MANHOLE_INLET } }];
  };
  return { first: [route(toward)], next };
}
