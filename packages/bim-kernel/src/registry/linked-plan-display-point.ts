import { defineExtensionPoint } from "../packs/contract";
import { activePackSet } from "../packs/scope";
import type { PackSet } from "../packs/set";

/**
 * How a linked model's categories show in plans and ceiling plans
 * (`kernel.linked_plan_display` v1). The kernel owns the one rule (which part
 * of the view range an element falls in: cut, below the cut, above it); each
 * add-on says, for the IFC entities its trade owns, what a plan draws in each
 * part. A category no row names is not drawn. Linked elements stay read-only:
 * this decides linework only.
 */

export interface LinkedPlanDisplayRow {
  /** One row per category group (a pack's `zz.louvers`). */
  readonly id: string;
  readonly label: string;
  /** IFC entity names, upper case as the file spells them (IFCWALL). */
  readonly ifcEntities: readonly string[];
  /** body: cut where the plane passes through, the outline of its upper faces elsewhere. symbol: the exporter's 2D plan symbol, its body when the file has none. */
  readonly drawAs: "body" | "symbol";
  /** Drawn where the cut plane passes through it. */
  readonly cut: boolean;
  /** Drawn wholly below the cut plane, down to the view's bottom less its depth. */
  readonly below: boolean;
  /** Floor plans: drawn wholly above the cut plane, up to the view's top. */
  readonly above: boolean;
  /** Ceiling plans (looking up from the cut): drawn where cut (when `cut`) and above the cut, up to the view's top. */
  readonly ceilingPlan: boolean;
  /** Its upward faces hide linework beneath it. Default true; false for what everything stands on. */
  readonly occludes?: boolean;
  /** Left out at Coarse detail. */
  readonly hideAtCoarse?: boolean;
}

export const LINKED_PLAN_DISPLAY_POINT = defineExtensionPoint<LinkedPlanDisplayRow>({
  id: "kernel.linked_plan_display",
  version: 1,
  label: "Linked model categories in plans",
  idOf: (row) => row.id,
});

const IFC_ENTITY = /^IFC[A-Z0-9]{2,60}$/;

/** Problems with linked plan display rows (pack conformance), in words. */
export function linkedPlanDisplayRowProblems(rows: readonly LinkedPlanDisplayRow[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) out.push(`linked plan display ${row.id} is declared twice`);
    seen.add(row.id);
    if (row.label.trim().length === 0) out.push(`linked plan display ${row.id} has no label`);
    if (row.ifcEntities.length === 0) out.push(`linked plan display ${row.id} names no IFC entity`);
    for (const e of row.ifcEntities) if (!IFC_ENTITY.test(e)) out.push(`linked plan display ${row.id}: "${e}" is not an upper-case IFC entity name such as IFCWALL`);
  }
  return out;
}

/** One entity's resolved rule: plain data, so a server can send it to the cut and key a cache by it. */
export interface LinkedPlanRule {
  readonly drawAs: "body" | "symbol";
  readonly cut: boolean;
  readonly below: boolean;
  readonly above: boolean;
  readonly ceilingPlan: boolean;
  readonly occludes: boolean;
  readonly hideAtCoarse: boolean;
}

export interface LinkedPlanDisplay {
  /** By IFC entity name. The first row to name an entity wins (built-in order, then first-party order). */
  readonly rules: Readonly<Record<string, LinkedPlanRule>>;
  /** Changes whenever any rule does: part of every cached cut's key. */
  readonly fingerprint: string;
}

function ruleOf(row: LinkedPlanDisplayRow): LinkedPlanRule {
  return { drawAs: row.drawAs, cut: row.cut, below: row.below, above: row.above, ceilingPlan: row.ceilingPlan, occludes: row.occludes !== false, hideAtCoarse: row.hideAtCoarse === true };
}

/** FNV-1a over the canonical rule text: short, stable, no crypto needed. */
function fingerprintOf(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function build(set: PackSet): LinkedPlanDisplay {
  return linkedPlanDisplayOf(set.items(LINKED_PLAN_DISPLAY_POINT));
}

/** The display these rows make, in order (the first row to name an entity wins). */
export function linkedPlanDisplayOf(rows: readonly LinkedPlanDisplayRow[]): LinkedPlanDisplay {
  const rules: Record<string, LinkedPlanRule> = {};
  for (const row of rows) {
    const rule = ruleOf(row);
    for (const e of row.ifcEntities) if (!(e in rules)) rules[e] = rule;
  }
  const canonical = Object.keys(rules)
    .sort()
    .map((e) => `${e}=${JSON.stringify(rules[e])}`)
    .join(";");
  return { rules, fingerprint: fingerprintOf(canonical) };
}

/** The linked plan display of the set in force (built once per set). */
export function linkedPlanDisplay(set: PackSet = activePackSet()): LinkedPlanDisplay {
  return set.memo("kernel.linked_plan_display#rules", build);
}

/** Where an element sits in a plan's view range, absolute heights in one frame (mm). */
export interface LinkedPlanRange {
  /** The cut plane. */
  readonly cutMm: number;
  /** The lowest height the view shows (its bottom less its depth). */
  readonly lowMm: number;
  /** The highest height the view shows (its top); Infinity when it sets none. */
  readonly highMm: number;
  /** A ceiling plan: looking up from the cut, so only what is cut or above it shows. */
  readonly lookingUp: boolean;
  readonly detail: "coarse" | "medium" | "fine";
}

export type LinkedPlanPlacement = "cut" | "below" | "above" | "skip";

/**
 * The one view-range rule for a linked element: outside the range is skipped;
 * inside, the element is cut, below or above the cut, and its category's rule
 * says whether that part is drawn.
 */
export function linkedPlanPlacement(rule: LinkedPlanRule | undefined, minZ: number, maxZ: number, range: LinkedPlanRange): LinkedPlanPlacement {
  if (!rule) return "skip";
  if (range.detail === "coarse" && rule.hideAtCoarse) return "skip";
  if (maxZ < range.lowMm || minZ > range.highMm) return "skip";
  const cut = minZ < range.cutMm && maxZ > range.cutMm;
  const below = !cut && maxZ <= range.cutMm;
  if (range.lookingUp) {
    // Looking up, a category shows where it is cut or above; nothing below the cut is seen.
    if (!rule.ceilingPlan || below) return "skip";
    return cut ? (rule.cut ? "cut" : "skip") : "above";
  }
  if (cut) return rule.cut ? "cut" : "skip";
  if (below) return rule.below ? "below" : "skip";
  return rule.above ? "above" : "skip";
}
