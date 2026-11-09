import { elementsOfKind, type BimElement, type ModelState } from "@permitzip/bim-kernel";
import { growAabb, measurePair, sharedCentre, type PairMeasure } from "../../geometry/convex";
import type { BodyRecord } from "../../index-state";
import { clip, feet, inches } from "../format";
import type { RuleContext, RuleDef } from "../registry";

/**
 * Clashes between solids: ours against ours, ours against linked models.
 * Deterministic geometry with tolerance classes (LINT-CLASH-ENGINE.md):
 *
 * - clash-hard: the solids overlap by more than the tolerance (0.5 in.).
 * - clash-self: the same, between two runs of one system (a duct crossing
 *   itself or its own branch, bug log #21).
 * - clash-soft: closer than the clearance (1 in. between services, 2 in. to
 *   structure and architecture), or overlapping within the tolerance.
 *
 * Elements that meet by design (a link, or both joined to the same fitting
 * or segment) are never a clash. A riser through a slab, and equipment on
 * a slab or roof, belong to the placement rules, not here.
 */

const MM_PER_IN = 25.4;
const INITIATORS = new Set(["mep", "equipment"]);
const OUR_OBSTACLES = new Set(["mep", "equipment", "architecture", "structure"]);

interface PairResult {
  readonly other: BodyRecord;
  readonly measure: PairMeasure;
  readonly clearanceMm: number;
}

const cache = new WeakMap<RuleContext, Map<string, PairResult[]>>();

function boxGap(a: BodyRecord["box"], b: BodyRecord["box"]): number {
  const dx = Math.max(0, a.min.x - b.max.x, b.min.x - a.max.x);
  const dy = Math.max(0, a.min.y - b.max.y, b.min.y - a.max.y);
  const dz = Math.max(0, a.min.z - b.max.z, b.min.z - a.max.z);
  return Math.hypot(dx, dy, dz);
}

function isSurfaceKind(b: BodyRecord, ctx: RuleContext): boolean {
  if (b.linkedKind === "slab" || b.linkedKind === "roof") return true;
  if (b.elementId) return ctx.model.elements[b.elementId]?.kind === "slab";
  return false;
}

function systemOf(el: BimElement | undefined): string | null {
  return el && (el.kind === "run_segment" || el.kind === "run_fitting") ? (el.systemId as string) : null;
}

/** Every body `el` comes within clearance of, measured once per element per run. */
export function pairsOf(ctx: RuleContext, el: BimElement): PairResult[] {
  let byEl = cache.get(ctx);
  if (!byEl) {
    byEl = new Map();
    cache.set(ctx, byEl);
  }
  const known = byEl.get(el.id);
  if (known) return known;
  const out: PairResult[] = [];
  byEl.set(el.id, out);
  if (ctx.pairsFrom !== null && !ctx.pairsFrom.has(el.id)) return out;
  const body = ctx.body(el.id);
  if (!body || !INITIATORS.has(body.kind)) return out;
  const soft = ctx.config.soft_clearance_in * MM_PER_IN;
  const structure = ctx.config.structure_clearance_in * MM_PER_IN;
  const far = Math.max(soft, structure, 1);
  const isPart = el.kind === "part";
  for (const other of ctx.obstaclesNear(growAabb(body.box, far))) {
    if (other.key === body.key) continue;
    // Two elements whose heights are both assumed from different level names can't be compared in height.
    if (body.layer !== null && other.layer !== null && body.layer !== other.layer) continue;
    if (other.elementId) {
      if (!OUR_OBSTACLES.has(other.kind)) continue;
      if (ctx.joined(el.id, other.elementId)) continue;
    } else {
      if (other.kind !== "linked_obstacle" || !ctx.config.include_linked) continue;
    }
    if (isSurfaceKind(other, ctx) && (isPart || body.plumb)) continue;
    const isStructure = other.kind === "architecture" || other.kind === "structure" || (other.kind === "linked_obstacle" && other.linkedKind !== "mep");
    const clearanceMm = isStructure ? structure : soft;
    // Boxes farther apart than the clearance can't hold solids closer than it.
    if (boxGap(body.box, other.box) >= clearanceMm) continue;
    const known = ctx.measured(body.key, other.key, far);
    const measure = known ?? measurePair(body.pieces(), other.pieces(), far);
    if (!known) ctx.remember(body.key, other.key, far, measure);
    if (measure.kind === "gap" && measure.gapMm >= clearanceMm) continue;
    out.push({ other, measure, clearanceMm });
  }
  return out;
}

function otherName(ctx: RuleContext, b: BodyRecord): string {
  if (b.linked) return `${b.linked.name || b.linked.ifcClass} (linked)`;
  return b.elementId ? ctx.name(b.elementId) : b.key;
}

/** Ours-against-ours findings are worded from the side the edit changed; the other side's run reports it. */
function otherSideSpeaks(ctx: RuleContext, el: BimElement, p: PairResult): boolean {
  return p.other.elementId !== null && ctx.changed.has(p.other.elementId) && !ctx.changed.has(el.id);
}

