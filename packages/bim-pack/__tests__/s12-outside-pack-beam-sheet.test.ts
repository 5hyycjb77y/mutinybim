/**
 * @jest-environment node
 *
 * s12-outside-pack-beam-sheet, s12-calc-sheet-governing-cell,
 * s12-calc-sheet-recompute-on-input-only, s12-calc-sheet-snapshot.
 *
 * A test structural add-on (not first-party, not the structural pack) reads
 * a beam's span and load through its own field resolver, registers a beam
 * check sheet, a deflection default and nothing else, with zero kernel
 * edits. The sheet looks up a capacity table the firm keeps, marks the
 * governing cell, checks against design limits (project over firm over the
 * add-on's default), re-runs only when the beam it reads changes, and
 * freezes with the governing cell pinned.
 *
 * Fails on round 11's code: there is no calculation sheet point or
 * evaluator (and on wave 0's, `evaluateCalcSheet` refuses "aren't built yet").
 */
import { CALC_SHEET_POINT, DESIGN_LIMIT_DEFAULT_POINT, PackSet, contribute, definePack, evaluateCalcSheet, isPackRefusal, runPackConformance, withPackSet, type CalcSheetSpec, type CalcTable, type DesignLimit, type Pack } from "../src";
import { FIELD_RESOLVER_POINT } from "../src/runtime";
import { CALC_GOVERNING_WORDS, CalcSheetSession, calcSheetSnapshot, calcSheetValueHash, calcSheetPins, placeCalcSheet, renderCalcSheet, headingNumber, type CalcSheetContext } from "@permitzip/bim-kernel/calc-sheets";
import { blockFreshness } from "@permitzip/bim-kernel";
import type { BimElement, ElementId, ModelState } from "@permitzip/bim-kernel";

type Beam = { readonly id: string; readonly kind: "zz_beam"; readonly span: number; readonly load: number };

function modelOf(beams: readonly Beam[]): ModelState {
  const elements: Record<string, BimElement> = {};
  for (const b of beams) elements[b.id] = b as unknown as BimElement;
  return { elements } as unknown as ModelState;
}

const beamSheet = (subjectId: string): CalcSheetSpec => ({
  template: "zz.beam_check",
  title: "Beam check",
  inputs: [
    { key: "span", label: "Span", unit: "ft", bind: { from: "field", subjectId: subjectId as ElementId, path: "zz.span" } },
    { key: "load", label: "Uniform load", unit: "plf", bind: { from: "field", subjectId: subjectId as ElementId, path: "zz.load" } },
  ],
  lookups: [{ key: "size", label: "Beam size", table: { slot: "zz.beam_capacity" }, row: { input: "span", match: "next_up" }, column: { input: "load", match: "next_up", by: "value" }, unit: "plf" }],
  steps: [
    { key: "use", label: "Use", formula: "{load} / {size}", unit: "1" },
    { key: "defl", label: "Deflection ratio", formula: "{span} * 12 / 360 * {use}", unit: "in" },
  ],
  checks: [{ key: "defl_ok", label: "Deflection", value: "defl", limit: { quantity: "length", discipline: "zz" } }],
  citations: [{ section: "Beam table 2", edition: "Test edition", note: "our summary" }],
  result: { key: "size", label: "Beam capacity" },
});

const capacity: CalcTable = {
  id: "zz.beam_capacity",
  label: "Beam capacity",
  rowHeading: { label: "Span", unit: "ft" },
  columnHeading: { label: "Size", unit: "in" },
  rows: [10, 15, 20],
  columns: ["6", "8", "10", "1-1/4"],
  values: [
    [400, 700, 1100, 50],
    [180, 320, 500, 20],
    [100, 180, 280, null],
  ],
};

const deflection = (id: string, max: number, extra: Partial<DesignLimit> = {}): DesignLimit => ({
  id,
  label: "Beam deflection",
  quantity: "length",
  unit: "in",
  appliesTo: { discipline: "zz" },
  band: { max },
  severity: "warning",
  citation: { source: "Test structural practice" },
  ...extra,
});

