import { ceilingsAt } from "../../ceilings/ceiling-index";
import { SURFACE_ROLE_POINT } from "../../ceilings/types";
import { defineExtensionPoint } from "../../packs/contract";
import { isPackRefusal, type PackRefusal } from "../../packs/points";
import { activePackSet } from "../../packs/scope";
import { designLimitsFor, type DesignLimitLayer, type DesignLimitSelector, type DesignLimitSources } from "../../policy/design-limits";
import { formatRating, ratingKindRow, ratingOf } from "../../registry/rating-kind-point";
import { boundarySegmentsNear } from "../../spaces/boundaries/boundary-index";
import { ratedSegmentsNear } from "../../spaces/boundaries/point";
import type { BoundarySegment } from "../../spaces/boundaries/rows";
import { boundingElementWords } from "../../spaces/boundaries/preview";
import { editBatchCommandSchemas, isEditBatchCommand, MAX_EDIT_BATCH_STEPS, type Command, type EditBatchCommand } from "../../commands";
import { insertPartOnRun } from "../insert-part";
import { asElementId, type ElementId, type ModelState, type ParamValue, type Vec2 } from "../../types";
import { sizeHeight, sizeWidth } from "../rules";

/**
 * Route constraints (contract 1.10.0, `kernel.route_constraint` v1).
 *
 * What a route (anything drawn from point to point: a run, a segment, a
 * raceway) must do where it meets the building. Two rule forms, read by the
 * route preview while drawing and by the checks after an edit, over the
 * touched span only:
 *
 * - **crossing**: a route crossing an element whose rating of kind K is at
 *   least V needs a named thing at the crossing (a damper, a firestop).
 * - **clearance**: a route under a surface (a ceiling, a soffit, a step in
 *   the ceiling) keeps its bottom at least `clearanceMm` below that surface.
 *
 * Rows are the add-on's; walls are found through the spatial index and
 * ceilings through the ceiling index, never by scanning the model.
 */

/** The piece of a route a rule is asked about, in model mm. */
export interface RouteSpan {
  /** The element drawn (absent while previewing a route not yet in the model). */
  readonly routeId?: ElementId;
  /** The stored kind of what is drawn (a pack's kind, `run_segment`). */
  readonly kind: string;
  /** The service or system it carries, when it carries one. */
  readonly serviceId?: string;
  readonly levelId: string;
  readonly start: Vec2;
  readonly end: Vec2;
  /** Elevation of the route's bottom above the level, mm. */
  readonly bottomMm: number;
  /** Elevation of the route's top above the level, mm. */
  readonly topMm: number;
  /** Plan width, mm. */
  readonly widthMm: number;
}

interface RouteRuleBase {
  /** `<pack>.<name>`. */
  readonly id: string;
  /** What a person calls it ("Fire damper at rated walls"). */
  readonly label: string;
  /** The route kinds it applies to. */
  readonly routes: readonly string[];
  /** Narrower than `routes` (a service, a size). Absent: every route of those kinds. */
  appliesTo?(span: RouteSpan): boolean;
}

export interface CrossingRule extends RouteRuleBase {
  readonly form: "crossing";
  /** The rating kind it reads (`RATING_KIND_POINT` id). */
  readonly ratingKind: string;
  /** The rating at and above which the crossing needs `requires`. */
  readonly atLeast: number;
  /** What the crossing needs: an id the add-on's check looks for at the crossing, and its words ("fire damper"). */
  readonly requires: { readonly id: string; readonly label: string };
  /** True when something at the crossing already meets it (the damper is there). Absent: never met. */
  satisfied?(model: ModelState, hit: RouteConstraintHit): boolean;
  /**
   * Contract 1.12.0 (additive): what Finish places at the crossing — a part
   * type already in the model and the values it takes — or, when there is
   * nothing to place yet, the refusal in words naming what to add. Absent:
   * the crossing is only reported (a Checklist finding).
   */
  place?(model: ModelState, hit: RouteConstraintHit, span: RouteSpan): CrossingPlacement | PackRefusal;
}

/** What a crossing rule places at a crossing (contract 1.12.0). */
export interface CrossingPlacement {
  /** A `part_type` element in the model. */
  readonly typeId: string;
  /** Instance values over the type's. */
  readonly values?: Readonly<Record<string, ParamValue>>;
}

