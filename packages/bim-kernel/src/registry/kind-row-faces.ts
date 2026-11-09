import type { ViewCategory } from "../documents";
import type { SolidRole } from "../drawing/solids";
import type { Tilt } from "../geometry";
import type { RunPoint, RunSize } from "../routing/types";
import type { BimElement, ConnectorRef, Vec2 } from "../types";

/**
 * Three element kind row faces added in contract 1.10.0, on
 * `ElementKindItem` (`registry/element-kind-point.ts`), so drawing, tags,
 * selection and view mapping read a kind's row instead of a kind case.
 */

type Elements = Readonly<Record<string, BimElement>>;

/** What plans draw for one record: a symbol (a `SYMBOL_POINT` id) at its anchor, turned and scaled. */
export interface KindSymbol {
  readonly symbolId: string;
  readonly at: Vec2;
  readonly rotationDeg: number;
  /** Model mm across; absent: the symbol's own size. */
  readonly sizeMm?: number;
}

/** Where a click selects one record, in plan model mm. */
export type KindPickShape =
  | { readonly form: "segment"; readonly a: Vec2; readonly b: Vec2; readonly halfWidthMm: number }
  | { readonly form: "point"; readonly at: Vec2; readonly radiusMm: number }
  | { readonly form: "outline"; readonly points: readonly Vec2[] };

/** Plan symbol for one record, or null when it draws no symbol (its shape is drawn instead). */
export type KindSymbolFace = (el: BimElement, elements: Elements) => KindSymbol | null;

/** The text a tag prints for one record by default ("S-1 400"), or null when it has none. */
export type KindTagTextFace = (el: BimElement, elements: Elements) => string | null;

/** Where a click picks one record, or null when it can't be picked in plan. */
export type KindPickShapeFace = (el: BimElement, elements: Elements) => KindPickShape | null;

/** How a text sits on its point: the point is its start, middle or end. Absent: start. */
export type PlanTextAnchor = "start" | "middle" | "end";

/**
 * Contract 1.11.0: what plans draw for one record as model-space lines,
 * fills, texts and tag places (a run's two edges and centre line, a wall's
 * faces and layer hatch, a door's swing). Plans read the row instead of a
 * kind case.
 *
 * `dash` names a line pattern (`solid`, `dashed`, `hidden`, `center`,
 * `phantom`, `dotted`); a name plans don't know draws solid. Text heights are
 * the printed cap height in paper mm, whatever the scale. A `tag_place` with
 * `text` is the record's own label: a plan prints it unless the view hides
 * tags or the record carries a tag of its own.
 */
export type PlanGraphic =
  | { readonly form: "line"; readonly a: Vec2; readonly b: Vec2; readonly pen: PlanPen; readonly dash?: string; readonly tone?: PlanTone }
  | { readonly form: "polyline"; readonly points: readonly Vec2[]; readonly closed: boolean; readonly pen: PlanPen; readonly dash?: string; readonly fill?: string; readonly tone?: PlanTone }
  /** An axis-aligned box about `center`, `size` across (a unit's outline). */
  | { readonly form: "rect"; readonly center: Vec2; readonly size: Vec2; readonly pen: PlanPen }
  | { readonly form: "arc"; readonly center: Vec2; readonly radiusMm: number; readonly startDeg: number; readonly sweepDeg: number; readonly pen: PlanPen; readonly dash?: string }
  | {
      readonly form: "text";
      readonly at: Vec2;
      readonly text: string;
      readonly heightMm: number;
      readonly rotationDeg: number;
      readonly anchor?: PlanTextAnchor;
      readonly bold?: boolean;
      /** Nudged this far on paper after placing, in paper mm, y down (a second line under a label). */
      readonly paperOffsetMm?: Vec2;
    }
  | {
      readonly form: "tag_place";
      readonly at: Vec2;
      readonly rotationDeg: number;
      /** The label printed here. Absent: a place only. */
      readonly text?: string;
      /** What the tag hangs on: the run's centre (`centerline_mid`) or the record's insertion point. Absent: insertion. */
      readonly ref?: "centerline_mid" | "insertion";
      /** Absent: 2.5. */
      readonly heightMm?: number;
      readonly anchor?: PlanTextAnchor;
      readonly bold?: boolean;
    };

/** `halftone`: printed screened whatever the view's own tone (work seen beyond, a run below the ceiling in a ceiling plan). Absent: the view's tone. */
export type PlanTone = "halftone";

/** Line weights a plan picks from; the view template maps them to widths. */
export type PlanPen = "thin" | "medium" | "wide" | "cut";

export interface PlanGraphicsContext {
  readonly elements: Elements;
  /** The view's scale denominator (100 for 1:100). */
  readonly scale: number;
  readonly levelId: string;
  /** The view's detail level: coarse draws runs as one line. */
  readonly detail: "coarse" | "medium" | "fine";
  /** What is being drawn: a plan `view` (tags at points come from tag annotations) or the one-sheet `sheet` printout, which labels every point record itself. */
  readonly drawing: "view" | "sheet";
  /** A ceiling plan: looking up at the ceiling, so what runs below it is seen beyond. */
  readonly lookingUp: boolean;
  /** The connector end joined to `ref`, or null when nothing is connected there. */
  connectedTo(ref: ConnectorRef): ConnectorRef | null;
}