function emitPair(ctx: RuleContext, rule: string, severity: "error" | "warning", el: BimElement, p: PairResult, message: string, fixHint: string, fixTool: string): void {
  const body = ctx.body(el.id);
  if (!body) return;
  const c = sharedCentre(body.box, p.other.box);
  ctx.emit({
    rule,
    severity,
    elementIds: p.other.elementId ? [el.id, p.other.elementId] : [el.id],
    ...(p.other.linked ? { linked: [p.other.linked] } : {}),
    at: { level: ctx.levelNameOf(el), x_ft: feet(c.x), y_ft: feet(c.y), z_ft: feet(c.z) },
    message: clip(message),
    fix: { tool: fixTool, hint: clip(fixHint, 120) },
  });
}

function moveTool(el: BimElement): string {
  if (el.kind === "part") return "bim_move_elements";
  if (el.kind === "run_segment" || el.kind === "run_fitting") return "bim_offset_run";
  return "bim_move_elements";
}

function hardOrSelf(ctx: RuleContext, el: BimElement, wantSelf: boolean): void {
  const tol = ctx.config.tolerance_in * MM_PER_IN;
  const mySystem = systemOf(el);
  for (const p of pairsOf(ctx, el)) {
    if (p.measure.kind !== "overlap" || p.measure.depthMm <= tol || otherSideSpeaks(ctx, el, p)) continue;
    const same = mySystem !== null && p.other.elementId !== null && systemOf(ctx.model.elements[p.other.elementId]) === mySystem;
    if (same !== wantSelf) continue;
    const depth = inches(p.measure.depthMm);
    const a = ctx.name(el.id);
    const b = otherName(ctx, p.other);
    const rule = wantSelf ? "clash-self" : "clash-hard";
    const message = wantSelf ? `${a} crosses its own system's ${b}, ${depth} deep` : `${a} passes ${depth} into ${b}`;
    emitPair(ctx, rule, "error", el, p, message, `move or reroute ${a} by at least ${inches(p.measure.depthMm + tol)}`, moveTool(el));
  }
}

const plannedCounts = new WeakMap<object, number>();

/** Planned parts in the model, counted once per model state from the per-kind index. */
function plannedCount(model: ModelState): number {
  let n = plannedCounts.get(model.elements);
  if (n === undefined) {
    n = 0;
    for (const part of elementsOfKind(model.elements, "part")) if (part.planned !== undefined) n += 1;
    plannedCounts.set(model.elements, n);
  }
  return n;
}

export const coordinationRules: readonly RuleDef[] = [
  {
    // Planned parts have no location, so the clash rules never see them; this says so instead of staying silent.
    id: "planned-not-checked",
    version: 1,
    pack: "coordination",
    severity: "info",
    title: "A part that isn't placed yet, so nothing checks it for clashes",
    scope: "element",
    kinds: ["part"],
    run: (ctx, el) => {
      if (el.kind !== "part" || el.planned === undefined) return;
      const n = plannedCount(ctx.model);
      const hint = el.planned.levelHint ? ctx.model.elements[el.planned.levelHint] : undefined;
      ctx.emit({
        rule: "planned-not-checked",
        severity: "info",
        elementIds: [el.id],
        at: { level: hint?.kind === "level" ? hint.name : (el.partition?.level ?? ""), x_ft: 0, y_ft: 0, z_ft: 0 },
        message: clip(`${ctx.name(el.id)} isn't placed yet: ${n} planned element${n === 1 ? "" : "s"} not checked for clashes`),
        fix: { tool: "bim_place_part", hint: clip(`place ${ctx.name(el.id)} (Not placed yet › Place, or bim_place_part with part_id) to check it`, 120) },
      });
    },
  },
  {
    id: "clash-hard",
    version: 1,
    pack: "coordination",
    pairsOnly: true,
    severity: "error",
    title: "Solids overlap by more than the tolerance (ours against ours, or a linked model)",
    scope: "element",
    kinds: ["run_segment", "run_fitting", "part", "duct_segment", "equipment"],
    run: (ctx, el) => hardOrSelf(ctx, el, false),
  },
  {
    id: "clash-self",
    version: 1,
    pack: "coordination",
    pairsOnly: true,
    severity: "error",
    title: "A run crosses another run of the same system",
    scope: "element",
    kinds: ["run_segment", "run_fitting"],
    run: (ctx, el) => hardOrSelf(ctx, el, true),
  },
  {
    id: "clash-soft",
    version: 1,
    pack: "coordination",
    pairsOnly: true,
    severity: "warning",
    title: "Closer than the clearance distance",
    scope: "element",
    kinds: ["run_segment", "run_fitting", "part", "duct_segment", "equipment"],
    run: (ctx, el) => {
      const tol = ctx.config.tolerance_in * MM_PER_IN;
      for (const p of pairsOf(ctx, el)) {
        const touching = p.measure.kind === "overlap" && p.measure.depthMm <= tol;
        if ((!touching && p.measure.kind !== "gap") || otherSideSpeaks(ctx, el, p)) continue;
        const gap = p.measure.kind === "gap" ? p.measure.gapMm : 0;
        const a = ctx.name(el.id);
        const b = otherName(ctx, p.other);
        const message = touching ? `${a} touches ${b} (clearance ${inches(p.clearanceMm)})` : `${a} is ${inches(gap)} from ${b} (clearance ${inches(p.clearanceMm)})`;
        emitPair(ctx, "clash-soft", "warning", el, p, message, `give ${a} ${inches(p.clearanceMm - gap)} more room`, moveTool(el));
      }
    },
  },
];
