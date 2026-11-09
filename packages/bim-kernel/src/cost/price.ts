import { addMoney, convert, money, multiplyMoney, unitCandidates, zeroMoney, type MoneyAmount, type UnitCode } from "@permitzip/bim-units";
import { activePackSet, modelPackSet, withPackSet } from "../packs/scope";
import type { ModelState } from "../types";
import { takeoffTotals, type TakeoffTotal } from "../qto/takeoff";
import type { CostBasis, CostParty, CostProvenance, CostRate, Money } from "../qto/types";
import { costSourceFor, type ReaderCostSources, type ReaderParty } from "./sources";

/**
 * Price a takeoff with one party's rates, in the reader's process only. The
 * model's quantities are multiplied by a snapshot of the source's rates
 * taken once per call; nothing is written to the model, a changeset or the
 * model server, and no model command accepts money. Every priced line says
 * whose number it is and which quantity it multiplied; the total says which
 * lines it adds.
 */

export interface PricedLine {
  /** The takeoff line it priced (`TakeoffTotal.key`). */
  readonly takeoffKey: string;
  readonly system: string;
  readonly code: string;
  readonly stageId: string | null;
  readonly typeId: string | null;
  readonly measure: string;
  /** In the rate's `per` unit. */
  readonly quantity: number;
  readonly per: string;
  /** What the quantity is measured from, in words, and how many elements it adds. */
  readonly quantityFrom: { readonly from: string; readonly elementCount: number };
  readonly unitRate: Money;
  readonly amount: Money;
  readonly provenance: CostProvenance;
}

/** A takeoff line no rate in the source priced, named so a person sees what is missing. */
export interface UnpricedLine {
  readonly takeoffKey: string;
  readonly groupLabel: string;
  readonly measure: string;
  readonly reason: string;
}

export interface DerivedTotalProvenance extends CostProvenance {
  /** The priced lines it adds (`PricedLine.takeoffKey`). */
  readonly lines: readonly string[];
}

/**
 * A code (and stage) in one of the source's code systems that the source has
 * no rate for at all. Shown as "no price", never as zero, and never added to
 * the total.
 */
export interface NoRateLine {
  readonly system: string;
  readonly code: string;
  readonly stageId: string | null;
  readonly groupLabel: string;
  readonly elementCount: number;
}

export interface PricedTakeoff {
  readonly source: { readonly id: string; readonly party: CostParty; readonly basis: CostBasis; readonly currency: string; readonly effectiveDate: string };
  readonly lines: readonly PricedLine[];
  readonly unpriced: readonly UnpricedLine[];
  /** Codes the model measures that the source has no rate for (one per code and stage). */
  readonly noRate: readonly NoRateLine[];
  readonly total: Money;
  readonly totalProvenance: DerivedTotalProvenance;
}

export interface PriceTakeoffOptions {
  /** Sources held only in the reader's process (see `ReaderCostSources`). */
  readonly sources?: ReaderCostSources;
}

function specificity(rate: CostRate): number {
  return (rate.stageId !== undefined ? 2 : 0) + (rate.typeId !== undefined ? 1 : 0);
}

function rateMatches(rate: CostRate, line: TakeoffTotal): boolean {
  const c = line.group.classification;
  if (!c || c.system !== rate.classification.system || c.code !== rate.classification.code) return false;
  if (rate.measure !== line.measure.key) return false;
  if (rate.stageId !== undefined && rate.stageId !== line.stageId) return false;
  if (rate.typeId !== undefined && rate.typeId !== line.typeId) return false;
  return true;
}

function asUnit(code: string): UnitCode | null {
  return unitCandidates(code).find((c) => c === code) ?? null;
}

function moneyOf(m: Money): MoneyAmount {
  return money(m.minor, m.currency);
}

function rateKey(rate: CostRate): string {
  return `${rate.classification.system}\u0000${rate.classification.code}\u0000${rate.measure}`;
}