export interface ClearanceRule extends RouteRuleBase {
  readonly form: "clearance";
  /** Surface roles it reads (`SURFACE_ROLE_POINT` ids). Absent: every ceiling surface. */
  readonly surfaceRoles?: readonly string[];
  /** How far below the surface the route's bottom must stay, mm: the default when no design limit binds. */
  readonly clearanceMm: number;
  /**
   * Contract 1.11.0: the design limit that sets the clearance (a length with
   * `band.min`), read project over firm over the add-on's default, most
   * specific first, so a firm or project can change it per system. A row whose
   * id is `id` or starts with `id.` (a per-system variant) binds.
   */
  readonly limit?: { readonly id: string; selector(span: RouteSpan): DesignLimitSelector };
}

/** Where a route check reads firm and project design limits (the host passes them; absent: add-on defaults only). */
export interface RouteCheckOptions {
  readonly stage?: string;
  readonly limits?: DesignLimitSources;
}

export type RouteConstraintRow = CrossingRule | ClearanceRule;

/** One place a route meets a rule. */
export interface RouteConstraintHit {
  readonly ruleId: string;
  readonly routeId?: ElementId;
  /** The wall, ceiling or soffit it meets. */
  readonly hostId: ElementId;
  /** Contract 1.12.0: the level the span is on (so a check of what sits at the crossing reads that level only). */
  readonly levelId?: string;
  readonly at: Vec2;
  /** The place and the fix, in words ("Crosses 1-hour wall at C/4: needs a fire damper"). */
  readonly message: string;
  /** Crossing rules: what is needed there. */
  readonly requires?: string;
  /** Clearance rules read from a design limit: which one, the layer it came from and its source in words. */
  readonly basis?: { readonly limitId: string; readonly layer: DesignLimitLayer; readonly source: string };
}

const MM_PER_UNIT: Readonly<Record<string, number>> = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 };

/** A clearance rule's distance for one span (mm) and the limit it came from, if one binds. */
function clearanceFor(rule: ClearanceRule, span: RouteSpan, options: RouteCheckOptions): { readonly mm: number; readonly basis?: RouteConstraintHit["basis"] } {
  if (!rule.limit) return { mm: rule.clearanceMm };
  const id = rule.limit.id;
  const bound = designLimitsFor(rule.limit.selector(span), options.stage, options.limits ?? {}).find((r) => r.limit.id === id || r.limit.id.startsWith(`${id}.`));
  const min = bound?.limit.band.min;
  const per = bound ? MM_PER_UNIT[bound.limit.unit] : undefined;
  if (!bound || min === undefined || per === undefined) return { mm: rule.clearanceMm };
  return { mm: min * per, basis: { limitId: bound.limit.id, layer: bound.layer, source: bound.limit.citation.source } };
}

export const ROUTE_CONSTRAINT_POINT = defineExtensionPoint<RouteConstraintRow>({
  id: "kernel.route_constraint",
  version: 1,
  label: "Route constraints",
  idOf: (row) => row.id,
});

/** Problems with route constraint rows (pack conformance), in words. */
export function routeConstraintRowProblems(rows: readonly RouteConstraintRow[]): string[] {
  const out: string[] = [];
  for (const row of rows) {
    if (row.label.trim().length === 0) out.push(`route rule ${row.id} has no label`);
    if (row.routes.length === 0) out.push(`route rule ${row.id} names no route kind`);
    if (row.appliesTo !== undefined && typeof row.appliesTo !== "function") out.push(`route rule ${row.id}: appliesTo must be a function`);
    if (row.form === "crossing") {
      if (row.ratingKind.trim().length === 0) out.push(`route rule ${row.id}: say which rating it reads (ratingKind)`);
      if (!Number.isFinite(row.atLeast)) out.push(`route rule ${row.id}: atLeast must be a number`);
      if (row.requires.label.trim().length === 0) out.push(`route rule ${row.id}: say what the crossing needs (requires.label)`);
    } else if (row.form === "clearance") {
      if (!Number.isFinite(row.clearanceMm) || row.clearanceMm < 0) out.push(`route rule ${row.id}: clearanceMm must be zero or more`);
      if (row.limit !== undefined && (row.limit.id.trim().length === 0 || typeof row.limit.selector !== "function")) out.push(`route rule ${row.id}: limit needs an id and a selector function`);
    } else {
      out.push(`route rule ${(row as { id: string }).id}: form must be crossing or clearance`);
    }
  }
  return out;
}

