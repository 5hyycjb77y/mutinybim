/**
 * @jest-environment node
 *
 * Round 12 lane E: trade words in the kernel files this lane owns only go
 * down. Counted exactly as the kernel's ratchet counts them
 * (`packages/bim-kernel/src/__tests__/trade-terms.test.ts`: identifiers split
 * into words, each compared with the trade terms and their plurals). The
 * transitional fallbacks (`catalog/entry-fallback.ts`,
 * `requirements/facet-fallback.ts`) are counted separately: the coordinator
 * deletes them at close.
 *
 * On round 11's code the five files held 437 trade words (catalog/model 90,
 * catalog/types 93, layout/one-line 73, annotation/connection-graphics 84,
 * requirements/facets 97) and this test fails.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const TERMS = [
  "electrical", "plumbing", "mechanical",
  "sanitary", "grease", "vent", "sewer", "drainage", "interceptor",
  "breaker", "panelboard", "panel", "circuit", "feeder", "receptacle", "conductor", "conduit", "ampacity", "voltage", "kva", "amps",
  "nec", "ipc", "ifgc", "imc",
  "hvac", "duct", "cfm", "diffuser", "airflow", "ventilation",
  "wsfu", "dfu", "fixture",
  "gas", "mbh",
  "sprinkler",
] as const;
const WORDS = new Set(TERMS.flatMap((t) => [t, `${t}s`, `${t}es`]));

function count(text: string): number {
  const split = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  return split.split(/[^A-Za-z]+/).filter((raw) => raw.length >= 3 && WORDS.has(raw.toLowerCase())).length;
}

const SRC = path.resolve(__dirname, "../../bim-kernel/src");
const words = (rel: string) => {
  const file = path.join(SRC, rel);
  return existsSync(file) ? count(readFileSync(file, "utf8")) : 0;
};

/** Round 11 (6eccc2969) per file, and what each may hold now. */
const BEFORE: Readonly<Record<string, number>> = {
  "catalog/model.ts": 90,
  "catalog/types.ts": 93,
  "layout/one-line.ts": 73,
  "annotation/connection-graphics.ts": 84,
  "requirements/facets.ts": 97,
};
const NEW_FILES = ["catalog/entry-point.ts", "catalog/kernel-rows.ts", "catalog/commands.ts", "layout/one-line-model.ts", "layout/diagram-layout-point.ts", "layout/view-graphics-point.ts"];
const FALLBACKS = ["catalog/entry-fallback.ts", "requirements/facet-fallback.ts"];

describe("e12: trade words in the moved kernel files only go down", () => {
  it("each file holds fewer than on round 11, and the five together at most 40", () => {
    const now = Object.fromEntries(Object.keys(BEFORE).map((f) => [f, words(f)]));
    for (const [f, before] of Object.entries(BEFORE)) expect({ f, n: now[f] ?? 0, fewer: (now[f] ?? 0) < before }).toEqual({ f, n: now[f] ?? 0, fewer: true });
    const total = Object.values(now).reduce((s, n) => s + n, 0);
    expect(total).toBeLessThanOrEqual(40);
  });

  it("the catalog commands and the new point files stay small (catalog/commands.ts held 32 on round 11)", () => {
    expect(words("catalog/commands.ts")).toBeLessThan(32);
    for (const f of NEW_FILES) expect({ f, n: words(f) }).toEqual({ f, n: expect.any(Number) });
    const pointFiles = NEW_FILES.filter((f) => f !== "catalog/commands.ts" && f !== "catalog/kernel-rows.ts").map(words).reduce((s, n) => s + n, 0);
    expect(pointFiles).toBeLessThanOrEqual(6);
  });

  it("the transitional fallbacks are gone (round 14 K14 deleted them; k14-stand-ins-gone)", () => {
    for (const f of FALLBACKS) expect(existsSync(path.join(SRC, f))).toBe(false);
  });
});
