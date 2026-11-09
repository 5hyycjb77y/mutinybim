import type { ViewCommand } from "../commands/views";
import type { Pen } from "../drawing/sheet";
import { isPackRefusal } from "../packs/points";
import { firstPartyPackName, firstPartyStoredOwner } from "../packs/first-party/manifests";
import { DEFAULT_SETTINGS, type ModelState, type Vec2 } from "../types";
import { diagramLayoutRow } from "./diagram-layout-point";

/**
 * Generic diagram items: what a diagram layout draws into (components, lines,
 * polylines, text blocks and ovals in drawing mm, y up, for a drafting view at
 * SCALE: NONE), how big their text prints, their extent, and the views/sheets
 * commands that put them on a drafting view. Riser, piping and isometric
 * layouts draw these; a stored radial one-line (`one_line`) is laid out by
 * the add-on that registers that kind on `DIAGRAM_LAYOUT_POINT`.
 */

/** An equipment kind as a stored one-line names it; the drawing add-on owns the words. */
export type OneLineKind = string;
/** A protective device as a stored one-line names it; the drawing add-on owns the words. */
export type OneLineDevice = string;
/** The feed ahead of a piece of equipment as a stored one-line keeps it; the drawing add-on reads its fields. */
export type OneLineFeed = Readonly<Record<string, string | number | undefined>>;

/** A piece of equipment in a stored radial one-line description (`one_line`). */
export interface OneLineNode {
  readonly id: string;
  readonly kind: OneLineKind;
  readonly name: string;
  readonly ratings?: readonly string[];
  readonly main?: { readonly device: OneLineDevice; readonly label?: string };
  readonly feeder?: OneLineFeed;
  readonly spd?: boolean;
  readonly ground?: boolean;
  readonly emergency?: OneLineNode;
  readonly children?: readonly OneLineNode[];
  /** A space for future equipment: drawn dashed. */
  readonly placeholder?: boolean;
}

/** A stored radial one-line description. */
export interface OneLineSpec {
  readonly title?: string;
  readonly roots: readonly OneLineNode[];
  readonly notes?: readonly string[];
}

export interface OneLineTextLine {
  readonly text: string;
  readonly bold?: boolean;
}

/** What a label says: the equipment's own text block, its feed's device, or its line's tag. */
export type OneLineTextRole = "equipment" | "device" | "conductor" | "note";

export type OneLineItem =
  | { readonly shape: "component"; readonly symbolId: string; readonly at: Vec2; readonly widthMm: number; readonly heightMm: number; readonly nodeId: string; readonly rotationDeg?: number }
  | { readonly shape: "line"; readonly points: readonly [Vec2, Vec2]; readonly weight: Pen; readonly nodeId: string; readonly dashed?: boolean }
  | { readonly shape: "polyline"; readonly points: readonly Vec2[]; readonly weight: Pen; readonly nodeId: string; readonly dashed?: boolean; readonly closed?: boolean }
  | {
      readonly shape: "text";
      readonly at: Vec2;
      readonly widthMm: number;
      readonly lines: readonly OneLineTextLine[];
      readonly nodeId: string;
      readonly role?: OneLineTextRole;
      /** The x of the line it labels, in the vertical layout (where a horizontal layout puts it). */
      readonly ref?: number;
      readonly align?: "left" | "center";
    }
  /** A type mark in an oval on a line (it stays upright in every orientation). */
  | { readonly shape: "oval"; readonly center: Vec2; readonly text: string; readonly widthMm: number; readonly heightMm: number; readonly nodeId: string };

export const ONE_LINE_ORIENTATIONS = ["vertical", "horizontal"] as const;
/** vertical: power flows down the sheet. horizontal: power flows left to right. */
export type OneLineOrientation = (typeof ONE_LINE_ORIENTATIONS)[number];

export interface OneLineLayoutOptions {
  readonly orientation?: OneLineOrientation;
  /** The model the diagram reads live values from; absent: the description carries everything it draws. */
  readonly model?: ModelState;
}

