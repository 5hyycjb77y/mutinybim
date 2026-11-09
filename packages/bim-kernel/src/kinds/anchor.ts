import { elementKindTable, type ElementKindTable } from "../registry/element-kind-point";
import type { BimElement, Vec2 } from "../types";

/**
 * Where a record of an add-on's kind sits (`anchorOf` for kinds the kernel
 * doesn't name): its row's `anchor`, else the middle of its shape's points,
 * else nowhere. A kind no row in force names (its add-on isn't loaded, or a
 * non-drawn record) sits nowhere.
 */
export function kindAnchorOf(el: BimElement, table: ElementKindTable = elementKindTable()): Vec2 | null {
  const row = table.row(el.kind);
  if (row === undefined) return null;
  if (row.anchor !== undefined) return row.anchor(el);
  const points = row.shape?.points?.(el);
  if (points === undefined || points.length === 0) return null;
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
  }
  return { x: x / points.length, y: y / points.length };
}
