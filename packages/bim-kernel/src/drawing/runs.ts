import { add, perp, scale, sub, unit } from "../geometry";
import { partToWorld } from "../parts";
import { placedSymbol } from "../part-placed";
import { flexPlanLines } from "../routing/flex";
import { FaceIndex, cellFor, planProjector, projectSolid, splitHidden } from "./projection";
import { elementSolid } from "./solids";
import { fittingBody, segmentWidthAxis, straightPiece, type Ring } from "../routing/fittings/geometry";
import { sizeLabel, sizeWidth } from "../routing/rules";
import type { BimElement, ModelState, PartInstance, RunFitting, RunSegment, Vec2 } from "../types";
import type { Pen } from "./sheet";
import { drawInsulationPlan } from "./insulation";
import { styleOfSystemId } from "../routing/system-graphics";
import { partClearances } from "../spatial";
import { elementSymbolId, runViewCategory } from "../categories/element";
import { symbolById } from "../categories/symbol-registry";
import { planDisplayFor } from "../categories/symbols";
import type { DetailLevel } from "../part-model/schema";
import { isPartModel2 } from "../part-model/schema-2";
import { partSymbolLines } from "../part-model/symbols";

/**
 * Plan linework for routed runs and placed parts. Duct draws double-line at
 * its width; pipe and conduit draw single-line, with the system's line type.
 * Vertical pieces (drops and rises) draw as their cross-section with a
 * diagonal. Fittings close the linework where pieces meet.
 */

export type LineFn = (a: Vec2, b: Vec2, pen: Pen, dash?: number[]) => void;
export type TextFn = (at: Vec2, text: string, size: number) => void;

const plan = (p: { x: number; y: number }): Vec2 => ({ x: p.x, y: p.y });

/** The system's line pattern and weight (system-graphics.ts): vent dashed, cold water dash-dot, gas long dash, or the system's own. */
export function systemLine(model: ModelState, systemId: string): { readonly dash: number[] | undefined; readonly weight: Pen | undefined } {
  const style = styleOfSystemId(model.elements, systemId);
  return { dash: style?.dash ? [...style.dash] : undefined, weight: style?.weight };
}

function circle(center: Vec2, r: number, line: LineFn, pen: Pen): void {
  const n = 16;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const b = ((i + 1) / n) * Math.PI * 2;
    line({ x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) }, { x: center.x + r * Math.cos(b), y: center.y + r * Math.sin(b) }, pen);
  }
}

function vertical(seg: RunSegment): boolean {
  return Math.hypot(seg.end.x - seg.start.x, seg.end.y - seg.start.y) < 0.01;
}