/** The set in force's rules for one route kind. */
export function routeConstraintsFor(kind: string): readonly RouteConstraintRow[] {
  const set = activePackSet();
  const byKind = set.memo("kernel.route_constraint#by_kind", (s) => {
    const map = new Map<string, RouteConstraintRow[]>();
    for (const row of s.items(ROUTE_CONSTRAINT_POINT)) for (const k of row.routes) map.set(k, [...(map.get(k) ?? []), row]);
    return map;
  });
  return byKind.get(kind) ?? [];
}

const MM_PER_FT = 304.8;
/** Plan step between clearance samples along a span, mm (a ceiling step narrower than this can fall between two). */
const CLEARANCE_STEP_MM = 150;
const MAX_CLEARANCE_SAMPLES = 4000;

const feet = (mm: number): string => `${(Math.round((mm / MM_PER_FT) * 100) / 100).toString()} ft`;

/** Where two plan segments cross (ends included), or null. */
function crossingPoint(a: Vec2, b: Vec2, c: Vec2, d: Vec2): Vec2 | null {
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  const sx = d.x - c.x;
  const sy = d.y - c.y;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / denom;
  const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / denom;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return { x: a.x + rx * t, y: a.y + ry * t };
}

function crossingHits(model: ModelState, span: RouteSpan, rules: readonly CrossingRule[]): RouteConstraintHit[] {
  if (rules.length === 0) return [];
  const pad = span.widthMm / 2;
  const box = { minX: Math.min(span.start.x, span.end.x) - pad, minY: Math.min(span.start.y, span.end.y) - pad, maxX: Math.max(span.start.x, span.end.x) + pad, maxY: Math.max(span.start.y, span.end.y) + pad };
  const elements = model.elements;
  const levelId = asElementId(span.levelId);
  // An element's boundary is its faces (a wall has two): the crossing is the middle of where the span meets them.
  const met = new Map<ElementId, Vec2[]>();
  const seen = new Set<string>();
  const meet = (seg: BoundarySegment) => {
    const key = `${seg.elementId}\u0000${seg.start.x},${seg.start.y}\u0000${seg.end.x},${seg.end.y}`;
    if (seen.has(key)) return;
    seen.add(key);
    const p = crossingPoint(span.start, span.end, seg.start, seg.end);
    if (p) met.set(seg.elementId, [...(met.get(seg.elementId) ?? []), p]);
  };
  for (const seg of boundarySegmentsNear(elements, levelId, box)) meet(seg);
  // Rated elements that don't bound rooms (contract 1.12.0, the rated index); a refusal from it leaves the room-bounding elements above.
  for (const ratingKind of new Set(rules.map((r) => r.ratingKind))) {
    const rated = ratedSegmentsNear(model, levelId, box, ratingKind);
    if (!("refused" in rated)) for (const seg of rated) meet(seg);
  }
  const along = (p: Vec2) => Math.hypot(p.x - span.start.x, p.y - span.start.y);
  const crossings = [...met].map(([elementId, points]) => ({ elementId, at: { x: points.reduce((s, p) => s + p.x, 0) / points.length, y: points.reduce((s, p) => s + p.y, 0) / points.length } }));
  crossings.sort((a, b) => along(a.at) - along(b.at) || (a.elementId < b.elementId ? -1 : 1));
  const out: RouteConstraintHit[] = [];
  for (const { elementId, at } of crossings) {
    const el = elements[elementId];
    if (!el) continue;
    for (const rule of rules) {
      const value = ratingOf(elements, el, rule.ratingKind);
      if (value === null || value < rule.atLeast) continue;
      const row = ratingKindRow(rule.ratingKind);
      const rated = row ? formatRating(row, value) : `rated ${value}`;
      const hit: RouteConstraintHit = {
        ruleId: rule.id,
        ...(span.routeId ? { routeId: span.routeId } : {}),
        hostId: elementId,
        levelId: span.levelId,
        at: { x: Math.round(at.x * 1000) / 1000, y: Math.round(at.y * 1000) / 1000 },
        message: `${rated} ${boundingElementWords(elements, elementId)}: a ${rule.requires.label} goes here`,
        requires: rule.requires.id,
      };
      if (rule.satisfied?.(model, hit)) continue;
      out.push(hit);
    }
  }
  return out;
}

