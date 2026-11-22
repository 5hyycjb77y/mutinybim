import { localBounds, partToWorld, type ResolvedSymbol } from "../parts";
import { placedGeometry, placedSymbol } from "../part-placed";
import { elementSymbolId } from "../categories/element";
import { symbolById } from "../categories/symbol-registry";
import { planDisplayFor } from "../categories/symbols";
import type { DetailLevel } from "../part-model/schema";
import { isPartModel2 } from "../part-model/schema-2";
import { partSymbolLines } from "../part-model/symbols";
import type { ModelState, PartInstance, Vec2 } from "../types";

/**
 * Pure plan symbol / outline resolution for placed parts. Kept free of routing,
 * commands, solids, and annotation modules so both `drawing/runs.ts` and
 * `annotation/annotations.ts` can inspect exact part outlines without import cycles.
 */

export const DEFAULT_SYMBOL_SCALE = 48;

/** A 2D axis-aligned box in model millimetres, used to keep plan labels clear of symbols and each other. */
export interface PartLabelBox {
  readonly min: Vec2;
  readonly max: Vec2;
}

/** One boundary piece of a placed part's plan representation, in model millimetres. */
export type PlanOutline =
  | { readonly kind: "seg"; readonly a: Vec2; readonly b: Vec2 }
  | { readonly kind: "circle"; readonly c: Vec2; readonly r: number };

export function arcPolyline(center: Vec2, r: number, startDeg: number, sweepDeg: number): Vec2[] {
  const steps = Math.max(2, Math.min(32, Math.ceil(Math.abs(sweepDeg) / 15)));
  return Array.from({ length: steps + 1 }, (_, i) => {
    const a = ((startDeg + (sweepDeg * i) / steps) * Math.PI) / 180;
    return { x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) };
  });
}

function scaleSymbolPrimitive(s: ResolvedSymbol, k: number): ResolvedSymbol {
  if (k === 1) return s;
  const sc = (p: Vec2): Vec2 => ({ x: p.x * k, y: p.y * k });
  switch (s.kind) {
    case "rect":
      return { ...s, center: sc(s.center), size: sc(s.size) };
    case "circle":
      return { ...s, center: sc(s.center), radius: s.radius * k };
    case "arc":
      return { ...s, center: sc(s.center), radius: s.radius * k };
    case "line":
      return { ...s, from: sc(s.from), to: sc(s.to) };
    case "polyline":
      return { ...s, points: s.points.map(sc) };
    case "text":
      return { ...s, at: sc(s.at) };
  }
}

/**
 * Convert a part's filtered plan symbols into local model mm:
 * - `units === "paper"` primitives always plot at constant paper mm (`viewScale * symbolScale`).
 * - `units !== "paper"` primitives stay true 1:1 model size unless any carries `minPaperMm`
 *   and the model-unit group's plotted span shrinks below `minPaperMm * symbolScale`, in which
 *   case the whole model-unit group scales up uniformly around `(0, 0)` so it stays legible.
 */
function scaleLocalSymbols(rawSymbols: readonly ResolvedSymbol[], viewScale: number, symbolScale: number): readonly ResolvedSymbol[] {
  let maxFloorPaper = 0;
  let hasPaper = false;
  for (let i = 0; i < rawSymbols.length; i++) {
    const s = rawSymbols[i]!;
    if (s.units === "paper") {
      hasPaper = true;
    } else if (s.minPaperMm !== undefined && s.minPaperMm > maxFloorPaper) {
      maxFloorPaper = s.minPaperMm;
    }
  }
  let modelBoost = 1;
  if (maxFloorPaper > 0) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < rawSymbols.length; i++) {
      const s = rawSymbols[i]!;
      if (s.units === "paper") continue;
      switch (s.kind) {
        case "rect": {
          const hx = s.size.x * 0.5;
          const hy = s.size.y * 0.5;
          const x0 = s.center.x - hx;
          const x1 = s.center.x + hx;
          const y0 = s.center.y - hy;
          const y1 = s.center.y + hy;
          if (x0 < minX) minX = x0;
          if (x1 > maxX) maxX = x1;
          if (y0 < minY) minY = y0;
          if (y1 > maxY) maxY = y1;
          break;
        }
        case "circle":
        case "arc": {
          const x0 = s.center.x - s.radius;
          const x1 = s.center.x + s.radius;
          const y0 = s.center.y - s.radius;
          const y1 = s.center.y + s.radius;
          if (x0 < minX) minX = x0;
          if (x1 > maxX) maxX = x1;
          if (y0 < minY) minY = y0;
          if (y1 > maxY) maxY = y1;
          break;
        }
        case "line": {
          if (s.from.x < minX) minX = s.from.x;
          if (s.from.x > maxX) maxX = s.from.x;
          if (s.from.y < minY) minY = s.from.y;
          if (s.from.y > maxY) maxY = s.from.y;
          if (s.to.x < minX) minX = s.to.x;
          if (s.to.x > maxX) maxX = s.to.x;
          if (s.to.y < minY) minY = s.to.y;
          if (s.to.y > maxY) maxY = s.to.y;
          break;
        }
        case "polyline":
          for (let j = 0; j < s.points.length; j++) {
            const pt = s.points[j]!;
            if (pt.x < minX) minX = pt.x;
            if (pt.x > maxX) maxX = pt.x;
            if (pt.y < minY) minY = pt.y;
            if (pt.y > maxY) maxY = pt.y;
          }
          break;
        case "text":
          if (s.at.x < minX) minX = s.at.x;
          if (s.at.x > maxX) maxX = s.at.x;
          if (s.at.y < minY) minY = s.at.y;
          if (s.at.y > maxY) maxY = s.at.y;
          break;
      }
    }
    const spanModel = Number.isFinite(minX) ? Math.max(maxX - minX, maxY - minY) : 0;
    const targetModel = maxFloorPaper * symbolScale * viewScale;
    if (spanModel > 1e-6 && spanModel < targetModel) modelBoost = targetModel / spanModel;
  }
  const paperK = viewScale * symbolScale;
  if (modelBoost === 1 && (!hasPaper || paperK === 1)) return rawSymbols;
  const out: ResolvedSymbol[] = new Array(rawSymbols.length);
  for (let i = 0; i < rawSymbols.length; i++) {
    const s = rawSymbols[i]!;
    out[i] = scaleSymbolPrimitive(s, s.units === "paper" ? paperK : modelBoost);
  }
  return out;
}

