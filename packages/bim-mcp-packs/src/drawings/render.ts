import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildSheetSceneFor, buildViewScene, canonicalJson, modelToPaper, sheetViewports, titleBlockValues, withCategoryRegistry, type ModelState, type SheetScene } from "@permitzip/bim-kernel";
import { nodeNoteFonts, renderSheetPdf } from "@permitzip/bim-sheets";
import {
  RENDER_DEFAULT_DPI,
  RENDER_DEFAULT_MAX_PX,
  RENDER_MAX_DPI,
  RENDER_MAX_PX,
  highlightInView,
  highlightOnSheet,
  padBox,
  renderSceneImage,
  unionBoxes,
  type PaperBox,
  type RenderedImage,
} from "../support/render-image";
import { explain, failure, target, text, withSession, type Extra, type ResolveBimCaller } from "../runtime";
import { NOTE_FONTS_DIR, drawingCategoriesFor, findSheet, findView } from "../views/views";
import { agentSheetTitle } from "../views/sheet-title";
import type { RenderToolsHost, StoreProjectFile } from "./capabilities";

/**
 * Look at the drawings: a PNG of any view or sheet as it prints, returned as
 * an image the model can see (plus the numbers), and a vector PDF of one view.
 * Reads only, from the last saved revision; no approval.
 */

const FT = 304.8;
const IN = 25.4;

const pt = z.object({ x: z.number().finite(), y: z.number().finite() });
const box = z.object({ min: pt, max: pt });
const imageInput = {
  dpi: z.number().min(20).max(RENDER_MAX_DPI).optional().describe(`Resolution in dots per paper inch (default ${RENDER_DEFAULT_DPI}). Lowered automatically to stay within max_px.`),
  max_px: z.number().int().min(200).max(RENDER_MAX_PX).optional().describe(`Longest side of the picture in pixels (default ${RENDER_DEFAULT_MAX_PX}).`),
  highlight_ids: z.array(z.string().min(1).max(200)).max(50).optional().describe("Element or drawn item ids to outline in red."),
  keep_copy: z.boolean().optional().describe("Also store the PNG in the project's files and return a 5-minute link (for a person)."),
};

/**
 * A picture's answer: the numbers as text and the PNG once, as MCP image
 * content. The picture's bytes are never repeated in the text part.
 */
export function imageResult(summary: Record<string, unknown>, image: Pick<RenderedImage, "png">) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(summary, null, 2) },
      { type: "image" as const, data: image.png.toString("base64"), mimeType: "image/png" },
    ],
  };
}

/** Said when the picture was drawn below the resolution asked for, so the agent zooms instead of squinting. */
export function scaledWords(image: Pick<RenderedImage, "dpi">, askedDpi: number): string {
  return image.dpi < askedDpi ? ` Scaled down to fit max_px (${image.dpi} dpi, not ${askedDpi}): to read small text, zoom with a region or raise max_px.` : "";
}

/** Grow a box about its centre to at least `mm` each way, so a zoom keeps some context. */
function atLeast(b: PaperBox, mm: number): PaperBox {
  const cx = (b.min.x + b.max.x) / 2;
  const cy = (b.min.y + b.max.y) / 2;
  const hw = Math.max(mm, b.max.x - b.min.x) / 2;
  const hh = Math.max(mm, b.max.y - b.min.y) / 2;
  return { min: { x: cx - hw, y: cy - hh }, max: { x: cx + hw, y: cy + hh } };
}

function overlaps(a: PaperBox, b: PaperBox): boolean {
  return a.min.x <= b.max.x && b.min.x <= a.max.x && a.min.y <= b.max.y && b.min.y <= a.max.y;
}

function inches(b: PaperBox) {
  const r = (v: number) => Math.round((v / IN) * 100) / 100;
  return { min: { x: r(b.min.x), y: r(b.min.y) }, max: { x: r(b.max.x), y: r(b.max.y) } };
}

async function keep(store: StoreProjectFile, extra: Extra, projectId: string, kind: string, name: string, revision: number, png: Buffer) {
  const sha = createHash("sha256").update(png).digest("hex");
  const safe = name.replace(/[^\w.-]/g, "_").slice(0, 80);
  const stored = await store(extra, projectId, `projects/${projectId}/building-model/images/${kind}-${safe}-rev${revision}-${sha.slice(0, 12)}.png`, new Uint8Array(png), "image/png");
  return { download_url: stored.downloadUrl, link_minutes: Math.round(stored.expiresInSeconds / 60) };
}