function clearanceHits(model: ModelState, span: RouteSpan, rules: readonly ClearanceRule[], options: RouteCheckOptions): RouteConstraintHit[] {
  if (rules.length === 0) return [];
  const length = Math.hypot(span.end.x - span.start.x, span.end.y - span.start.y);
  const steps = Math.min(MAX_CLEARANCE_SAMPLES, Math.max(1, Math.ceil(length / CLEARANCE_STEP_MM)));
  const roleLabel = new Map(activePackSet().items(SURFACE_ROLE_POINT).map((r) => [r.id, r.label.toLowerCase()] as const));
  const levelId = asElementId(span.levelId);
  const out: RouteConstraintHit[] = [];
  const seen = new Set<string>();
  const clearances = new Map(rules.map((r) => [r.id, clearanceFor(r, span, options)] as const));
  for (let i = 0; i <= steps; i++) {
    const k = i / steps;
    const at = { x: span.start.x + (span.end.x - span.start.x) * k, y: span.start.y + (span.end.y - span.start.y) * k };
    for (const c of ceilingsAt(model.elements, levelId, at)) {
      // A surface wholly below the route (the ceiling it runs above) doesn't bear on it; one reaching above its bottom does.
      if (c.heightMm <= span.bottomMm) continue;
      for (const rule of rules) {
        const key = `${rule.id}\u0000${c.ceilingId}`;
        if (seen.has(key) || (rule.surfaceRoles && !rule.surfaceRoles.includes(c.role))) continue;
        const room = c.heightMm - span.topMm;
        const clearance = clearances.get(rule.id) ?? { mm: rule.clearanceMm };
        if (room >= clearance.mm) continue;
        seen.add(key);
        const what = roleLabel.get(c.role) ?? c.role.replace(/_/g, " ");
        out.push({
          ruleId: rule.id,
          ...(span.routeId ? { routeId: span.routeId } : {}),
          hostId: c.ceilingId,
          levelId: span.levelId,
          at: { x: Math.round(at.x * 1000) / 1000, y: Math.round(at.y * 1000) / 1000 },
          message:
            room < 0
              ? `The ${what} at ${feet(c.heightMm)} comes down through the run (its top is at ${feet(span.topMm)}): drop the run to ${feet(c.heightMm - clearance.mm)} or lower here`
              : `The run's top is ${feet(room)} under the ${what} at ${feet(c.heightMm)}; ${rule.label} keeps ${feet(clearance.mm)}${clearance.basis ? ` (${clearance.basis.source})` : ""}: drop the run to ${feet(c.heightMm - clearance.mm)} or lower here`,
          ...(clearance.basis ? { basis: clearance.basis } : {}),
        });
      }
    }
  }
  return out;
}

/**
 * Every place one route span meets a rule (preview and checks): rated
 * elements its plan line crosses (through the boundary index, near the span
 * only) and ceilings overhead that come within a rule's clearance of its top
 * (through the ceiling index). Empty when no rule applies.
 */
export function checkRouteSpan(model: ModelState, span: RouteSpan, options: RouteCheckOptions = {}): readonly RouteConstraintHit[] | PackRefusal {
  const nums = [span.start.x, span.start.y, span.end.x, span.end.y, span.bottomMm, span.topMm, span.widthMm];
  if (nums.some((v) => !Number.isFinite(v))) return { refused: "That route span has a point or height that isn't a number" };
  if (span.topMm < span.bottomMm) return { refused: "That route span's top is below its bottom" };
  const rules = routeConstraintsFor(span.kind).filter((r) => r.appliesTo?.(span) ?? true);
  if (rules.length === 0) return [];
  const crossing = rules.filter((r): r is CrossingRule => r.form === "crossing");
  const clearance = rules.filter((r): r is ClearanceRule => r.form === "clearance");
  return [...crossingHits(model, span, crossing), ...clearanceHits(model, span, clearance, options)];
}

// ------------------------------------------------------------ legs of a drawn route (contract 1.12.0)

