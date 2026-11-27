import {
  buildSheetSceneFor,
  buildViewScene,
  detailItemBounds,
  documentIndex,
  elementsAabb,
  frameForViewport,
  markupBounds,
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
import type { ScriptRenderRequest } from "@permitzip/bim-script";
import type { ScriptRenderedImage } from "../host";

const MM_PER_IN = 25.4;
const DEFAULT_DPI = 150;
const DEFAULT_MAX_PX = 1800;

interface PaperBox {
  readonly min: { readonly x: number; readonly y: number };
  readonly max: { readonly x: number; readonly y: number };
}

function clampBox(b: PaperBox, paper: { readonly x: number; readonly y: number }): PaperBox {
  const minX = Math.max(0, Math.min(paper.x, b.min.x));
  const minY = Math.max(0, Math.min(paper.y, b.min.y));
  const maxX = Math.max(minX + 1, Math.min(paper.x, b.max.x));
  const maxY = Math.max(minY + 1, Math.min(paper.y, b.max.y));
  return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
}

function unionPaperBoxes(boxes: readonly PaperBox[]): PaperBox | null {
  if (boxes.length === 0) return null;
  return {
    min: { x: Math.min(...boxes.map((b) => b.min.x)), y: Math.min(...boxes.map((b) => b.min.y)) },
    max: { x: Math.max(...boxes.map((b) => b.max.x)), y: Math.max(...boxes.map((b) => b.max.y)) },
  };
}

function drawnItemBox(item: DrawingItem, toPaper: (p: Vec2) => Vec2): PaperBox | null {
  return detailItemBounds(item, toPaper) ?? unionPaperBoxes(item.points.map((p) => toPaper(p)).map((p) => ({ min: p, max: p })));
}

function corners3d(box: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }) {
  const out: Array<{ x: number; y: number; z: number }> = [];
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) out.push({ x, y, z });
  return out;
}

function cropSvg(svg: string, region: PaperBox, highlights: readonly PaperBox[]): string {
  const w = Math.max(1, region.max.x - region.min.x);
  const h = Math.max(1, region.max.y - region.min.y);
  const out = svg.replace(
    /viewBox="[^"]*"/,
    `viewBox="${region.min.x.toFixed(2)} ${region.min.y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)}"`,
  );
  if (highlights.length === 0) return out;
  const stroke = Math.max(0.45, Math.min(1.6, Math.max(w, h) * 0.0022));
  const boxes = highlights
    .map(
      (b) =>
        `<rect x="${b.min.x.toFixed(2)}" y="${b.min.y.toFixed(2)}" width="${Math.max(1, b.max.x - b.min.x).toFixed(2)}" height="${Math.max(1, b.max.y - b.min.y).toFixed(2)}" fill="rgba(220,38,38,0.06)" stroke="#dc2626" stroke-width="${stroke.toFixed(2)}" stroke-dasharray="${(stroke * 3).toFixed(2)} ${(stroke * 2).toFixed(2)}"/>`,
    )
    .join("");
  return out.replace("</svg>", `<g data-highlight="script-render">${boxes}</g></svg>`);
}

function highlightBoxesForView(model: ModelState, view: ViewElement, frame: ViewFrame, ids: readonly string[] | undefined): PaperBox[] {
  if (!ids || ids.length === 0) return [];
  const boxes: PaperBox[] = [];
  const index = documentIndex(model);
  const drawn = new Map<string, DrawingItem>((index.itemsByOwner.get(view.id) ?? []).map((i) => [i.id, i]));
  let mapping: ReturnType<typeof viewMapping> | null = null;
  try {
    mapping = viewMapping(model, view);
  } catch {
    mapping = null;
  }
  for (const id of ids) {
    const item = drawn.get(id);
    if (item && !item.deleted && item.points.length > 0) {
      const box = drawnItemBox(item, (p) => modelToPaper(frame, p));
      if (box) {
        boxes.push({ min: { x: box.min.x - 1.5, y: box.min.y - 1.5 }, max: { x: box.max.x + 1.5, y: box.max.y + 1.5 } });
        continue;
      }
    }
    const aabb = mapping && mapping.modelReason === null ? elementsAabb(model, [id]) : null;
    if (!aabb || !mapping) continue;
    const m = mapping;
    const pts = corners3d(aabb).map((c) => {
      const d = m.toDrawing(c);
      return modelToPaper(frame, { x: d.u, y: d.v });
    });
    const box = unionPaperBoxes(pts.map((p) => ({ min: p, max: p })));
    if (box) boxes.push({ min: { x: box.min.x - 1.5, y: box.min.y - 1.5 }, max: { x: box.max.x + 1.5, y: box.max.y + 1.5 } });
  }
  return boxes;
}

