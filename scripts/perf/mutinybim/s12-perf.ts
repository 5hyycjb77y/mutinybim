/**
 * Round 12 S12 perf rows. Not run by builders (resource rules); the
 * coordinator runs it through the heavy lock before and after and sets the
 * budgets in docs/perf/mutinybim-budgets.json.
 *
 * - calc_sheet.recompute.after_edit.<n>: one edit to one element in a model
 *   of n elements holding 2,000 live sheets (each bound to one element): only
 *   the sheets that read it re-run. p50 / p95 ms and `rerun` (expect 1).
 *   Budget per the brief: 10 ms at 250k, 20 ms at 1M.
 * - design_limit.check.one_edit.<n>: the design limit problem source after
 *   one edit among n measured runs (re-measures the changed id only). Budget:
 *   the lint one-edit row + 5 %.
 * - typical.mirror.outlines.500: "typical to" outlines for one typical with
 *   500 copies, every other one mirrored (four points per copy; totals use the
 *   multiplier, never expansion). Measured first; no budget yet.
 * - intake.cells_to_rows.60: the deterministic mapping of a 60-row, 8-column
 *   read. Budget 200 ms (off the edit path).
 *
 *   node --expose-gc --import tsx scripts/perf/mutinybim/s12-perf.ts [--sizes 250000,1000000]
 */
import { PackSet, contribute, definePack, withPackSet, CALC_SHEET_POINT, DESIGN_LIMIT_DEFAULT_POINT, INTAKE_COLUMN_POINT } from "../../../packages/bim-pack/src";
import { FIELD_RESOLVER_POINT } from "../../../packages/bim-pack/src/runtime";
import { CalcSheetSession, type CalcSheetSpec } from "../../../packages/bim-kernel/src/calc-sheets";
import { DESIGN_LIMIT_MEASURE_POINT, designLimitFindingSource, type DesignLimitMeasurement } from "../../../packages/bim-kernel/src/policy";
import { proposeIntakeRows, type TableReadCell } from "../../../packages/bim-kernel/src/propose/intake";
import { typicalCopyOutlines } from "../../../packages/bim-kernel/src/annotation/typical-graphics";
import type { BimElement, ElementId, ModelState, PartInstance } from "../../../packages/bim-kernel/src";
import type { FindingRef } from "../../../packages/bim-kernel/src/findings/ref";
import { gc, percentile, round, timeSync } from "./lib";

const SAMPLES = 9;
const SHEETS = 2000;

type Thing = { readonly id: string; readonly kind: "s12_thing"; readonly a: number; readonly v: number };

const pack = definePack({ id: "s12perf", name: "S12 perf", version: "1.0.0", kernel: "^1.10.0" }, [
  contribute(FIELD_RESOLVER_POINT, [
    { id: "s12perf.fields", resolveRank: 30, listRank: 30, paths: [], resolve: (els, id, path) => { const t = els[id] as unknown as Thing | undefined; return t?.kind === "s12_thing" && path === "s12perf.a" ? { value: t.a, text: String(t.a) } : null; } },
  ]),
  contribute(CALC_SHEET_POINT, [{ id: "s12perf.sheet", label: "Perf sheet", build: () => ({ refused: "unused" }) }]),
  contribute(DESIGN_LIMIT_DEFAULT_POINT, [{ id: "s12perf.v", label: "Velocity", quantity: "velocity", unit: "ft/s", appliesTo: {}, band: { max: 8 }, severity: "warning", citation: { source: "Perf" } }]),
  contribute(DESIGN_LIMIT_MEASURE_POINT, [
    {
      id: "s12perf.measure",
      label: "Perf velocity",
      quantities: ["velocity"],
      measure: (model: ModelState, ids?: ReadonlySet<string>): DesignLimitMeasurement[] => {
        const out: DesignLimitMeasurement[] = [];
        const list = ids ? [...ids].map((id) => model.elements[id]) : Object.values(model.elements);
        for (const el of list as unknown as (Thing | undefined)[]) if (el?.kind === "s12_thing") out.push({ elementId: el.id as ElementId, label: "Velocity", selector: { quantity: "velocity" }, value: el.v, unit: "ft/s" });
        return out;
      },
    },
  ]),
  contribute(INTAKE_COLUMN_POINT, [{ id: "s12perf.mark", label: "Mark", headings: ["MARK"], field: "mark" }, { id: "s12perf.kw", label: "kW", headings: ["KW"], field: "s12perf.kw", unit: "kW" }]),
]);

function modelOf(n: number): ModelState {
  const elements: Record<string, BimElement> = {};
  for (let i = 0; i < n; i++) elements[`t${i}`] = { id: `t${i}`, kind: "s12_thing", a: i % 97, v: (i % 13) * 0.75 } as unknown as BimElement;
  return { modelId: "s12-perf", revision: 1, elements, connections: [] } as unknown as ModelState;
}

