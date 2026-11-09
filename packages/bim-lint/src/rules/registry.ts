import type { BimElement, ElementKind, ModelState } from "@permitzip/bim-kernel";
import type { Aabb, PairMeasure } from "../geometry/convex";
import { isKnownRulePack, type Finding, type LintConfig, type LinkedModelIndex, type LinkedRef, type RulePack, type Ruleset, type Severity } from "../types";
import type { BodyRecord, Surface } from "../index-state";

/**
 * Rules are data plus a small pure function. A new rule is one file (or a
 * few lines in its pack), one line in RULES, and a golden test that fires
 * and one near miss that doesn't. Rules never edit the model and never
 * rank: they report what a deterministic test found.
 */

export type RuleScope =
  /** Runs for each of our elements in scope whose kind it lists. */
  | "element"
  /** Runs for views, sheets, viewports and diagram views the edit touched (all of them in a full check). */
  | "document"
  /** Runs for systems with an element in scope. */
  | "system"
  /** Runs only on the elements this edit changed, comparing them with how they were. */
  | "edit";

export interface RuleContext {
  readonly model: ModelState;
  readonly config: LintConfig;
  readonly linked: readonly LinkedModelIndex[];
  /** The model before the edit (edit-scope rules only). */
  readonly previous: ModelState | null;
  /** Elements the edit changed (empty in a full check): pair findings are worded from their side. */
  readonly changed: ReadonlySet<string>;
  /** When set, clash pairs are measured only from these elements (see LintScope.pairsFrom). */
  readonly pairsFrom: ReadonlySet<string> | null;
  /** True when an agent made the edit being linted. */
  readonly editedByAgent: boolean;
  /** Project name the title block should print, when the caller knows it. */
  readonly projectName: string | null;
  body(id: string): BodyRecord | undefined;
  /** Bodies (ours and linked) whose boxes meet `box`. */
  bodiesNear(box: Aabb): BodyRecord[];
  /** Like bodiesNear, without linked bodies that are never clash obstacles (spaces, openings, ceilings, furniture). */
  obstaclesNear(box: Aabb): BodyRecord[];
  /** Surfaces (slabs, roofs, spaces, rooms) whose plan footprint contains the point. */
  surfacesAt(x: number, y: number): Surface[];
  /** Surfaces whose box meets `box`. */
  surfacesNear(box: Aabb): Surface[];
  /** Run elements (segments, fittings) of a system, and the parts they connect. */
  systemMembers(systemId: string): readonly string[];
  /** Clash measurements already made for this pair (to this far distance), kept until either element changes. */
  measured(a: string, b: string, far: number): PairMeasure | undefined;
  remember(a: string, b: string, far: number, m: PairMeasure): void;
  /** Our ceiling components (hosts for ceiling terminals). */
  nativeCeilings(): readonly string[];
  /** True when two of our elements are joined by a link, or both join the same fitting or segment (they meet by design). */
  joined(a: string, b: string): boolean;
  levelNameOf(el: BimElement): string;
  /** Floor elevation of one of our levels by name (exact or normalised), or null. */
  elevationOfLevel(name: string): number | null;
  name(id: string): string;
  emit(f: Omit<Finding, "id" | "elementIds"> & { readonly elementIds: readonly string[]; readonly linked?: readonly LinkedRef[] }): void;
}

export interface AvailabilityContext {
  readonly model: ModelState;
  readonly linked: readonly LinkedModelIndex[];
  readonly hasNativeCeilings: boolean;
}

export interface RuleDef {
  readonly id: string;
  readonly version: number;
  readonly pack: RulePack;
  readonly severity: Severity;
  /** Plain words: what it flags. */
  readonly title: string;
  readonly scope: RuleScope;
  readonly kinds?: readonly ElementKind[];
  /**
   * Other kinds the rule reads (a column rule that reads the footing under
   * it). When an edit changes one, the rule re-runs on every element it
   * lints, not only those near the edit, so a deleted footing re-flags its
   * column. Element-scope rules only.
   */
  readonly reads?: readonly ElementKind[];
  /**
   * The rule only reports clash pairs measured from the element (see
   * RuleContext.pairsFrom), so when `pairsFrom` is set it has nothing to say
   * about an element outside it and the engine doesn't call it there.
   */
  readonly pairsOnly?: boolean;
  /**
   * Where the rule runs among the others, lower first (built-in groups are
   * 100–1200 in steps of 100). A rule without one runs after every ranked
   * rule, in the order it was contributed.
   */
  readonly rank?: number;
  /** Null when it can run on this model; else why it can't yet (shown as "not available"). */
  available?(ctx: AvailabilityContext): string | null;
  run(ctx: RuleContext, el: BimElement): void;
}

/** Which packs each ruleset runs. */
export const RULESET_PACKS: Readonly<Record<Ruleset, readonly RulePack[]>> = {
  default: ["coordination", "placement", "clearance", "systems", "documents", "electrical"],
  coordination: ["coordination", "placement", "clearance"],
  documents: ["documents"],
  issue: ["coordination", "placement", "clearance", "systems", "documents", "electrical", "process"],
};

/** Rulesets that also run every add-on pack's rules (a pack's `pack` is its namespace, never a built-in pack). */
const RULESETS_WITH_PACK_RULES: ReadonlySet<Ruleset> = new Set<Ruleset>(["default", "issue"]);

export function rulesFor(rules: readonly RuleDef[], config: Pick<LintConfig, "ruleset" | "disabled_rules">): RuleDef[] {
  const packs = new Set<string>(RULESET_PACKS[config.ruleset]);
  const withPackRules = RULESETS_WITH_PACK_RULES.has(config.ruleset);
  const off = new Set(config.disabled_rules);
  return rules.filter((r) => (packs.has(r.pack) || (withPackRules && !isKnownRulePack(r.pack))) && !off.has(r.id));
}

const MAX_ID = 160;

/** Stable finding id: rule plus sorted ids (ours, then linked GlobalIds); long ones are shortened deterministically. */
export function findingId(rule: string, elementIds: readonly string[], linked: readonly LinkedRef[] = []): string {
  const parts = [...[...elementIds].sort(), ...linked.map((l) => `linked:${l.globalId}`).sort()];
  const id = `${rule}:${parts.join("|")}`;
  if (id.length <= MAX_ID) return id;
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${id.slice(0, MAX_ID - 10)}#${(h >>> 0).toString(16)}`;
}
