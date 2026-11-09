/**
 * @jest-environment node
 *
 * @mutinybim-bare-kernel: reads source files only; no add-on is needed.
 *
 * Mechanical air left the kernel and `bim-calc` (round 6, lane M): the moved
 * files are gone from their sources, nothing there imports the add-on, the
 * removed `/ventilation` kernel entry is read nowhere, and the kernel's mechanical
 * words fell below the trade-term baseline. Before the move every listed file
 * existed and the totals were the baseline's.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const PACKAGES = path.resolve(__dirname, "../..");

const MOVED = [
  "bim-calc/src/mechanical/makeup-air.ts",
  "bim-calc/src/mechanical/plugins.ts",
  "bim-calc/src/mechanical/pressurization.ts",
  "bim-calc/src/ventilation/engine.ts",
  "bim-calc/src/ventilation/index.ts",
  "bim-calc/src/ventilation/kernel-seam.ts",
  "bim-calc/src/ventilation/plugin.ts",
  "bim-calc/src/ventilation/space.ts",
  "bim-calc/src/ventilation/standards.ts",
  "bim-kernel/src/balance/makeup-air.ts",
  "bim-kernel/src/balance/pressurization.ts",
  "bim-kernel/src/blocks/pressurization-table.ts",
  "bim-kernel/src/blocks/ventilation-table.ts",
  "bim-kernel/src/connections/mechanical/adapter.ts",
  "bim-kernel/src/fields/providers/mechanical.ts",
  "bim-kernel/src/fields/providers/pressurization.ts",
  "bim-kernel/src/fields/providers/ventilation.ts",
  "bim-kernel/src/packs/first-party/mechanical.ts",
  "bim-kernel/src/routing/duct-design-commands.ts",
  "bim-kernel/src/routing/duct-sizing.ts",
  "bim-kernel/src/ventilation.ts",
  "bim-lint/src/rules/packs/balance.ts",
];

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "__tests__" || name === "node_modules") continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const MECH_TERMS = ["mechanical", "hvac", "duct", "cfm", "diffuser", "airflow", "ventilation", "imc"] as const;
const WORDS: ReadonlyMap<string, string> = new Map(MECH_TERMS.flatMap((t) => [[t, t], [`${t}s`, t], [`${t}es`, t]] as const));

function mechanicalWords(text: string): number {
  const split = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  return split.split(/[^A-Za-z]+/).filter((w) => WORDS.has(w.toLowerCase())).length;
}

describe("the kernel without Mechanical", () => {
  it("has none of the moved files", () => {
    expect(MOVED.filter((f) => existsSync(path.join(PACKAGES, f)))).toEqual([]);
  });

  it("kernel, bim-calc, bim-lint and bim-pack source import nothing from the add-on, and nothing reads the removed /ventilation entry", () => {
    const offenders: string[] = [];
    for (const pkg of ["bim-kernel", "bim-calc", "bim-lint", "bim-pack"]) {
      for (const file of sources(path.join(PACKAGES, pkg, "src"))) {
        const src = readFileSync(file, "utf8");
        if (/from\s+["']@permitzip\/bim-pack-mechanical["']|from\s+["']@permitzip\/bim-kernel\/ventilation["']/.test(src)) offenders.push(path.relative(PACKAGES, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("has fewer mechanical words than the trade-term baseline", () => {
    const baselineRaw: unknown = JSON.parse(readFileSync(path.join(PACKAGES, "bim-kernel/src/__tests__/trade-terms.batch-5c.json"), "utf8"));
    if (typeof baselineRaw !== "object" || baselineRaw === null || !("files" in baselineRaw) || typeof baselineRaw.files !== "object" || baselineRaw.files === null) throw new Error("trade-terms baseline has no files");
    let before = 0;
    for (const byTerm of Object.values(baselineRaw.files)) {
      if (typeof byTerm !== "object" || byTerm === null) continue;
      for (const [term, n] of Object.entries(byTerm)) if ((MECH_TERMS as readonly string[]).includes(term) && typeof n === "number") before += n;
    }
    const after = sources(path.join(PACKAGES, "bim-kernel/src")).reduce((n, f) => n + mechanicalWords(readFileSync(f, "utf8")), 0);
    process.stdout.write(`[c6m] kernel mechanical words: baseline ${before}, now ${after}\n`);
    expect(after).toBeLessThan(before);
  });
});
