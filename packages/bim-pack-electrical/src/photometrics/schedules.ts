import {
  formScheduleSupport,
  type EvaluatedForm,
  type FormScheduleDef,
  type FormScheduleDefinition,
  type FormTemplate,
  type ModelState,
  type ScheduleSource,
} from "@permitzip/bim-kernel";
import { evaluateEgressPhotometrics, evaluateNormalPhotometrics } from "./calc";

/**
 * Form schedule presets for:
 * - `photometric_summary`: Photometric Summary Schedule (Normal illuminance & LPD by space)
 * - `egress_lighting_compliance`: Emergency / Egress Lighting Compliance Schedule (NFPA 101 §7.9.2.1 / IBC §1008.3.5)
 */

const { listForm } = formScheduleSupport;

export const PHOTOMETRIC_SUMMARY_TEMPLATE: FormTemplate = {
  name: "Photometric summary",
  title: "PHOTOMETRIC SUMMARY SCHEDULE",
  header: { columns: 1, fields: [] },
  body: {
    layout: "rows",
    columns: [
      { heading: "ROOM / ZONE", value: "{room}", align: "left" },
      { heading: "LEVEL", value: "{level}", align: "center" },
      { heading: "MODE", value: "{mode}", align: "center" },
      { heading: "AREA (SF)", value: "{area_sf}", align: "right" },
      { heading: "TARGET AVG / MIN", value: "{target_fc}", align: "center" },
      { heading: "CALC AVG (FC)", value: "{calc_avg}", align: "right" },
      { heading: "CALC MIN (FC)", value: "{calc_min}", align: "right" },
      { heading: "CALC MAX (FC)", value: "{calc_max}", align: "right" },
      { heading: "MAX:MIN", value: "{max_min}", align: "center" },
      { heading: "LPD (W/SF)", value: "{lpd}", align: "right" },
      { heading: "STATUS", value: "{status}", align: "center" },
    ],
  },
  notes: [
    { mark: "1", text: "IES LM-63 point-by-point illuminance (80/50/20 reflectances, 2'-0\" grid)." },
    { mark: "2", text: "Lighting Power Density checked against ASHRAE 90.1 Space-by-Space limits." },
  ],
};

export const EGRESS_LIGHTING_COMPLIANCE_TEMPLATE: FormTemplate = {
  name: "Emergency / egress lighting compliance",
  title: "EMERGENCY / EGRESS LIGHTING COMPLIANCE SCHEDULE",
  header: { columns: 1, fields: [] },
  body: {
    layout: "rows",
    columns: [
      { heading: "EGRESS PATH / ZONE", value: "{path}", align: "left" },
      { heading: "LEVEL", value: "{level}", align: "center" },
      { heading: "MODE", value: "{mode}", align: "center" },
      { heading: "TARGET AVG / MIN", value: "{target_fc}", align: "center" },
      { heading: "INIT AVG / MIN (FC)", value: "{init_fc}", align: "right" },
      { heading: "90-MIN AVG / MIN (FC)", value: "{end90_fc}", align: "right" },
      { heading: "CALC MAX (FC)", value: "{calc_max}", align: "right" },
      { heading: "MAX:MIN", value: "{max_min}", align: "center" },
      { heading: "STATUS", value: "{status}", align: "center" },
    ],
  },
  notes: [
    { mark: "1", text: "NFPA 101 §7.9.2.1 / IBC §1008.3.5 (0\" AFF): Init ≥1.0/0.1 fc; 90m ≥0.6/0.06 fc; ≤40:1." },
    { mark: "2", text: "Direct-only emergency calc; integral battery packs derated to 60% at 90 minutes." },
  ],
};

export function evaluatePhotometricSummarySchedule(
  model: ModelState,
  def: FormScheduleDefinition,
): EvaluatedForm {
  const result = evaluateNormalPhotometrics(model, { gridSpacingFt: 2, interReflectance: true });
  const rows = result.spaces.map((sp) => {
    const label = sp.number ? `${sp.number} ${sp.name}` : sp.name;
    const map: Readonly<Record<string, string>> = {
      room: label,
      level: sp.levelName,
      mode: `Normal (${sp.workplaneHeightIn}\" AFF)`,
      area_sf: sp.areaSqFt.toFixed(0),
      target_fc: `${sp.target.targetAvgFc < 1 ? sp.target.targetAvgFc.toFixed(1) : sp.target.targetAvgFc.toFixed(0)} / ${sp.target.targetMinFc < 1 ? sp.target.targetMinFc.toFixed(1) : sp.target.targetMinFc.toFixed(0)} fc`,
      calc_avg: sp.avgFc.toFixed(1),
      calc_min: sp.minFc.toFixed(1),
      calc_max: sp.maxFc.toFixed(1),
      max_min: `${sp.maxMinRatio.toFixed(1)}:1`,
      lpd: `${sp.lpdWPerSqFt.toFixed(2)} / ${sp.target.maxLpdWPerSqFt.toFixed(2)}`,
      status: sp.pass ? "PASS" : "FAIL",
    };
    return {
      ids: [sp.spaceId],
      value: (path: string) => map[path] ?? "",
    };
  });
  return listForm(model, def, rows);
}

export function evaluateEgressComplianceSchedule(
  model: ModelState,
  def: FormScheduleDefinition,
): EvaluatedForm {
  const result = evaluateEgressPhotometrics(model, { gridSpacingFt: 2, workplaneHeightIn: 0 });
  const T = result.thresholds;
  const rows = result.paths.map((p) => {
    const map: Readonly<Record<string, string>> = {
      path: p.name,
      level: p.levelName,
      mode: "Emergency (0\" AFF)",
      target_fc: `${T.initialAvgFc.toFixed(1)} / ${T.initialMinFc.toFixed(1)} fc`,
      init_fc: `${p.avgFc.toFixed(2)} / ${p.minFc.toFixed(2)}`,
      end90_fc: `${p.avgFc90Min.toFixed(2)} / ${p.minFc90Min.toFixed(2)}`,
      calc_max: p.maxFc.toFixed(2),
      max_min: `${p.maxMinRatio.toFixed(1)}:1`,
      status: p.pass ? "PASS" : "FAIL",
    };
    return {
      ids: [p.pathId],
      value: (path: string) => map[path] ?? "",
    };
  });
  return listForm(model, def, rows);
}

const PHOTOMETRICS_SOURCE: ScheduleSource = {
  kind: "classes",
  classes: ["mep.lighting_fixture", "arch.room"],
  includeSubclasses: true,
};

export const PHOTOMETRIC_FORM_ROWS: readonly FormScheduleDef[] = [
  {
    kind: "photometric_summary",
    evaluate: evaluatePhotometricSummarySchedule,
    label: "Photometric summary schedule",
    template: PHOTOMETRIC_SUMMARY_TEMPLATE,
    source: PHOTOMETRICS_SOURCE,
    order: 56,
  },
  {
    kind: "egress_lighting_compliance",
    evaluate: evaluateEgressComplianceSchedule,
    label: "Emergency / egress lighting compliance schedule",
    template: EGRESS_LIGHTING_COMPLIANCE_TEMPLATE,
    source: PHOTOMETRICS_SOURCE,
    order: 57,
  },
];
