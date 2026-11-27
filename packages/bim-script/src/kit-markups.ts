import {
  DEFAULT_MARKER_COLOR,
  DEFAULT_MARKER_WIDTH_MM,
  documentIndex,
  markupBounds,
  markupViewportContext,
  sheetPaperSize,
  type DrawingItem,
  type MarkupSmartShape,
  type MarkupStatus,
  type MarkupTool,
  type ModelState,
  type Sheet,
  type Vec2,
} from "@permitzip/bim-kernel";
import { measureIn, type Measure } from "@permitzip/bim-units";
import { ScriptRunError, type ScriptContext } from "./context";
import { MAX_SCRIPT_RENDERS, type ScriptRenderRequest } from "./output";
import { onWorking } from "./working";

const MM_PER_IN = 25.4;
const MM_PER_FT = 304.8;

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;

export type PaperPointInput =
  | { readonly x: number; readonly y: number }
  | { readonly x: Measure; readonly y: Measure };

function toPaperMm(p: PaperPointInput): Vec2 {
  const x = typeof p.x === "number" ? p.x : measureIn(p.x, "mm");
  const y = typeof p.y === "number" ? p.y : measureIn(p.y, "mm");
  return { x: r2(x), y: r2(y) };
}

function resolveSheet(model: ModelState, ref: string): Sheet {
  const trimmed = ref.trim();
  const direct = model.elements[trimmed];
  if (direct && direct.kind === "sheet" && !direct.deleted) return direct;
  const lower = trimmed.toLowerCase();
  for (const sheet of documentIndex(model).sheets) {
    if (sheet.number.toLowerCase() === lower || sheet.title.toLowerCase() === lower) return sheet;
  }
  throw new ScriptRunError(`Sheet "${ref}" was not found. Pass a sheet id or sheet number (like "M-101").`);
}

function sheetMarkupsOf(model: ModelState, sheetId: string, status: MarkupStatus | "all" = "all"): readonly DrawingItem[] {
  const items = documentIndex(model).markupsBySheet.get(sheetId) ?? [];
  if (status === "all") return items;
  return items.filter((item) => (item.markup?.status ?? "open") === status);
}

function unionBounds(items: readonly DrawingItem[]): { readonly min: Vec2; readonly max: Vec2 } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const item of items) {
    const b = markupBounds(item);
    if (!b) continue;
    if (b.min.x < minX) minX = b.min.x;
    if (b.min.y < minY) minY = b.min.y;
    if (b.max.x > maxX) maxX = b.max.x;
    if (b.max.y > maxY) maxY = b.max.y;
  }
  if (!Number.isFinite(minX)) return null;
  return { min: { x: r1(minX), y: r1(minY) }, max: { x: r1(maxX), y: r1(maxY) } };
}

function paddedRegion(
  bounds: { readonly min: Vec2; readonly max: Vec2 },
  paper: Vec2,
  padMm: number,
): { readonly min: Vec2; readonly max: Vec2 } {
  const pad = Math.max(5, padMm);
  const minX = Math.max(0, bounds.min.x - pad);
  const minY = Math.max(0, bounds.min.y - pad);
  const maxX = Math.min(paper.x, bounds.max.x + pad);
  const maxY = Math.min(paper.y, bounds.max.y + pad);
  return {
    min: { x: r1(minX), y: r1(minY) },
    max: { x: r1(Math.max(minX + 20, maxX)), y: r1(Math.max(minY + 20, maxY)) },
  };
}

function samplePoints<T>(points: readonly T[], maxCount: number): readonly T[] {
  if (points.length <= maxCount) return points;
  const out: T[] = [];
  const step = (points.length - 1) / (maxCount - 1);
  for (let i = 0; i < maxCount; i++) {
    out.push(points[Math.round(i * step)]!);
  }
  return out;
}