export interface OneLineLayout {
  readonly items: readonly OneLineItem[];
  /** Bounds of everything drawn (labels included), drawing mm. */
  readonly extent: { readonly min: Vec2; readonly max: Vec2 };
  /** Every piece of equipment and where its symbol sits. */
  readonly nodes: ReadonlyArray<{ readonly id: string; readonly kind: OneLineKind; readonly name: string; readonly center: Vec2; readonly depth: number }>;
  /** Items [start, end) each node and everything below it drew (its subtree), in `items` order. */
  readonly ranges?: Readonly<Record<string, readonly [number, number]>>;
  /** Where each node's feed leaves what feeds it (on the parent's bus or under its load terminal). */
  readonly entries?: Readonly<Record<string, Vec2>>;
}

/** Text cap height on paper; 3/32" is the smallest drafting text. */
export const ONE_LINE_TEXT_MM = 2.4;
const LINE_PITCH = ONE_LINE_TEXT_MM * 1.75;
/** Conservative average glyph advance, so a label's height covers its wrapping. */
const CHAR_MM = ONE_LINE_TEXT_MM * 0.8;
const LABEL_WIDTH = 52;

/** Printed height of a note of these lines at this width, wrapping included. */
export function oneLineTextHeight(lines: readonly OneLineTextLine[], width = LABEL_WIDTH): number {
  if (lines.length === 0) return 0;
  const perLine = Math.max(1, Math.floor(width / CHAR_MM));
  const rows = lines.reduce((s, l) => s + Math.max(1, Math.ceil(l.text.length / perLine)), 0);
  return rows * LINE_PITCH + 1;
}
const textHeight = oneLineTextHeight;

/** Printed width of a note of these lines, at most `width`. */
export function oneLineTextWidth(lines: readonly OneLineTextLine[], width = LABEL_WIDTH): number {
  if (lines.length === 0) return 0;
  return Math.min(width, Math.max(...lines.map((l) => l.text.length)) * CHAR_MM);
}

function round(p: Vec2): Vec2 {
  return { x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 };
}

/** Bounds of a list of items, labels included. */
export function oneLineItemsExtent(items: readonly OneLineItem[]): { min: Vec2; max: Vec2 } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const grow = (p: Vec2) => {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  };
  for (const item of items) {
    switch (item.shape) {
      case "component": {
        const turned = item.rotationDeg === 90;
        grow(item.at);
        grow(turned ? { x: item.at.x - item.heightMm, y: item.at.y + item.widthMm } : { x: item.at.x + item.widthMm, y: item.at.y + item.heightMm });
        break;
      }
      case "line":
      case "polyline":
        for (const p of item.points) grow(p);
        break;
      case "oval":
        grow({ x: item.center.x - item.widthMm / 2, y: item.center.y - item.heightMm / 2 });
        grow({ x: item.center.x + item.widthMm / 2, y: item.center.y + item.heightMm / 2 });
        break;
      case "text":
        grow(item.at);
        grow({ x: item.at.x + item.widthMm, y: item.at.y - textHeight(item.lines, item.widthMm) });
        break;
    }
  }
  if (!Number.isFinite(minX)) return { min: { x: 0, y: 0 }, max: { x: 0, y: 0 } };
  return { min: round({ x: minX, y: minY }), max: round({ x: maxX, y: maxY }) };
}

/** The stored kind of a radial one-line description. Frozen. */
const ONE_LINE_KIND = "one_line";

/** A model with nothing in it, for a description that carries everything it draws. */
const NO_MODEL: ModelState = { modelId: "diagram", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };

/** Why a stored one-line can't be drawn here, in words. */
function notDrawnHere(): string {
  const owner = firstPartyStoredOwner("diagram", ONE_LINE_KIND);
  const name = owner ? firstPartyPackName(owner) : null;
  return name ? `This one-line is drawn by ${name}, which isn't loaded here` : "No add-on loaded here draws this one-line";
}

/**
 * Lay out a stored radial one-line through the row registered for it
 * (`DIAGRAM_LAYOUT_POINT`, kind `one_line`); throws the plain reason when the
 * description can't be drawn or no add-on here draws it.
 */
export function layoutOneLine(spec: OneLineSpec, options: OneLineLayoutOptions = {}): OneLineLayout {
  const row = diagramLayoutRow(ONE_LINE_KIND);
  if (!row) throw new Error(notDrawnHere());
  const out = row.layout(spec, { model: options.model ?? NO_MODEL, ...(options.orientation ? { orientation: options.orientation } : {}) });
  if (isPackRefusal(out)) throw new Error(out.refused);
  return out;
}

