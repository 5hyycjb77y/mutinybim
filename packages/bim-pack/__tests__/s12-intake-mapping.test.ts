/**
 * @jest-environment node
 *
 * s12-intake-mapping, s12-outside-pack-intake-columns.
 *
 * A test add-on (not first-party) registers three columns (mark, input,
 * phase) through `INTAKE_COLUMN_POINT`. A two-page schedule read into cells
 * maps to planned rows deterministically: headings match by letters and
 * digits only, a column no add-on reads ("REMARKS") is kept as text and never
 * guessed into a field, low-confidence or unreadable cells are unsure and
 * leave their row unticked, page 2's repeated heading row isn't a row, and
 * the ticked rows become `plan_part` commands carrying only sure values.
 *
 * Fails on round 11's code: there is no intake mapping (wave 0 refuses
 * "Reading rows from a picture isn't built yet").
 */
import { INTAKE_COLUMN_POINT, PackSet, contribute, definePack, isPackRefusal, proposeIntakeRows, runPackConformance, withPackSet, type Pack, type TableReadCell, type TableReadResult } from "../src";
import { intakeNumber, intakePlanCommands } from "@permitzip/bim-kernel/intake";

const pack: Pack = definePack({ id: "ti", name: "Test intake", version: "1.0.0", kernel: "^1.10.0" }, [
  contribute(INTAKE_COLUMN_POINT, [
    { id: "ti.mark", label: "Mark", headings: ["MARK", "TAG", "ITEM NO"], field: "mark" },
    { id: "ti.input", label: "Rated input", headings: ["INPUT (KW)", "KW"], field: "ti.input_kw", unit: "kW" },
    { id: "ti.phase", label: "Phase", headings: ["PH", "PHASE"], field: "ti.phase", unit: "1", parse: (t) => (/^[13]$/.test(t.trim()) ? Number(t.trim()) : null) },
  ]),
]);

const cell = (row: number, column: number, text: string, page = 0, confidence = 0.97): TableReadCell => ({ row, column, text, confidence, box: { page, x: column * 0.2, y: row * 0.05, width: 0.2, height: 0.05 } });

const read: TableReadResult = {
  source: { name: "kitchen-schedule.pdf", kind: "document" },
  pages: [{ index: 0, label: "K-1" }, { index: 1, label: "K-2" }],
  headerRow: 0,
  notes: [],
  cells: [
    cell(0, 0, "Item No."), cell(0, 1, "Input (kW)"), cell(0, 2, "Ph"), cell(0, 3, "Remarks"),
    cell(1, 0, "K-1"), cell(1, 1, "12.5"), cell(1, 2, "3"), cell(1, 3, "By vendor"),
    cell(2, 0, "K-2"), cell(2, 1, "4.5", 0, 0.42), cell(2, 2, "1"),
    cell(3, 0, ""), cell(3, 1, ""),
    cell(4, 0, "ITEM NO", 1), cell(4, 1, "INPUT (KW)", 1), cell(4, 2, "PH", 1), cell(4, 3, "REMARKS", 1),
    cell(5, 0, "K-3", 1), cell(5, 1, "1,200", 1), cell(5, 2, "2", 1),
  ],
};

describe("s12-outside-pack-intake-columns", () => {
  it("an outside add-on's columns pass conformance and receive the cells with no kernel edit", () => {
    expect(runPackConformance(pack).problems).toEqual([]);
    withPackSet(PackSet.create([pack]), () => {
      const p = proposeIntakeRows(read);
      if (isPackRefusal(p)) throw new Error(p.refused);
      expect(p.columns).toEqual([
        { index: 0, heading: "Item No.", field: "mark" },
        { index: 1, heading: "Input (kW)", field: "ti.input_kw" },
        { index: 2, heading: "Ph", field: "ti.phase" },
        { index: 3, heading: "Remarks", field: null },
      ]);
    });
  });
});

describe("s12-intake-mapping", () => {
  it("cells to rows: deterministic, unknown columns kept as text, unsure cells unticked, repeated headings skipped", () => {
    withPackSet(PackSet.create([pack]), () => {
      const p = proposeIntakeRows(read);
      if (isPackRefusal(p)) throw new Error(p.refused);
      expect(proposeIntakeRows(read)).toEqual(p);
      expect(p.rows.map((r) => [r.key, r.page, r.sure, r.values])).toEqual([
        ["p0r1", 0, true, { mark: "K-1", "ti.input_kw": 12.5, "ti.phase": 3 }],
        ["p0r2", 0, false, { mark: "K-2", "ti.phase": 1 }],
        ["p1r5", 1, false, { mark: "K-3", "ti.input_kw": 1200 }],
      ]);
      const remarks = p.rows[0]?.cells.find((c) => c.column === 3);
      expect(remarks).toMatchObject({ field: null, value: "By vendor", sure: true });
      expect(p.rows[1]?.cells.find((c) => c.column === 1)).toMatchObject({ value: 4.5, confidence: 0.42, sure: false });
      expect(p.rows[2]?.cells.find((c) => c.column === 2)).toMatchObject({ text: "2", value: null, sure: false });

      const commands = intakePlanCommands(p, new Set(["p0r1", "p1r5"]), { typeId: "builtin:equipment", partIdFor: (k) => `intake-${k}` });
      expect(commands).toEqual([
        { type: "plan_part", partId: "intake-p0r1", typeId: "builtin:equipment", mark: "K-1", values: { "ti.input_kw": 12.5, "ti.phase": 3 }, note: "Read from kitchen-schedule.pdf, page 1" },
        { type: "plan_part", partId: "intake-p1r5", typeId: "builtin:equipment", mark: "K-3", values: { "ti.input_kw": 1200 }, note: "Read from kitchen-schedule.pdf, page 2" },
      ]);
    });
  });

  it("never guesses a heading, and says why when there's nothing to map", () => {
    withPackSet(PackSet.create([pack]), () => {
      const near = proposeIntakeRows({ ...read, cells: [cell(0, 0, "Marks"), cell(1, 0, "K-1")] });
      if (isPackRefusal(near)) throw new Error(near.refused);
      expect(near.columns).toEqual([{ index: 0, heading: "Marks", field: null }]);
      expect(proposeIntakeRows({ ...read, headerRow: null })).toEqual({ refused: "No heading row was found, so the columns can't be matched. Try a picture that shows the schedule's headings." });
      expect(proposeIntakeRows({ ...read, cells: [], notes: ["This page is too blurry to read; try a sharper picture"] })).toEqual({ refused: "This page is too blurry to read; try a sharper picture" });
    });
    expect([intakeNumber("1,200"), intakeNumber("4.5 kW"), intakeNumber("12,00")]).toEqual([1200, null, null]);
  });
});