/** One straight piece of a route as a span: its segment and what the rules are asked about. */
export interface RouteLeg {
  readonly segmentId: ElementId;
  readonly span: RouteSpan;
}

/** A leg's answer: the places it meets a rule, or why it couldn't be checked. */
export interface RouteLegCheck extends RouteLeg {
  readonly hits: readonly RouteConstraintHit[];
  readonly refused?: string;
}

/**
 * A straight run piece as a route span: plan line, bottom and top above its
 * level (centreline heights plus half the section), plan width, and the
 * service its system carries. Null for anything else, and for a vertical
 * piece (a rise or drop has no plan line to cross a wall with).
 */
export function routeLegOf(model: ModelState, segmentId: string): RouteLeg | null {
  const el = model.elements[segmentId];
  if (el?.kind !== "run_segment") return null;
  if (Math.hypot(el.end.x - el.start.x, el.end.y - el.start.y) < 1) return null;
  const system = model.elements[el.systemId];
  const half = sizeHeight(el.size) / 2;
  return {
    segmentId: el.id,
    span: {
      routeId: el.id,
      kind: el.kind,
      ...(system?.kind === "mep_system" ? { serviceId: system.systemKind } : {}),
      levelId: el.levelId,
      start: { x: el.start.x, y: el.start.y },
      end: { x: el.end.x, y: el.end.y },
      bottomMm: Math.min(el.start.z, el.end.z) - half,
      topMm: Math.max(el.start.z, el.end.z) + half,
      widthMm: sizeWidth(el.size),
    },
  };
}

/**
 * The route preview's check (pointer-follow, nothing sent) and the checks
 * after an edit: every leg among `segmentIds` against the rules in force.
 * Reads only those legs and the indexes near them.
 */
export function checkRouteLegs(model: ModelState, segmentIds: readonly string[], options: RouteCheckOptions = {}): readonly RouteLegCheck[] {
  const out: RouteLegCheck[] = [];
  for (const id of segmentIds) {
    const leg = routeLegOf(model, id);
    if (!leg) continue;
    const answer = checkRouteSpan(model, leg.span, options);
    out.push("refused" in answer ? { ...leg, hits: [], refused: answer.refused } : { ...leg, hits: answer });
  }
  return out;
}

/** A `place_part` the host sends after the route (the same command an agent's place-part tool sends). */
export type CrossingPlaceCommand = Extract<Command, { type: "place_part" }>;

/** What Finish sends at a crossing: a part on the run's centre line, or the part cut into the run (`insertPartOnRun`'s one batch). */
export type CrossingFinishCommand = CrossingPlaceCommand | EditBatchCommand;

/** What Finish does at each place a drawn route meets a rule. */
export interface RouteFinishPlan {
  /** In the order they run: one per crossing an add-on can place for. */
  readonly commands: readonly CrossingFinishCommand[];
  /** The crossings those commands meet. */
  readonly placed: readonly RouteConstraintHit[];
  /** Of `placed`, the ones cut into the run (the part's two in-line connectors join its pieces). */
  readonly cut: readonly RouteConstraintHit[];
  /** Placed on the run's centre line instead of cut in, with why (a type with no in-line connectors, a piece too short there). */
  readonly onCentreLine: readonly { readonly hit: RouteConstraintHit; readonly why: string }[];
  /** What stays on the Checklist, with why nothing was placed for it. */
  readonly left: readonly { readonly hit: RouteConstraintHit; readonly why: string }[];
}

/** Finish options: the checks', plus how to cut parts into the run. */
export interface RouteFinishOptions extends RouteCheckOptions {
  /**
   * Cut each part into its run (feature `routing:insert_part`; pass it only
   * when the model server reads it). The host's own decide: the model after
   * `command`, or why it was refused. Each later cut is worked out on the
   * model after the ones before it.
   */
  readonly inline?: (model: ModelState, command: Command) => ModelState | PackRefusal;
}

interface PlannedCrossing {
  readonly hit: RouteConstraintHit;
  readonly leg: RouteLeg;
  readonly placement: CrossingPlacement;
  /** Along the leg from its start, mm (3D). */
  readonly atMm: number;
}

