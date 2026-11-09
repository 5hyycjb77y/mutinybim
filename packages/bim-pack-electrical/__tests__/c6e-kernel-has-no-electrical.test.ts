/**
 * @jest-environment node
 *
 * Round 6 lane E: electrical has left the core. The kernel and bim-calc
 * source hold none of the files that moved into this package and import
 * nothing from it, and the kernel's electrical words fell against the
 * batch-5c baseline. Before the move every listed file existed, the kernel
 * barrels re-exported them, and the counts were the baseline's.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const PACKAGES = path.resolve(__dirname, "../..");
const ROOT = path.resolve(PACKAGES, "..");

const MOVED = [
  "bim-calc/src/electrical/aggregation-rules.ts",
  "bim-calc/src/electrical/demand.ts",
  "bim-calc/src/electrical/fault-current.ts",
  "bim-calc/src/electrical/feeder-type.ts",
  "bim-calc/src/electrical/motor.ts",
  "bim-calc/src/electrical/nec.ts",
  "bim-calc/src/electrical/plugins.ts",
  "bim-calc/src/electrical/service-size.ts",
  "bim-calc/src/electrical/size-circuit.ts",
  "bim-calc/src/electrical/working-space.ts",
  "bim-calc/src/equipment-list.ts",
  "bim-kernel/src/annotation/electrical-symbols.ts",
  "bim-kernel/src/connections/electrical/adapter.ts",
  "bim-kernel/src/connections/electrical/balance.ts",
  "bim-kernel/src/connections/electrical/check.ts",
  "bim-kernel/src/connections/electrical/dedicated-circuits.ts",
  "bim-kernel/src/connections/electrical/engine.ts",
  "bim-kernel/src/connections/electrical/equipment-connection.ts",
  "bim-kernel/src/connections/electrical/equipment.ts",
  "bim-kernel/src/connections/electrical/estimates.ts",
  "bim-kernel/src/connections/electrical/fed-from.ts",
  "bim-kernel/src/connections/electrical/inventory.ts",
  "bim-kernel/src/connections/electrical/load-classes.ts",
  "bim-kernel/src/connections/electrical/loads.ts",
  "bim-kernel/src/connections/electrical/panel.ts",
  "bim-kernel/src/connections/electrical/proposals.ts",
  "bim-kernel/src/connections/electrical/readiness.ts",
  "bim-kernel/src/connections/electrical/rebalance.ts",
  "bim-kernel/src/connections/electrical/rules.ts",
  "bim-kernel/src/connections/electrical/service-layout.ts",
  "bim-kernel/src/connections/electrical/synthetic.ts",
  "bim-kernel/src/connections/electrical/systems.ts",
  "bim-kernel/src/connections/electrical/templates.ts",
  "bim-kernel/src/diagrams/electrical-graph.ts",
  "bim-kernel/src/diagrams/feeder-types.ts",
  "bim-kernel/src/fields/electrical-resolver.ts",
  "bim-kernel/src/fields/feeder-types.ts",
  "bim-kernel/src/fields/providers/electrical.ts",
  "bim-kernel/src/fields/rules-registry.ts",
  "bim-kernel/src/library/electrical.ts",
  "bim-kernel/src/packs/first-party/electrical.ts",
  "bim-kernel/src/packs/first-party/index.ts",
  "bim-kernel/src/propose/receptacles.ts",
  "bim-kernel/src/schedules/forms/distribution-forms.ts",
] as const;

/** The kernel trade-term ratchet's electrical words (trade-terms.test.ts): the trade by name, its distribution words and its code book. */
const ELECTRICAL_TERMS = ["electrical", "breaker", "panelboard", "panel", "circuit", "feeder", "receptacle", "conductor", "conduit", "ampacity", "voltage", "kva", "amps", "nec"] as const;
const WORDS: ReadonlyMap<string, string> = new Map(ELECTRICAL_TERMS.flatMap((t) => [[t, t], [`${t}s`, t], [`${t}es`, t]] as const));

