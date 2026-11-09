/**
 * @jest-environment node
 *
 * Guard: no new full-model scans through the element record's proxy in hot
 * paths. `Object.values / entries / keys(x.elements)` and `for (… in
 * x.elements)` go through a proxy trap per key: 50-160 ms on a 250k model
 * (163 ms against 5 ms for `elementValues`, measured 2026-10-22), and worse on
 * a prediction. Use `elementValues` / `elementEntries` / `elementKeys` /
 * `elementCount`, or `elementsOfKind` when only some kinds matter (indexed,
 * reused across revisions).
 *
 * A scan over something that is not a model's element record (a calculation
 * report's `elements`, a test fixture) can stay: end the line with
 * `// full-scan-ok: <why>`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../..");
const HOT_PATHS = [
  "packages/bim-kernel/src",
  "packages/bim-sync/src",
  "packages/bim-sheets/src",
  "packages/bim-calc/src",
  "packages/bim-viewer/src",
  "packages/bim-viewer-3d/src",
  "packages/bim-ui/src",
  "packages/bim-editor/src",
  "components/building-model",
  "lib/bim",
  "lib/mcp/tools",
  "services/bim-authority/src",
];
/** The element store implements these reads; it is the one place allowed to touch the record directly. */
const IMPLEMENTATION = new Set(["packages/bim-kernel/src/store.ts"]);
/** Calculation reports that carry their own `elements` record (not a model). */
const NOT_A_MODEL = /\b(report|result|summary|totals)\.elements\b/;

const SCAN = /Object\.(?:values|entries|keys)\(\s*[\w$.?!]*\.elements\s*\)|for\s*\(\s*(?:const|let|var)\s+[\w$]+\s+in\s+[\w$.?!]*\.elements\s*\)/;

function sourceFiles(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  let entries: string[];
  try {
    entries = readdirSync(abs);
  } catch (err) {
    // A tree without the host's screens (the standalone repo) has nothing there to scan. Not `instanceof Error`: fs errors come from another realm under jsdom.
    if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") return [];
    throw err;
  }
  const out: string[] = [];
  for (const name of entries) {
    if (name === "node_modules" || name === "__tests__" || name === "dist") continue;
    const rel = path.join(dir, name);
    if (statSync(path.join(ROOT, rel)).isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name)) out.push(rel);
  }
  return out;
}

describe("no full-model scans in hot paths", () => {
  it("uses the indexed element reads instead of Object.values/entries/keys or for-in on a model's elements", () => {
    const offenders: string[] = [];
    for (const dir of HOT_PATHS) {
      for (const file of sourceFiles(dir)) {
        if (IMPLEMENTATION.has(file)) continue;
        readFileSync(path.join(ROOT, file), "utf8")
          .split("\n")
          .forEach((line, i) => {
            if (!SCAN.test(line) || NOT_A_MODEL.test(line) || line.includes("full-scan-ok:")) return;
            offenders.push(`${file}:${i + 1}: ${line.trim()}`);
          });
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the guard catches the shapes it is meant to", () => {
    expect(SCAN.test("for (const el of Object.values(model.elements)) {")).toBe(true);
    expect(SCAN.test("const n = Object.keys(view.elements).length")).toBe(true);
    expect(SCAN.test("for (const id in model.elements) {")).toBe(true);
    expect(SCAN.test("for (const el of elementValues(model.elements)) {")).toBe(false);
    expect(NOT_A_MODEL.test("Object.values(report.elements)")).toBe(true);
  });
});
