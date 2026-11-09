/**
 * @jest-environment node
 *
 * Round 6 lane P: Plumbing and gas left the kernel. None of its files is in
 * the kernel's or bim-calc's source any more, neither imports this add-on,
 * and the kernel's plumbing and gas words fell from the round's baseline
 * (`trade-terms.batch-5c.json`, frozen at 5c's tip). On the old tree every moved path existed and
 * every total was the baseline's.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const PACKAGES = path.resolve(__dirname, "../..");
const ROOT = path.resolve(PACKAGES, "..");

const MOVED = [
  "bim-calc/src/plumbing",
  "bim-calc/src/packs/hunter/curves.ts",
  "bim-kernel/src/blocks/gas-table.ts",
  "bim-kernel/src/connections/plumbing",
  "bim-kernel/src/diagrams/plumbing-graph.ts",
  "bim-kernel/src/diagrams/plumbing-topology.ts",
  "bim-kernel/src/drainage",
  "bim-kernel/src/fields/gas.ts",
  "bim-kernel/src/fields/plumbing.ts",
  "bim-kernel/src/fields/providers/gas.ts",
  "bim-kernel/src/fields/providers/plumbing.ts",
  "bim-kernel/src/library/plumbing.ts",
  "bim-kernel/src/load-points/engine.ts",
  "bim-kernel/src/packs/first-party/plumbing.ts",
  "bim-kernel/src/plumbing",
  "bim-kernel/src/routing/pipe/drainage.ts",
  "bim-kernel/src/routing/pipe/gas-connections.ts",
  "bim-kernel/src/routing/pipe/gas-fuel.ts",
  "bim-kernel/src/routing/pipe/gas-zones.ts",
  "bim-kernel/src/routing/pipe/hydraulics.ts",
  "bim-kernel/src/routing/pipe/plumbing-catalog.ts",
  "bim-kernel/src/schedules/forms/fuel-forms.ts",
] as const;

/** This trade's words in `trade-terms.test.ts`. */
const TERMS = ["plumbing", "sanitary", "grease", "vent", "sewer", "drainage", "interceptor", "ipc", "ifgc", "wsfu", "dfu", "fixture", "gas", "mbh"] as const;
type Term = (typeof TERMS)[number];
const WORDS: ReadonlyMap<string, Term> = new Map(TERMS.flatMap((t) => [[t, t], [`${t}s`, t], [`${t}es`, t]] as const));

function countTerms(text: string, into: Record<Term, number>): void {
  const split = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  for (const raw of split.split(/[^A-Za-z]+/)) {
    if (raw.length < 3) continue;
    const term = WORDS.get(raw.toLowerCase());
    if (term) into[term] += 1;
  }
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "__tests__" || name === "node_modules") continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const zero = (): Record<Term, number> => Object.fromEntries(TERMS.map((t) => [t, 0])) as Record<Term, number>;
const sum = (c: Record<Term, number>) => TERMS.reduce((s, t) => s + c[t], 0);

describe("Plumbing and gas is out of the kernel", () => {
  it("the kernel and bim-calc hold none of the moved files", () => {
    expect(MOVED.filter((p) => existsSync(path.join(PACKAGES, p)))).toEqual([]);
  });

  it("neither imports the add-on", () => {
    const offenders = [...sourceFiles(path.join(PACKAGES, "bim-kernel/src")), ...sourceFiles(path.join(PACKAGES, "bim-calc/src"))].filter((f) => /bim-pack-plumbing/.test(readFileSync(f, "utf8")));
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  it("the kernel's plumbing and gas words fell from the round's baseline", () => {
    const baseline = JSON.parse(readFileSync(path.join(PACKAGES, "bim-kernel/src/__tests__/trade-terms.batch-5c.json"), "utf8")) as { files: Record<string, Partial<Record<string, number>>> };
    const before = zero();
    for (const counts of Object.values(baseline.files)) for (const t of TERMS) before[t] += counts[t] ?? 0;
    const after = zero();
    for (const f of sourceFiles(path.join(PACKAGES, "bim-kernel/src"))) countTerms(readFileSync(f, "utf8"), after);
    console.log("[c6p] kernel plumbing and gas words", { before: sum(before), after: sum(after), byTerm: Object.fromEntries(TERMS.map((t) => [t, `${before[t]} -> ${after[t]}`])) });
    expect(sum(after)).toBeLessThan(sum(before));
    for (const t of ["plumbing", "gas", "drainage", "ipc", "ifgc"] as const) expect(after[t]).toBeLessThan(before[t]);
  });
});
