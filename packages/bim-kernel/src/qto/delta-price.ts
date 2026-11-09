import { addMoney, convert, money, multiplyMoney, unitCandidates, zeroMoney, type UnitCode } from "@permitzip/bim-units";
import { costSourceFor, type ReaderCostSources, type ReaderParty } from "../cost/sources";
import type { QuantityDelta } from "../graph/types";
import type { PackSet } from "../packs/set";
import type { CostBasis, CostParty, CostRate, Money } from "./types";

/**
 * A quantity change priced with one party's own price list, in the reader's
 * process (round 8b, lane O): "+42 ft of TEST-0100 at that company's rate".
 * Two companies price the same change privately; neither sees the other's
 * rates, and nothing is stored. Only rows grouped by a classification code
 * (`code:<system>:<code>`) can meet a rate; a rate scoped to one stage or
 * type doesn't apply to a change summed across them, so only a list's
 * general rate for the code and measure is used. A code with no rate says
 * so, never $0.
 */

export interface PricedDeltaLine {
  readonly group: string;
  readonly measure: string;
  readonly label: string;
  /** The change in the rate's unit (negative: less). */
  readonly quantity: number;
  readonly per: string;
  readonly unitRate: Money;
  readonly amount: Money;
}

export interface PricedDelta {
  readonly source: { readonly id: string; readonly party: CostParty; readonly basis: CostBasis; readonly currency: string; readonly effectiveDate: string };
  readonly lines: readonly PricedDeltaLine[];
  /** Rows with no general rate in this list (or not grouped by a code), by label. */
  readonly noRate: readonly { readonly group: string; readonly label: string }[];
  readonly total: Money;
}

function parseCodeGroup(group: string): { readonly system: string; readonly code: string } | null {
  if (!group.startsWith("code:")) return null;
  const rest = group.slice("code:".length);
  const at = rest.lastIndexOf(":");
  if (at <= 0 || at === rest.length - 1) return null;
  return { system: rest.slice(0, at), code: rest.slice(at + 1) };
}

function asUnit(code: string): UnitCode | null {
  return unitCandidates(code).find((c) => c === code) ?? null;
}

/** Price `deltas` with source `sourceId`, as `reader` (who must be allowed to read it). */
export function priceQuantityDeltas(deltas: readonly QuantityDelta[], set: PackSet, sourceId: string, reader: ReaderParty, extra: ReaderCostSources = []): PricedDelta {
  const source = costSourceFor(set, sourceId, reader, extra);
  const general = new Map<string, CostRate>();
  for (const r of source.rates()) {
    if (r.stageId !== undefined || r.typeId !== undefined) continue;
    if (r.unitRate.currency !== source.currency) throw new Error(`Price list ${source.id} is in ${source.currency} but a rate for ${r.classification.code} is in ${r.unitRate.currency}. Fix the rate in the list.`);
    general.set(`${r.classification.system}\u0000${r.classification.code}\u0000${r.measure}`, r);
  }
  const lines: PricedDeltaLine[] = [];
  const noRate: { group: string; label: string }[] = [];
  let total = zeroMoney(source.currency);
  for (const d of deltas) {
    const code = parseCodeGroup(d.group);
    const rate = code ? general.get(`${code.system}\u0000${code.code}\u0000${d.measure}`) : undefined;
    const from = asUnit(d.unit);
    const per = rate ? asUnit(rate.per) : null;
    if (!rate || !from || !per) {
      noRate.push({ group: d.group, label: d.label });
      continue;
    }
    let quantity: number;
    try {
      quantity = convert(d.delta, from, per);
    } catch (err) {
      console.error("[cost] a rate's unit doesn't convert from the change's quantity; shown as no price", { sourceId, measure: d.measure, per: rate.per, err });
      noRate.push({ group: d.group, label: d.label });
      continue;
    }
    const amount = multiplyMoney(money(rate.unitRate.minor, rate.unitRate.currency), quantity);
    total = addMoney(total, amount);
    lines.push({ group: d.group, measure: d.measure, label: d.label, quantity, per: rate.per, unitRate: { minor: rate.unitRate.minor, currency: rate.unitRate.currency }, amount: { minor: amount.minor, currency: amount.currency } });
  }
  return {
    source: { id: source.id, party: source.party, basis: source.basis, currency: source.currency, effectiveDate: source.effectiveDate },
    lines,
    noRate,
    total: { minor: total.minor, currency: total.currency },
  };
}
