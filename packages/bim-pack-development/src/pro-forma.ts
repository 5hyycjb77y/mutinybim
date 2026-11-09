import { costSourceFor, priceTakeoff, type BimElement, type CostRate, type ModelState, type ReaderCostSources } from "@permitzip/bim-kernel";
import { activePackSet } from "@permitzip/bim-pack/runtime";
import { addMoney, money, multiplyMoney, zeroMoney, type MoneyAmount } from "@permitzip/bim-units";
import { DEAL_COST_SYSTEM, DEVELOPMENT_KIND, DEVELOPMENT_VALUE, FRACTION_ASSUMPTIONS, MONEY_ASSUMPTIONS } from "./ids";

/**
 * The owner's pro forma over the model's intent records and quantities
 * (round 11, D3), worked in the reader's process only:
 *
 *   gross area       Σ program areas
 *   rent             rent per m² per year × Σ (area × rentable share), less vacancy
 *   NOI              rent collected − operating cost per m² per year × gross area
 *   value            NOI ÷ cap rate
 *   hard cost        the model's quantities priced with the reader's cost source when it
 *                    prices any; otherwise cost per m² × gross area
 *   total cost       hard cost × (1 + soft cost share)
 *   margin           value − total cost;  yield on cost  NOI ÷ total cost
 *
 * Money comes only from the reader's own cost source (`COST_SOURCE_POINT`):
 * nothing here writes, and no record holds money. Every record it read is
 * listed in `used`, so a screen shows each input's confidence with the
 * kernel's `readBasis`.
 */

export interface ProFormaOptions {
  /** The reader's price list (`COST_SOURCE_POINT` id). Absent: the money lines read "no price list". */
  readonly costSourceId?: string;
  /** The company reading. */
  readonly reader?: string;
  /** Lists held only in the reader's process. */
  readonly sources?: ReaderCostSources;
}

export interface ProFormaUsed {
  readonly recordId: string;
  /** The value key it read; absent for a money assumption (its amount is the cost source's). */
  readonly key?: string;
}

export interface ProFormaResult {
  readonly currency: string | null;
  /** m². */
  readonly grossArea: number;
  readonly rentableArea: number;
  readonly rentCollected: MoneyAmount | null;
  readonly operatingCost: MoneyAmount | null;
  readonly noi: MoneyAmount | null;
  readonly value: MoneyAmount | null;
  readonly hardCost: MoneyAmount | null;
  readonly hardCostFrom: "priced_quantities" | "cost_per_area" | null;
  readonly totalCost: MoneyAmount | null;
  readonly margin: MoneyAmount | null;
  /** NOI ÷ total cost. */
  readonly yieldOnCost: number | null;
  readonly used: readonly ProFormaUsed[];
  /** What it couldn't work out, in words. */
  readonly missing: readonly string[];
  /** Assumption records it doesn't know, kept and listed. */
  readonly notUsed: readonly string[];
}

type Raw = Readonly<Record<string, unknown>>;

function valuesOf(el: BimElement): Raw {
  const v: unknown = (el as unknown as Raw).values;
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Raw) : {};
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function rateFor(rates: readonly CostRate[], assumption: string): CostRate | undefined {
  return rates.find((r) => r.classification.system === DEAL_COST_SYSTEM && r.classification.code === assumption && r.measure === DEVELOPMENT_VALUE.area && r.stageId === undefined && r.typeId === undefined);
}