/** Price the model's takeoff with source `sourceId`, as `reader` (who must be allowed to read it). */
export function priceTakeoff(model: ModelState, sourceId: string, reader: ReaderParty, options: PriceTakeoffOptions = {}): PricedTakeoff {
  return withPackSet(modelPackSet(model.modelId), () => {
    const set = activePackSet();
    const source = costSourceFor(set, sourceId, reader, options.sources ?? []);
    // The snapshot: one read of the party's rates; the rest of the call multiplies it.
    const rates: readonly CostRate[] = Object.freeze([...source.rates()]);
    const byKey = new Map<string, CostRate[]>();
    const systems = new Set<string>();
    const ratedCodes = new Set<string>();
    for (const r of rates) {
      if (r.unitRate.currency !== source.currency) throw new Error(`Price list ${source.id} is in ${source.currency} but a rate for ${r.classification.code} is in ${r.unitRate.currency}. Fix the rate in the list.`);
      systems.add(r.classification.system);
      ratedCodes.add(`${r.classification.system}\u0000${r.classification.code}`);
      const k = rateKey(r);
      const list = byKey.get(k);
      if (list) list.push(r);
      else byKey.set(k, [r]);
    }
    const lines: PricedLine[] = [];
    const unpriced: UnpricedLine[] = [];
    const noRate = new Map<string, { system: string; code: string; stageId: string | null; groupLabel: string; elementCount: number }>();
    let total = zeroMoney(source.currency);
    for (const system of systems) {
      for (const line of takeoffTotals(model.elements, { system })) {
        const c = line.group.classification;
        if (!c) continue;
        if (!ratedCodes.has(`${c.system}\u0000${c.code}`)) {
          const k = `${c.system}\u0000${c.code}\u0000${line.stageId ?? ""}`;
          const seen = noRate.get(k);
          // A code's lines repeat once per measure; its element count is the largest of them.
          if (!seen) noRate.set(k, { system: c.system, code: c.code, stageId: line.stageId, groupLabel: line.group.label, elementCount: line.elementCount });
          else if (line.elementCount > seen.elementCount) seen.elementCount = line.elementCount;
          continue;
        }
        const candidates = (byKey.get(`${c.system}\u0000${c.code}\u0000${line.measure.key}`) ?? []).filter((r) => rateMatches(r, line));
        if (candidates.length === 0) continue;
        const rate = candidates.reduce((best, r) => (specificity(r) > specificity(best) ? r : best));
        const from = asUnit(line.measure.unit);
        const per = asUnit(rate.per);
        if (!from || !per) {
          unpriced.push({ takeoffKey: line.key, groupLabel: line.group.label, measure: line.measure.key, reason: `The rate is per "${rate.per}", which can't be compared with the quantity's ${line.measure.unit}` });
          continue;
        }
        let quantity: number;
        try {
          quantity = convert(line.value, from, per);
        } catch (err) {
          console.error("[cost] a rate's unit doesn't convert from the quantity's", { sourceId, measure: line.measure.key, per: rate.per, err });
          unpriced.push({ takeoffKey: line.key, groupLabel: line.group.label, measure: line.measure.key, reason: `The rate is per ${rate.per}, which isn't a ${line.measure.kind}` });
          continue;
        }
        const amount = multiplyMoney(moneyOf(rate.unitRate), quantity);
        total = addMoney(total, amount);
        lines.push({
          takeoffKey: line.key,
          system: c.system,
          code: c.code,
          stageId: line.stageId,
          typeId: line.typeId,
          measure: line.measure.key,
          quantity,
          per: rate.per,
          quantityFrom: { from: line.measure.from, elementCount: line.elementCount },
          unitRate: { minor: rate.unitRate.minor, currency: rate.unitRate.currency },
          amount: { minor: amount.minor, currency: amount.currency },
          provenance: rate.provenance,
        });
      }
    }
    lines.sort((a, b) => a.code.localeCompare(b.code) || (a.stageId ?? "").localeCompare(b.stageId ?? "") || a.measure.localeCompare(b.measure));
    return {
      source: { id: source.id, party: source.party, basis: source.basis, currency: source.currency, effectiveDate: source.effectiveDate },
      lines,
      unpriced,
      noRate: [...noRate.values()]
        .map((l) => ({ system: l.system, code: l.code, stageId: l.stageId, groupLabel: l.groupLabel, elementCount: l.elementCount }))
        .sort((a, b) => a.code.localeCompare(b.code) || (a.stageId ?? "").localeCompare(b.stageId ?? "")),
      total: { minor: total.minor, currency: total.currency },
      totalProvenance: { ownedBy: { party: source.party.id }, source: source.id, date: source.effectiveDate, lines: lines.map((l) => l.takeoffKey) },
    };
  });
}
