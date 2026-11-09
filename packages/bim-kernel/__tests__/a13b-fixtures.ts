/**
 * Lane A13b test fixtures: two levels, walls (bounding through the kernel's
 * own wall row), and `lineRow`, the row an outside test add-on gives its
 * own line-placed kind.
 */
import { asElementId, DEFAULT_SETTINGS, type BimElement, type ElementId, type ModelState, type Vec2 } from "../src";
import { levelOf } from "../src/fields/providers/level-room";
import { PackSet } from "../src/packs";
import type { BoundarySegment, BoundingElementRow } from "../src/spaces/boundaries/point";

export const L1 = asElementId("L1");
export const L2 = asElementId("L2");
const P = { level: "Level 1", zone: "A", discipline: "architecture" } as const;

/** The two faces of a straight line element `thickness` wide, offset either side of its line. */
export function facesOf(id: ElementId, start: Vec2, end: Vec2, thickness: number): BoundarySegment[] {
  const len = Math.hypot(end.x - start.x, end.y - start.y);
  const nx = (-(end.y - start.y) / len) * (thickness / 2);
  const ny = ((end.x - start.x) / len) * (thickness / 2);
  return [
    { elementId: id, start: { x: start.x + nx, y: start.y + ny }, end: { x: end.x + nx, y: end.y + ny } },
    { elementId: id, start: { x: start.x - nx, y: start.y - ny }, end: { x: end.x - nx, y: end.y - ny } },
  ];
}

function lineOf(el: BimElement): { start: Vec2; end: Vec2; thickness: number } | null {
  const r = el as unknown as { start?: Vec2; end?: Vec2; thickness?: number };
  return r.start && r.end && typeof r.thickness === "number" ? { start: r.start, end: r.end, thickness: r.thickness } : null;
}

/** Test row: a line-placed kind bounds by its two faces on its own level. */
export function lineRow(kind: string, label: string, typeParameterKey?: string): BoundingElementRow {
  return {
    kind,
    label,
    boundsByDefault: true,
    ...(typeParameterKey ? { typeParameterKey } : {}),
    segments: (el, elements, levelId) => {
      const line = lineOf(el);
      if (!line || levelOf(elements, el)?.id !== levelId) return [];
      return facesOf(el.id, line.start, line.end, line.thickness);
    },
  };
}

/** The built-in set: walls bound through the kernel's own row (faces trimmed by joins), separation lines through theirs. */
export const BUILTINS = PackSet.create([]);

export function wall(id: string, start: Vec2, end: Vec2, extra: Record<string, unknown> = {}): BimElement {
  const record: unknown = { id: asElementId(id), kind: "wall", version: 1, authoredRev: {}, partition: P, start, end, thickness: 200, height: 3000, wallType: "Partition", ...extra };
  return record as BimElement;
}

/** Four walls on centrelines (x0, y0)–(x1, y1), 200 mm thick: the room inside is (w − 0.2) × (h − 0.2) m. */
export function box(prefix: string, x0: number, y0: number, x1: number, y1: number, extra: Record<string, unknown> = {}): BimElement[] {
  return [
    wall(`${prefix}-s`, { x: x0, y: y0 }, { x: x1, y: y0 }, extra),
    wall(`${prefix}-e`, { x: x1, y: y0 }, { x: x1, y: y1 }, extra),
    wall(`${prefix}-n`, { x: x1, y: y1 }, { x: x0, y: y1 }, extra),
    wall(`${prefix}-w`, { x: x0, y: y1 }, { x: x0, y: y0 }, extra),
  ];
}

export function modelWith(extra: readonly BimElement[], modelId = "a13b"): ModelState {
  const l1: BimElement = { id: L1, kind: "level", version: 1, authoredRev: {}, name: "Level 1", elevationMm: 0 };
  const l2: BimElement = { id: L2, kind: "level", version: 1, authoredRev: {}, name: "Level 2", elevationMm: 4000 };
  const elements: Record<string, BimElement> = { [L1]: l1, [L2]: l2 };
  for (const el of extra) elements[el.id] = el;
  return { modelId, revision: 0 as ModelState["revision"], elements, connections: [], settings: DEFAULT_SETTINGS };
}
