import { IFC_IMPORT_RULE_POINT, rectangleAxis, roundPlan, type BimElement, type ImportExtrusion, type ImportProduct, type ImportRuleContext, type ImportRuleDef, type ImportRuleResult, type Level, type Vec2 } from "@permitzip/bim-kernel";
import { ROOF_KIND, STAIR_KIND, type RoofRecord, type StairRecord } from "./kinds";

/**
 * Roofs and stairs from a linked model (`kernel.ifc_import_rule`): an
 * `IfcRoof` becomes a roof from its body's footprint, thickness and height
 * (its `ROOF` slab part is how it is made, not a second record); an
 * `IfcStair` becomes one straight run from its steps (its flight's risers
 * and treads), rising to the level above. Anything else stays linked with
 * its reason.
 */

const round = (n: number): number => Math.round(n * 10) / 10;
const fail = (reason: string): ImportRuleResult => ({ ok: false, reason });
const FLAT_MM = 1;

function needLevel(ctx: ImportRuleContext, p: ImportProduct): Level | string {
  return ctx.level(p) ?? "it isn't on a storey this model has a level for";
}

function base(ctx: ImportRuleContext, p: ImportProduct, level: Level) {
  const values = ctx.values(p);
  return {
    id: ctx.idFor(p.sourceId),
    version: 0,
    authoredRev: {},
    partition: ctx.partition(level),
    provenance: ctx.provenance(p),
    ...(ctx.cls.source === "builtin" ? {} : { classId: ctx.cls.id }),
    ...(Object.keys(values).length > 0 ? { values } : {}),
  };
}

/** A block of a body: a horizontal footprint pushed up (its sides may lean), bottom and top heights. */
interface Block {
  readonly outline: readonly Vec2[];
  readonly bottom: number;
  readonly top: number;
}

function blockOf(x: ImportExtrusion): Block | null {
  const zs = x.base.map((q) => q.z);
  if (zs.length < 3 || Math.max(...zs) - Math.min(...zs) > FLAT_MM || Math.abs(x.along.z) < FLAT_MM) return null;
  const z0 = zs[0] ?? 0;
  const outline = [...x.base.map((q) => ({ x: q.x, y: q.y })), ...x.base.map((q) => ({ x: q.x + x.along.x, y: q.y + x.along.y }))];
  return { outline, bottom: Math.min(z0, z0 + x.along.z), top: Math.max(z0, z0 + x.along.z) };
}

/** Every block of the body, or why the body can't be read as flat blocks. */
function blocksOf(p: ImportProduct, what: string): Block[] | string {
  if (p.geometry.unread) return `its shape is ${p.geometry.unread}`;
  if (p.geometry.extrusions.length === 0) return `it has no ${what} body of its own to read`;
  const blocks: Block[] = [];
  for (const x of p.geometry.extrusions) {
    const b = blockOf(x);
    if (!b) return `its ${what} isn't made of flat pieces (a sloped or curved surface)`;
    blocks.push(b);
  }
  return blocks;
}

