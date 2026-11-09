/**
 * @jest-environment node
 *
 * Round 12 lane M12: the kernel files the move has emptied or changed so far
 * hold fewer trade words, counted the way `src/__tests__/trade-terms.test.ts`
 * counts them (identifiers split into words, case-insensitive, plurals).
 * Each limit is this lane's measured count; round 11's is in the comment.
 *
 * Fails on round 11's code: `solver.ts` held the duct propagation (5 words),
 * `seed.ts` the demo and heavy networks (25), `fullbim.ts` the load-test
 * building (49), and `part-commands.ts` an `equipment` move case (15).
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const SRC = path.join(__dirname, "..", "src");

const TERMS = [
  "electrical", "plumbing", "mechanical", "sanitary", "grease", "vent", "sewer", "drainage", "interceptor",
  "breaker", "panelboard", "panel", "circuit", "feeder", "receptacle", "conductor", "conduit", "ampacity", "voltage", "kva", "amps",
  "nec", "ipc", "ifgc", "imc", "hvac", "duct", "cfm", "diffuser", "airflow", "ventilation", "wsfu", "dfu", "fixture", "gas", "mbh", "sprinkler",
];
const WORDS = new Set(TERMS.flatMap((t) => [t, `${t}s`, `${t}es`]));

function tradeWords(file: string): number {
  const full = path.join(SRC, file);
  if (!existsSync(full)) return 0;
  const text = readFileSync(full, "utf8");
  const split = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  return split.split(/[^A-Za-z]+/).filter((w) => w.length >= 3 && WORDS.has(w.toLowerCase())).length;
}

describe("m12-trade-terms-drop", () => {
  it.each([
    ["solver.ts", 0], // round 11: 5
    ["seed.ts", 0], // round 11: 25
    ["fullbim.ts", 0], // round 11: 49
    ["part-commands.ts", 14], // round 11: 15
  ] as const)("%s holds at most %d trade words", (file, limit) => {
    expect(tradeWords(file)).toBeLessThanOrEqual(limit);
  });
});