export function registerBimRenderTools(server: McpServer, caller: ResolveBimCaller, stores: RenderToolsHost) {
  const linkedBackgrounds = stores.backgrounds;
  const resolveSheetTitle = stores.sheetTitle;
  server.registerTool(
    "bim_render_view_image",
    {
      title: "Picture of a view",
      description:
        "Draw one view (floor or ceiling plan, section, 3D view, detail or drafting view, schedule) from the last saved revision as a PNG you can look at, exactly as it prints: linework, tags, dimensions, notes, crop. Use it after edits to check the drawing reads right (overlaps, clipped notes, missing tags). Optional: a region (view feet in the view's own frame, or paper inches from the drawing's top-left), elements to frame and outline in red, resolution. Returns the image, the revision drawn and the paper size.",
      inputSchema: {
        ...target,
        view: z.string().min(1).max(200).describe("View id or exact name."),
        region_ft: box.optional().describe("Part of the view to show, in view feet (plan x / y; a section's distance along the cut and elevation; a detail view's drawing feet)."),
        region_in: box.optional().describe("Part of the drawing to show, in paper inches from its top-left. Ignored when region_ft is given."),
        focus_ids: z.array(z.string().min(1).max(200)).max(50).optional().describe("Show just the area around these elements or drawn items (with a margin). A region wins; ids it leaves out come back as outside_region."),
        ...imageInput,
      },
    },
    async (args, extra) => {
      try {
        const who = await caller(extra, args.project_id, false);
        const drawn = await withSession(who, args.model_id, undefined, async (s) => {
          const model = s.model();
          const viewId = findView(model, args.view);
          if (!viewId) return `No view "${args.view}". List views and sheets first.`;
          const view = model.elements[viewId];
          if (!view || view.kind !== "view") return `No view "${args.view}". List views and sheets first.`;
          const linked = await linkedBackgrounds(extra, args.project_id, model, [view]);
          const graphics = await drawingCategoriesFor(extra, [view], stores.firmClasses);
          const { scene, frame } = withCategoryRegistry(graphics.categories, () => buildViewScene(model, viewId, linked.backgrounds[viewId] ?? []));
          const highlight = highlightInView(model, view, frame, args.highlight_ids ?? []);
          const focus = args.focus_ids?.length ? highlightInView(model, view, frame, args.focus_ids) : null;
          let region: PaperBox | null = null;
          if (args.region_ft) {
            const a = modelToPaper(frame, { x: args.region_ft.min.x * FT, y: args.region_ft.min.y * FT });
            const b = modelToPaper(frame, { x: args.region_ft.max.x * FT, y: args.region_ft.max.y * FT });
            region = unionBoxes([{ min: a, max: a }, { min: b, max: b }]);
          } else if (args.region_in) {
            region = { min: { x: args.region_in.min.x * IN, y: args.region_in.min.y * IN }, max: { x: args.region_in.max.x * IN, y: args.region_in.max.y * IN } };
          } else if (focus) {
            const u = unionBoxes(focus.boxes);
            region = u ? atLeast(padBox(u, 12), 60) : null;
          }
          const image = renderSceneImage(scene, { dpi: args.dpi ?? RENDER_DEFAULT_DPI, maxPx: args.max_px ?? RENDER_DEFAULT_MAX_PX, region, highlights: highlight.boxes, fontDir: NOTE_FONTS_DIR });
          // A region given with focus ids wins; say which focus elements it leaves out instead of drawing them silently away.
          const outside = focus && region && (args.region_ft || args.region_in) ? focus.found.filter((_, i) => { const b = focus.boxes[i]; return b !== undefined && !overlaps(b, region); }) : [];
          return { model, view, scene, image, highlight, focusMissing: focus?.missing ?? [], outside, linkedMissing: linked.missing, graphicsNote: graphics.note };
        });
        if (typeof drawn === "string") return failure(drawn);
        const { view, scene, image, highlight, focusMissing, outside, linkedMissing, graphicsNote } = drawn;
        const regionName = args.region_ft ? "region_ft" : "region_in";
        const kept = args.keep_copy ? await keep(stores.storeProjectFile, extra, args.project_id, "view", view.name, scene.revision, image.png) : null;
        return imageResult(
          {
            status: "drawn",
            message: `${view.name} from saved Rev ${scene.revision}, ${image.widthPx} × ${image.heightPx} px at ${image.dpi} dpi.${scaledWords(image, args.dpi ?? RENDER_DEFAULT_DPI)}${outside.length ? ` ${outside.length} of the focus elements are in the view but outside ${regionName}, so they aren't in the picture (${outside.join(", ")}); leave out ${regionName} to frame them, or widen it.` : ""}`,
            view: { id: view.id, name: view.name, type: view.viewType },
            revision: scene.revision,
            paper_in: inches({ min: { x: 0, y: 0 }, max: scene.paper }).max,
            region_in: inches(image.region),
            ...(highlight.found.length ? { highlighted: highlight.found } : {}),
            ...(highlight.missing.length || focusMissing.length ? { not_in_view: [...new Set([...highlight.missing, ...focusMissing])] } : {}),
            ...(outside.length ? { outside_region: outside } : {}),
            ...(linkedMissing.length ? { linked_models_missing: linkedMissing } : {}),
            ...(graphicsNote ? { graphics_note: graphicsNote } : {}),
            ...(kept ?? {}),
          },
          image,
        );
      } catch (err) {
        return explain(err, "bim_render_view_image");
      }
    },
  );

  server.registerTool(
    "bim_render_sheet_image",
    {
      title: "Picture of a sheet",
      description:
        "Draw one sheet from the last saved revision as a PNG you can look at, exactly as it prints: border, viewports at scale with titles, notes, schedules, title block. Use it to check a sheet's layout before printing or issuing. Optional: a region in paper inches from the sheet's top-left (to read small text), elements or drawn items to outline in red, resolution. A whole 36 x 24 sheet at the default size is an overview; zoom with region_in to read notes.",
      inputSchema: {
        ...target,
        sheet: z.string().min(1).max(200).describe("Sheet id or number, e.g. M-101."),
        region_in: box.optional().describe("Part of the sheet to show, paper inches from its top-left."),
        ...imageInput,
      },
    },
    async (args, extra) => {
      try {
        const who = await caller(extra, args.project_id, false);
        const titleBlock = await agentSheetTitle(resolveSheetTitle, extra, args.project_id);
        const drawn = await withSession(who, args.model_id, undefined, async (s) => {
          const model: ModelState = s.model();
          const sheetId = findSheet(model, args.sheet);
          const sheet = sheetId ? model.elements[sheetId] : undefined;
          if (!sheetId || !sheet || sheet.kind !== "sheet") return `No sheet "${args.sheet}". List views and sheets first.`;
          const views = sheetViewports(model, sheet).map((v) => v.view);
          const linked = await linkedBackgrounds(extra, args.project_id, model, views);
          const graphics = await drawingCategoriesFor(extra, views, stores.firmClasses);
          const scene: SheetScene = withCategoryRegistry(graphics.categories, () => buildSheetSceneFor(model, sheetId, { projectName: titleBlock.projectName, projectNumber: titleBlock.projectNumber, firmName: titleBlock.firmName, backgrounds: linked.backgrounds }));
          const highlight = highlightOnSheet(model, sheetId, args.highlight_ids ?? []);
          const region = args.region_in ? { min: { x: args.region_in.min.x * IN, y: args.region_in.min.y * IN }, max: { x: args.region_in.max.x * IN, y: args.region_in.max.y * IN } } : null;
          const image = renderSceneImage(scene, { dpi: args.dpi ?? RENDER_DEFAULT_DPI, maxPx: args.max_px ?? RENDER_DEFAULT_MAX_PX, region, highlights: highlight.boxes, fontDir: NOTE_FONTS_DIR });
          return { number: sheet.number, title: sheet.title, scene, image, highlight, linkedMissing: linked.missing, printedTitle: titleBlockValues(sheet, titleBlock), graphicsNote: graphics.note };
        });
        if (typeof drawn === "string") return failure(drawn);
        const { number, title, scene, image, highlight, linkedMissing, printedTitle, graphicsNote } = drawn;
        const kept = args.keep_copy ? await keep(stores.storeProjectFile, extra, args.project_id, "sheet", number, scene.revision, image.png) : null;
        return imageResult(
          {
            status: "drawn",
            message: `Sheet ${number} from saved Rev ${scene.revision}, ${image.widthPx} × ${image.heightPx} px at ${image.dpi} dpi.${scaledWords(image, args.dpi ?? RENDER_DEFAULT_DPI)}`,
            sheet: { number, name: title },
            title_block: { firm: printedTitle.firm, project: printedTitle.project, project_number: printedTitle.projectNumber },
            revision: scene.revision,
            paper_in: inches({ min: { x: 0, y: 0 }, max: scene.paper }).max,
            region_in: inches(image.region),
            ...(highlight.found.length ? { highlighted: highlight.found } : {}),
            ...(highlight.missing.length ? { not_on_sheet: highlight.missing } : {}),
            ...(linkedMissing.length ? { linked_models_missing: linkedMissing } : {}),
            ...(graphicsNote ? { graphics_note: graphicsNote } : {}),
            ...(titleBlock.note ? { title_block_note: titleBlock.note } : {}),
            ...(kept ?? {}),
          },
          image,
        );
      } catch (err) {
        return explain(err, "bim_render_sheet_image");
      }
    },
  );

  server.registerTool(
    "bim_print_view_pdf",
    {
      title: "Print a view to PDF",
      description:
        "Draw one view (plan, section, 3D, detail or drafting view, schedule) on its own from the last saved revision to a vector PDF sized to the view at its scale, and return a download link valid for 5 minutes with the revision and sha256. For a sheet use bim_print_sheet_pdf; for several sheets in one PDF, bim_print_set_pdf. Does not issue anything.",
      inputSchema: { ...target, view: z.string().min(1).max(200).describe("View id or exact name.") },
    },
    async (args, extra) => {
      try {
        const who = await caller(extra, args.project_id, false);
        const printed = await withSession(who, args.model_id, undefined, async (s) => {
          const model = s.model();
          const viewId = findView(model, args.view);
          const view = viewId ? model.elements[viewId] : undefined;
          if (!viewId || !view || view.kind !== "view") return null;
          const linked = await linkedBackgrounds(extra, args.project_id, model, [view]);
          const graphics = await drawingCategoriesFor(extra, [view], stores.firmClasses);
          const { scene } = withCategoryRegistry(graphics.categories, () => buildViewScene(model, viewId, linked.backgrounds[viewId] ?? []));
          const snapshotSha256 = createHash("sha256").update(canonicalJson({ modelId: model.modelId, revision: model.revision, viewId })).digest("hex");
          const pdf = await renderSheetPdf(scene, { title: view.name, modelRevision: model.revision, snapshotSha256, renderer: "mutinybim-mcp" }, nodeNoteFonts(NOTE_FONTS_DIR));
          return { name: view.name, revision: model.revision, bytes: pdf.bytes, paper: scene.paper, linkedMissing: linked.missing, graphicsNote: graphics.note };
        });
        if (!printed) return failure(`No view "${args.view}". List views and sheets first.`);
        const sha256 = createHash("sha256").update(printed.bytes).digest("hex");
        const safe = printed.name.replace(/[^\w.-]/g, "_").slice(0, 80);
        const stored = await stores.storeSheetPdf(extra, args.project_id, `projects/${args.project_id}/building-model/views/${safe}-rev${printed.revision}-${sha256.slice(0, 12)}.pdf`, printed.bytes);
        return text({
          status: "printed",
          message: `Printed ${printed.name} from saved Rev ${printed.revision}. The link works for ${Math.round(stored.expiresInSeconds / 60)} minutes.`,
          view: printed.name,
          revision: printed.revision,
          paper_in: { x: Math.round((printed.paper.x / IN) * 100) / 100, y: Math.round((printed.paper.y / IN) * 100) / 100 },
          sha256,
          bytes: printed.bytes.byteLength,
          download_url: stored.downloadUrl,
          ...(printed.linkedMissing.length ? { linked_models_missing: printed.linkedMissing } : {}),
          ...(printed.graphicsNote ? { graphics_note: printed.graphicsNote } : {}),
        });
      } catch (err) {
        return explain(err, "bim_print_view_pdf");
      }
    },
  );
}