function highlightBoxesForSheet(model: ModelState, sheetId: string, ids: readonly string[] | undefined): PaperBox[] {
  if (!ids || ids.length === 0) return [];
  const sheet = model.elements[sheetId];
  if (!sheet || sheet.kind !== "sheet" || sheet.deleted) return [];
  const index = documentIndex(model);
  const ownMarkups = new Map<string, DrawingItem>((index.markupsBySheet.get(sheet.id) ?? []).map((i) => [i.id, i]));
  const ownItems = new Map<string, DrawingItem>((index.itemsByOwner.get(sheet.id) ?? []).map((i) => [i.id, i]));
  const boxes: PaperBox[] = [];
  const rest: string[] = [];
  for (const id of ids) {
    const mk = ownMarkups.get(id);
    if (mk && !mk.deleted) {
      const b = markupBounds(mk);
      if (b) {
        boxes.push({ min: { x: b.min.x - 4, y: b.min.y - 4 }, max: { x: b.max.x + 4, y: b.max.y + 4 } });
        continue;
      }
    }
    const item = ownItems.get(id);
    if (item && !item.deleted && item.points.length > 0) {
      const b = drawnItemBox(item, (p) => p);
      if (b) {
        boxes.push({ min: { x: b.min.x - 1.5, y: b.min.y - 1.5 }, max: { x: b.max.x + 1.5, y: b.max.y + 1.5 } });
        continue;
      }
    }
    rest.push(id);
  }
  if (rest.length > 0) {
    for (const { viewport, view } of sheetViewports(model, sheet)) {
      if (view.viewType === "schedule") continue;
      const frame = frameForViewport(model, viewport, view);
      const left = frame.center.x - frame.size.x / 2;
      const top = frame.center.y - frame.size.y / 2;
      for (const b of highlightBoxesForView(model, view, frame, rest)) {
        if (b.max.x < left || b.min.x > left + frame.size.x || b.max.y < top || b.min.y > top + frame.size.y) continue;
        boxes.push(b);
      }
    }
  }
  return boxes;
}

type ResvgModule = {
  Resvg: new (
    svg: string,
    options?: {
      fitTo?: { mode: "width" | "height"; value: number };
      background?: string;
      font?: { fontDirs?: string[]; loadSystemFonts?: boolean; defaultFontFamily?: string };
    },
  ) => { render(): { width: number; height: number; asPng(): Uint8Array } };
};

let resvgLoader: Promise<ResvgModule | null> | null = null;

async function loadResvg(): Promise<ResvgModule | null> {
  if (!resvgLoader) {
    // Dynamic runtime import so @permitzip/bim-mcp keeps zero mandatory native deps in edge/lightweight builds.
    const pkgName = "@resvg/resvg-js";
    resvgLoader = import(/* @vite-ignore */ pkgName)
      .then((m) => (m && "Resvg" in m ? (m as ResvgModule) : null))
      .catch(() => null);
  }
  return resvgLoader;
}

