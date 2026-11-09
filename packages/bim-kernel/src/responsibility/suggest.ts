/**
 * "Take responsibility for this" starts from the part's own levels and
 * systems (round 9 lane B9): the scope that selects exactly the levels and
 * the networks the waiting part's changes sit on, so taking a part doesn't
 * silently take the whole discipline. The person can still widen or narrow it.
 *
 * Generic: levels are partition levels, systems are what the coverage context
 * says an element belongs to (a network id, else a service id). A selector
 * with more values than a person could check at a glance is left out (the
 * suggestion is then broader, never narrower than the part).
 */
import { GLOBAL_LEVEL } from "../partition";
import type { BimElement, ModelState } from "../types";
import type { CoverageContext, ResponsibilityScope } from "./types";

/** Most values one suggested selector lists; beyond it the selector is dropped. */
export const SUGGESTED_SCOPE_MAX = 12;

export interface SuggestedScope {
  readonly scope: ResponsibilityScope;
  /** What a person reads: "Level 2 and Level 3; systems SA-1 and RA-1". Empty scope: "all of it". */
  readonly words: string;
}

function list(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function nameOf(model: Pick<ModelState, "elements">, id: string): string {
  const el = model.elements[id];
  const name: unknown = el && "name" in el ? Reflect.get(el, "name") : undefined;
  return typeof name === "string" && name.trim() !== "" ? name : id;
}

/** The levels and systems the part's elements sit on, as a scope and in words. */
export function suggestedScopeFor(elements: readonly BimElement[], ctx: Pick<CoverageContext, "systemsOf">, model: Pick<ModelState, "elements">): SuggestedScope {
  const levels = new Set<string>();
  const systems = new Set<string>();
  for (const el of elements) {
    const level = el.partition?.level;
    if (level && level !== GLOBAL_LEVEL) levels.add(level);
    // The element's own network first (its first value); a service id only when it has no network.
    const own = ctx.systemsOf(el)[0];
    if (own) systems.add(own);
  }
  const scope: { levels?: string[]; systems?: string[] } = {};
  if (levels.size > 0 && levels.size <= SUGGESTED_SCOPE_MAX) scope.levels = [...levels].sort();
  if (systems.size > 0 && systems.size <= SUGGESTED_SCOPE_MAX) scope.systems = [...systems].sort();
  const parts: string[] = [];
  if (scope.levels) parts.push(list(scope.levels));
  if (scope.systems) parts.push(`${scope.systems.length === 1 ? "system" : "systems"} ${list(scope.systems.map((s) => nameOf(model, s)))}`);
  return { scope, words: parts.length > 0 ? parts.join("; ") : "all of it" };
}