/** Plan graphics for one record, or null to fall back to the symbol / outline the view draws today. */
export type KindPlanGraphicsFace = (el: BimElement, ctx: PlanGraphicsContext) => readonly PlanGraphic[] | null;

/**
 * Contract 1.11.0: a record's body, for sections, 3D views and plan hiding,
 * as a shape the kernel builds (world mm, z above project zero). A kind with
 * this face has a body: its plan linework hides under what is above it and
 * fills when a plan is shaded.
 */
export type KindSolidShape =
  /** A straight run of one cross-section from `a` to `b`. `sizeMm`: its nominal width (single-line cut markers). */
  | { readonly form: "run"; readonly a: RunPoint; readonly b: RunPoint; readonly size: RunSize; readonly sizeMm: number; readonly category: ViewCategory; readonly role: KindSolidRole }
  /** An upright prism over a convex plan outline, from `z0` to `z1`. */
  | { readonly form: "prism"; readonly outline: readonly Vec2[]; readonly z0: number; readonly z1: number; readonly category: ViewCategory; readonly role: KindSolidRole }
  /** Several upright prisms as one body (a wall left in blocks round its openings, a stepped footing). A tilted bottom or top is a sloped plane through `z0` / `z1` (a pitched roof). */
  | { readonly form: "prisms"; readonly blocks: readonly { readonly outline: readonly Vec2[]; readonly z0: number; readonly z1: number; readonly tilt0?: Tilt; readonly tilt1?: Tilt }[]; readonly category: ViewCategory; readonly role: KindSolidRole };

/** How a body shades (`drawing/solids.ts` `SolidRole`): building services, building fabric, or a piece of equipment. */
export type KindSolidRole = SolidRole;

export interface KindSolidContext {
  readonly elements: Elements;
  /** The drawing's floor, for records that carry no elevation of their own. */
  readonly floorMm: number;
}

/** A record's body, or null when this one has none (a zero-length run). */
export type KindSolidFace = (el: BimElement, ctx: KindSolidContext) => KindSolidShape | null;

/** What `create_element` hands a kind's `create` face: where to draw it and what the person chose. Lengths in mm. */
export interface KindCreateInput {
  readonly id: string;
  readonly levelId: string;
  readonly placement:
    | { readonly kind: "point"; readonly position: Vec2; readonly rotationDeg: number }
    | { readonly kind: "line"; readonly start: Vec2; readonly end: Vec2 }
    | { readonly kind: "area"; readonly outline: readonly Vec2[]; readonly holes: readonly (readonly Vec2[])[] };
  readonly typeId?: string;
  readonly values?: Readonly<Record<string, number | string | boolean>>;
  readonly size?: { readonly thicknessMm?: number; readonly heightMm?: number; readonly widthMm?: number; readonly depthMm?: number };
  readonly label?: string;
}

/** Placements a kind can be drawn with. */
export const KIND_CREATE_PLACEMENTS = ["point", "line", "area"] as const;

/**
 * Contract 1.11.0: how `create_element` / `create_elements` make one record
 * of an add-on kind. `make` returns the whole record (the command stamps its
 * id and revision fields) or a refusal in words.
 */
export interface KindCreateFace {
  readonly placements: readonly (typeof KIND_CREATE_PLACEMENTS)[number][];
  make(input: KindCreateInput, elements: Elements): BimElement | { readonly refused: string };
}

/** Problems with the faces on one row (pack conformance), in words. */
export function kindRowFaceProblems(kind: string, row: { readonly symbol?: unknown; readonly tagText?: unknown; readonly pickShape?: unknown; readonly planGraphics?: unknown; readonly solid?: unknown; readonly create?: unknown }): string[] {
  const out: string[] = [];
  for (const face of ["symbol", "tagText", "pickShape", "planGraphics", "solid"] as const) {
    if (row[face] !== undefined && typeof row[face] !== "function") out.push(`element kind ${kind}: ${face} must be a function`);
  }
  if (row.create !== undefined) out.push(...createFaceProblems(kind, row.create));
  return out;
}

function createFaceProblems(kind: string, face: unknown): string[] {
  if (typeof face !== "object" || face === null) return [`element kind ${kind}: create must say how to draw one (placements and make)`];
  const out: string[] = [];
  const placements: unknown = (face as { placements?: unknown }).placements;
  if (!Array.isArray(placements) || placements.length === 0) out.push(`element kind ${kind}: create names no placement (point, line or area)`);
  else for (const p of placements) if (!(KIND_CREATE_PLACEMENTS as readonly unknown[]).includes(p)) out.push(`element kind ${kind}: create placement "${String(p)}" must be point, line or area`);
  if (typeof (face as { make?: unknown }).make !== "function") out.push(`element kind ${kind}: create.make must be a function`);
  return out;
}