/** A closed outline for an oval of this size (straight sides, round ends), drawing mm. */
export function ovalOutline(center: Vec2, widthMm: number, heightMm: number): Vec2[] {
  const r = heightMm / 2;
  const half = Math.max(0, widthMm / 2 - r);
  const pts: Vec2[] = [];
  const steps = 8;
  for (let i = 0; i <= steps; i++) {
    const a = -Math.PI / 2 + (Math.PI * i) / steps;
    pts.push(round({ x: center.x + half + r * Math.cos(a), y: center.y + r * Math.sin(a) }));
  }
  for (let i = 0; i <= steps; i++) {
    const a = Math.PI / 2 + (Math.PI * i) / steps;
    pts.push(round({ x: center.x - half + r * Math.cos(a), y: center.y + r * Math.sin(a) }));
  }
  return pts;
}

/** Crop the drafting view to the diagram with a paper margin, so its viewport is exactly as big as the drawing. */
export function oneLineCropCommand(viewId: string, layout: OneLineLayout, marginMm = 8): ViewCommand {
  return {
    type: "set_view_crop",
    viewId,
    crop: round2({ min: { x: layout.extent.min.x - marginMm, y: layout.extent.min.y - marginMm }, max: { x: layout.extent.max.x + marginMm, y: layout.extent.max.y + marginMm } }),
    cropView: true,
  };
}

function round2(r: { min: Vec2; max: Vec2 }): { min: Vec2; max: Vec2 } {
  return { min: round(r.min), max: round(r.max) };
}

/**
 * The layout as views/sheets commands on one drafting view: one
 * add_drawing_item per symbol and line, one note per label, each in a detail
 * group per piece of equipment so it moves as one. Ids are `<idPrefix>-<n>`:
 * the same call makes the same ids.
 */
export function oneLineCommands(ownerId: string, layout: OneLineLayout, idPrefix: string, textSizeMm = ONE_LINE_TEXT_MM): ViewCommand[] {
  return layout.items.flatMap((item, i): ViewCommand[] => {
    const itemId = `${idPrefix}-${i}`;
    const detailGroup = `one-line ${item.nodeId}`;
    const pattern = "dashed" in item && item.dashed ? { pattern: "dashed" as const } : {};
    switch (item.shape) {
      case "component":
        return [{ type: "add_drawing_item", itemId, ownerId, shape: "component", points: [item.at], component: { symbolId: item.symbolId, widthMm: item.widthMm, heightMm: item.heightMm, ...(item.rotationDeg ? { rotationDeg: item.rotationDeg } : {}) }, detailGroup }];
      case "line":
        return [{ type: "add_drawing_item", itemId, ownerId, shape: "line", points: [...item.points], lineStyle: { weight: item.weight, ...pattern }, detailGroup }];
      case "polyline":
        return [{ type: "add_drawing_item", itemId, ownerId, shape: "polyline", points: [...item.points], lineStyle: { weight: item.weight, ...pattern }, ...(item.closed ? { closed: true } : {}), detailGroup }];
      case "oval":
        return [
          { type: "add_drawing_item", itemId, ownerId, shape: "polyline", points: ovalOutline(item.center, item.widthMm, item.heightMm), closed: true, lineStyle: { weight: "thin" }, detailGroup },
          { type: "create_text_note", itemId: `${itemId}-t`, ownerId, at: { x: item.center.x - item.widthMm / 2, y: item.center.y + textSizeMm * 0.75 }, width: item.widthMm, textSize: textSizeMm * 0.85, paragraphs: [{ runs: [{ text: item.text }], align: "center" }] },
        ];
      case "text":
        return [
          {
            type: "create_text_note",
            itemId,
            ownerId,
            at: item.at,
            width: item.widthMm,
            textSize: textSizeMm,
            paragraphs: item.lines.map((l) => ({ runs: [{ text: l.text, ...(l.bold ? { bold: true } : {}) }], ...(item.align === "center" ? { align: "center" as const } : {}) })),
          },
        ];
    }
  });
}
