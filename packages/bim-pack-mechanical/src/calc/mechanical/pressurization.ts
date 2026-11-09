import { asElementId } from "@permitzip/bim-kernel";
import { to } from "@permitzip/bim-units";
import { z } from "zod";
import { criteriaCite, defineCalc, round, type CalcIssue, type CalcStep, type CalcValue, type Citation } from "@permitzip/bim-calc";
import { AIR_ROLE_WORDS, pressurizationOf, pressurizationScopeZones, signedCfm, type PressurizationScope } from "../../balance/pressurization";
import { pressurizationZoneText } from "../../blocks/pressurization-table";
import { makeupAirHeatCalc, SENSIBLE_HEAT_CITE } from "./makeup-air";

/**
 * Building pressurization on the calc plugin interface (ROADMAP M1 on F9's
 * balance): exhaust out, makeup air and outdoor air in, per zone and for the
 * building, each against its design target, plus the makeup-air load on the
 * unit that serves it. The kernel reads the model (balance/pressurization.ts);
 * this adds the run envelope, citations and issues an agent can act on.
 */

export const PRESSURIZATION_CALC_VERSION = "1.0.0";

const input = z
  .object({
    scope: z.enum(["model", "level", "zone"]).default("model").describe("model: every zone and the building. level: the zones with a space on level_id. zone: zone_id only."),
    level_id: z.string().min(1).max(200).optional(),
    zone_id: z.string().min(1).max(200).optional(),
  })
  .strict()
  .refine((v) => v.scope !== "level" || v.level_id !== undefined, { message: "Give level_id for scope level." })
  .refine((v) => v.scope !== "zone" || v.zone_id !== undefined, { message: "Give zone_id for scope zone." });

const BALANCE_CITE: Citation = { source: "method", code: "Air balance", edition: null, clause: "Σ makeup air + Σ outdoor air − Σ exhaust", text: "Air balance: net = Σ makeup air + Σ outdoor air − Σ exhaust (+ positive, − negative)" };