export function drawRunSegment(model: ModelState, seg: RunSegment, line: LineFn, label: TextFn | null, scaleMmPerPaperMm: number): void {
  const w = sizeWidth(seg.size);
  const { dash, weight } = systemLine(model, seg.systemId);
  const a = plan(seg.start);
  const b = plan(seg.end);
  if (seg.flex) {
    // Flex: both edges along its curve with ticks across, labelled as flex.
    for (const [p, q, what] of flexPlanLines(seg)) line(p, q, what === "edge" ? "medium" : "thin");
    const mid = seg.flex.path[Math.floor(seg.flex.path.length / 2)] ?? seg.start;
    if (label) label(add(plan(mid), { x: 0, y: sizeWidth(seg.size) / 2 + 6 * scaleMmPerPaperMm }), `${sizeLabel(seg.size)} FLEX`, 2.5);
    return;
  }
  drawInsulationPlan(model, seg, line);
  if (vertical(seg)) {
    // A drop or rise, seen from above.
    const h = Math.max(w, 50) / 2;
    if (seg.domain === "duct" && seg.size.shape === "rect") {
      // Turned the way the elbows into it turn it.
      const wa = segmentWidthAxis(model.elements, seg);
      const ha = { x: -wa.y, y: wa.x };
      const hy = seg.size.height / 2;
      const at = (sw: number, sh: number) => add(a, { x: wa.x * sw * h + ha.x * sh * hy, y: wa.y * sw * h + ha.y * sh * hy });
      const corners = [at(-1, -1), at(1, -1), at(1, 1), at(-1, 1)];
      for (let i = 0; i < 4; i++) line(corners[i] ?? a, corners[(i + 1) % 4] ?? a, "medium");
      line(corners[0] ?? a, corners[2] ?? a, "thin");
    } else {
      circle(a, h, line, seg.domain === "duct" ? "medium" : (weight ?? "wide"));
    }
    return;
  }
  // Library fittings take real length: the straight duct stops where their bodies begin.
  const fromLibrary = [seg.links.start, seg.links.end].some((l) => {
    const f = l ? model.elements[l.elementId] : undefined;
    return f?.kind === "run_fitting" && f.family !== undefined;
  });
  const piece = seg.domain === "duct" && fromLibrary ? straightPiece(model.elements, seg) : null;
  const u = unit(sub(b, a));
  const n = perp(u);
  if (piece) {
    // Fittings meeting end to end leave no straight duct to draw.
    if (piece.lengthMm > 0) {
      const pa = plan(piece.start);
      const pb = plan(piece.end);
      line(add(pa, scale(n, w / 2)), add(pb, scale(n, w / 2)), weight ?? "medium", dash);
      line(add(pa, scale(n, -w / 2)), add(pb, scale(n, -w / 2)), weight ?? "medium", dash);
      if (!seg.links.start) line(add(pa, scale(n, w / 2)), add(pa, scale(n, -w / 2)), "medium");
      if (!seg.links.end) line(add(pb, scale(n, w / 2)), add(pb, scale(n, -w / 2)), "medium");
    }
  } else if (seg.domain === "duct") {
    line(add(a, scale(n, w / 2)), add(b, scale(n, w / 2)), weight ?? "medium", dash);
    line(add(a, scale(n, -w / 2)), add(b, scale(n, -w / 2)), weight ?? "medium", dash);
    // An open end shows as its end line.
    if (!seg.links.start) line(add(a, scale(n, w / 2)), add(a, scale(n, -w / 2)), "medium");
    if (!seg.links.end) line(add(b, scale(n, w / 2)), add(b, scale(n, -w / 2)), "medium");
  } else {
    line(a, b, weight ?? "wide", dash);
  }
  const run = Math.hypot(b.x - a.x, b.y - a.y);
  if (label && run / scaleMmPerPaperMm > 25) {
    const at = add(scale(add(a, b), 0.5), scale(n, (seg.domain === "duct" ? w / 2 : 0) + 6 * scaleMmPerPaperMm));
    label(at, sizeLabel(seg.size), 2.5);
  }
}

/** A library fitting's outline in plan: both sides of every tube, joint lines, and (fine detail) turning vanes. */
function drawBody(model: ModelState, f: RunFitting, line: LineFn, vanes: boolean): boolean {
  const body = fittingBody(model.elements, f);
  if (body.tubes.length === 0 && body.plates.length === 0) return false;
  const side = (r: Ring, k: 1 | -1): Vec2 => {
    // The horizontal half-axis is what shows in plan.
    const h = Math.abs(r.a.z) <= Math.abs(r.b.z) ? r.a : r.b;
    return { x: r.center.x + k * h.x, y: r.center.y + k * h.y };
  };
  for (const tube of body.tubes) {
    for (let i = 0; i + 1 < tube.rings.length; i++) {
      const r0 = tube.rings[i];
      const r1 = tube.rings[i + 1];
      if (!r0 || !r1) continue;
      line(side(r0, 1), side(r1, 1), "medium");
      line(side(r0, -1), side(r1, -1), "medium");
    }
    const first = tube.rings[0];
    const last = tube.rings[tube.rings.length - 1];
    for (const r of first && last ? [first, last] : []) line(side(r, 1), side(r, -1), "thin");
  }
  for (const plate of vanes ? body.plates : []) {
    if (plate.kind !== "sheet") continue;
    for (let i = 0; i + 1 < plate.points.length; i++) {
      const q0 = plate.points[i];
      const q1 = plate.points[i + 1];
      if (q0 && q1) line(plan(q0), plan(q1), "thin");
    }
  }
  return true;
}

