/**
 * @jest-environment node
 *
 * Round 12 lane P12: trade words only go down in the kernel files this lane
 * owns. Counted the way the kernel ratchet counts (`trade-terms.test.ts`:
 * the same terms, identifiers split into words, plurals folded). The transitional `services/builtin-fallback.ts` is counted
 * by the ratchet and leaves when the coordinator deletes it at close.
 * (@mutinybim-bare-kernel: reads source files only.)
 *
 * Fails on round 11's code: `routing/pipe/families.ts` held 137 trade words
 * and `services/builtin.ts` 122.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const TERMS = ["electrical", "plumbing", "mechanical", "sanitary", "grease", "vent", "sewer", "drainage", "interceptor", "breaker", "panelboard", "panel", "circuit", "feeder", "receptacle", "conductor", "conduit", "ampacity", "voltage", "kva", "amps", "nec", "ipc", "ifgc", "imc", "hvac", "duct", "cfm", "diffuser", "airflow", "ventilation", "wsfu", "dfu", "fixture", "gas", "mbh", "sprinkler"] as const;
const WORDS: ReadonlyMap<string, string> = new Map(TERMS.flatMap((t) => [[t, t], [`${t}s`, t], [`${t}es`, t]] as const));

function countTerms(text: string): Partial<Record<string, number>> {
  const out: Partial<Record<string, number>> = {};
  const split = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  for (const raw of split.split(/[^A-Za-z]+/)) {
    if (raw.length < 3) continue;
    const term = WORDS.get(raw.toLowerCase());
    if (term) out[term] = (out[term] ?? 0) + 1;
  }
  return out;
}

const SRC = path.join(__dirname, "..", "..", "bim-kernel", "src");
const total = (file: string): number => Object.values(countTerms(readFileSync(path.join(SRC, file), "utf8"))).reduce((sum: number, n) => sum + (n ?? 0), 0);

/** Round 11 count → the most this lane leaves. */
const OWNED: ReadonlyArray<readonly [file: string, before: number, atMost: number]> = [
  ["routing/pipe/families.ts", 137, 2],
  ["services/builtin.ts", 122, 16],
  ["services/registry.ts", 35, 35],
  ["registry/fitting-family-point.ts", 0, 0],
];

describe("p12-trade-terms-drop", () => {
  it.each(OWNED)("%s: %i → at most %i", (file, _before, atMost) => {
    expect(total(file)).toBeLessThanOrEqual(atMost);
  });

  it("the family reader section of routing/fittings/library.ts holds no drainage, vent or gas family words (duct lines are M12's)", () => {
    const counts = countTerms(readFileSync(path.join(SRC, "routing/fittings/library.ts"), "utf8"));
    expect({ drainage: counts.drainage ?? 0, vent: counts.vent ?? 0, gas: counts.gas ?? 0 }).toEqual({ drainage: 2, vent: 0, gas: 0 });
  });
});
