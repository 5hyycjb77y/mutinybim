/**
 * @jest-environment node
 *
 * Round 9 lane A9: the kernel stops knowing what airflow is. Its element
 * types name no airflow field, no kernel source reads one, the terminal
 * airflow command and the duct checks are gone from it, and the trade-term
 * counts of the files that held them drop (by removal; `trade-terms.test.ts`
 * is the ratchet). Fails on round 8b's code: `types.ts` declared `cfm`,
 * `flowCfm` and `totalCfm`, and the kernel read them in nine files.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const SRC = path.resolve(__dirname, "..", "src");

/** The ratchet's word count (`src/__tests__/trade-terms.test.ts`, which isn't imported so its own cases don't run twice), for the three air terms. */
function countAir(text: string): Record<"duct" | "cfm" | "airflow", number> {
  const out = { duct: 0, cfm: 0, airflow: 0 };
  const split = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  for (const raw of split.split(/[^A-Za-z]+/)) {
    const w = raw.toLowerCase();
    for (const t of ["duct", "cfm", "airflow"] as const) if (w === t || w === `${t}s` || w === `${t}es`) out[t] += 1;
  }
  return out;
}

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "__tests__") continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

const read = (rel: string) => readFileSync(path.join(SRC, rel), "utf8");

/** Round 8b's counts of the files this lane changed, for the terms it removed (`trade-terms.baseline.json` at 42e1ac5de). */
const BEFORE: Readonly<Record<string, Partial<Record<"duct" | "cfm" | "airflow", number>>>> = {
  "types.ts": { cfm: 3, airflow: 3 },
  "commands.ts": { cfm: 26 },
  "validate.ts": { duct: 1 },
  "command-core.ts": { cfm: 2 },
  "part-commands.ts": { cfm: 14, airflow: 4 },
  "drawing/sheet.ts": { cfm: 11 },
  "schedules/records.ts": { cfm: 26 },
  "annotation/annotations.ts": { cfm: 11 },
  "selection-scopes.ts": { cfm: 2 },
};

describe("a9 trade terms drop", () => {
  it("the element types name no airflow field", () => {
    expect(read("types.ts")).not.toMatch(/\b(cfm|flowCfm|totalCfm)\b/);
  });

  it("no kernel source reads an airflow field off a record", () => {
    const offenders = sources(SRC).flatMap((file) => {
      const text = readFileSync(file, "utf8");
      return [...text.matchAll(/\b(?:el|t|e|terminal|unit|seg|dev|ahu|host|other)\.(cfm|flowCfm|totalCfm)\b/g)].map((m) => `${path.relative(SRC, file)}: ${m[0]}`);
    });
    expect(offenders).toEqual([]);
  });

  it("the kernel has no terminal airflow command and no duct check", () => {
    expect(read("commands.ts")).not.toContain("set_terminal_cfm");
    expect(read("validate.ts")).not.toContain("duct_segment");
    expect(read("validate.ts")).not.toContain("minStraightMm");
  });

  it("the counts of the files that held them go down", () => {
    for (const [file, before] of Object.entries(BEFORE)) {
      const now = countAir(read(file));
      for (const [term, n] of Object.entries(before)) {
        const key = term as "duct" | "cfm" | "airflow";
        expect([file, term, now[key] < (n ?? 0)]).toEqual([file, term, true]);
      }
    }
  });
});