export function drawRunFitting(model: ModelState, f: RunFitting, line: LineFn, vanes = true): void {
  drawInsulationPlan(model, f, line);
  if (f.domain === "duct" && f.family !== undefined && drawBody(model, f, line, vanes)) return;
  const p = plan(f.position);
  const [pa, pb] = f.ports;
  const flat = (d: { z: number }) => Math.abs(d.z) < 1e-6;
  const isDuct = f.domain === "duct";
  switch (f.fittingType) {
    case "elbow": {
      if (!pa || !pb) return;
      const w = sizeWidth(pa.size) / 2;
      if (flat(pa.direction) && flat(pb.direction) && isDuct) {
        const la = perp(unit(plan(pa.direction)));
        const lb = perp(unit(plan(pb.direction)));
        const inner = add(p, sub(scale(la, w), scale(lb, w)));
        const outer = add(p, sub(scale(lb, w), scale(la, w)));
        line(add(p, scale(la, w)), inner, "medium");
        line(inner, add(p, scale(lb, -w)), "medium");
        line(add(p, scale(la, -w)), outer, "medium");
        line(outer, add(p, scale(lb, w)), "medium");
      }
      return;
    }
    case "transition": {
      if (!pa || !pb || !flat(pa.direction)) return;
      const n = perp(unit(plan(pa.direction)));
      const w = Math.max(sizeWidth(pa.size), sizeWidth(pb.size)) / 2;
      line(add(p, scale(n, w)), add(p, scale(n, -w)), isDuct ? "medium" : "wide");
      return;
    }
    case "cap": {
      if (!pa || !flat(pa.direction)) return;
      const n = perp(unit(plan(pa.direction)));
      const w = isDuct ? sizeWidth(pa.size) / 2 : Math.max(sizeWidth(pa.size), 60);
      line(add(p, scale(n, w)), add(p, scale(n, -w)), "wide");
      return;
    }
    case "tap":
    case "tee":
    case "wye": {
      if (!pa) return;
      const at = plan(pa.position);
      const d = unit(plan(pa.direction));
      const n = perp(d);
      const w = sizeWidth(pa.size) / 2;
      if (isDuct) {
        line(add(at, scale(n, w)), add(at, scale(n, -w)), "thin");
      } else if (f.fittingType === "wye") {
        line(at, add(at, scale(add(d, n), Math.max(w * 2, 60))), "thin");
      } else {
        circle(at, Math.max(w, 25), line, "thin");
      }
      return;
    }
    case "offset": {
      if (!pa || !pb || !flat(pa.direction)) return;
      const n = perp(unit(plan(pb.direction)));
      const w = sizeWidth(pa.size) / 2;
      line(add(plan(pa.position), scale(n, w)), add(plan(pb.position), scale(n, w)), "medium");
      line(add(plan(pa.position), scale(n, -w)), add(plan(pb.position), scale(n, -w)), "medium");
      return;
    }
  }
}

/** A modeled part seen from above: its sharp and outline edges, with the ones it hides itself left out. */
function drawPartModelPlan(model: ModelState, part: PartInstance, line: LineFn): void {
  const solid = elementSolid(model, part, 0);
  if (!solid?.mesh) return;
  const projected = projectSolid(solid, planProjector(false));
  if (projected.faces.length === 0) return;
  const xs = projected.faces.flatMap((f) => [f.minU, f.maxU]);
  const ys = projected.faces.flatMap((f) => [f.minV, f.maxV]);
  const index = new FaceIndex(cellFor(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)));
  for (const f of projected.faces) index.add(f);
  for (const e of projected.edges) {
    for (const [a, b] of splitHidden(e.a, e.b, index).visible) line({ x: a.u, y: a.v }, { x: b.u, y: b.v }, "medium");
  }
}

/** A placed part's plan symbol from its type, in model coordinates. Modeled parts draw their model, their symbol or both. */
/**
 * A placed part in a plan: its plan symbol, its 3D body seen from above, or
 * both, as its type says unless the view's category says symbol or body
 * (`planSymbol`, from `categories/resolve.ts`; null keeps the type's).
 */