function countTerms(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  const split = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  for (const raw of split.split(/[^A-Za-z]+/)) {
    if (raw.length < 3) continue;
    const term = WORDS.get(raw.toLowerCase());
    if (term) out[term] = (out[term] ?? 0) + 1;
  }
  return out;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "__tests__" || name === "node_modules") continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

function totals(files: readonly string[]): Record<string, number> {
  const sum: Record<string, number> = Object.fromEntries(ELECTRICAL_TERMS.map((t) => [t, 0]));
  for (const f of files) for (const [t, n] of Object.entries(countTerms(readFileSync(f, "utf8")))) sum[t] = (sum[t] ?? 0) + n;
  return sum;
}

interface Baseline {
  readonly files: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

function baselineTotals(): Record<string, number> {
  const raw: unknown = JSON.parse(readFileSync(path.join(PACKAGES, "bim-kernel/src/__tests__/trade-terms.batch-5c.json"), "utf8"));
  if (typeof raw !== "object" || raw === null || !("files" in raw)) throw new Error("trade-terms.batch-5c.json needs files");
  const sum: Record<string, number> = Object.fromEntries(ELECTRICAL_TERMS.map((t) => [t, 0]));
  for (const byTerm of Object.values((raw as Baseline).files)) for (const t of ELECTRICAL_TERMS) sum[t] = (sum[t] ?? 0) + (byTerm[t] ?? 0);
  return sum;
}

const KERNEL_AND_CALC = [...sourceFiles(path.join(PACKAGES, "bim-kernel/src")), ...sourceFiles(path.join(PACKAGES, "bim-calc/src"))];

describe("c6e: the kernel has no electrical", () => {
  it("holds none of the files that moved into the Electrical add-on", () => {
    expect(MOVED.filter((f) => existsSync(path.join(PACKAGES, f)))).toEqual([]);
    expect(existsSync(path.join(PACKAGES, "bim-kernel/src/connections/electrical"))).toBe(false);
    expect(existsSync(path.join(PACKAGES, "bim-calc/src/electrical"))).toBe(false);
    // The stored load-class names stay: every host parses a catalog's loadClass, add-on or not.
    expect(existsSync(path.join(PACKAGES, "bim-kernel/src/catalog/load-classes.ts"))).toBe(true);
  });

  it("imports nothing from the add-on, in the kernel or in bim-calc", () => {
    const importers = KERNEL_AND_CALC.filter((f) => /from\s+["']@permitzip\/bim-pack-electrical["']|bim-pack-electrical\/src/.test(readFileSync(f, "utf8")));
    expect(importers.map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  it("names no electrical module path in a kernel or bim-calc import", () => {
    const stale = KERNEL_AND_CALC.filter((f) => /from\s+["'][^"']*(connections\/electrical\/|\/electrical-symbols|\/electrical-graph|\/electrical-resolver|\/rules-registry|\/distribution-forms|\/receptacles|library\/electrical|calc\/src\/electrical)/.test(readFileSync(f, "utf8")));
    expect(stale.map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  it("the kernel's electrical words fell against the batch-5c baseline", () => {
    const before = baselineTotals();
    const after = totals(sourceFiles(path.join(PACKAGES, "bim-kernel/src")));
    const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);
    console.log(`[c6e] kernel electrical words: before ${sum(before)} ${JSON.stringify(before)}; after ${sum(after)} ${JSON.stringify(after)}`);
    expect(sum(after)).toBeLessThan(sum(before));
    expect(after.electrical ?? 0).toBeLessThan(before.electrical ?? 0);
  });

  // Was r5l-load-order: the kernel's barrel exported these moved names; the add-on's does now.
  it("exports the names r5l moved, from the add-on's barrel", () => {
    const addon = require("../src") as Record<string, unknown>;
    for (const name of ["equipmentNameplate", "equipmentConnectionOf"]) expect([name, typeof addon[name]]).toEqual([name, "function"]);
  });

  // Was r5l-load-order (C5, C6): balance and the nameplate read loaded without the adapter table. Out of the kernel they load on its public entry alone.
  it("balance and the equipment nameplate load on their own", () => {
    expect(() =>
      jest.isolateModules(() => {
        require("../src/connections/balance");
        require("../src/connections/equipment");
      }),
    ).not.toThrow();
  });
});