export function lineEndpoints(s: Extract<ResolvedSymbol, { kind: "line" }>, w: (q: Vec2) => Vec2): readonly [Vec2, Vec2] {
  if (!s.upright) return [w(s.from), w(s.to)];
  const mid = w({ x: (s.from.x + s.to.x) / 2, y: (s.from.y + s.to.y) / 2 });
  const hx = (s.to.x - s.from.x) / 2;
  const hy = (s.to.y - s.from.y) / 2;
  return [{ x: mid.x - hx, y: mid.y - hy }, { x: mid.x + hx, y: mid.y + hy }];
}

export function growBox(box: { minX: number; minY: number; maxX: number; maxY: number }, p: Vec2): void {
  if (p.x < box.minX) box.minX = p.x;
  if (p.y < box.minY) box.minY = p.y;
  if (p.x > box.maxX) box.maxX = p.x;
  if (p.y > box.maxY) box.maxY = p.y;
}

export function resolvePartPlan(
  model: ModelState,
  part: PartInstance,
  planSymbol: boolean | null,
  detail: DetailLevel,
  viewScale: number,
  symbolScale = 1,
): { readonly symbols: readonly ResolvedSymbol[]; readonly planDisplay: "symbol" | "model" | "both"; readonly bodyOutline: PlanOutline[]; readonly bodyBounds: PartLabelBox | null } | null {
  if (part.planned !== undefined) return null;
  const type = model.elements[part.typeId];
  if (type?.kind !== "part_type") return null;
  const classSymbolId = elementSymbolId(model.elements, part);
  const classSymbol = classSymbolId === null ? null : symbolById(classSymbolId);
  const solidProgram = type.definition.model !== undefined && isPartModel2(type.definition.model);
  const levelSymbol = !classSymbol && solidProgram ? partSymbolLines(type.definition, part.values, "plan", detail) : null;
  const directSymbol = type.definition.symbol;
  const symbolSource = classSymbol
    ? [...classSymbol.primitives]
    : levelSymbol !== null
      ? directSymbol.length > 0
        ? [...levelSymbol, ...directSymbol]
        : levelSymbol
      : null;
  const rawSymbols = placedSymbol(symbolSource ? { ...type, definition: { ...type.definition, symbol: symbolSource } } : type, part);
  const filteredSymbols = rawSymbols.filter((s) => !s.detailLevels || s.detailLevels.includes(detail));
  const ownSymbols = scaleLocalSymbols(filteredSymbols, viewScale, symbolScale);
  const typeDisplay = solidProgram && !classSymbol && levelSymbol === null && directSymbol.length === 0 ? "model" : type.definition.model?.planDisplay;
  const planDisplay = planDisplayFor(planSymbol, { typeDisplay, hasSymbol: ownSymbols.length > 0, hasBody: type.definition.model !== undefined });
  const symbols = planDisplay === "model" ? [] : ownSymbols;
  const bodyOutline: PlanOutline[] = [];
  let bodyBounds: PartLabelBox | null = null;
  if (planDisplay === "model" || planDisplay === "both" || symbols.length === 0) {
    const geom = placedGeometry(type, part);
    if (geom.length > 0) {
      const w = (q: Vec2) => partToWorld(part, q);
      const bb = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      for (const p of geom) {
        if (p.kind === "cylinder" && p.axis === "z") {
          const c = w({ x: p.center[0], y: p.center[1] });
          bodyOutline.push({ kind: "circle", c, r: p.radius });
          growBox(bb, { x: c.x - p.radius, y: c.y - p.radius });
          growBox(bb, { x: c.x + p.radius, y: c.y + p.radius });
        } else if (p.kind === "extrusion" && p.profile.length >= 3) {
          const pts = p.profile.map(w);
          for (let i = 0; i < pts.length; i++) {
            const a = pts[i]!;
            const b = pts[(i + 1) % pts.length]!;
            bodyOutline.push({ kind: "seg", a, b });
            growBox(bb, a);
          }
        } else {
          const b = localBounds([p]);
          if (Number.isFinite(b.min[0]) && Number.isFinite(b.max[0])) {
            const corners = [
              w({ x: b.min[0], y: b.min[1] }),
              w({ x: b.max[0], y: b.min[1] }),
              w({ x: b.max[0], y: b.max[1] }),
              w({ x: b.min[0], y: b.max[1] }),
            ];
            for (let i = 0; i < 4; i++) {
              bodyOutline.push({ kind: "seg", a: corners[i]!, b: corners[(i + 1) % 4]! });
              growBox(bb, corners[i]!);
            }
          }
        }
      }
      if (Number.isFinite(bb.minX)) bodyBounds = { min: { x: bb.minX, y: bb.minY }, max: { x: bb.maxX, y: bb.maxY } };
    }
  }
  return { symbols, planDisplay, bodyOutline, bodyBounds };
}

