import { refuse, registerEditHook } from "../command-core";
import { decidingUndo, peerReads } from "../elements/feature";
import { round } from "../geometry";
import { TrackedReader } from "../model";
import { isUnitCodeOnly, PARTS_UNIT_CODES_FEATURE, type ParamDef } from "../parts";
import { carryConnectedRuns, RunPropagator } from "../routing/propagate";
import {
  lineHostTopMm,
  PARTS_LINE_HOST_FEATURE,
  PARTS_WALL_FACE_HOST_FEATURE,
  partsHostedOnWalls,
  resolveMovedWallFacePart,
  wallFaceFrame,
} from "../spatial";
import type { BimElement, ElementId, ModelState, PartInstance } from "../types";

/**
 * Part writes gated on what peers read (units here; line hosts below).
 *
 * Part parameter units, expand then contract: every reader of this release
 * reads a unit code (`cfs`) as well as a v1 unit name (`gpm`); a part type
 * newly carrying a unit code is written only when the peers advertise
 * `parts:unit_codes`. A unit a type already carried passes, so a newer peer's
 * type round-trips; undo restores stored records and stands aside.
 */
function unitCodes(params: readonly ParamDef[]): Set<string> {
  const out = new Set<string>();
  for (const p of params) if (isUnitCodeOnly(p.unit)) out.add(`${p.name}:${p.unit ?? ""}`);
  return out;
}

function checkUnits(base: Readonly<Record<string, BimElement>>, working: Readonly<Record<string, BimElement>>, touchedIds: readonly ElementId[]): void {
  if (decidingUndo()) return;
  for (const id of touchedIds) {
    const next = working[id];
    if (next?.kind !== "part_type") continue;
    const now = unitCodes([...next.definition.typeParams, ...next.definition.instanceParams]);
    if (now.size === 0) continue;
    const prior = base[id];
    const before = prior?.kind === "part_type" ? unitCodes([...prior.definition.typeParams, ...prior.definition.instanceParams]) : new Set<string>();
    const added = [...now].find((u) => !before.has(u));
    if (added === undefined || peerReads(PARTS_UNIT_CODES_FEATURE)) continue;
    const [name, unit] = added.split(":");
    refuse("invalid_value", `${next.definition.familyName} ${next.definition.typeName}'s ${name} in ${unit} can't be saved yet: the model server this model is open on is an older version that reads only the original part unit names. Try again once the server is updated`, [next.id]);
  }
}

/**
 * A part standing on a line-placed element (a unit on a beam): the element
 * must exist and have a line, and the host is written only when the peers
 * advertise `parts:line_host`. A host a part already had passes.
 */
function checkLineHosts(base: ModelState, working: Readonly<Record<string, BimElement>>, touchedIds: readonly ElementId[]): void {
  if (decidingUndo()) return;
  for (const id of touchedIds) {
    const next = working[id];
    if (next?.kind !== "part" || next.host?.kind !== "element") continue;
    const prior = base.elements[id];
    const was = prior?.kind === "part" ? prior.host : undefined;
    if (was?.kind === "element" && was.elementId === next.host.elementId && was.stationMm === next.host.stationMm) continue;
    const name = next.mark || "The part";
    if (lineHostTopMm({ ...base, elements: working }, next.host.elementId, next.host.stationMm) === null) refuse("element_not_found", `${name} can't stand on ${next.host.elementId}: it isn't a beam, wall, grid or component with a line in this model`, [id]);
    if (!peerReads(PARTS_LINE_HOST_FEATURE)) refuse("invalid_value", `${name} can't be saved standing on a beam yet: the model server this model is open on is an older version that stores only slab and roof hosts. Try again once the server is updated`, [id]);
  }
}

/**
 * A part mounted on a wall's finish face: the host wall must exist, and the
 * host is written only when peers advertise `parts:wall_face_host`.
 */
function checkWallFaceHosts(base: ModelState, working: Readonly<Record<string, BimElement>>, touchedIds: readonly ElementId[]): void {
  if (decidingUndo()) return;
  for (const id of touchedIds) {
    const next = working[id];
    if (next?.kind !== "part" || next.host?.kind !== "wall_face") continue;
    const prior = base.elements[id];
    const was = prior?.kind === "part" ? prior.host : undefined;
    if (
      was?.kind === "wall_face" &&
      was.elementId === next.host.elementId &&
      was.stationMm === next.host.stationMm &&
      was.side === next.host.side &&
      (was.faceOffsetMm ?? 0) === (next.host.faceOffsetMm ?? 0)
    ) {
      continue;
    }
    const name = next.mark || "The part";
    if (working[next.host.elementId]?.kind !== "wall") {
      refuse("element_not_found", `${name} can't mount on ${next.host.elementId}: it isn't a wall in this model`, [id]);
    }
    if (!peerReads(PARTS_WALL_FACE_HOST_FEATURE)) {
      refuse("invalid_value", `${name} can't be saved mounted to a wall face yet: the model server this model is open on is an older version. Try again once the server is updated`, [id]);
    }
  }
}

/**
 * Parts mounted on a wall face:
 * 1. When a host wall moves, rotates, stretches or changes thickness, every
 *    hosted part follows its finish face inside the same atomic edit / undo step.
 * 2. When a hosted part itself is moved (e.g. dragged on a plan while its host
 *    wall stayed put), it slides smoothly along the nearest wall finish face
 *    within 450 mm (even hopping corners onto perpendicular walls), or detaches
 *    if dragged into open space away from walls.
 */
