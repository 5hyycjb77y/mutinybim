import { formatMoney, type MoneyAmount } from "@permitzip/bim-units";
import { z } from "zod";
import { CALC_POINT, contribute, defineCalc, definePack, ELEMENT_KIND_POINT, type CalcValue, type Pack } from "@permitzip/bim-pack/runtime";
import { DEVELOPMENT_PACK_ID } from "./ids";
import { DEVELOPMENT_KIND_ROWS } from "./kinds";
import { proForma, type ProFormaResult } from "./pro-forma";

/**
 * The Development add-on on the add-on contract (round 11, D3): program areas
 * and deal assumptions as intent records, and the pro forma as a calc over
 * them and the model's quantities. Prices are the reader's own cost source,
 * in the reader's process; the calc returns money and stores nothing.
 */

const proFormaInput = z
  .object({
    /** The reader's price list. */
    costSourceId: z.string().trim().min(1).max(200).optional(),
    /** The company reading (the host fills it from the session). */
    reader: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

const moneyValue = (key: string, label: string, m: MoneyAmount | null): CalcValue => ({ key, label, value: m ? formatMoney(m) : null, unit: null, cite: [] });

export const PRO_FORMA_CALC = defineCalc({
  id: "development.pro_forma",
  version: "1.0.0",
  domain: "development",
  title: "Development pro forma",
  summary: "Net operating income, value at the recorded cap rate, hard and total cost, margin and yield on cost, from the model's program areas and deal assumptions, priced with your own price list (the model's quantities when it prices them, else cost per m²).",
  codeFamily: null,
  needsModel: true,
  input: proFormaInput,
  example: { costSourceId: "firm:owner_budget", reader: "owner" },
  run: (input, ctx) => {
    if (!ctx.model) {
      return { values: [], steps: [], issues: [{ severity: "error", message: "The pro forma reads the model's program areas and assumptions; open a model first.", cite: [] }], detail: null };
    }
    const r: ProFormaResult = proForma(ctx.model, { ...(input.costSourceId ? { costSourceId: input.costSourceId } : {}), ...(input.reader ? { reader: input.reader } : {}) });
    const values: CalcValue[] = [
      { key: "gross_area", label: "Gross area", value: r.grossArea, unit: "m2", cite: [] },
      { key: "rentable_area", label: "Rentable area", value: r.rentableArea, unit: "m2", cite: [] },
      moneyValue("noi", "Net operating income per year", r.noi),
      moneyValue("value", "Value at the cap rate", r.value),
      moneyValue("hard_cost", "Hard cost", r.hardCost),
      moneyValue("total_cost", "Total cost", r.totalCost),
      moneyValue("margin", "Margin", r.margin),
      { key: "yield_on_cost", label: "Yield on cost", value: r.yieldOnCost, unit: "1", cite: [] },
    ];
    const steps = [{ label: "Hard cost", detail: r.hardCostFrom === "priced_quantities" ? "The model's quantities priced with your price list" : r.hardCostFrom === "cost_per_area" ? "Cost per m² × gross area" : "Not worked out", cite: [] }];
    return { values, steps, issues: r.missing.map((message) => ({ severity: "warning" as const, message, cite: [] })), detail: r };
  },
});

export const DEVELOPMENT_PACK: Pack = definePack(
  {
    id: DEVELOPMENT_PACK_ID,
    name: "Development",
    version: "0.1.0",
    kernel: "^1.8.0",
    description: "Program areas and deal assumptions as records before anything is drawn, and a pro forma over them and the model's quantities priced with your own price list.",
    firstParty: true,
  },
  [contribute(ELEMENT_KIND_POINT, DEVELOPMENT_KIND_ROWS), contribute(CALC_POINT, [PRO_FORMA_CALC])],
);
