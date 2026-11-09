/**
 * @jest-environment node
 *
 * Round 13 lane E, step 1: the connection type's electrical fields leave the
 * kernel, so its catalog files and the readers that named those fields hold
 * fewer trade words, and none of them names the fields any more. Counted
 * exactly as the kernel's ratchet counts them
 * (`packages/bim-kernel/src/__tests__/trade-terms.test.ts`).
 *
 * On round 12's code `catalog/**` held 21 words and `requirements/allocation.ts`
 * 17, and `catalog/types.ts`, `catalog/model.ts`, `requirements/allocation.ts`
 * and `spaces/zone-servers.ts` named `loadVa` / `loadClass` / `voltage`, so
 * this test fails.
 */
import { readFileSync, readdirSync } from "node:fs";
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
const source = (rel: string) => readFileSync(path.join(SRC, rel), "utf8");
const words = (rel: string) => count(source(rel));
const CATALOG = readdirSync(path.join(SRC, "catalog")).filter((f) => f.endsWith(".ts")).map((f) => `catalog/${f}`);

/** Code only: comments may still say what a field was. */
const code = (rel: string) => source(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("e13: Electrical's connection fields leave the kernel's catalog and readers", () => {
  it("catalog/** holds fewer trade words than round 12 (21)", () => {
    const total = CATALOG.map(words).reduce((s, n) => s + n, 0);
    expect(total).toBeLessThan(21);
  });

  it("the readers hold no more than round 12, and allocation fewer (17)", () => {
    expect(words("requirements/allocation.ts")).toBeLessThan(17);
    expect(words("spaces/zone-servers.ts")).toBeLessThanOrEqual(26);
    expect(words("parts.ts")).toBeLessThanOrEqual(72);
  });

  it("no catalog file or reader names the moved fields in code", () => {
    for (const f of [...CATALOG, "requirements/allocation.ts", "spaces/zone-servers.ts"]) {
      expect({ f, names: /\b(loadVa|loadClass|voltage)\b/.test(code(f)) }).toEqual({ f, names: false });
    }
  });
});