export interface SheetMarkupSummary {
  readonly id: string;
  readonly sheetId: string;
  readonly sheetNumber: string;
  readonly sheetTitle: string;
  readonly tool: MarkupTool;
  readonly color: string;
  readonly widthMm: number;
  readonly status: MarkupStatus;
  readonly smartShape?: MarkupSmartShape;
  readonly author?: string;
  readonly createdAt?: string;
  readonly addressedNote?: string;
  readonly addressedColor?: string;
  readonly note?: string;
  readonly pointCount: number;
  readonly boundsMm: { readonly min: Vec2; readonly max: Vec2 } | null;
  readonly boundsIn: { readonly min: Vec2; readonly max: Vec2 } | null;
  readonly viewports: readonly {
    readonly viewportId: string;
    readonly viewId: string;
    readonly viewName: string;
    readonly viewType: string;
    readonly scale: number;
    readonly level?: string;
    readonly modelBoundsFt: { readonly min: { readonly xFt: number; readonly yFt: number }; readonly max: { readonly xFt: number; readonly yFt: number } };
    readonly modelPointsFt: readonly { readonly xFt: number; readonly yFt: number }[];
  }[];
}

export interface MarkedSheetSummary {
  readonly sheetId: string;
  readonly number: string;
  readonly title: string;
  readonly paperSize: string;
  readonly openCount: number;
  readonly addressedCount: number;
  readonly resolvedCount: number;
  readonly totalCount: number;
  readonly markupIds: readonly string[];
  readonly boundsMm: { readonly min: Vec2; readonly max: Vec2 } | null;
  readonly viewports: readonly { readonly viewportId: string; readonly viewId: string; readonly viewName: string; readonly scale: number }[];
}

export interface RenderSheetMarkupOptions {
  /** Custom label shown next to the returned image. */
  readonly label?: string;
  /** Zoom/crop tightly around these specific markup ids on the sheet. */
  readonly focusMarkupIds?: readonly string[];
  /** Zoom/crop tightly around all markups on this sheet with this status ("open" | "addressed" | "all"). */
  readonly focusStatus?: MarkupStatus | "all";
  /** Padding around auto-focused markups in paper mm (default 45 mm). */
  readonly padMm?: number;
  /** Manual crop region in paper millimetres from the top-left corner. */
  readonly regionMm?: { readonly min: Vec2; readonly max: Vec2 };
  /** Manual crop region in paper inches from the top-left corner. */
  readonly regionIn?: { readonly min: Vec2; readonly max: Vec2 };
  /** Draw sheet review markups on top of the sheet (default true). */
  readonly includeMarkups?: boolean;
  /** Include resolved markups when `includeMarkups` is true (default false). */
  readonly includeResolvedMarkups?: boolean;
  /** Print underlying sheet linework monochrome B&W so red/purple/yellow marker ink pops clearly (default true). */
  readonly monochromeSheet?: boolean;
  /** Optional element or markup ids to frame with a highlight box. */
  readonly highlightIds?: readonly string[];
  /** Raster resolution in DPI (default 150 full sheet, 220 cropped). */
  readonly dpi?: number;
  /** Maximum pixel dimension of the returned PNG (default 1800). */
  readonly maxPx?: number;
}

export interface RenderAllMarkedSheetsOptions {
  /** Which markup status selects a sheet (default "open"). */
  readonly status?: MarkupStatus | "all";
  /** "full": full sheet only. "crop": zoomed crop around markups only. "both": full sheet + zoomed crop when budget allows (default "both"). */
  readonly mode?: "full" | "crop" | "both";
  /** Maximum images to queue (default 6, capped at MAX_SCRIPT_RENDERS). */
  readonly maxImages?: number;
  readonly padMm?: number;
  readonly monochromeSheet?: boolean;
  readonly dpi?: number;
  readonly maxPx?: number;
}

export interface AddSheetMarkupSpec {
  readonly id?: string;
  /** Paper coordinates (top-left origin): plain numbers in mm, or `units.*` Measures. */
  readonly points: readonly PaperPointInput[];
  readonly tool?: MarkupTool;
  readonly color?: string;
  readonly widthMm?: number;
  readonly closed?: boolean;
  readonly smartShape?: MarkupSmartShape;
  readonly status?: MarkupStatus;
  readonly author?: string;
  readonly note?: string;
}