/**
 * Finish on a route: for each crossing whose rule says what to place
 * (`CrossingRule.place`), the part at the crossing, turned along the leg;
 * everything else (no type to place yet, clearance hits, rules with no
 * `place`) is left for the Checklist with its reason.
 *
 * With `inline`, the part is cut into the run: one leg's crossings far end
 * first, so the leg keeps its id and each cut's distance from its start, each
 * worked out on the model after the cuts before it. A type with no in-line
 * pair, or a piece too short at that point, falls back to the centre line and
 * says why. Ids start `idPrefix-x1`, `-x2`… so a retried Finish sends the
 * same edits.
 */
export function routeFinishPlan(model: ModelState, segmentIds: readonly string[], idPrefix: string, options: RouteFinishOptions = {}): RouteFinishPlan {
  const left: { hit: RouteConstraintHit; why: string }[] = [];
  const byLeg: PlannedCrossing[][] = [];
  for (const leg of checkRouteLegs(model, segmentIds, options)) {
    if (leg.hits.length === 0) continue;
    const rules = new Map(routeConstraintsFor(leg.span.kind).map((r) => [r.id, r] as const));
    const planned: PlannedCrossing[] = [];
    for (const hit of leg.hits) {
      const rule = rules.get(hit.ruleId);
      if (rule?.form !== "crossing" || !rule.place) {
        left.push({ hit, why: rule?.form === "clearance" ? "a clearance is fixed by moving the run, not by placing a part" : "the add-on that asks for it doesn't say what to place" });
        continue;
      }
      const placement = rule.place(model, hit, leg.span);
      if ("refused" in placement) {
        left.push({ hit, why: placement.refused });
        continue;
      }
      planned.push({ hit, leg, placement, atMm: alongLeg(model, leg, hit.at) });
    }
    if (planned.length > 0) byLeg.push(planned);
  }

  const commands: CrossingFinishCommand[] = [];
  const placed: RouteConstraintHit[] = [];
  const cut: RouteConstraintHit[] = [];
  const onCentreLine: { hit: RouteConstraintHit; why: string }[] = [];
  let current = model;
  let n = 0;
  for (const planned of byLeg) {
    const order = options.inline ? [...planned].sort((a, b) => b.atMm - a.atMm) : planned;
    for (const p of order) {
      n += 1;
      const centre = centreLinePart(p, `${idPrefix}-x${n}`);
      if (!options.inline) {
        commands.push(centre);
        placed.push(p.hit);
        continue;
      }
      const insert = insertPartOnRun(current, { runId: p.leg.segmentId, atMm: p.atMm, partDefinitionId: p.placement.typeId, idPrefix: `${idPrefix}-x${n}` });
      const inlineCommand = isPackRefusal(insert) ? null : withPlacementValues(insert[0], p.placement);
      const tried = inlineCommand ? options.inline(current, inlineCommand) : null;
      if (inlineCommand && tried && !isPackRefusal(tried)) {
        commands.push(inlineCommand);
        placed.push(p.hit);
        cut.push(p.hit);
        current = tried;
        continue;
      }
      const why = isPackRefusal(insert) ? insert.refused : tried && isPackRefusal(tried) ? tried.refused : "the cut wasn't one edit";
      const after = options.inline(current, centre);
      if (isPackRefusal(after)) {
        left.push({ hit: p.hit, why: after.refused });
        continue;
      }
      commands.push(centre);
      placed.push(p.hit);
      onCentreLine.push({ hit: p.hit, why });
      current = after;
    }
  }
  return { commands, placed, cut, onCentreLine, left };
}

/** Distance along the leg's run from its start to the crossing's plan point, mm (the run's own length, so a gentle slope counts). */
function alongLeg(model: ModelState, leg: RouteLeg, at: Vec2): number {
  const el = model.elements[leg.segmentId];
  const { start, end } = leg.span;
  const plan = Math.hypot(end.x - start.x, end.y - start.y);
  const k = plan === 0 ? 0 : ((at.x - start.x) * (end.x - start.x) + (at.y - start.y) * (end.y - start.y)) / (plan * plan);
  const length = el?.kind === "run_segment" ? Math.hypot(el.end.x - el.start.x, el.end.y - el.start.y, el.end.z - el.start.z) : plan;
  return Math.round(k * length * 1000) / 1000;
}

