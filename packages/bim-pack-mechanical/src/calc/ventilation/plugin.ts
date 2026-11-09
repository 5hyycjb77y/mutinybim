import { asElementId } from "@permitzip/bim-kernel";
import { to } from "@permitzip/bim-units";
import { z } from "zod";
import { defineCalc, type CalcIssue, type CalcStep, type CalcValue, type Citation } from "@permitzip/bim-calc";
import { VentilationEngine } from "./engine";
import { registeredVentilationReader, ventilationZoneText, VENTILATION_NOT_LOADED, VENTILATION_STANDARD_IDS, type VentilationCite, type VentilationScope } from "./kernel-seam";
import { resolveGoverningStandard, VENTILATION_PACK_VERSION, VENTILATION_STANDARDS } from "./standards";

/**
 * The ventilation table on the calc plugin interface, for the agent and
 * anything else that runs calcs by id: the same engine the fields, the panel
 * and the sheet block read, with the common run envelope (citations, steps,
 * issues, a run key over the inputs, the plugin version and the model
 * revision).
 */

const input = z
  .object({
    scope: z.enum(["model", "level", "zone"]).default("model").describe("model: every space. level: the spaces on level_id. zone: the spaces in zone_id."),
    level_id: z.string().min(1).max(200).optional(),
    zone_id: z.string().min(1).max(200).optional(),
    governing: z.enum(VENTILATION_STANDARD_IDS).optional().describe("Mark this standard governing instead of the adopted code."),
    state: z.string().length(2).optional().describe("Two-letter state; its adopted mechanical code governs when no project code is given."),
    project_mechanical_code: z.object({ code_name: z.string().min(1).max(120), edition: z.string().min(1).max(40), status: z.enum(["confirmed", "unconfirmed"]) }).strict().optional().describe("The project's adopted mechanical code from its Code Study."),
  })
  .strict()
  .refine((v) => v.scope !== "level" || v.level_id !== undefined, { message: "Give level_id for scope level." })
  .refine((v) => v.scope !== "zone" || v.zone_id !== undefined, { message: "Give zone_id for scope zone." });

const asCitation = (c: VentilationCite): Citation => ({ source: "code", code: c.code, edition: c.edition, clause: c.clause, text: c.text });

export const ventilationOutdoorAirCalc = defineCalc({
  id: "mech.ventilation_outdoor_air",
  version: VENTILATION_PACK_VERSION,
  domain: "mechanical",
  title: "Outdoor air and exhaust per space and zone (IMC 403.3.1.1 and ASHRAE 62.1)",
  summary: "Breathing-zone outdoor air Vbz = Rp·Pz + Ra·Az, zone outdoor air Voz = Vbz / Ez and area exhaust for every space in the scope, under IMC and ASHRAE 62.1 side by side with one marked governing, and each zone's total against its serving unit's outdoor air. Spaces that can't be calculated say why.",
  codeFamily: null,
  needsModel: true,
  input,
  example: { scope: "model" },
  run: (args, ctx) => {
    const registered = registeredVentilationReader();
    if (!(registered instanceof VentilationEngine) || !ctx.model) return { values: [], steps: [], issues: [{ severity: "error", message: VENTILATION_NOT_LOADED, cite: [] }], detail: null };
    const pc = args.project_mechanical_code;
    const governing = resolveGoverningStandard({ ...(args.governing ? { asked: args.governing } : {}), ...(pc ? { projectAdoption: { codeName: pc.code_name, edition: pc.edition, status: pc.status } } : {}), ...(args.state ? { state: args.state } : {}) });
    const engine = registered.withGoverning(governing);
    const scope: VentilationScope = args.scope === "level" ? { kind: "level", levelId: asElementId(args.level_id ?? "") } : args.scope === "zone" ? { kind: "zone", zoneId: asElementId(args.zone_id ?? "") } : { kind: "model" };
    const table = engine.table(ctx.model.elements, scope);
    const exhaust = table.totals[governing.standard].exhaust;
    const cites = [...new Map(table.spaces.flatMap((s) => s.standards[governing.standard].cites).map((c) => [c.text, asCitation(c)])).values()];
    const values: CalcValue[] = [
      { key: "governing", label: "Governing standard", value: VENTILATION_STANDARDS[governing.standard].label, unit: null, cite: [] },
      ...VENTILATION_STANDARD_IDS.map((id): CalcValue => {
        const t = table.totals[id];
        return { key: `${id}_oa_cfm`, label: `Outdoor air, ${VENTILATION_STANDARDS[id].label} (Σ Voz)`, value: t.voz === null ? null : Math.round(to(t.voz, "cfm") * 100) / 100, unit: "cfm", cite: cites };
      }),
      { key: "exhaust_cfm", label: "Area exhaust", value: exhaust === null ? null : Math.round(to(exhaust, "cfm") * 100) / 100, unit: "cfm", cite: cites },
      { key: "spaces", label: "Spaces", value: table.spaces.length, unit: null, cite: [] },
    ];
    const steps: CalcStep[] = [
      { label: "Governing standard", detail: governing.text, cite: [] },
      ...table.spaces.flatMap((s): CalcStep[] => {
        const g = s.standards[governing.standard];
        return g.arithmetic ? [{ label: s.label, detail: `${g.arithmetic}${to(g.ez.value, "1") === 1 ? "" : `; Voz = Vbz / ${to(g.ez.value, "1")}`}`, cite: g.cites.map(asCitation) }] : [];
      }),
      ...table.zones.map((z): CalcStep => ({ label: z.name, detail: ventilationZoneText(z), cite: [] })),
    ];
    const issues: CalcIssue[] = [
      ...(table.empty ? [{ severity: "warning" as const, message: table.empty, cite: [] }] : []),
      ...table.spaces.flatMap((s): CalcIssue[] => {
        const g = s.standards[governing.standard];
        return g.status === "missing" ? [{ severity: "warning", message: `${s.label}: ${g.reasons.join(" ")}`, cite: [] }] : [];
      }),
      ...table.zones.flatMap((z): CalcIssue[] => (z.servedBy?.comparison === "short" ? [{ severity: "warning", message: `${z.name}: ${z.servedBy.mark}'s outdoor air is less than the zone needs.`, cite: [] }] : [])),
    ];
    return { values, steps, issues, detail: table };
  },
});

export const VENTILATION_CALCS = [ventilationOutdoorAirCalc] as const;
