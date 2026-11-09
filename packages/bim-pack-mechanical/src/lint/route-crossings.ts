import type { BimElement } from "@permitzip/bim-kernel";
import { checkRouteLegs, type RouteConstraintHit, type RouteLegCheck } from "@permitzip/bim-kernel/rated-routes";
import { clip, feet, type RuleContext, type RuleDef } from "@permitzip/bim-lint";
import { MECHANICAL_ROUTE_RULES } from "../constraints/rated-crossings";

/**
 * Round 14 lane M14: Mechanical's route rules as Checklist findings, on the
 * duct pieces an edit touched (element scope: the engine calls a rule only
 * for elements in the edit's region, never the whole model).
 *
 *   duct-rated-crossing     a duct crosses a rated wall or smoke barrier with no damper there
 *   duct-ceiling-clearance  a ceiling, soffit or step comes within the clearance of a duct's top
 *
 * Select: the duct and what it meets. Fix: place the damper (bim_place_part),
 * or drop the run. Findings use the add-on's default clearance until the
 * lint context carries the firm's and project's design limits.
 */

const CROSSING_RULE_IDS: ReadonlySet<string> = new Set(MECHANICAL_ROUTE_RULES.filter((r) => r.form === "crossing").map((r) => r.id));
const NEEDS: ReadonlyMap<string, string> = new Map(MECHANICAL_ROUTE_RULES.flatMap((r) => (r.form === "crossing" ? [[r.id, r.requires.label] as const] : [])));
const CLEARANCE_RULE_IDS: ReadonlySet<string> = new Set(MECHANICAL_ROUTE_RULES.filter((r) => r.form === "clearance").map((r) => r.id));

function legOf(ctx: RuleContext, el: BimElement): RouteLegCheck | undefined {
  return checkRouteLegs(ctx.model, [el.id])[0];
}

function at(ctx: RuleContext, el: BimElement, leg: RouteLegCheck, hit: RouteConstraintHit) {
  return { level: ctx.levelNameOf(el), x_ft: feet(hit.at.x), y_ft: feet(hit.at.y), z_ft: feet((leg.span.bottomMm + leg.span.topMm) / 2) };
}

export const DUCT_RATED_CROSSING_RULE_ID = "duct-rated-crossing";
export const DUCT_CEILING_CLEARANCE_RULE_ID = "duct-ceiling-clearance";

export const routeCrossingRules: readonly RuleDef[] = [
  {
    id: DUCT_RATED_CROSSING_RULE_ID,
    version: 1,
    pack: "systems",
    severity: "warning",
    title: "A duct crosses a rated wall or smoke barrier with no damper there",
    scope: "element",
    kinds: ["run_segment"],
    run: (ctx, el) => {
      const leg = legOf(ctx, el);
      if (!leg) return;
      for (const hit of leg.hits) {
        if (!CROSSING_RULE_IDS.has(hit.ruleId)) continue;
        ctx.emit({
          rule: DUCT_RATED_CROSSING_RULE_ID,
          severity: "warning",
          elementIds: [el.id, hit.hostId],
          at: at(ctx, el, leg, hit),
          message: clip(hit.message),
          fix: { tool: "bim_place_part", hint: clip(`place a ${NEEDS.get(hit.ruleId) ?? "damper"} on the duct where it crosses ${ctx.name(hit.hostId)}`, 120) },
        });
      }
    },
  },
  {
    id: DUCT_CEILING_CLEARANCE_RULE_ID,
    version: 1,
    pack: "clearance",
    severity: "warning",
    title: "A ceiling, soffit or step comes within the clearance of a duct's top",
    scope: "element",
    kinds: ["run_segment"],
    run: (ctx, el) => {
      const leg = legOf(ctx, el);
      if (!leg) return;
      for (const hit of leg.hits) {
        if (!CLEARANCE_RULE_IDS.has(hit.ruleId)) continue;
        ctx.emit({
          rule: DUCT_CEILING_CLEARANCE_RULE_ID,
          severity: "warning",
          elementIds: [el.id, hit.hostId],
          at: at(ctx, el, leg, hit),
          // A finding holds 160 characters: the limit's source is dropped before the height to drop to is (the design limits screen names it).
          message: clip(hit.basis && hit.message.length > 160 ? hit.message.replace(` (${hit.basis.source})`, "") : hit.message),
          fix: { tool: "bim_move_elements", hint: "drop the run (or that piece) to the height the message gives" },
        });
      }
    },
  },
];