const pack: Pack = definePack({ id: "zz", name: "Test structural", version: "1.0.0", kernel: "^1.10.0" }, [
  contribute(FIELD_RESOLVER_POINT, [
    {
      id: "zz.beam_fields",
      resolveRank: 30,
      listRank: 30,
      paths: [],
      resolve: (elements, id, path) => {
        const el = elements[id] as unknown as Partial<Beam> | undefined;
        if (el?.kind !== "zz_beam") return null;
        const v = path === "zz.span" ? el.span : path === "zz.load" ? el.load : undefined;
        return v === undefined ? null : { value: v, text: String(v) };
      },
    },
  ]),
  contribute(CALC_SHEET_POINT, [{ id: "zz.beam_check", label: "Beam check", discipline: "zz", subjectKinds: ["zz_beam"], build: (_m, req) => (req.subjectId ? beamSheet(req.subjectId) : { refused: "Pick a beam" }) }]),
  contribute(DESIGN_LIMIT_DEFAULT_POINT, [deflection("zz.beam_deflection", 1)]),
]);

const ctx = (extra: Partial<CalcSheetContext> = {}): CalcSheetContext => ({ tables: { table: (slot) => (slot === capacity.id ? capacity : null) }, limits: {}, ...extra });

describe("s12-outside-pack-beam-sheet", () => {
  it("an outside add-on's sheet, field resolver and limit pass conformance and work out with no kernel edit", () => {
    expect(runPackConformance(pack).problems).toEqual([]);
    withPackSet(PackSet.create([pack]), () => {
      const model = modelOf([{ id: "b1", kind: "zz_beam", span: 14, load: 300 }]);
      const placed = placeCalcSheet(model, "zz.beam_check", { subjectId: "b1" as ElementId }, ctx());
      if (isPackRefusal(placed)) throw new Error(placed.refused);
      expect(placed.evaluation.values.size).toBe(320);
      expect(placed.evaluation.missing).toEqual([]);
      expect(placeCalcSheet(model, "zz.beam_check", {}, ctx())).toEqual({ refused: "Pick a beam" });
      expect(placeCalcSheet(model, "nope.sheet", {}, ctx())).toEqual({ refused: "No add-on in this model has the nope.sheet calculation" });
    });
  });
});

describe("s12-calc-sheet-governing-cell", () => {
  it("reads the row up and across the row for the first capacity at or above the load, and marks that cell", () => {
    withPackSet(PackSet.create([pack]), () => {
      const model = modelOf([{ id: "b1", kind: "zz_beam", span: 14, load: 300 }]);
      const ev = evaluateCalcSheet(model, beamSheet("b1"), ctx());
      if (isPackRefusal(ev)) throw new Error(ev.refused);
      expect(ev.governing).toEqual([{ lookup: "size", rowIndex: 1, columnIndex: 1, rowLabel: "15 ft", columnLabel: "8", value: 320, unit: "plf" }]);
      expect(ev.values.size_row).toBe(15);
      expect(ev.values.size_column).toBe(8);
      expect(ev.values.use).toBeCloseTo(300 / 320, 9);
      const text = renderCalcSheet(beamSheet("b1"), ev).text;
      expect(text).toContain(`Beam size | 320 | plf | ${CALC_GOVERNING_WORDS}: 15 ft row, 8 column`);
      expect(text).toContain("Reference: Beam table 2 (Test edition), our summary");
    });
  });

  it("checks against the most specific limit, project over firm over the add-on default, naming who set it", () => {
    withPackSet(PackSet.create([pack]), () => {
      const model = modelOf([{ id: "b1", kind: "zz_beam", span: 14, load: 300 }]);
      // defl = 14 * 12 / 360 * (300 / 320) = 0.4375 in
      const run = (limits: CalcSheetContext["limits"]) => {
        const ev = evaluateCalcSheet(model, beamSheet("b1"), ctx({ limits }));
        if (isPackRefusal(ev)) throw new Error(ev.refused);
        return ev.checks[0];
      };
      expect(run({})).toMatchObject({ pass: true, limitId: "zz.beam_deflection", message: "Deflection ratio 0.44 in within the default 1 in" });
      expect(run({ firm: [deflection("zz.beam_deflection", 0.4, { setBy: { name: "Rowan", at: "2026-11-03T00:00:00Z" } })] })).toMatchObject({ pass: false, message: "Deflection ratio 0.44 in over the firm's 0.4 in (set by Rowan)" });
      expect(run({ firm: [deflection("zz.beam_deflection", 0.4)], project: [deflection("zz.beam_deflection", 0.5)] })).toMatchObject({ pass: true, message: "Deflection ratio 0.44 in within the project's 0.5 in" });
    });
  });

  it("never guesses: a missing table, row or limit leaves the line empty and says what to add", () => {
    withPackSet(PackSet.create([pack]), () => {
      const long = modelOf([{ id: "b1", kind: "zz_beam", span: 30, load: 300 }]);
      const ev = evaluateCalcSheet(long, beamSheet("b1"), ctx());
      if (isPackRefusal(ev)) throw new Error(ev.refused);
      expect(ev.values.size).toBeNull();
      expect(ev.governing).toEqual([]);
      expect(ev.missing).toEqual(["Beam size: Beam capacity has no row for 30 ft"]);
      expect(ev.checks[0]?.pass).toBeNull();
      const noTable = evaluateCalcSheet(long, beamSheet("b1"), { tables: { table: () => null }, limits: {} });
      if (isPackRefusal(noTable)) throw new Error(noTable.refused);
      expect(noTable.missing[0]).toMatch(/add the table this sheet reads \(zz.beam_capacity\)/);
    });
    expect(headingNumber("1-1/4")).toBe(1.25);
    expect(headingNumber("3/4\"")).toBe(0.75);
    expect(headingNumber("Type L")).toBeNull();
  });
});

