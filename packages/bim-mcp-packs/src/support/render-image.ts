import { readdirSync } from "node:fs";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import {
  detailItemBounds,
  documentIndex,
  elementsAabb,
  frameForViewport,
  modelToPaper,
  sceneToSvg,
  sheetViewports,
  viewMapping,
  type DrawingItem,
  type ModelState,
  type SheetScene,
  type Vec2,
  type ViewElement,
  type ViewFrame,
} from "@permitzip/bim-kernel";

/**
 * Pictures of MutinyBIM views and sheets for agents: the same scene graph the
 * Building Model shows and the PDF writer prints, drawn to SVG and rasterized
 * with resvg (native, no browser). Notes use the same embedded Liberation Sans
 * the layout engine measured, so wrapping matches the print. Placed standard
 * details show as their labelled frame (the PDF embeds the vector page).
 */

const MM_PER_IN = 25.4;
export const RENDER_DEFAULT_DPI = 100;
export const RENDER_MAX_DPI = 400;
/**
 * The longest side of a picture unless the agent asks for more. A PNG rides
 * in the answer as base64 (about 4 characters for every 3 bytes), and at
 * 1,600 px one drawing was 100,000 to 177,000 characters kept in the agent's
 * context. 1,280 px is about a megapixel on a sheet's proportions: as much as
 * a vision model reads before it shrinks the picture itself. Zoom with a
 * region, or raise max_px, to read small text.
 */
export const RENDER_DEFAULT_MAX_PX = 1280;
export const RENDER_MAX_PX = 4000;

export interface PaperBox {
  readonly min: Vec2;
  readonly max: Vec2;
}

export interface RenderedImage {
  readonly png: Buffer;
  readonly widthPx: number;
  readonly heightPx: number;
  /** The paper drawn, mm from the scene's top-left. */
  readonly region: PaperBox;
  /** Resolution actually used (lowered to keep within the pixel cap). */
  readonly dpi: number;
}

let fontFiles: string[] | null = null;

/** The note fonts, from the directory the PDF writer reads (traced into the BIM routes). */
function noteFonts(dir: string): string[] {
  if (fontFiles) return fontFiles;
  const files = readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".ttf"))
    .map((f) => path.join(dir, f));
  if (files.length === 0) throw new Error(`No note fonts in ${dir}; the picture would print without text`);
  fontFiles = files;
  return files;
}

function clampBox(box: PaperBox, paper: Vec2): PaperBox {
  const min = { x: Math.max(0, Math.min(box.min.x, box.max.x)), y: Math.max(0, Math.min(box.min.y, box.max.y)) };
  const max = { x: Math.min(paper.x, Math.max(box.min.x, box.max.x)), y: Math.min(paper.y, Math.max(box.min.y, box.max.y)) };
  return { min, max };
}

/** Grow a box by `pad` mm each side. */
export function padBox(box: PaperBox, pad: number): PaperBox {
  return { min: { x: box.min.x - pad, y: box.min.y - pad }, max: { x: box.max.x + pad, y: box.max.y + pad } };
}

export function unionBoxes(boxes: readonly PaperBox[]): PaperBox | null {
  if (boxes.length === 0) return null;
  return {
    min: { x: Math.min(...boxes.map((b) => b.min.x)), y: Math.min(...boxes.map((b) => b.min.y)) },
    max: { x: Math.max(...boxes.map((b) => b.max.x)), y: Math.max(...boxes.map((b) => b.max.y)) },
  };
}

/**
 * PNG of a scene (or a region of it) at `dpi`, scaled down if it would be more
 * than `maxPx` on its long side. Highlight boxes (paper mm) are outlined in red.
 */
export function renderSceneImage(
  scene: SheetScene,
  opts: { readonly dpi: number; readonly maxPx: number; readonly region?: PaperBox | null; readonly highlights?: readonly PaperBox[]; readonly fontDir: string },
): RenderedImage {
  const region = clampBox(opts.region ?? { min: { x: 0, y: 0 }, max: scene.paper }, scene.paper);
  const w = region.max.x - region.min.x;
  const h = region.max.y - region.min.y;
  if (w < 1 || h < 1) throw new Error("That region is outside the drawing; nothing to show.");
  const wantedPx = (Math.max(w, h) / MM_PER_IN) * opts.dpi;
  const dpi = wantedPx > opts.maxPx ? (opts.maxPx * MM_PER_IN) / Math.max(w, h) : opts.dpi;
  const widthPx = Math.max(1, Math.round((w / MM_PER_IN) * dpi));

  const svg = sceneToSvg(scene);
  const open = svg.indexOf(">");
  if (!svg.startsWith("<svg") || open < 0) throw new Error("The drawing didn't produce an SVG");
  const head = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${region.min.x} ${region.min.y} ${w} ${h}" width="${widthPx}" height="${Math.round((h / MM_PER_IN) * dpi)}" font-family="Helvetica, Arial, sans-serif">`;
  const stroke = Math.max(0.5, (2 * MM_PER_IN) / dpi);
  const marks = (opts.highlights ?? [])
    .map((b) => {
      const p = padBox(b, 1.5);
      return `<rect x="${p.min.x}" y="${p.min.y}" width="${p.max.x - p.min.x}" height="${p.max.y - p.min.y}" fill="rgba(220,38,38,0.08)" stroke="#dc2626" stroke-width="${stroke}"/>`;
    })
    .join("");
  const body = svg.slice(open + 1, svg.lastIndexOf("</svg>"));
  const doc = `${head}${body}${marks}</svg>`;

  const resvg = new Resvg(doc, {
    fitTo: { mode: "width", value: widthPx },
    background: "#ffffff",
    font: { fontFiles: noteFonts(opts.fontDir), loadSystemFonts: false, defaultFontFamily: "Liberation Sans" },
  });
  const rendered = resvg.render();
  return { png: Buffer.from(rendered.asPng()), widthPx: rendered.width, heightPx: rendered.height, region, dpi: Math.round(dpi * 10) / 10 };
}

