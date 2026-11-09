import { FaceIndex, cellFor, planProjector, projectSolid, splitHidden, type Projector } from "../drawing/projection";
import { meshEdges } from "../drawing/mesh-projection";
import type { ElementSolid } from "../drawing/solids";
import { p3 } from "../routing/geometry";
import { resolveConnectors, type PartTypeDefinition } from "../parts";
import type { ParamValue } from "../types";
import { partMesh } from "./engine";
import type { DetailLevel } from "./schema";

/**
 * A part definition seen from above, the front or the side: shaded faces,
 * visible and hidden edges and its connectors, in drawing millimetres. The
 * part editor's views and the agents' previews both draw from this.
 *
 * The part faces +x; front looks at it from +x (its left, +y, on the right),
 * side looks from its right (−y), plan from above.
 */

export const PART_VIEWS = ["plan", "front", "side"] as const;
export type PartView = (typeof PART_VIEWS)[number];

export interface Seg {
  readonly a: { readonly u: number; readonly v: number };
  readonly b: { readonly u: number; readonly v: number };
}

export interface PartViewLinework {
  readonly view: PartView;
  readonly faces: ReadonlyArray<{ readonly poly: ReadonlyArray<{ readonly u: number; readonly v: number }>; readonly light: number }>;
  readonly visible: readonly Seg[];
  readonly hidden: readonly Seg[];
  readonly connectors: ReadonlyArray<{ readonly id: string; readonly label: string; readonly u: number; readonly v: number; readonly du: number; readonly dv: number; readonly domain: string }>;
  readonly min: { readonly u: number; readonly v: number };
  readonly max: { readonly u: number; readonly v: number };
}

export function partViewProjector(view: PartView): Projector {
  switch (view) {
    case "plan":
      return planProjector(false);
    case "front":
      return { toViewer: p3(1, 0, 0), nearMin: -Infinity, nearMax: Infinity, project: (p) => ({ u: p.y, v: p.z, near: p.x }) };
    case "side":
      return { toViewer: p3(0, -1, 0), nearMin: -Infinity, nearMax: Infinity, project: (p) => ({ u: p.x, v: p.z, near: -p.y }) };
  }
}

/** Linework of a modeled part in one view. Needs the geometry engine (throws PartGeometryUnavailableError otherwise). */
export function partViewLinework(def: PartTypeDefinition, view: PartView, values: Readonly<Record<string, ParamValue>> = {}, detail: DetailLevel = "fine"): PartViewLinework {
  const local = partMesh(def, values, detail);
  const solid: ElementSolid = {
    owner: "part",
    category: "equipment",
    role: "equipment",
    pieces: [],
    mesh: { positions: Float64Array.from(local.positions), indices: local.indices, edges: meshEdges(local.positions, local.indices) },
  };
  const proj = partViewProjector(view);
  const projected = projectSolid(solid, proj);
  let minU = Infinity;
  let minV = Infinity;
  let maxU = -Infinity;
  let maxV = -Infinity;
  for (const f of projected.faces) {
    minU = Math.min(minU, f.minU);
    minV = Math.min(minV, f.minV);
    maxU = Math.max(maxU, f.maxU);
    maxV = Math.max(maxV, f.maxV);
  }
  const connectors = resolveConnectors(def, values).map((c) => {
    const at = proj.project(p3(c.position[0], c.position[1], c.position[2]));
    const tip = proj.project(p3(c.position[0] + c.direction[0], c.position[1] + c.direction[1], c.position[2] + c.direction[2]));
    minU = Math.min(minU, at.u);
    minV = Math.min(minV, at.v);
    maxU = Math.max(maxU, at.u);
    maxV = Math.max(maxV, at.v);
    return { id: c.id, label: c.label, u: at.u, v: at.v, du: tip.u - at.u, dv: tip.v - at.v, domain: c.domain };
  });
  if (!Number.isFinite(minU)) {
    minU = -100;
    minV = -100;
    maxU = 100;
    maxV = 100;
  }
  const index = new FaceIndex(cellFor(minU, minV, maxU, maxV));
  for (const f of projected.faces) index.add(f);
  const visible: Seg[] = [];
  const hidden: Seg[] = [];
  for (const e of projected.edges) {
    const split = splitHidden(e.a, e.b, index);
    for (const [a, b] of split.visible) visible.push({ a: { u: a.u, v: a.v }, b: { u: b.u, v: b.v } });
    for (const [a, b] of split.hidden) hidden.push({ a: { u: a.u, v: a.v }, b: { u: b.u, v: b.v } });
  }
  const faces = [...projected.faces].sort((x, y) => x.meanNear - y.meanNear).map((f) => ({ poly: f.poly.map((q) => ({ u: q.u, v: q.v })), light: f.light }));
  return { view, faces, visible, hidden, connectors, min: { u: minU, v: minV }, max: { u: maxU, v: maxV } };
}

const fmt = (n: number) => (Math.round(n * 10) / 10).toString();

/** One view as a standalone SVG (y up flipped to SVG's y down), sized to `widthPx`. */
export function partViewSvg(lw: PartViewLinework, widthPx = 360): string {
  const pad = 0.08 * Math.max(lw.max.u - lw.min.u, lw.max.v - lw.min.v, 1);
  const x0 = lw.min.u - pad;
  const y0 = lw.min.v - pad;
  const w = lw.max.u - lw.min.u + 2 * pad;
  const h = lw.max.v - lw.min.v + 2 * pad;
  const k = widthPx / w;
  const X = (u: number) => fmt((u - x0) * k);
  const Y = (v: number) => fmt((y0 + h - v) * k);
  const parts: string[] = [];
  for (const f of lw.faces) {
    const g = Math.round(200 + 40 * f.light);
    parts.push(`<polygon points="${f.poly.map((q) => `${X(q.u)},${Y(q.v)}`).join(" ")}" fill="rgb(${g},${g},${g})" stroke="none"/>`);
  }
  for (const s of lw.hidden) parts.push(`<line x1="${X(s.a.u)}" y1="${Y(s.a.v)}" x2="${X(s.b.u)}" y2="${Y(s.b.v)}" stroke="#666" stroke-width="0.8" stroke-dasharray="4 3"/>`);
  for (const s of lw.visible) parts.push(`<line x1="${X(s.a.u)}" y1="${Y(s.a.v)}" x2="${X(s.b.u)}" y2="${Y(s.b.v)}" stroke="#111" stroke-width="1.2"/>`);
  const labelled = new Map<string, number>();
  for (const c of lw.connectors) {
    const color = c.domain === "duct" ? "#0a6cff" : c.domain === "pipe" ? "#0a9a55" : "#d97706";
    // Connectors that coincide in this view stack their labels.
    const spot = `${Math.round((c.u - x0) * k / 8)},${Math.round((y0 + h - c.v) * k / 8)}`;
    const nth = labelled.get(spot) ?? 0;
    labelled.set(spot, nth + 1);
    parts.push(`<circle cx="${X(c.u)}" cy="${Y(c.v)}" r="5" fill="${color}"/><text x="${fmt((c.u - x0) * k + 7)}" y="${fmt((y0 + h - c.v) * k - 7 + nth * 13)}" style="font:11px sans-serif" fill="${color}">${c.label.replace(/[<>&]/g, "")}</text>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="${fmt(h * k)}" viewBox="0 0 ${widthPx} ${fmt(h * k)}"><rect width="100%" height="100%" fill="white"/><text x="6" y="14" style="font:11px sans-serif" fill="#444">${lw.view}</text>${parts.join("")}</svg>`;
}