export function proForma(model: ModelState, options: ProFormaOptions = {}): ProFormaResult {
  const used: ProFormaUsed[] = [];
  const missing: string[] = [];
  const notUsed: string[] = [];
  let grossArea = 0;
  let rentableArea = 0;
  const fractions = new Map<string, number>();
  const moneyAssumed = new Set<string>();
  for (const id in model.elements) {
    const el = model.elements[id];
    if (!el) continue;
    // Add-on kinds sit outside the kernel's element union: compare as stored text.
    const kind: string = el.kind;
    if (kind === DEVELOPMENT_KIND.programArea) {
      const v = valuesOf(el);
      const area = num(v[DEVELOPMENT_VALUE.area]);
      if (area === null) {
        missing.push(`Program area ${id} has no area`);
        continue;
      }
      const share = num(v[DEVELOPMENT_VALUE.rentableFraction]) ?? 1;
      grossArea += area;
      rentableArea += area * share;
      used.push({ recordId: id, key: DEVELOPMENT_VALUE.area });
    } else if (kind === DEVELOPMENT_KIND.dealAssumption) {
      const v = valuesOf(el);
      const which = v[DEVELOPMENT_VALUE.assumption];
      if (typeof which !== "string") {
        notUsed.push(id);
        continue;
      }
      if ((FRACTION_ASSUMPTIONS as readonly string[]).includes(which)) {
        const f = num(v[DEVELOPMENT_VALUE.fraction]);
        if (f === null) missing.push(`The ${which.replace(/_/g, " ")} assumption has no amount`);
        else {
          fractions.set(which, f);
          used.push({ recordId: id, key: DEVELOPMENT_VALUE.fraction });
        }
      } else if ((MONEY_ASSUMPTIONS as readonly string[]).includes(which)) {
        moneyAssumed.add(which);
        used.push({ recordId: id });
      } else notUsed.push(id);
    }
  }

  let rates: readonly CostRate[] = [];
  let currency: string | null = null;
  if (options.costSourceId && options.reader) {
    const source = costSourceFor(activePackSet(), options.costSourceId, options.reader, options.sources ?? []);
    rates = source.rates();
    currency = source.currency;
  } else missing.push("No price list chosen, so no money lines");

  const perArea = (assumption: string, area: number): MoneyAmount | null => {
    if (!currency || !moneyAssumed.has(assumption)) return null;
    const r = rateFor(rates, assumption);
    if (!r) {
      missing.push(`The price list has no ${assumption.replace(/_/g, " ")} rate`);
      return null;
    }
    if (r.per !== "m2") {
      missing.push(`The price list's ${assumption.replace(/_/g, " ")} rate is per ${r.per}; it must be per m2`);
      return null;
    }
    return multiplyMoney(money(r.unitRate.minor, r.unitRate.currency), area);
  };

  const vacancy = fractions.get("vacancy") ?? 0;
  const rentGross = perArea("rent_per_area_year", rentableArea);
  const rentCollected = rentGross ? multiplyMoney(rentGross, 1 - vacancy) : null;
  const operatingCost = perArea("operating_cost_per_area_year", grossArea);
  const noi = rentCollected && currency ? addMoney(rentCollected, multiplyMoney(operatingCost ?? zeroMoney(currency), -1)) : null;
  const cap = fractions.get("cap_rate");
  let value: MoneyAmount | null = null;
  if (noi && cap !== undefined && cap > 0) value = money(Math.round(noi.minor / cap), noi.currency);
  else if (noi) missing.push("No cap rate recorded, so no value");

  let hardCost: MoneyAmount | null = null;
  let hardCostFrom: ProFormaResult["hardCostFrom"] = null;
  if (options.costSourceId && options.reader) {
    const priced = priceTakeoff(model, options.costSourceId, options.reader, options.sources ? { sources: options.sources } : {});
    if (priced.lines.length > 0) {
      hardCost = money(priced.total.minor, priced.total.currency);
      hardCostFrom = "priced_quantities";
    }
  }
  if (!hardCost) {
    const fromArea = perArea("cost_per_area", grossArea);
    if (fromArea) {
      hardCost = fromArea;
      hardCostFrom = "cost_per_area";
    } else if (currency) missing.push("Nothing priced the hard cost: no priced quantities and no cost per area");
  }
  const soft = fractions.get("soft_cost_fraction") ?? 0;
  const totalCost = hardCost ? multiplyMoney(hardCost, 1 + soft) : null;
  const margin = value && totalCost ? addMoney(value, multiplyMoney(totalCost, -1)) : null;
  const yieldOnCost = noi && totalCost && totalCost.minor !== 0 ? noi.minor / totalCost.minor : null;
  return { currency, grossArea, rentableArea, rentCollected, operatingCost, noi, value, hardCost, hardCostFrom, totalCost, margin, yieldOnCost, used, missing, notUsed };
}
