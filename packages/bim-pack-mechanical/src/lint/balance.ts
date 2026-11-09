import type { BimElement } from "@permitzip/bim-kernel";
import { clip, feet, type RuleContext, type RuleDef } from "@permitzip/bim-lint";
import { netCfm, pressurizationOf, signedCfm, signedContributorCfm, type PressurizationReport } from "../balance/pressurization";

/**
 * Building pressurization (ROADMAP M1 on F9's balance; balance/pressurization.ts): exhaust out, makeup air and outdoor air in, per zone and for
 * the building, against the design targets the host registers from the space-use
 * library (kitchens negative, dining positive, building slightly positive).
 *
 *   zone-pressure-off-target       a zone positive where it should be negative (or the reverse)
 *   building-pressure-off-target   the building's net against its slightly positive target, contributors named
 *   pressurization-airflow-missing an exhaust fan, MUA or unit with no airflow typed (no net can be given)
 *   makeup-air-tempering-unknown   makeup air whose tempering or design temperatures aren't stated
 *
 * One report per model state (the kernel keeps it), so every rule here is a
 * lookup. Models with nothing that moves air in or out get nothing.
 */

const WHOLE = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function report(ctx: RuleContext): PressurizationReport {
  return pressurizationOf(ctx.model.elements);
}

function atPart(ctx: RuleContext, el: BimElement) {
  const body = ctx.body(el.id);
  const c = body ? { x: (body.box.min.x + body.box.max.x) / 2, y: (body.box.min.y + body.box.max.y) / 2, z: body.box.min.z } : { x: 0, y: 0, z: 0 };
  return { level: ctx.levelNameOf(el), x_ft: feet(c.x), y_ft: feet(c.y), z_ft: feet(c.z) };
}

/** "kitchens are kept negative to the dining room" from "102 Kitchen: kitchens are kept negative to the dining room so … (cite)". */
function targetClause(why: string): string {
  const afterLabel = why.includes(": ") ? why.slice(why.indexOf(": ") + 2) : why;
  return afterLabel.split(/ so | \(|\. /)[0]?.replace(/\.$/, "") ?? afterLabel;
}

export const balanceRules: readonly RuleDef[] = [
  {
    id: "zone-pressure-off-target",
    version: 1,
    pack: "systems",
    severity: "warning",
    title: "A zone positive where it should be negative (or the reverse)",
    scope: "element",
    kinds: ["zone"],
    run: (ctx, el) => {
      const z = report(ctx).zones.find((x) => x.zoneId === el.id);
      if (!z || z.meetsTarget !== false || !z.target) return;
      const net = netCfm(z);
      if (net === null) return;
      const members = report(ctx).contributors.filter((c) => c.zoneIds.includes(z.zoneId));
      ctx.emit({
        rule: "zone-pressure-off-target",
        severity: "warning",
        elementIds: [z.zoneId, ...members.map((c) => c.partId)],
        at: { level: ctx.levelNameOf(el), x_ft: 0, y_ft: 0, z_ft: 0 },
        message: clip(`${z.name} is ${signedCfm(net)} cfm ${z.state}; ${targetClause(z.target.why)}`),
        fix: { tool: "bim_set_parameters", hint: clip(`change ${members.map((c) => c.label).join(", ") || "its exhaust or makeup air"} so the zone is ${z.target.target}`, 120) },
      });
    },
  },
  {
    id: "building-pressure-off-target",
    version: 1,
    pack: "systems",
    severity: "warning",
    title: "The building's net air against its slightly positive target",
    scope: "element",
    kinds: ["part"],
    run: (ctx, el) => {
      const r = report(ctx);
      // One finding for the building, reported on its first contributor.
      if (r.contributors[0]?.partId !== el.id) return;
      const b = r.building;
      if (b.meetsTarget !== false || !b.target) return;
      const net = netCfm(b);
      if (net === null) return;
      const named = r.contributors.map((c) => `${c.label} ${signedCfm(signedContributorCfm(c) ?? 0)}`).join("; ");
      const word = b.state === "neutral" ? "neutral" : `${b.state} by ${WHOLE.format(Math.abs(Math.round(net)))} cfm`;
      ctx.emit({
        rule: "building-pressure-off-target",
        severity: "warning",
        elementIds: r.contributors.map((c) => c.partId),
        at: atPart(ctx, el),
        message: clip(`Building is ${word} (target ${b.target.target}): ${named}`),
        fix: { tool: "bim_set_parameters", hint: "raise makeup or outdoor air, or lower exhaust, until the building is slightly positive" },
      });
    },
  },
  {
    id: "pressurization-airflow-missing",
    version: 1,
    pack: "systems",
    severity: "info",
    title: "An exhaust fan, makeup air unit or unit with no airflow typed",
    scope: "element",
    kinds: ["part"],
    run: (ctx, el) => {
      const c = report(ctx).contributors.find((x) => x.partId === el.id);
      if (!c || c.value !== null) return;
      ctx.emit({
        rule: "pressurization-airflow-missing",
        severity: "info",
        elementIds: [el.id],
        at: atPart(ctx, el),
        message: clip(`${c.missing ?? `${c.label} has no airflow.`} Until then the building's pressurization can't be added up.`),
        fix: { tool: "bim_set_parameters", hint: clip(`set ${c.via} on ${c.label}`, 120) },
      });
    },
  },
  {
    id: "makeup-air-tempering-unknown",
    version: 1,
    pack: "systems",
    severity: "info",
    title: "Makeup air whose tempering or design temperatures aren't stated",
    scope: "element",
    kinds: ["part"],
    run: (ctx, el) => {
      const h = report(ctx).heat.find((x) => x.partId === el.id);
      if (!h || !h.missing || h.heat) return;
      ctx.emit({
        rule: "makeup-air-tempering-unknown",
        severity: "info",
        elementIds: [el.id],
        at: atPart(ctx, el),
        message: clip(h.missing),
        fix: { tool: "bim_set_parameters", hint: "set makeup_air_tempering and, if untempered, tempering_from_temp / tempering_to_temp (°F)" },
      });
    },
  },
];
