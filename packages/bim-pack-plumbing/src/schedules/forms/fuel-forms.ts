import { elementValues, fieldText, formSupport, type EvaluatedForm } from "@permitzip/bim-kernel";
import type { ModelState, FormScheduleDef, FormScheduleDefinition, FormTemplate, ScheduleSource } from "@permitzip/bim-kernel";
import { gasNetwork, pressureLabel } from "../../routing/pipe/gas-zones";
import { gasBasisText, gasConnectionRows, gasFuelText, gasPipeSizeText, type GasConnectionRow } from "../../routing/pipe/gas-connections";

const { COLLATOR, listForm, options } = formSupport;

/** The fuel gas form schedules (equipment, connections): rows of `FORM_SCHEDULE_POINT` the Plumbing and gas pack contributes. */

// ------------------------------------------------------------------ gas equipment

const btuh = (mbh: number) => Math.round(mbh * 1000).toLocaleString("en-US");

/**
 * Every gas appliance on every gas system, one row per ID and input (two K09
 * fryers are one row, quantity 2), with the regulator whose zone it is on and
 * that regulator's vent, and the grand total input. From the gas zones walk,
 * so it is the same input the sizing reads.
 */
function evaluateGasEquipment(model: Pick<ModelState, "elements">, def: FormScheduleDefinition): EvaluatedForm {
  const elements = model.elements;
  const groups = new Map<string, { ids: string[]; mark: string; description: string; mbh: number; regulator: string; vent: string }>();
  let total = 0;
  for (const el of elementValues(elements)) {
    if (el.kind !== "mep_system" || el.systemKind !== "natural_gas") continue;
    const net = gasNetwork(model, el.id);
    if (!net) continue;
    const regs = new Map(net.regulators.map((g) => [g.elementId, g]));
    for (const a of net.appliances) {
      total += a.mbh;
      const reg = a.regulatorId ? regs.get(a.regulatorId) : undefined;
      const key = `${a.mark ?? a.elementId}\u0000${a.description}\u0000${a.mbh}`;
      const g = groups.get(key);
      if (g) g.ids.push(a.elementId);
      else groups.set(key, { ids: [a.elementId], mark: a.mark ?? "", description: a.description, mbh: a.mbh, regulator: reg ? `${reg.label}, ${pressureLabel(reg.outletInWc)}` : "", vent: reg ? reg.vent.replace(/_/g, " ") : "" });
    }
  }
  const rows = [...groups.values()].sort((a, b) => COLLATOR.compare(a.mark, b.mark));
  const value = (g: (typeof rows)[number]) => (path: string) => {
    switch (path) {
      case "count":
        return String(g.ids.length);
      case "gas_id":
        return g.mark;
      case "gas_description":
        return g.description;
      case "gas_input_btuh":
        return btuh(g.mbh);
      case "gas_total_btuh":
        return btuh(g.mbh * g.ids.length);
      case "gas_regulator":
        return g.regulator;
      case "gas_vent":
        return g.vent;
      default:
        return g.ids[0] ? fieldText(elements, g.ids[0], path, options(def)) : "";
    }
  };
  const form = listForm(model, def, rows.map((g) => ({ ids: g.ids, value: value(g) })));
  return { ...form, totals: rows.length > 0 ? [{ label: "TOTAL GAS INPUT", value: `${btuh(total)} BTU/H` }] : [] };
}

// ------------------------------------------------------------------ gas connections

const mbhText = (mbh: number) => (Math.round(mbh * 100) / 100).toLocaleString("en-US", { maximumFractionDigits: 2 });

/**
 * One row per gas outlet (appliance or load point), in the order the pipe
 * reaches them: input, pressure zone, regulator, the size of the pipe that
 * feeds it, the developed length from the source along the routed pipe, and
 * the length its pipe is sized on (`gasConnectionRows`, the same walk the
 * sizing reads).
 */