function followWallFaceHosts(base: ModelState, working: Record<string, BimElement>, touchedIds: ElementId[]): void {
  if (decidingUndo()) return;
  const changedWalls = new Set<string>();
  for (const id of touchedIds) {
    const next = working[id];
    if (next?.kind !== "wall") continue;
    const prev = base.elements[id];
    if (
      prev?.kind !== "wall" ||
      prev.start.x !== next.start.x ||
      prev.start.y !== next.start.y ||
      prev.end.x !== next.end.x ||
      prev.end.y !== next.end.y ||
      prev.thickness !== next.thickness
    ) {
      changedWalls.add(id);
    }
  }
  const alreadyTouched = new Set<string>(touchedIds);
  const hookTouched = new Set<ElementId>(touchedIds);
  let propagator: RunPropagator | null = null;
  const runPropagator = (): RunPropagator => {
    if (!propagator) propagator = new RunPropagator(new TrackedReader(base), working, hookTouched, alreadyTouched);
    return propagator;
  };
  const flushHookTouched = (): void => {
    for (const id of hookTouched) {
      if (!alreadyTouched.has(id)) {
        touchedIds.push(id);
        alreadyTouched.add(id);
      }
    }
  };
  // 1) Hosted parts whose host wall changed follow their wall's new finish face (O(|hosted parts on changed walls|), no full-model scan).
  if (changedWalls.size > 0) {
    const followers = partsHostedOnWalls(base.elements, working, changedWalls, touchedIds);
    // Record all following parts as moving so runs bridging two parts on the same moved wall don't refuse each other.
    const movingFollowers = new Set<string>(alreadyTouched);
    for (const part of followers) movingFollowers.add(part.id);
    let wallRuns: RunPropagator | null = null;
    for (const part of followers) {
      if (part.host?.kind !== "wall_face") continue;
      const wall = working[part.host.elementId];
      if (wall?.kind !== "wall") continue;
      const frame = wallFaceFrame(wall, part.host.stationMm, part.host.side, part.host.faceOffsetMm ?? 0);
      if (part.position.x === frame.position.x && part.position.y === frame.position.y && part.rotationDeg === frame.rotationDeg) continue;
      const hasLinks = Boolean(part.links && Object.keys(part.links).length > 0);
      if (hasLinks) {
        if (frame.rotationDeg !== part.rotationDeg) {
          refuse(
            "anchored_would_move",
            `${part.mark || part.id} has runs connected to it; disconnect them before turning its host wall`,
            [part.id, wall.id],
          );
        }
        const dx = round(frame.position.x - part.position.x);
        const dy = round(frame.position.y - part.position.y);
        if (dx !== 0 || dy !== 0) {
          if (!wallRuns) wallRuns = new RunPropagator(new TrackedReader(base), working, hookTouched, movingFollowers);
          carryConnectedRuns(wallRuns, part, { x: dx, y: dy, z: 0 });
        }
      }
      working[part.id] = { ...part, position: frame.position, rotationDeg: frame.rotationDeg };
      hookTouched.add(part.id);
    }
    flushHookTouched();
  }
  // 2) Fallback for any non-move_elements command that moved a wall-hosted or wall-mountable part
  //    without already updating its host record: snap via the spatial wall grid and carry connected runs.
  const workingModel: ModelState = { ...base, elements: working };
  const wallFaceAllowed = peerReads(PARTS_WALL_FACE_HOST_FEATURE);
  const initialCount = touchedIds.length;
  for (let i = 0; i < initialCount; i++) {
    const id = touchedIds[i]!;
    const next = working[id];
    if (next?.kind !== "part" || next.planned !== undefined) continue;
    const prev = base.elements[id];
    if (prev?.kind !== "part") continue;
    const movedPos = prev.position.x !== next.position.x || prev.position.y !== next.position.y;
    if (!movedPos) continue;
    if (next.host?.kind === "wall_face") {
      if (changedWalls.has(next.host.elementId)) continue;
      if (prev.host?.kind !== "wall_face") continue;
      const sameHost =
        prev.host.elementId === next.host.elementId &&
        prev.host.stationMm === next.host.stationMm &&
        prev.host.side === next.host.side &&
        (prev.host.faceOffsetMm ?? 0) === (next.host.faceOffsetMm ?? 0);
      if (!sameHost) continue;
    } else if (!(wallFaceAllowed && next.host === undefined && prev.host === undefined)) {
      continue;
    }
    const snapped = resolveMovedWallFacePart(workingModel, next, next.position, {
      wallFaceAllowed,
      baseElements: base.elements,
      overlayWallIds: changedWalls,
    });
    if (!snapped.changed) continue;
    const dx = round(snapped.position.x - next.position.x);
    const dy = round(snapped.position.y - next.position.y);
    if ((dx !== 0 || dy !== 0) && next.links && Object.keys(next.links).length > 0) {
      carryConnectedRuns(runPropagator(), next, { x: dx, y: dy, z: 0 });
    }
    const { host: _prevHost, ...partBase } = next;
    const updated: PartInstance = {
      ...partBase,
      position: snapped.position,
      rotationDeg: snapped.rotationDeg,
      ...(snapped.host !== undefined ? { host: snapped.host } : {}),
    };
    working[id] = updated;
  }
  flushHookTouched();
}

registerEditHook("part-unit-codes", (base, working, touchedIds) => {
  checkUnits(base.elements, working, touchedIds);
  checkLineHosts(base, working, touchedIds);
  checkWallFaceHosts(base, working, touchedIds);
  followWallFaceHosts(base, working, touchedIds);
});