const sheet = (id: string): CalcSheetSpec => ({
  template: "s12perf.sheet",
  title: "Perf",
  inputs: [{ key: "a", label: "A", unit: "ft", bind: { from: "field", subjectId: id as ElementId, path: "s12perf.a" } }],
  lookups: [],
  steps: [{ key: "b", label: "B", formula: "{a} * 2 + 1", unit: "ft" }],
  checks: [],
  citations: [],
  result: { key: "b", label: "B" },
});

function stats(ms: number[]) {
  return { p50: round(percentile(ms, 50) ?? 0), p95: round(percentile(ms, 95) ?? 0) };
}

function recompute(n: number) {
  const m0 = modelOf(n);
  const session = new CalcSheetSession({ tables: { table: () => null }, limits: {} });
  for (let i = 0; i < SHEETS; i++) session.put(m0, `sheet-${i}`, sheet(`t${Math.floor((i * n) / SHEETS)}`));
  const ms: number[] = [];
  let rerun = 0;
  for (let s = 0; s < SAMPLES; s++) {
    const id = `t${Math.floor(((s * 37) % SHEETS) * (n / SHEETS))}`;
    const prev = m0.elements[id] as unknown as Thing;
    const m = { ...m0, elements: { ...m0.elements, [id]: { ...prev, a: prev.a + 1 } as unknown as BimElement } } as ModelState;
    gc();
    const t = timeSync(() => session.applyEdit(m, [id]));
    ms.push(t.ms);
    rerun = t.value.length;
  }
  return { row: `calc_sheet.recompute.after_edit.${n}`, ...stats(ms), rerun };
}

function limitOneEdit(n: number) {
  const m = modelOf(n);
  const source = designLimitFindingSource({ limits: () => ({}) });
  const all = source.all({ model: m, lineageId: "main" });
  const ledger = new Map<string, FindingRef>(all.map((f) => [f.id, f]));
  const bySubject = new Map<string, FindingRef[]>();
  for (const f of all) for (const s of f.subjects) bySubject.set(s, [...(bySubject.get(s) ?? []), f]);
  const ms: number[] = [];
  for (let s = 0; s < SAMPLES; s++) {
    const id = `t${(s * 7919) % n}`;
    gc();
    ms.push(timeSync(() => source.changed?.({ model: m, previous: m, lineageId: "main", changedIds: [id], current: ledger, touching: (ids) => [...ids].flatMap((x) => bySubject.get(x) ?? []) })).ms);
  }
  return { row: `design_limit.check.one_edit.${n}`, ...stats(ms), findings: all.length };
}

function mirrorOutlines() {
  const group = { id: "g", kind: "organization", entry: { type: "group", name: "Unit", color: "#000000", description: "", locked: false, defaultVisibility: "show", order: 1, typical: { label: "Unit", mark: "001", basePoint: { x: 0, y: 0 }, copies: Array.from({ length: 500 }, (_, i) => ({ id: `g:${i}`, mark: `${i + 2}`, offset: { x: (i + 1) * 10_000, y: 0 }, rotationDeg: 0, ...(i % 2 === 0 ? { mirror: { axis: "x" } } : {}) })) } } } as unknown as BimElement;
  const parts = Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, kind: "part", groupId: "g", position: { x: i * 300, y: i * 100 }, rotationDeg: 0 }) as unknown as PartInstance);
  const model = { elements: { g: group, ...Object.fromEntries(parts.map((p) => [p.id, p])) }, connections: [] } as unknown as ModelState;
  const ms: number[] = [];
  for (let s = 0; s < SAMPLES; s++) {
    gc();
    ms.push(timeSync(() => typicalCopyOutlines(model, parts)).ms);
  }
  return { row: "typical.mirror.outlines.500", ...stats(ms) };
}

function intake60() {
  const cells: TableReadCell[] = [];
  const heads = ["MARK", "KW", "DESC", "VOLTS", "PH", "AMPS", "GAS", "REMARKS"];
  heads.forEach((h, c) => cells.push({ row: 0, column: c, text: h, confidence: 0.99 }));
  for (let r = 1; r <= 60; r++) heads.forEach((_, c) => cells.push({ row: r, column: c, text: c === 0 ? `K-${r}` : String(r * 1.5), confidence: r % 9 === 0 ? 0.5 : 0.95 }));
  const read = { source: { name: "perf.png", kind: "image" as const }, pages: [{ index: 0 }], cells, headerRow: 0, notes: [] };
  const ms: number[] = [];
  for (let s = 0; s < SAMPLES; s++) {
    gc();
    ms.push(timeSync(() => proposeIntakeRows(read)).ms);
  }
  return { row: "intake.cells_to_rows.60", ...stats(ms) };
}

const sizesArg = process.argv.indexOf("--sizes");
const sizes = sizesArg > 0 ? (process.argv[sizesArg + 1] ?? "").split(",").map(Number).filter((n) => n > 0) : [250_000, 1_000_000];

withPackSet(PackSet.create([pack]), () => {
  for (const n of sizes) {
    console.log(JSON.stringify(recompute(n)));
    console.log(JSON.stringify(limitOneEdit(n)));
  }
  console.log(JSON.stringify(mirrorOutlines()));
  console.log(JSON.stringify(intake60()));
});
