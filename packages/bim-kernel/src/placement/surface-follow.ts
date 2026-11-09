import { refuse, registerEditHook } from "../command-core";
import { WALLS_SURFACE_BINDING_FEATURE } from "../contract-features";
import { decidingUndo, peerReads } from "../elements/feature";
import { joinLinesInBox } from "../joins/solve";
import { spaceOutlines } from "../spaces/space-geometry";
import { elementsOfKind } from "../store";
import { surfaceFaceKinds, surfaceFaceRow } from "../surfaces/faces";
import { forgetSurfaceIndexes } from "../surfaces/surfaces-at";
import type { BimElement, ElementId, ModelState, Vec2 } from "../types";
import { resolveBoundBody, surfaceBindingKey, surfaceBoundPlacement, withBoundBody } from "./surface-bind";

/**
 * Bound bodies follow their surfaces. After any edit, inside the same change
 * (one undo restores both):
 *
 * - a line element whose binding the edit set (drawn bound, or its top or
 *   base moved to a surface) is resolved, and the edit is refused in words
 *   when the surface isn't there;
 * - a bound element the edit moved, and every bound element over or under a
 *   face the edit changed (a slab's thickness, a ceiling's height, a roof's
 *   slope, any face drawn or removed, a space's stated ceiling height), is
 *   re-derived; one whose surface is gone keeps its last height.
 *
 * Which bound elements a face reaches comes from the line-join index's cells
 * under the face's old and new footprints, on every level, so the cost is the
 * lines near the change, never the model. A level that moves reaches every
 * bound wall (rare; the level command already reads the model).
 */

type Elements = Readonly<Record<string, BimElement>>;

interface Box {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

function boxOf(points: readonly Vec2[]): Box | null {
  if (points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

/** The plan boxes a record's faces cover (none when it offers no face). */
function faceBoxes(el: BimElement | undefined, elements: Elements, faceKinds: ReadonlySet<string>): Box[] {
  if (!el) return [];
  if (faceKinds.has(el.kind)) {
    const box = boxOf(surfaceFaceRow(el.kind)?.footprint(el, elements) ?? []);
    return box ? [box] : [];
  }
  // A space's stated ceiling height is a ceiling where none is drawn.
  if (el.kind === "space" && el.ceilingHeightMm !== undefined) return spaceOutlines(elements, el).flatMap((o) => boxOf(o) ?? []);
  return [];
}

/** Whether an edit to a space moved the ceiling it states: its height, or where it is when it states one. */
function spaceCeilingChanged(before: BimElement | undefined, after: BimElement | undefined): boolean {
  const a = before?.kind === "space" ? before : undefined;
  const b = after?.kind === "space" ? after : undefined;
  if (a?.ceilingHeightMm === undefined && b?.ceilingHeightMm === undefined) return false;
  return a?.ceilingHeightMm !== b?.ceilingHeightMm || a?.bounds !== b?.bounds || a?.levelId !== b?.levelId;
}

/** The records an edit set the binding of, and the bound ones it may have moved or reached. */
function reachedBy(base: ModelState, working: Elements, touchedIds: readonly ElementId[]): { readonly strict: ElementId[]; readonly reached: Set<ElementId> } {
  const strict: ElementId[] = [];
  const reached = new Set<ElementId>();
  const faceKinds: ReadonlySet<string> = new Set(surfaceFaceKinds());
  const boxes: Box[] = [];
  let levelMoved = false;
  for (const id of touchedIds) {
    const before = base.elements[id];
    const after = working[id];
    if (surfaceBoundPlacement(after)) {
      if (surfaceBindingKey(after) !== surfaceBindingKey(before)) strict.push(id);
      else reached.add(id);
    }
    if (before?.kind === "level" || after?.kind === "level") {
      if (before?.kind !== "level" || after?.kind !== "level" || before.elevationMm !== after.elevationMm) levelMoved = true;
      continue;
    }
    if (before === after) continue;
    if ((before?.kind === "space" || after?.kind === "space") && !spaceCeilingChanged(before, after)) continue;
    boxes.push(...faceBoxes(before, base.elements, faceKinds), ...faceBoxes(after, working, faceKinds));
  }
  if (levelMoved) {
    for (const w of elementsOfKind(working, "wall")) if (surfaceBoundPlacement(w)) reached.add(w.id);
  } else if (boxes.length > 0) {
    const levels = elementsOfKind(working, "level");
    for (const box of boxes) {
      for (const level of levels) {
        // The line index of the revision the edit started from: the lines a face change can reach don't move with it.
        for (const id of joinLinesInBox(base.elements, level.id, box)) if (surfaceBoundPlacement(working[id])) reached.add(id as ElementId);
      }
    }
  }
  for (const id of strict) reached.delete(id);
  return { strict, reached };
}

/** Re-derive the bound bodies an edit reaches; refuse one it bound to a surface that isn't there. Pushes each one rewritten onto `touchedIds`. */
export function followSurfaceEdits(base: ModelState, working: Record<string, BimElement>, touchedIds: ElementId[]): void {
  if (decidingUndo()) return;
  const { strict, reached } = reachedBy(base, working, touchedIds);
  if (strict.length === 0 && reached.size === 0) return;
  const model: ModelState = { ...base, elements: working };
  const stores = peerReads(WALLS_SURFACE_BINDING_FEATURE);
  const already = new Set(touchedIds);
  try {
    for (const id of strict) {
      const el = working[id];
      const body = el ? resolveBoundBody(model, el) : null;
      if (!el || !body) continue;
      if (!body.ok) refuse("invalid_value", body.reason, [id]);
      const next = withBoundBody(el, body) ?? el;
      // A peer that doesn't store bindings (`walls:surface_binding`) is sent the height and base it works out to.
      working[id] = stores ? next : withoutBinding(next);
    }
    for (const id of [...reached].sort()) {
      const el = working[id];
      const body = el ? resolveBoundBody(model, el) : null;
      // A surface that is gone (a slab removed from over it) leaves the body as it was.
      if (!el || !body || !body.ok) continue;
      const next = withBoundBody(el, body);
      if (!next) continue;
      working[id] = next;
      if (!already.has(id)) touchedIds.push(id);
    }
  } finally {
    forgetSurfaceIndexes(working);
  }
}

/** The record with its bindings dropped and its derived body kept as plain values (an older peer's shape). */
function withoutBinding(el: BimElement): BimElement {
  const p = surfaceBoundPlacement(el);
  if (!p || el.kind !== "wall") return el;
  const { topSurface: _top, baseSurface: _base, ...placement } = p;
  const { bodyProfile: _profile, ...rest } = el;
  return { ...rest, placement };
}

registerEditHook("placement.surface-follow", followSurfaceEdits);
