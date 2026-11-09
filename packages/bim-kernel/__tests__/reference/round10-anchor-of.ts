/**
 * Round 10's `anchorOf` (model.ts before K11), verbatim, for the K11
 * equivalence tests and the A/B perf row. It imports its helpers by module,
 * as model.ts did, so the A/B compares like with like.
 */
import { add, scale } from "../../src/geometry";
import { kindAnchorOf } from "../../src/kinds/anchor";
import type { BimElement, Vec2 } from "../../src/types";

function centroid(points: readonly Vec2[]): Vec2 {
  if (points.length === 0) return { x: 0, y: 0 };
  const sum = points.reduce((acc, p) => add(acc, p), { x: 0, y: 0 });
  return scale(sum, 1 / points.length);
}

export function round10AnchorOf(el: BimElement): Vec2 | null {
  switch (el.kind) {
    case "opening":
    case "column":
    case "riser_segment":
    case "component":
    case "part":
      return el.position;
    case "wall":
    case "beam":
    case "grid":
      return scale(add(el.start, el.end), 0.5);
    case "run_segment":
      return { x: (el.start.x + el.end.x) / 2, y: (el.start.y + el.end.y) / 2 };
    case "run_fitting":
      return { x: el.position.x, y: el.position.y };
    case "mep_system":
      return null;
    case "slab":
    case "room":
      return centroid(el.outline);
    case "space":
      return el.bounds.kind === "outline" && el.bounds.outline.length > 0 ? centroid(el.bounds.outline) : null;
    case "zone":
    case "drawing_underlay":
      return null;
    case "question":
      return el.anchor.point?.position ?? null;
    case "ceiling":
      return centroid(el.outline);
    case "determination":
    case "rule":
    case "requirement_state":
    case "observation":
    case "construction_stage":
      return null;
    case "mounting_plane":
      return scale(add(el.min, el.max), 0.5);
    case "view":
    case "sheet":
    case "tag":
    case "dimension":
    case "viewport":
    case "drawing_item":
    case "level":
    case "part_type":
    case "element_type":
    case "organization":
    case "site":
    case "service_link":
    case "service_catalog":
    case "load_point":
      return null;
    default:
      // An add-on's kind sits where its kind row says.
      return kindAnchorOf(el);
  }
}