function hull(points: readonly Vec2[]): Vec2[] {
  const q = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (q.length < 3) return q;
  const cross = (o: Vec2, a: Vec2, b: Vec2): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const half = (pts: readonly Vec2[]): Vec2[] => {
    const out: Vec2[] = [];
    for (const v of pts) {
      while (out.length >= 2 && cross(out[out.length - 2] as Vec2, out[out.length - 1] as Vec2, v) <= 0) out.pop();
      out.push(v);
    }
    return out;
  };
  const lower = half(q);
  const upper = half([...q].reverse());
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

export const ROOF_IMPORT_RULE: ImportRuleDef = {
  id: "architecture.roof",
  label: "Flat roofs",
  forKinds: [ROOF_KIND],
  convert(p, ctx) {
    const level = needLevel(ctx, p);
    if (typeof level === "string") return fail(level);
    const blocks = blocksOf(p, "roof");
    if (typeof blocks === "string") return fail(blocks);
    const outline = hull(blocks.flatMap((b) => b.outline)).map(roundPlan);
    if (outline.length < 3) return fail("its footprint has no area");
    const bottom = Math.min(...blocks.map((b) => b.bottom));
    const top = Math.max(...blocks.map((b) => b.top));
    if (blocks.length > 1) ctx.note(`${p.name?.trim() || p.sourceId}: its openings come in on their own; the roof is drawn round them`);
    const roof: RoofRecord = { id: ctx.idFor(p.sourceId), kind: ROOF_KIND, levelId: level.id, outline, thicknessMm: round(top - bottom), baseOffsetMm: round(bottom - level.elevationMm) };
    return { ok: true, records: [{ ...base(ctx, p, level), ...roof } as unknown as BimElement] };
  },
};

function numberIn(p: ImportProduct, set: string, key: string): number | null {
  const v = p.properties[set]?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export const STAIR_IMPORT_RULE: ImportRuleDef = {
  id: "architecture.stair",
  label: "Straight stairs",
  forKinds: [STAIR_KIND],
  convert(p, ctx) {
    const level = needLevel(ctx, p);
    if (typeof level === "string") return fail(level);
    const blocks = blocksOf(p, "stair");
    if (typeof blocks === "string") return fail(blocks);
    const name = p.name?.trim() || p.sourceId;
    const all = blocks.flatMap((b) => b.outline);
    let u: Vec2;
    let risers: number | null = numberIn(p, "Pset_StairCommon", "NumberOfRiser");
    if (blocks.length > 1) {
      // Steps climb from the foot: the run goes from the lowest step's middle towards the highest's.
      const mid = (b: Block): Vec2 => ({ x: b.outline.reduce((s, q) => s + q.x, 0) / b.outline.length, y: b.outline.reduce((s, q) => s + q.y, 0) / b.outline.length });
      const sorted = [...blocks].sort((a, b) => a.top - b.top);
      const lo = mid(sorted[0] as Block);
      const hi = mid(sorted[sorted.length - 1] as Block);
      const d = Math.hypot(hi.x - lo.x, hi.y - lo.y);
      if (d < FLAT_MM) return fail("its steps don't climb in one straight line");
      u = { x: (hi.x - lo.x) / d, y: (hi.y - lo.y) / d };
      risers ??= blocks.length + 1;
    } else {
      const axis = rectangleAxis(hull(all));
      if (!axis) return fail("its footprint isn't a rectangle (a turning or curved stair)");
      const d = Math.hypot(axis.end.x - axis.start.x, axis.end.y - axis.start.y);
      u = { x: (axis.end.x - axis.start.x) / d, y: (axis.end.y - axis.start.y) / d };
      ctx.note(`${name}: the file doesn't say which end is its foot; check its UP arrow`);
    }
    const along = all.map((q) => q.x * u.x + q.y * u.y);
    const across = all.map((q) => -q.x * u.y + q.y * u.x);
    const [a0, a1, c0, c1] = [Math.min(...along), Math.max(...along), Math.min(...across), Math.max(...across)];
    const c = (c0 + c1) / 2;
    const at = (a: number): Vec2 => roundPlan({ x: a * u.x - c * u.y, y: a * u.y + c * u.x });
    const stair: StairRecord = { id: ctx.idFor(p.sourceId), kind: STAIR_KIND, levelId: level.id, start: at(a0), end: at(a1), widthMm: round(c1 - c0), ...(risers !== null && risers >= 2 ? { risers: Math.round(risers) } : {}) };
    return { ok: true, records: [{ ...base(ctx, p, level), ...stair } as unknown as BimElement] };
  },
};

export const ARCHITECTURE_IMPORT_RULES: readonly ImportRuleDef[] = [ROOF_IMPORT_RULE, STAIR_IMPORT_RULE];
export { IFC_IMPORT_RULE_POINT };