/**
 * The exact plan boundary (world-mm segments and circles) and bounding box of
 * what a plan draws for `part` at `detail` and `scale`. Shared by symbol
 * drawing, view-graphics line trimming, and label/tag collision avoidance.
 */
export function partPlanOutline(
  model: ModelState,
  part: PartInstance,
  opts: { readonly detail?: DetailLevel; readonly scale?: number; readonly symbolScale?: number; readonly planSymbol?: boolean | null } = {},
): { readonly outline: PlanOutline[]; readonly bounds: PartLabelBox | null } {
  const viewScale = opts.scale ?? DEFAULT_SYMBOL_SCALE;
  const symScale = opts.symbolScale ?? 1;
  const resolved = resolvePartPlan(model, part, opts.planSymbol ?? null, opts.detail ?? "medium", viewScale, symScale);
  if (!resolved) return { outline: [], bounds: null };
  const w = (q: Vec2) => partToWorld(part, q);
  const outline: PlanOutline[] = [];
  const bb = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const addRect = (c: Vec2, hx: number, hy: number) => {
    const corners = [w({ x: c.x - hx, y: c.y - hy }), w({ x: c.x + hx, y: c.y - hy }), w({ x: c.x + hx, y: c.y + hy }), w({ x: c.x - hx, y: c.y + hy })];
    for (let i = 0; i < 4; i++) {
      const a = corners[i] ?? c;
      const b = corners[(i + 1) % 4] ?? c;
      outline.push({ kind: "seg", a, b });
      growBox(bb, a);
    }
  };
  for (const s of resolved.symbols) {
    switch (s.kind) {
      case "rect":
        addRect(s.center, s.size.x / 2, s.size.y / 2);
        break;
      case "circle": {
        const c = w(s.center);
        outline.push({ kind: "circle", c, r: s.radius });
        growBox(bb, { x: c.x - s.radius, y: c.y - s.radius });
        growBox(bb, { x: c.x + s.radius, y: c.y + s.radius });
        break;
      }
      case "arc": {
        const pts = arcPolyline(s.center, s.radius, s.startDeg, s.sweepDeg).map(w);
        for (let i = 0; i + 1 < pts.length; i++) {
          outline.push({ kind: "seg", a: pts[i]!, b: pts[i + 1]! });
          growBox(bb, pts[i]!);
          growBox(bb, pts[i + 1]!);
        }
        break;
      }
      case "line": {
        const [a, b] = lineEndpoints(s, w);
        outline.push({ kind: "seg", a, b });
        growBox(bb, a);
        growBox(bb, b);
        break;
      }
      case "polyline": {
        const pts = s.points.map(w);
        for (let i = 0; i + 1 < pts.length; i++) {
          outline.push({ kind: "seg", a: pts[i]!, b: pts[i + 1]! });
          growBox(bb, pts[i]!);
          growBox(bb, pts[i + 1]!);
        }
        if (s.closed && pts.length > 2) outline.push({ kind: "seg", a: pts[pts.length - 1]!, b: pts[0]! });
        break;
      }
      case "text": {
        break;
      }
    }
  }
  if (resolved.bodyOutline.length > 0 && (resolved.planDisplay === "model" || resolved.planDisplay === "both" || outline.length === 0)) {
    outline.push(...resolved.bodyOutline);
    if (resolved.bodyBounds) {
      growBox(bb, resolved.bodyBounds.min);
      growBox(bb, resolved.bodyBounds.max);
    }
  }
  if (outline.length === 0) {
    for (const s of resolved.symbols) {
      if (s.kind !== "text") continue;
      const half = 0.6 * (s.units === "paper" ? s.heightMm : 2) * viewScale;
      addRect(s.at, half, half);
    }
  }
  const bounds: PartLabelBox | null = Number.isFinite(bb.minX) ? { min: { x: bb.minX, y: bb.minY }, max: { x: bb.maxX, y: bb.maxY } } : null;
  return { outline, bounds };
}
