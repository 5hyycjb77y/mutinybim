import { feetInches } from "../drawing/sheet";
import { viewFloorMm } from "../levels";
import { p3 } from "../routing/geometry";
import type { RunPoint } from "../routing/types";
import type { ModelState, Vec2, ViewElement } from "../types";

/**
 * How a saved view's drawing relates to the model: one mapping per view type,
 * shared by every tool that takes a point in a plan, section or elevation
 * (people's pointers and the agent's view-relative coordinates alike).
 *
 * The drawing frame is the one `drawing/views.ts` draws in (`ViewFrame.modelCenter`):
 * - plan (floor and ceiling): u = model x, v = model y; depth = elevation (z; minus z
 *   for a ceiling plan, which looks up);
 * - section and elevation: u = distance along the cut from its start, v = elevation
 *   above project zero; depth = minus the distance beyond the cut line;
 * - 3D views print as an isometric, which has no unique model point under the
 *   pointer, so they map model → drawing only.
 *
 * Every point is model millimetres; z is above project zero (level elevation
 * included), as in `drawing/solids.ts`.
 */
export type ViewSurfaceKind = "plan" | "section" | "isometric" | "drafting" | "schedule";

export interface DrawingPoint {
  readonly u: number;
  readonly v: number;
  /** Larger is nearer the viewer. */
  readonly depth: number;
}

/** What the drawing plane alone can't say: a plan's elevation, or how far beyond a section's cut line. */
export interface DepthChoice {
  /** Plans: elevation above project zero, mm. Absent: the view's floor. */
  readonly elevationMm?: number;
  /** Sections: distance beyond the cut line, mm (0 is on the line). Absent: 0. */
  readonly depthMm?: number;
}

export interface ViewMapping {
  readonly viewId: string;
  readonly kind: ViewSurfaceKind;
  /** The view's floor elevation (the drawing and the live canvas cut from it). */
  readonly floorMm: number;
  /** Plain-language reason model points can't be taken here; null when they can. */
  readonly modelReason: string | null;
  /** Sections: unit vector along the cut and the one the section looks along. */
  readonly axis: Vec2 | null;
  readonly look: Vec2 | null;
  /** Sections: how far beyond the line the section sees. */
  readonly depthRangeMm: number | null;
  toDrawing(p: RunPoint): DrawingPoint;
  /** The model point at a drawing point; null where the view can't say (3D, detail, schedule). */
  toModel(d: Vec2, at?: DepthChoice): RunPoint | null;
  /** The model move for a drawing move (depth unchanged); null where the view can't say. */
  deltaToModel(d: Vec2): RunPoint | null;
  /** The depth choice that puts `toModel` back on `p` (plan: its elevation; section: its distance beyond the line). */
  depthOf(p: RunPoint): DepthChoice;
}

const COS30 = Math.cos(Math.PI / 6);
const ISO_NEAR = 1 / Math.sqrt(3);

export const DRAFTING_VIEW_REASON =
  "A detail view is drawing only, with no model in it. Lines, text and dimensions work here; open a plan, section or the 3D model to change the model.";
export const SCHEDULE_VIEW_REASON = "A schedule is a table of the model. Open a plan, section or the 3D model to change what it lists.";
export const ISOMETRIC_VIEW_REASON =
  "A 3D view's drawing is an isometric, so a point on it isn't one place in the model. Select works here; to draw or move, open the 3D model or a plan or section.";

function viewFloor(model: ModelState, view: ViewElement): number {
  return viewFloorMm(model, view.props?.level, view.props?.levelElevationMm) ?? 0;
}

/** The mapping for a saved view. A section without a cut line maps like a detail view (nothing to put a point on). */
export function viewMapping(model: ModelState, view: ViewElement): ViewMapping {
  const floorMm = viewFloor(model, view);
  const base = { viewId: view.id, floorMm, axis: null, look: null, depthRangeMm: null };
  switch (view.viewType) {
    case "floor_plan":
    case "ceiling_plan": {
      const k = view.viewType === "ceiling_plan" ? -1 : 1;
      return {
        ...base,
        kind: "plan",
        modelReason: null,
        toDrawing: (p) => ({ u: p.x, v: p.y, depth: k * p.z }),
        toModel: (d, at) => p3(d.x, d.y, at?.elevationMm ?? floorMm),
        deltaToModel: (d) => p3(d.x, d.y, 0),
        depthOf: (p) => ({ elevationMm: p.z }),
      };
    }
    case "section": {
      const cut = view.props?.section;
      if (!cut) break;
      const len = Math.hypot(cut.end.x - cut.start.x, cut.end.y - cut.start.y);
      if (len < 1e-6) break;
      const axis = { x: (cut.end.x - cut.start.x) / len, y: (cut.end.y - cut.start.y) / len };
      // Same convention as `sectionProjector`: perp(axis) = (-y, x), turned by the direction.
      const look = { x: -axis.y * cut.direction, y: axis.x * cut.direction };
      const s = cut.start;
      return {
        ...base,
        kind: "section",
        modelReason: null,
        axis,
        look,
        depthRangeMm: cut.depthMm,
        toDrawing: (p) => {
          const dx = p.x - s.x;
          const dy = p.y - s.y;
          return { u: dx * axis.x + dy * axis.y, v: p.z, depth: -(dx * look.x + dy * look.y) };
        },
        toModel: (d, at) => {
          const beyond = at?.depthMm ?? 0;
          return p3(s.x + axis.x * d.x + look.x * beyond, s.y + axis.y * d.x + look.y * beyond, d.y);
        },
        deltaToModel: (d) => p3(axis.x * d.x, axis.y * d.x, d.y),
        depthOf: (p) => ({ depthMm: (p.x - s.x) * look.x + (p.y - s.y) * look.y }),
      };
    }
    case "three_d":
      return {
        ...base,
        kind: "isometric",
        modelReason: ISOMETRIC_VIEW_REASON,
        // `drawIso` lays the isometric out with the level at z = 0.
        toDrawing: (p) => {
          const z = p.z - floorMm;
          return { u: (p.x - p.y) * COS30, v: (p.x + p.y) * 0.5 + z, depth: (-p.x - p.y + z) * ISO_NEAR };
        },
        toModel: () => null,
        deltaToModel: () => null,
        depthOf: () => ({}),
      };
    case "schedule":
      return { ...base, kind: "schedule", modelReason: SCHEDULE_VIEW_REASON, toDrawing: (p) => ({ u: p.x, v: p.y, depth: 0 }), toModel: () => null, deltaToModel: () => null, depthOf: () => ({}) };
    default:
      break;
  }
  return {
    ...base,
    kind: "drafting",
    modelReason: view.viewType === "section" ? "This section has no cut line, so it has nothing of the model to show. Draw a new section across a plan." : DRAFTING_VIEW_REASON,
    toDrawing: (p) => ({ u: p.x, v: p.y, depth: 0 }),
    toModel: () => null,
    deltaToModel: () => null,
    depthOf: () => ({}),
  };
}

/** Plain words for what a drawing move does in the model (the hint while dragging). */
export function describeModelDelta(mapping: ViewMapping, delta: RunPoint): string {
  if (mapping.kind === "section") {
    const along = mapping.axis ? delta.x * mapping.axis.x + delta.y * mapping.axis.y : Math.hypot(delta.x, delta.y);
    return `${feetInches(Math.abs(along))} along the section, ${feetInches(Math.abs(delta.z))} ${delta.z >= 0 ? "up" : "down"}`;
  }
  return `${feetInches(Math.abs(delta.x))} east-west, ${feetInches(Math.abs(delta.y))} north-south`;
}