async function rasterizeScene(
  scene: SheetScene,
  req: ScriptRenderRequest,
  highlights: readonly PaperBox[],
  fontDirs: readonly string[],
): Promise<{ png: Buffer; widthPx: number; heightPx: number; dpi: number; region: PaperBox }> {
  const resvgMod = await loadResvg();
  if (!resvgMod) {
    throw new Error(
      "Optional PNG rasterizer '@resvg/resvg-js' is not installed on this host; install '@resvg/resvg-js' or configure a custom renderImages host to attach sheet/view images.",
    );
  }
  const full: PaperBox = { min: { x: 0, y: 0 }, max: { x: scene.paper.x, y: scene.paper.y } };
  const region = req.regionMm ? clampBox(req.regionMm, scene.paper) : full;
  const wMm = Math.max(1, region.max.x - region.min.x);
  const hMm = Math.max(1, region.max.y - region.min.y);
  const askedDpi = req.dpi ?? DEFAULT_DPI;
  const maxPx = req.maxPx ?? DEFAULT_MAX_PX;
  const rawW = (wMm / MM_PER_IN) * askedDpi;
  const rawH = (hMm / MM_PER_IN) * askedDpi;
  const scale = Math.min(1, maxPx / Math.max(rawW, rawH));
  const widthPx = Math.max(1, Math.round(rawW * scale));
  const svg = cropSvg(sceneToSvg(scene, { monochrome: req.monochromeSheet ?? false }), region, highlights);
  const resvg = new resvgMod.Resvg(svg, {
    fitTo: { mode: "width", value: widthPx },
    background: "#ffffff",
    font: { fontDirs: [...fontDirs], loadSystemFonts: true, defaultFontFamily: "Liberation Sans" },
  });
  const rendered = resvg.render();
  return {
    png: Buffer.from(rendered.asPng()),
    widthPx: rendered.width,
    heightPx: rendered.height,
    dpi: Math.round(askedDpi * scale),
    region,
  };
}

/**
 * Default host-side image renderer for `bim_run_script` (`ctx.render` / `markups.renderSheet`).
 * Renders each requested sheet or view at the requested region/DPI using `@permitzip/bim-kernel`
 * SVG output + `@resvg/resvg-js` when available.
 */
export async function renderScriptRequests(
  model: ModelState,
  requests: readonly ScriptRenderRequest[],
  opts: { readonly fontDirs?: readonly string[] } = {},
): Promise<readonly ScriptRenderedImage[]> {
  if (requests.length === 0) return [];
  const fontDirs = opts.fontDirs ?? [];
  const out: ScriptRenderedImage[] = [];
  for (const req of requests) {
    if (req.kind === "sheet") {
      const sheet = model.elements[req.targetId];
      if (!sheet || sheet.kind !== "sheet" || sheet.deleted) continue;
      const scene = buildSheetSceneFor(model, sheet.id, {
        projectName: model.modelId || "Building Model",
        projectNumber: "",
        firmName: "",
        includeMarkups: req.includeMarkups ?? true,
        includeResolvedMarkups: req.includeResolvedMarkups ?? false,
      });
      const rendered = await rasterizeScene(scene, req, highlightBoxesForSheet(model, sheet.id, req.highlightIds), fontDirs);
      out.push({
        label: req.label,
        kind: "sheet",
        targetId: sheet.id,
        targetName: `${sheet.number} — ${sheet.title}`,
        revision: scene.revision,
        widthPx: rendered.widthPx,
        heightPx: rendered.heightPx,
        dpi: rendered.dpi,
        regionMm: rendered.region,
        png: rendered.png,
      });
    } else {
      const view = model.elements[req.targetId];
      if (!view || view.kind !== "view" || view.deleted) continue;
      const { scene, frame } = buildViewScene(model, view.id);
      const rendered = await rasterizeScene(scene, req, highlightBoxesForView(model, view, frame, req.highlightIds), fontDirs);
      out.push({
        label: req.label,
        kind: "view",
        targetId: view.id,
        targetName: view.name,
        revision: scene.revision,
        widthPx: rendered.widthPx,
        heightPx: rendered.heightPx,
        dpi: rendered.dpi,
        regionMm: rendered.region,
        png: rendered.png,
      });
    }
  }
  return out;
}