function centreLinePart(p: PlannedCrossing, partId: string): CrossingPlaceCommand {
  const { span } = p.leg;
  const angle = (Math.atan2(span.end.y - span.start.y, span.end.x - span.start.x) * 180) / Math.PI;
  return {
    type: "place_part",
    partId,
    typeId: p.placement.typeId,
    levelId: span.levelId,
    position: p.hit.at,
    offsetMm: Math.round(((span.bottomMm + span.topMm) / 2) * 1000) / 1000,
    rotationDeg: Math.round(angle * 1000) / 1000,
    ...(p.placement.values && Object.keys(p.placement.values).length > 0 ? { values: p.placement.values } : {}),
  };
}

/** `insertPartOnRun`'s batch with the add-on's values on its `place_part` step. */
function withPlacementValues(command: Command | undefined, placement: CrossingPlacement): EditBatchCommand | null {
  if (command?.type !== "batch_edits") return null;
  const values = placement.values && Object.keys(placement.values).length > 0 ? placement.values : null;
  if (!values) return command;
  return { ...command, commands: command.commands.map((step) => (step.type === "place_part" ? { ...step, values } : step)) };
}

/**
 * The route and what Finish puts at its crossings as one edit (one revision,
 * one undo step): the route first, then each crossing's steps. Null when there
 * is nothing to add, or too many steps for one batch (send them one by one).
 */
export function routeFinishBatch(route: { readonly type: string }, plan: RouteFinishPlan, label?: string): EditBatchCommand | null {
  if (plan.commands.length === 0) return null;
  const steps: unknown[] = [];
  for (const c of [route, ...plan.commands]) {
    if (isEditBatchCommand(c)) steps.push(...c.commands);
    else steps.push(c);
  }
  if (steps.length > MAX_EDIT_BATCH_STEPS) return null;
  const parsed = editBatchCommandSchemas[0].safeParse({ type: "batch_edits", ...(label ? { label } : {}), commands: steps });
  return parsed.success ? parsed.data : null;
}

/** The preview's lines for a route being drawn, one per place a leg meets a rule, in the add-on's words; keyed for a list. */
export function routeCheckLines(legs: readonly RouteLegCheck[]): readonly { readonly key: string; readonly message: string; readonly at: Vec2; readonly segmentId: ElementId }[] {
  const out: { key: string; message: string; at: Vec2; segmentId: ElementId }[] = [];
  for (const leg of legs) {
    if (leg.refused) out.push({ key: `${leg.segmentId}\u0000refused`, message: `This piece couldn't be checked: ${leg.refused}`, at: leg.span.start, segmentId: leg.segmentId });
    for (const hit of leg.hits) out.push({ key: `${leg.segmentId}\u0000${hit.ruleId}\u0000${hit.hostId}`, message: hit.message, at: hit.at, segmentId: leg.segmentId });
  }
  return out;
}

/** What Finish did at the crossings, in words for the hint ("Placed a <what the add-on places> at the <element>"); null when the route met nothing. */
export function routeFinishWords(model: ModelState, plan: RouteFinishPlan): string | null {
  const parts: string[] = [];
  const label = (hit: RouteConstraintHit, kind: string) => {
    const rule = routeConstraintsFor(kind).find((r) => r.id === hit.ruleId);
    return rule?.form === "crossing" ? rule.requires.label : (rule?.label.toLowerCase() ?? "what the rule needs");
  };
  const kindOf = (hit: RouteConstraintHit) => (hit.routeId ? (model.elements[hit.routeId]?.kind ?? "run_segment") : "run_segment");
  const cut = new Set(plan.cut);
  const centre = new Map(plan.onCentreLine.map((c) => [c.hit, c.why] as const));
  const one = (h: RouteConstraintHit) => {
    const at = `a ${label(h, kindOf(h))} at the ${boundingElementWords(model.elements, h.hostId)}`;
    if (cut.has(h)) return `${at}, cut into the run`;
    const why = centre.get(h);
    return why ? `${at} on the run's centre line, not cut in (${why})` : at;
  };
  if (plan.placed.length > 0) parts.push(`Placed ${plan.placed.map(one).join("; ")}.`);
  if (plan.left.length > 0) parts.push(`On the Checklist (Select / Fix): ${plan.left.map(({ hit, why }) => `${hit.message} (${why})`).join("; ")}.`);
  return parts.length > 0 ? parts.join(" ") : null;
}
