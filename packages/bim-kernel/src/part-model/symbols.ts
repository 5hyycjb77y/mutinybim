import { resolveDim, type PartTypeDefinition, type SymbolPrimitive } from "../parts";
import type { ParamValue } from "../types";
import { resolveSketchSet, type ModelIssue } from "./resolve";
import type { DetailLevel } from "./schema";
import { isPartModel2, type PartSymbolView } from "./schema-2";

/**
 * A schema 2 part's symbol lines for one view and detail level (part model
 * symbols: sketches drawn instead of, or with, the solid). Null when the part
 * has none for that view and level: drawings then show the solid seen from
 * that side. Plan and below symbols are in the part's plan frame (x, y).
 */
export function partSymbolLines(def: PartTypeDefinition, values: Readonly<Record<string, ParamValue>>, view: PartSymbolView, detail: DetailLevel): SymbolPrimitive[] | null {
  const model = def.model;
  if (!model || !isPartModel2(model)) return null;
  const wanted = model.symbols.filter((s) => s.view === view && s.detailLevels.includes(detail));
  if (wanted.length === 0) return null;
  const issues: ModelIssue[] = [];
  const notes: string[] = [];
  const safe = (d: Parameters<typeof resolveDim>[2], field: string): number | null => {
    try {
      return resolveDim(def, values, d);
    } catch (err) {
      issues.push({ field, message: err instanceof Error ? err.message : String(err) });
      return null;
    }
  };
  const used = new Set(wanted.map((s) => s.sketch));
  const sketches = resolveSketchSet({ referencePlanes: model.referencePlanes, sketches: model.sketches.filter((s) => used.has(s.id)) }, safe, issues, notes);
  const out: SymbolPrimitive[] = [];
  for (const symbol of wanted) {
    const rs = sketches.get(symbol.sketch);
    if (!rs) continue;
    const at = (id: string): [number, number] | null => {
      const p = rs.solution.points.get(id);
      return p ? [p.u, p.v] : null;
    };
    for (const e of rs.sketch.entities) {
      if (e.kind === "line") {
        if (e.construction) continue;
        const a = at(e.a);
        const b = at(e.b);
        if (a && b) out.push({ kind: "line", from: a, to: b });
      } else if (e.kind === "circle") {
        const c = at(e.center);
        const r = safe(e.radius, `${symbol.name} circle`);
        if (c && r !== null && r > 0) out.push({ kind: "circle", center: c, radius: r });
      } else if (e.kind === "arc") {
        const c = at(e.center);
        const s = at(e.start);
        const t = at(e.end);
        if (!c || !s || !t) continue;
        const r = Math.hypot(s[0] - c[0], s[1] - c[1]);
        const a0 = Math.atan2(s[1] - c[1], s[0] - c[0]);
        let a1 = Math.atan2(t[1] - c[1], t[0] - c[0]);
        while (a1 <= a0 + 1e-9) a1 += 2 * Math.PI;
        const n = Math.max(2, Math.min(32, Math.ceil(((a1 - a0) / (2 * Math.PI)) * 32)));
        out.push({ kind: "polyline", points: Array.from({ length: n + 1 }, (_, i): [number, number] => [c[0] + r * Math.cos(a0 + ((a1 - a0) * i) / n), c[1] + r * Math.sin(a0 + ((a1 - a0) * i) / n)]), closed: false });
      } else if (e.kind === "polyline") {
        const pts = e.points.map(at).filter((p): p is [number, number] => p !== null);
        if (pts.length >= 2) out.push({ kind: "polyline", points: pts, closed: e.closed });
      } else {
        const pts = e.corners.map(at).filter((p): p is [number, number] => p !== null);
        if (pts.length === 4) out.push({ kind: "polyline", points: pts, closed: true });
      }
    }
  }
  if (issues[0]) console.error("[part-symbols] a symbol's sketch didn't resolve; drawn without it", { part: def.typeName, issue: issues[0] });
  return out;
}