describe("s12-calc-sheet-recompute-on-input-only", () => {
  it("an edit re-runs only the sheets whose beam changed", () => {
    withPackSet(PackSet.create([pack]), () => {
      const beams: Beam[] = [];
      for (let i = 0; i < 50; i++) beams.push({ id: `b${i}`, kind: "zz_beam", span: 12, load: 200 });
      let model = modelOf(beams);
      const session = new CalcSheetSession(ctx());
      for (const b of beams) session.put(model, `sheet-${b.id}`, beamSheet(b.id));
      expect(session.evaluations).toBe(50);
      expect(session.get("sheet-b7")?.evaluation.dependsOn).toEqual(["b7"]);
      beams[7] = { ...beams[7]!, load: 450 };
      model = modelOf(beams);
      expect(session.applyEdit(model, ["b7", "something-else"])).toEqual(["sheet-b7"]);
      expect(session.evaluations).toBe(51);
      expect(session.get("sheet-b7")?.evaluation.values.size).toBe(500);
      expect(session.applyEdit(model, ["unrelated"])).toEqual([]);
      expect(session.evaluations).toBe(51);
    });
  });
});

describe("s12-calc-sheet-snapshot", () => {
  it("freezes with the governing cell pinned; a table edit that moves the cell reads changed since issue", () => {
    withPackSet(PackSet.create([pack]), () => {
      const model = modelOf([{ id: "b1", kind: "zz_beam", span: 14, load: 300 }]);
      const spec = beamSheet("b1");
      const ev = evaluateCalcSheet(model, spec, ctx());
      if (isPackRefusal(ev)) throw new Error(ev.refused);
      const snap = calcSheetSnapshot("blk-1" as ElementId, 12, spec, ev, { "zz.beam_capacity": "rev-3" });
      expect(snap.libraryPins).toEqual({ "zz.beam_capacity": "rev-3", "governing:size": "1|1|320" });
      expect(snap.valueHash).toMatch(/^[0-9a-f]{64}$/);
      const again = evaluateCalcSheet(model, spec, ctx());
      if (isPackRefusal(again)) throw new Error(again.refused);
      expect(calcSheetValueHash(renderCalcSheet(spec, again), calcSheetPins(again, { "zz.beam_capacity": "rev-3" }))).toBe(snap.valueHash);
      expect(blockFreshness(snap.valueHash, snap, "SD").state).toBe("frozen_current");
      // The firm's table gains a 7 in size between 6 and 8 that carries the load: the governing cell moves.
      const edited: CalcTable = { ...capacity, columns: ["6", "7", "10", "1-1/4"], values: [[400, 700, 1100, 50], [180, 320, 500, 20], [100, 180, 280, null]] };
      const moved = evaluateCalcSheet(model, spec, { tables: { table: () => edited }, limits: {} });
      if (isPackRefusal(moved)) throw new Error(moved.refused);
      const liveHash = calcSheetValueHash(renderCalcSheet(spec, moved), calcSheetPins(moved, { "zz.beam_capacity": "rev-4" }));
      expect(blockFreshness(liveHash, snap, "SD").state).toBe("changed_since");
    });
  });
});