export const pressurizationCalc = defineCalc({
  id: "mech.pressurization",
  version: PRESSURIZATION_CALC_VERSION,
  domain: "mechanical",
  title: "Building pressurization (exhaust, makeup air, outdoor air)",
  summary: "Net air per zone and for the building from the model: exhaust fans and hoods out, makeup air units and rooftop-unit outdoor air in; positive, negative or neutral against each design target (kitchen negative to dining, building slightly positive); the untempered makeup air load on the unit that serves it. Any item with no airflow typed is named and no partial total is given.",
  codeFamily: null,
  needsModel: true,
  input,
  example: { scope: "model" },
  run: (args, ctx) => {
    if (!ctx.model) return { values: [], steps: [], issues: [{ severity: "error", message: "Pressurization reads a model.", cite: [] }], detail: null };
    const elements = ctx.model.elements;
    const report = pressurizationOf(elements);
    const scope: PressurizationScope = args.scope === "level" ? { kind: "level", levelId: asElementId(args.level_id ?? "") } : args.scope === "zone" ? { kind: "zone", zoneId: asElementId(args.zone_id ?? "") } : { kind: "model" };
    const { zones, showBuilding } = pressurizationScopeZones(elements, report, scope);
    const targetCite = criteriaCite(ctx.criteria, "pressure targets: building slightly positive, kitchens negative to dining, toilet rooms negative");
    const b = report.building;
    const values: CalcValue[] = showBuilding
      ? [
          { key: "building_net_cfm", label: "Building net air (in − out)", value: b.balance.status === "complete" ? round(to(b.balance.net, "cfm"), 1) : null, unit: "cfm", cite: [BALANCE_CITE] },
          { key: "building_exhaust_cfm", label: "Exhaust", value: b.subtotals ? round(to(b.subtotals.exhaust, "cfm"), 1) : null, unit: "cfm", cite: [BALANCE_CITE] },
          { key: "building_makeup_cfm", label: "Makeup air", value: b.subtotals ? round(to(b.subtotals.makeupAir, "cfm"), 1) : null, unit: "cfm", cite: [BALANCE_CITE] },
          { key: "building_outdoor_cfm", label: "Outdoor air (units)", value: b.subtotals ? round(to(b.subtotals.outdoorAir, "cfm"), 1) : null, unit: "cfm", cite: [BALANCE_CITE] },
          { key: "building_state", label: "Building pressure", value: b.state, unit: null, cite: b.target ? [targetCite] : [] },
        ]
      : [];
    for (const z of zones) {
      values.push({ key: `zone:${z.zoneId}:net_cfm`, label: `${z.name} net air`, value: z.balance.status === "complete" ? round(to(z.balance.net, "cfm"), 1) : null, unit: "cfm", cite: [BALANCE_CITE] });
      values.push({ key: `zone:${z.zoneId}:state`, label: `${z.name} pressure`, value: z.state, unit: null, cite: z.target ? [targetCite] : [] });
    }
    const inScope = new Set(zones.map((z) => z.zoneId));
    const rows = showBuilding ? report.contributors : report.contributors.filter((c) => c.zoneIds.some((id) => inScope.has(id)));
    const steps: CalcStep[] = [
      ...rows.map((c): CalcStep => ({ label: c.label, detail: `${AIR_ROLE_WORDS[c.role]} ${c.value === null ? "—" : signedCfm(c.side === "out" ? -to(c.value, "cfm") : to(c.value, "cfm"))} cfm (from ${c.via}${c.zoneIds.length === 0 ? "; in no zone, counted for the building only" : ""})`, cite: [] })),
      ...zones.map((z): CalcStep => ({ label: z.name, detail: pressurizationZoneText(z), cite: [BALANCE_CITE] })),
      ...(showBuilding ? [{ label: "Building", detail: b.text, cite: [BALANCE_CITE] }] : []),
      ...report.heat.flatMap((h): CalcStep[] => (h.heat && rows.some((c) => c.partId === h.partId) ? [{ label: `${h.mark} makeup air load`, detail: `${h.heat.arithmetic} ${h.heat.direction}${h.servingUnits.length === 1 ? `, carried by ${h.servingUnits[0]?.mark}` : ""}`, cite: [SENSIBLE_HEAT_CITE] }] : [])),
    ];
    const issues: CalcIssue[] = [
      ...(report.empty ? [{ severity: "warning" as const, message: report.empty, cite: [] }] : []),
      ...rows.flatMap((c): CalcIssue[] => (c.value === null && c.missing ? [{ severity: "warning", message: c.missing, cite: [] }] : [])),
      ...zones.flatMap((z): CalcIssue[] => (z.meetsTarget === false && z.target ? [{ severity: "warning", message: `${z.name} is ${z.state} (${signedCfm(z.balance.status === "complete" ? to(z.balance.net, "cfm") : 0)} cfm); ${z.target.why}`, cite: [targetCite] }] : [])),
      ...zones.flatMap((z): CalcIssue[] => (z.exhaustShort && z.requiredExhaust ? [{ severity: "warning", message: `${z.name} draws less exhaust than its spaces require (${Math.round(to(z.requiredExhaust, "cfm"))} cfm).`, cite: [] }] : [])),
      ...(showBuilding && b.meetsTarget === false && b.target ? [{ severity: "warning" as const, message: `The building is ${b.state} (${b.text}); ${b.target.why}`, cite: [targetCite] }] : []),
      ...report.heat.flatMap((h): CalcIssue[] => (h.missing && rows.some((c) => c.partId === h.partId) ? [{ severity: "info", message: h.missing, cite: [] }] : [])),
    ];
    return { values, steps, issues, detail: { scope, zones, building: showBuilding ? b : null, contributors: rows, heat: report.heat } };
  },
});

export const PRESSURIZATION_CALCS = [pressurizationCalc, makeupAirHeatCalc] as const;