function evaluateGasConnections(model: Pick<ModelState, "elements">, def: FormScheduleDefinition): EvaluatedForm {
  const elements = model.elements;
  const rows = gasConnectionRows(model);
  let total = 0;
  for (const row of rows) total += row.inputMbh;
  const value = (row: GasConnectionRow) => (path: string) => {
    switch (path) {
      case "count":
        return "1";
      case "gas_id":
        return row.mark;
      case "gas_description":
        return row.description;
      case "gas_fuel":
        return gasFuelText(row.fuel);
      case "gas_system":
        return row.systemName;
      case "gas_input_mbh":
        return mbhText(row.inputMbh);
      case "gas_input_btuh":
        return btuh(row.inputMbh);
      case "gas_input_cfh":
        return (Math.round(row.inputCfh * 10) / 10).toLocaleString("en-US", { maximumFractionDigits: 1 });
      case "gas_zone_pressure":
        return pressureLabel(row.zoneInletInWc);
      case "gas_zone":
        return row.zoneLabel;
      case "gas_regulator":
        return row.regulatorLabel ?? "";
      case "gas_pipe_size":
        return gasPipeSizeText(row);
      case "gas_developed_length":
        return String(Math.ceil(row.developedLengthFt - 1e-9));
      case "gas_zone_length":
        return String(Math.ceil(row.zoneLengthFt - 1e-9));
      case "gas_sizing_length":
        return String(Math.ceil(row.basis.lengthFt - 1e-9));
      case "gas_sizing_basis":
        return gasBasisText(row.basis);
      default:
        return fieldText(elements, row.elementId, path, options(def));
    }
  };
  const form = listForm(model, def, rows.map((row) => ({ ids: [row.elementId], value: value(row) })));
  return { ...form, totals: rows.length > 0 ? [{ label: "TOTAL GAS INPUT", value: `${btuh(total)} BTU/H` }] : [] };
}

// ------------------------------------------------------------------ built-in templates (moved from the kernel, round 15, verbatim)

export const GAS_EQUIPMENT_TEMPLATE: FormTemplate = {
  name: "Gas equipment",
  title: "GAS EQUIPMENT SCHEDULE",
  header: { columns: 1, fields: [] },
  body: {
    layout: "rows",
    columns: [
      { heading: "ID", value: "{gas_id}", align: "center" },
      { heading: "QTY", value: "{count}", align: "center" },
      { heading: "DESCRIPTION", value: "{gas_description}", align: "left" },
      { heading: "INPUT (BTU/H)", value: "{gas_input_btuh}", align: "right" },
      { heading: "TOTAL INPUT (BTU/H)", value: "{gas_total_btuh}", align: "right" },
      { heading: "PRESSURE REGULATOR", value: "{gas_regulator}", align: "left" },
      { heading: "VENT", value: "{gas_vent}", align: "left" },
    ],
  },
  notes: [],
};

export const GAS_CONNECTIONS_TEMPLATE: FormTemplate = {
  name: "Gas connections",
  title: "GAS CONNECTION SCHEDULE",
  header: { columns: 1, fields: [] },
  body: {
    layout: "rows",
    columns: [
      { heading: "ID", value: "{gas_id}", align: "center" },
      { heading: "DESCRIPTION", value: "{gas_description}", align: "left" },
      { heading: "GAS", value: "{gas_fuel}", align: "left" },
      { heading: "INPUT (MBH)", value: "{gas_input_mbh}", align: "right" },
      { heading: "INPUT (CFH)", value: "{gas_input_cfh}", align: "right" },
      { heading: "PRESSURE ZONE", value: "{gas_zone_pressure}", align: "center" },
      { heading: "REGULATOR", value: "{gas_regulator}", align: "left" },
      { heading: "PIPE SIZE", value: "{gas_pipe_size}", align: "center" },
      { heading: "DEVELOPED LENGTH (FT)", value: "{gas_developed_length}", align: "right" },
      { heading: "SIZING BASIS", value: "{gas_sizing_basis}", align: "left" },
    ],
  },
  notes: [],
};

const EQUIPMENT: ScheduleSource = { kind: "classes", classes: ["mep.equipment"], includeSubclasses: true };

export const FUEL_FORM_ROWS: readonly FormScheduleDef[] = [
  { kind: "gas_equipment", evaluate: evaluateGasEquipment, label: "Gas equipment schedule", template: GAS_EQUIPMENT_TEMPLATE, source: EQUIPMENT, order: 60 },
  { kind: "gas_connections", evaluate: evaluateGasConnections, label: "Gas connection schedule", template: GAS_CONNECTIONS_TEMPLATE, source: EQUIPMENT, order: 70 },
];
