/**
 * @jest-environment node
 *
 * Round 13 guard: the kernel names no building discipline. Walls, doors,
 * windows, roofs and stairs get their types, rules and IFC mapping from the
 * Architecture add-on, so the kernel's sources say `architecture` /
 * `architectural` (any case) and `arch.<id>` class ids less over time, never
 * more.
 *
 * Counted: every `.ts` file under packages/bim-kernel/src except tests.
 * Fails when a file's count rises, or when a file the baseline doesn't list
 * uses one. Passes and prints the new numbers when a count falls: lower
 * `a13-kernel-names-no-building-discipline.baseline.json` to them
 * (A13_BUILDING_WRITE=1 rewrites it; only ever commit a baseline that goes
 * down). The coordinator owns the baseline.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const SRC = path.join(__dirname, "..", "src");
const BASELINE_FILE = path.join(__dirname, "a13-kernel-names-no-building-discipline.baseline.json");
const PATTERN = /\barchitectur(?:e|al)\b|\barch\.[a-z]/gi;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== "__tests__") out.push(...sources(full));
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

function counts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const file of sources(SRC)) {
    const n = (readFileSync(file, "utf8").match(PATTERN) ?? []).length;
    if (n > 0) out[path.relative(SRC, file).split(path.sep).join("/")] = n;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

describe("a13 kernel names no building discipline", () => {
  it("no kernel file names a building discipline more than the baseline allows", () => {
    const now = counts();
    if (process.env.A13_BUILDING_WRITE === "1") {
      writeFileSync(BASELINE_FILE, `${JSON.stringify({ comment: "Shrink-only. Lower only; see the test's header.", files: now }, null, 2)}\n`);
    }
    const baseline = (JSON.parse(readFileSync(BASELINE_FILE, "utf8")) as { files: Record<string, number> }).files;
    const rises = Object.entries(now).flatMap(([file, n]) => (n > (baseline[file] ?? 0) ? [`${file}: ${baseline[file] ?? 0} -> ${n}`] : []));
    expect(rises).toEqual([]);
    const total = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);
    if (total(now) < total(baseline)) console.log(`[a13-kernel-names] building-discipline names fell ${total(baseline)} -> ${total(now)}; lower the baseline`);
  });
});