/**
 * `markups`: sheet review markups (felt-tip marker and highlighter strokes drawn
 * on sheets) and visual inspection helpers. Agents use `markups.sheetsWithMarkups`,
 * `markups.list`, and `markups.renderSheet` / `markups.renderAllMarkedSheets` to
 * inspect human redlines as actual rendered sheet PNG images plus exact model
 * coordinates, then `markups.markAddressed` to yellow-line them after modelling.
 */
export const markups = {
  /** Lists every sheet in the set that has review markups matching `status` (default "open"). */
  sheetsWithMarkups(ctx: ScriptContext, opts: { readonly status?: MarkupStatus | "all" } = {}): readonly MarkedSheetSummary[] {
    const status = opts.status ?? "open";
    return onWorking(ctx, "markups.sheetsWithMarkups", (model) => {
      const idx = documentIndex(model);
      const out: MarkedSheetSummary[] = [];
      for (const sheet of idx.sheets) {
        const all = idx.markupsBySheet.get(sheet.id) ?? [];
        if (all.length === 0) continue;
        let openCount = 0;
        let addressedCount = 0;
        let resolvedCount = 0;
        for (const item of all) {
          const st = item.markup?.status ?? "open";
          if (st === "open") openCount++;
          else if (st === "addressed") addressedCount++;
          else resolvedCount++;
        }
        const matched = status === "all" ? all : all.filter((item) => (item.markup?.status ?? "open") === status);
        if (matched.length === 0) continue;
        const vpMap = new Map<string, { readonly viewportId: string; readonly viewId: string; readonly viewName: string; readonly scale: number }>();
        for (const item of matched) {
          for (const hit of markupViewportContext(model, sheet.id, item)) {
            if (!vpMap.has(hit.viewportId)) {
              vpMap.set(hit.viewportId, { viewportId: hit.viewportId, viewId: hit.viewId, viewName: hit.viewName, scale: hit.scale });
            }
          }
        }
        out.push({
          sheetId: sheet.id,
          number: sheet.number,
          title: sheet.title,
          paperSize: sheet.props?.titleBlock ?? "arch_d_mutinybim",
          openCount,
          addressedCount,
          resolvedCount,
          totalCount: all.length,
          markupIds: matched.map((m) => m.id),
          boundsMm: unionBounds(matched),
          viewports: [...vpMap.values()],
        });
      }
      return out;
    });
  },

  /** Lists review markups on one sheet (by id or sheet number), including exact model coordinates for every viewport each stroke sits over. */
  list(ctx: ScriptContext, sheetRef: string, opts: { readonly status?: MarkupStatus | "all" } = {}): readonly SheetMarkupSummary[] {
    const status = opts.status ?? "all";
    return onWorking(ctx, "markups.list", (model) => {
      const sheet = resolveSheet(model, sheetRef);
      const items = sheetMarkupsOf(model, sheet.id, status);
      return items.map((item): SheetMarkupSummary => {
        const spec = item.markup;
        const b = markupBounds(item);
        const boundsIn = b
          ? {
              min: { x: r2(b.min.x / MM_PER_IN), y: r2(b.min.y / MM_PER_IN) },
              max: { x: r2(b.max.x / MM_PER_IN), y: r2(b.max.y / MM_PER_IN) },
            }
          : null;
        const hits = markupViewportContext(model, sheet.id, item).map((hit) => ({
          viewportId: hit.viewportId,
          viewId: hit.viewId,
          viewName: hit.viewName,
          viewType: hit.viewType,
          scale: hit.scale,
          ...(hit.level ? { level: hit.level } : {}),
          modelBoundsFt: {
            min: { xFt: r2(hit.modelBoundsMm.min.x / MM_PER_FT), yFt: r2(hit.modelBoundsMm.min.y / MM_PER_FT) },
            max: { xFt: r2(hit.modelBoundsMm.max.x / MM_PER_FT), yFt: r2(hit.modelBoundsMm.max.y / MM_PER_FT) },
          },
          modelPointsFt: samplePoints(hit.modelPointsMm, 16).map((p) => ({
            xFt: r2(p.x / MM_PER_FT),
            yFt: r2(p.y / MM_PER_FT),
          })),
        }));
        return {
          id: item.id,
          sheetId: sheet.id,
          sheetNumber: sheet.number,
          sheetTitle: sheet.title,
          tool: spec?.tool ?? "marker",
          color: spec?.color ?? DEFAULT_MARKER_COLOR,
          widthMm: spec?.widthMm ?? DEFAULT_MARKER_WIDTH_MM,
          status: spec?.status ?? "open",
          ...(spec?.smartShape ? { smartShape: spec.smartShape } : {}),
          ...(spec?.author ? { author: spec.author } : {}),
          ...(spec?.createdAt ? { createdAt: spec.createdAt } : {}),
          ...(spec?.addressedNote ? { addressedNote: spec.addressedNote } : {}),
          ...(spec?.addressedColor ? { addressedColor: spec.addressedColor } : {}),
          ...(spec?.note ? { note: spec.note } : {}),
          pointCount: item.points.length,
          boundsMm: b ? { min: { x: r1(b.min.x), y: r1(b.min.y) }, max: { x: r1(b.max.x), y: r1(b.max.y) } } : null,
          boundsIn,
          viewports: hits,
        };
      });
    });
  },

  /** Queues a sheet PNG image (with markups overlaid in vivid colour) so `bim_run_script` returns the picture directly to the agent. */
  renderSheet(ctx: ScriptContext, sheetRef: string, opts: RenderSheetMarkupOptions = {}): ScriptRenderRequest {
    const req = onWorking(ctx, "markups.renderSheet", (model): ScriptRenderRequest => {
      const sheet = resolveSheet(model, sheetRef);
      const paper = sheetPaperSize(sheet);
      let regionMm = opts.regionMm;
      if (!regionMm && opts.regionIn) {
        regionMm = {
          min: { x: r1(opts.regionIn.min.x * MM_PER_IN), y: r1(opts.regionIn.min.y * MM_PER_IN) },
          max: { x: r1(opts.regionIn.max.x * MM_PER_IN), y: r1(opts.regionIn.max.y * MM_PER_IN) },
        };
      }
      if (!regionMm && opts.focusMarkupIds && opts.focusMarkupIds.length > 0) {
        const wanted = new Set(opts.focusMarkupIds);
        const matched = (documentIndex(model).markupsBySheet.get(sheet.id) ?? []).filter((item) => wanted.has(item.id));
        const b = unionBounds(matched);
        if (b) regionMm = paddedRegion(b, paper, opts.padMm ?? 45);
      } else if (!regionMm && opts.focusStatus) {
        const matched = sheetMarkupsOf(model, sheet.id, opts.focusStatus);
        const b = unionBounds(matched);
        if (b) regionMm = paddedRegion(b, paper, opts.padMm ?? 45);
      }
      const label =
        opts.label ??
        (regionMm ? `Sheet ${sheet.number} (${sheet.title}) — markup close-up` : `Sheet ${sheet.number} (${sheet.title}) — full sheet with markups`);
      return {
        kind: "sheet",
        targetId: sheet.id,
        label,
        ...(regionMm ? { regionMm } : {}),
        includeMarkups: opts.includeMarkups ?? true,
        ...(opts.includeResolvedMarkups ? { includeResolvedMarkups: true } : {}),
        monochromeSheet: opts.monochromeSheet ?? true,
        ...(opts.highlightIds && opts.highlightIds.length > 0 ? { highlightIds: [...opts.highlightIds] } : {}),
        dpi: opts.dpi ?? (regionMm ? 220 : 150),
        maxPx: opts.maxPx ?? 1800,
      };
    });
    ctx.render(req);
    return req;
  },

  /** Finds every sheet with markups (default "open") and queues sheet PNG images (full sheet + zoomed markup crops) in one call. */
  renderAllMarkedSheets(
    ctx: ScriptContext,
    opts: RenderAllMarkedSheetsOptions = {},
  ): { readonly sheets: readonly MarkedSheetSummary[]; readonly queuedRenders: readonly ScriptRenderRequest[] } {
    const status = opts.status ?? "open";
    const maxImages = Math.max(1, Math.min(MAX_SCRIPT_RENDERS, opts.maxImages ?? MAX_SCRIPT_RENDERS));
    const sheets = markups.sheetsWithMarkups(ctx, { status });
    const queued: ScriptRenderRequest[] = [];
    const wantBoth = (opts.mode ?? "both") === "both" && sheets.length * 2 <= maxImages;
    const effectiveMode = opts.mode === "crop" ? "crop" : opts.mode === "full" ? "full" : wantBoth ? "both" : "full";

    for (const sheet of sheets) {
      if (queued.length >= maxImages) break;
      if (effectiveMode === "full" || effectiveMode === "both") {
        queued.push(
          markups.renderSheet(ctx, sheet.sheetId, {
            monochromeSheet: opts.monochromeSheet ?? true,
            dpi: opts.dpi ?? 150,
            maxPx: opts.maxPx ?? 1800,
          }),
        );
      }
      if (queued.length >= maxImages) break;
      if (effectiveMode === "crop" || effectiveMode === "both") {
        queued.push(
          markups.renderSheet(ctx, sheet.sheetId, {
            focusStatus: status,
            padMm: opts.padMm ?? 45,
            monochromeSheet: opts.monochromeSheet ?? true,
            dpi: opts.dpi ?? 220,
            maxPx: opts.maxPx ?? 1800,
          }),
        );
      }
    }
    return { sheets, queuedRenders: queued };
  },

  /** Adds a sheet review markup stroke (marker or highlighter) in paper coordinates on `sheetRef`. */
  add(ctx: ScriptContext, sheetRef: string, spec: AddSheetMarkupSpec): string {
    const sheetId = onWorking(ctx, "markups.add", (model) => resolveSheet(model, sheetRef).id);
    const itemId = spec.id ?? ctx.id("markup");
    const markupSpec = {
      ...(spec.tool ? { tool: spec.tool } : {}),
      ...(spec.color ? { color: spec.color } : {}),
      ...(spec.widthMm !== undefined ? { widthMm: spec.widthMm } : {}),
      ...(spec.smartShape ? { smartShape: spec.smartShape } : {}),
      ...(spec.status ? { status: spec.status } : {}),
      ...(spec.author ? { author: spec.author } : {}),
      ...(spec.note ? { note: spec.note } : {}),
    };
    ctx.edit({
      type: "add_sheet_markup",
      itemId,
      sheetId,
      points: spec.points.map(toPaperMm),
      ...(Object.keys(markupSpec).length > 0 ? { markup: markupSpec } : {}),
    });
    return itemId;
  },

  /** Marks one or more review markups as "addressed" (yellow-line backcheck style) with an optional note of what changed. */
  markAddressed(
    ctx: ScriptContext,
    markupIds: readonly string[],
    opts: { readonly note?: string; readonly addressedColor?: string } = {},
  ): void {
    for (const itemId of markupIds) {
      ctx.edit({
        type: "update_sheet_markup",
        itemId,
        status: "addressed",
        ...(opts.note ? { addressedNote: opts.note } : {}),
        ...(opts.addressedColor ? { addressedColor: opts.addressedColor } : {}),
      });
    }
  },

  /** Marks one or more review markups as "resolved" (hidden from active review views). */
  resolve(ctx: ScriptContext, markupIds: readonly string[], opts: { readonly note?: string } = {}): void {
    for (const itemId of markupIds) {
      ctx.edit({
        type: "update_sheet_markup",
        itemId,
        status: "resolved",
        ...(opts.note ? { addressedNote: opts.note } : {}),
      });
    }
  },

  /** Reopens one or more review markups back to "open" redline status. */
  reopen(ctx: ScriptContext, markupIds: readonly string[]): void {
    for (const itemId of markupIds) {
      ctx.edit({
        type: "update_sheet_markup",
        itemId,
        status: "open",
      });
    }
  },

  /** Deletes review markups on `sheetRef`, optionally only those matching `status` ("open" | "addressed" | "resolved"). */
  clear(ctx: ScriptContext, sheetRef: string, opts: { readonly status?: MarkupStatus } = {}): void {
    const sheetId = onWorking(ctx, "markups.clear", (model) => resolveSheet(model, sheetRef).id);
    ctx.edit({
      type: "clear_sheet_markups",
      sheetId,
      ...(opts.status ? { statuses: [opts.status] } : {}),
    });
  },
};
