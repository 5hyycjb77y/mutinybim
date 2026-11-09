import { parseToSI, fromSI, QUANTITY_BINDINGS, UnitError } from "@permitzip/bim-units";
import { z } from "zod";
import { QUANTITIES, QUANTITY_KEYS, quantityBagSchema, quantityValueLabel, type QuantityBag, type QuantityKey } from "./index";

/**
 * Quantities as a person or an agent writes them: a bare number is in the
 * quantity's own unit (min_inlet_pressure in psi, mbh in MBH); text carries
 * its unit ("7 in. w.c.", "2 psi", "0.5 kPa", "199,000 Btu/h") and is read by
 * the unit library into that unit. Stored values stay numbers in the
 * quantity's unit, so nothing downstream changes.
 */

const amount = z.number().finite().min(0).max(1_000_000);
const written = z.union([amount, z.string().trim().min(1).max(40)]);

export const quantityBagInputSchema = quantityBagSchema.extend(Object.fromEntries(QUANTITY_KEYS.map((k) => [k, written.optional()])) as Record<QuantityKey, z.ZodOptional<typeof written>>);
export type QuantityBagInput = z.infer<typeof quantityBagInputSchema>;

const BARE = /^[+-]?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?$/;

/** One written value in the quantity's unit, or why it can't be read. */
export function readQuantityValue(key: QuantityKey, input: number | string): { ok: true; value: number } | { ok: false; reason: string } {
  if (typeof input === "number") return { ok: true, value: input };
  const binding = QUANTITY_BINDINGS[key];
  const text = input.trim();
  let value: number;
  if (BARE.test(text) && /\d/.test(text)) value = Number(text.replace(/,/g, ""));
  else {
    try {
      value = fromSI(parseToSI(text, binding.kind), binding.unit);
    } catch (err) {
      if (!(err instanceof UnitError)) throw err;
      return { ok: false, reason: `${key} "${input}": ${err.message} Give a number in ${QUANTITIES[key].unit}, or text with a unit` };
    }
  }
  if (!Number.isFinite(value) || value < 0 || value > 1_000_000) return { ok: false, reason: `${key} "${input}" is ${value} ${QUANTITIES[key].unit}, outside 0 to 1,000,000` };
  return { ok: true, value: Math.round(value * 1e6) / 1e6 };
}

/**
 * The bag in each quantity's unit, with what was read from text in words
 * ("min_inlet_pressure "7 in w.c." → min inlet 7 in. w.c. (0.253 psi)"), or
 * the first value that can't be read.
 */
export function readQuantityBag(input: QuantityBagInput): { ok: true; bag: QuantityBag; read: string[] } | { ok: false; reason: string } {
  const out: Record<string, unknown> = { ...input };
  const read: string[] = [];
  for (const k of QUANTITY_KEYS) {
    const v = input[k];
    if (v === undefined) continue;
    const r = readQuantityValue(k, v);
    if (!r.ok) return r;
    out[k] = r.value;
    if (typeof v === "string") read.push(`${k} "${v}" → ${quantityValueLabel(k, r.value)}`);
  }
  return { ok: true, bag: out as QuantityBag, read };
}