/** A drawn item's paper box: a symbol's whole box, else the extent of its points. */
function drawnItemBox(item: DrawingItem, toPaper: (p: Vec2) => Vec2): PaperBox | null {
  return detailItemBounds(item, toPaper) ?? unionBoxes(item.points.map((p) => toPaper(p)).map((p) => ({ min: p, max: p })));
}

function corners(box: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }) {
  const out: Array<{ x: number; y: number; z: number }> = [];
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) out.push({ x, y, z });
  return out;
}

/** Paper boxes for elements in one view drawn through `frame`: model elements by their 3D bounds, drawn items by their points. */
export function highlightInView(model: ModelState, view: ViewElement, frame: ViewFrame, ids: readonly string[]): { boxes: PaperBox[]; found: string[]; missing: string[] } {
  const boxes: PaperBox[] = [];
  const found: string[] = [];
  const missing: string[] = [];
  const index = documentIndex(model);
  const drawn = new Map<string, DrawingItem>((index.itemsByOwner.get(view.id) ?? []).map((i) => [i.id, i]));
  let mapping: ReturnType<typeof viewMapping> | null = null;
  try {
    mapping = viewMapping(model, view);
  } catch (err) {
    console.error("[bim render] view has no model mapping; model elements can't be highlighted", { viewId: view.id, err });
  }
  for (const id of ids) {
    const item = drawn.get(id);
    if (item && !item.deleted && item.points.length > 0) {
      const box = drawnItemBox(item, (p) => modelToPaper(frame, p));
      if (box) {
        boxes.push(box);
        found.push(id);
        continue;
      }
    }
    const aabb = mapping && mapping.modelReason === null ? elementsAabb(model, [id]) : null;
    if (!aabb || !mapping) {
      missing.push(id);
      continue;
    }
    const m = mapping;
    const pts = corners(aabb).map((c) => {
      const d = m.toDrawing(c);
      return modelToPaper(frame, { x: d.u, y: d.v });
    });
    const box = unionBoxes(pts.map((p) => ({ min: p, max: p })));
    if (box) {
      boxes.push(box);
      found.push(id);
    } else missing.push(id);
  }
  return { boxes, found, missing };
}

/** Paper boxes on a sheet: its own drawn items, and model elements in each viewport that shows them. */
export function highlightOnSheet(model: ModelState, sheetId: string, ids: readonly string[]): { boxes: PaperBox[]; found: string[]; missing: string[] } {
  const sheet = model.elements[sheetId];
  if (!sheet || sheet.kind !== "sheet") return { boxes: [], found: [], missing: [...ids] };
  const index = documentIndex(model);
  const own = new Map<string, DrawingItem>((index.itemsByOwner.get(sheet.id) ?? []).map((i) => [i.id, i]));
  const boxes: PaperBox[] = [];
  const found = new Set<string>();
  const rest: string[] = [];
  for (const id of ids) {
    const item = own.get(id);
    if (item && !item.deleted && item.points.length > 0) {
      const box = drawnItemBox(item, (p) => p);
      if (box) {
        boxes.push(box);
        found.add(id);
        continue;
      }
    }
    rest.push(id);
  }
  for (const { viewport, view } of sheetViewports(model, sheet)) {
    if (view.viewType === "schedule") continue;
    const frame = frameForViewport(model, viewport, view);
    const hit = highlightInView(model, view, frame, rest);
    const left = frame.center.x - frame.size.x / 2;
    const top = frame.center.y - frame.size.y / 2;
    hit.boxes.forEach((b, i) => {
      // Only where it lands inside the viewport.
      if (b.max.x < left || b.min.x > left + frame.size.x || b.max.y < top || b.min.y > top + frame.size.y) return;
      boxes.push(b);
      const id = hit.found[i];
      if (id) found.add(id);
    });
  }
  return { boxes, found: [...found], missing: ids.filter((id) => !found.has(id)) };
}