export function drawPartSymbol(model: ModelState, part: PartInstance, line: LineFn, text: TextFn, planSymbol: boolean | null = null, detail: DetailLevel = "medium"): void {
  // Not placed yet: it has no location to draw at (placement/planned-index.ts reports it instead).
  if (part.planned !== undefined) return;
  const type = model.elements[part.typeId];
  if (type?.kind !== "part_type") return;
  const w = (q: Vec2) => partToWorld(part, q);
  // A class that names a symbol (a firm's smoke detector) draws that row in place of the type's own lines.
  const classSymbolId = elementSymbolId(model.elements, part);
  const classSymbol = classSymbolId === null ? null : symbolById(classSymbolId);
  // A solid-program part draws its symbol for this detail level; at a level with none, the solid seen from above.
  const solidProgram = type.definition.model !== undefined && isPartModel2(type.definition.model);
  const levelSymbol = !classSymbol && solidProgram ? partSymbolLines(type.definition, part.values, "plan", detail) : null;
  const symbolSource = classSymbol ? [...classSymbol.primitives] : levelSymbol;
  const ownSymbols = placedSymbol(symbolSource ? { ...type, definition: { ...type.definition, symbol: symbolSource } } : type, part);
  const typeDisplay = solidProgram && !classSymbol && levelSymbol === null ? "model" : type.definition.model?.planDisplay;
  const planDisplay = planDisplayFor(planSymbol, { typeDisplay, hasSymbol: ownSymbols.length > 0, hasBody: type.definition.model !== undefined });
  if (planDisplay === "model" || planDisplay === "both") drawPartModelPlan(model, part, line);
  const symbols = planDisplay === "model" ? [] : ownSymbols;
  for (const s of symbols) {
    switch (s.kind) {
      case "rect": {
        const hx = s.size.x / 2;
        const hy = s.size.y / 2;
        const c = s.center;
        const corners = [w({ x: c.x - hx, y: c.y - hy }), w({ x: c.x + hx, y: c.y - hy }), w({ x: c.x + hx, y: c.y + hy }), w({ x: c.x - hx, y: c.y + hy })];
        for (let i = 0; i < 4; i++) line(corners[i] ?? c, corners[(i + 1) % 4] ?? c, "medium");
        break;
      }
      case "circle":
        circle(w(s.center), s.radius, line, "medium");
        break;
      case "line":
        line(w(s.from), w(s.to), "thin");
        break;
      case "polyline":
        for (let i = 0; i + 1 < s.points.length; i++) line(w(s.points[i] ?? s.points[0] ?? part.position), w(s.points[i + 1] ?? part.position), "medium");
        if (s.closed && s.points.length > 2) line(w(s.points[s.points.length - 1] ?? part.position), w(s.points[0] ?? part.position), "medium");
        break;
      case "text":
        text(w(s.at), s.text, 2);
        break;
    }
  }
  if (part.mark) text(part.position, part.mark, 2.5);
  drawPartClearances(model, part, line, text);
}

/** Clearance zones draw dashed (paper mm), never as part of the part's body. */
export const CLEARANCE_DASH: readonly number[] = [3, 1.5];

/** A placed part's clearance zones in plan: a dashed outline each, named inside. */
export function drawPartClearances(model: ModelState, part: PartInstance, line: LineFn, text: TextFn): void {
  for (const z of partClearances(model, part)) {
    const c = z.corners;
    for (let i = 0; i < 4; i++) line(c[i] ?? c[0], c[(i + 1) % 4] ?? c[0], "thin", [...CLEARANCE_DASH]);
    text({ x: (c[0].x + c[2].x) / 2, y: (c[0].y + c[2].y) / 2 }, z.name.toUpperCase(), 1.8);
  }
}

/** Drawing category of a routed element (views can hide duct and pipe separately). */
export function runCategory(el: BimElement): "duct" | "duct_fitting" | "pipe" | null {
  return runViewCategory(el);
}
