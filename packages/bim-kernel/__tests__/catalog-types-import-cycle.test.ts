/**
 * @jest-environment node
 *
 * `catalog/types.ts` builds its zod schemas at load time from constants it
 * imports (`z.enum(ELECTRICAL_LOAD_CLASSES)`). If any of those imports leads
 * back to `catalog/types.ts` at runtime, whichever module the bundle enters
 * first decides whether the constant exists yet. Round 4 changed that order
 * and the production build died collecting
 * `/api/projects/[id]/building-model/route-defaults` with
 * "Cannot access … before initialization" (loads.ts → catalog/model.ts →
 * catalog/types.ts → loads.ts). Type-only imports vanish at runtime and do not
 * count.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const SRC = path.resolve(__dirname, "../src");
const TARGET = path.join(SRC, "catalog/types.ts");

const IMPORT_RE = /^\s*(import|export)\s+([^;]*?)\s+from\s+["'](\.{1,2}\/[^"']+)["']/gm;
const SIDE_EFFECT_RE = /^\s*import\s+["'](\.{1,2}\/[^"']+)["']/gm;

function isTypeOnly(clause: string): boolean {
  if (/^type\b/.test(clause)) return true;
  const braces = clause.match(/^\{([\s\S]*)\}$/);
  if (!braces?.[1]) return false;
  const names = braces[1].split(",").map((s) => s.trim()).filter(Boolean);
  return names.length > 0 && names.every((n) => n.startsWith("type "));
}

function resolve(from: string, spec: string): string | null {
  const base = path.resolve(path.dirname(from), spec);
  for (const candidate of [`${base}.ts`, path.join(base, "index.ts"), base]) {
    if (candidate.endsWith(".ts") && existsSync(candidate)) return candidate;
  }
  return null;
}

function valueImports(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const out: string[] = [];
  for (const m of source.matchAll(IMPORT_RE)) {
    const clause = (m[2] ?? "").replace(/\s+/g, " ").trim();
    if (m[3] && !isTypeOnly(clause)) {
      const target = resolve(file, m[3]);
      if (target) out.push(target);
    }
  }
  for (const m of source.matchAll(SIDE_EFFECT_RE)) {
    const target = m[1] ? resolve(file, m[1]) : null;
    if (target) out.push(target);
  }
  return out;
}

function cycleBackTo(start: string): string[] | null {
  const seen = new Set<string>();
  const stack: Array<{ file: string; trail: string[] }> = valueImports(start).map((file) => ({ file, trail: [start, file] }));
  while (stack.length > 0) {
    const next = stack.pop();
    if (!next) break;
    if (next.file === start) return next.trail;
    if (seen.has(next.file)) continue;
    seen.add(next.file);
    for (const dep of valueImports(next.file)) stack.push({ file: dep, trail: [...next.trail, dep] });
  }
  return null;
}

describe("catalog/types import graph", () => {
  it("reads value imports, so the check below is not vacuous", () => {
    expect(valueImports(TARGET).map((f) => path.relative(SRC, f))).toContain("catalog/load-classes.ts");
  });

  it("is not on a runtime import cycle", () => {
    const cycle = cycleBackTo(TARGET);
    expect(cycle?.map((f) => path.relative(SRC, f)).join(" → ") ?? null).toBeNull();
  });

  it("builds its schemas when the electrical loads module is loaded first", () => {
    jest.isolateModules(() => {
      require("../../bim-pack-electrical/src/connections/loads");
      const { connectionTypeSchema } = require("../src/catalog/types") as typeof import("../src/catalog/types");
      expect(connectionTypeSchema.parse({ type: "connection_type", designator: "E.05", loadClass: "motor" }).loadClass).toBe("motor");
    });
  });
});
