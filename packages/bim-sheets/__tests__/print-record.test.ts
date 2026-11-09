import { commandSchema, executeCommand, type ModelState } from "@permitzip/bim-kernel";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { compareWithPrint, describePrintComparison, sheetDigests, type SetPrintRecord } from "../src/print-record";

function run(model: ModelState, command: Record<string, unknown> & { type: string }): ModelState {
  const r = executeCommand(model, commandSchema.parse(command));
  if (!r.ok) throw new Error(r.error.message);
  return { ...r.model, revision: (model.revision + 1) as ModelState["revision"] };
}

const opts = { projectName: "7301 - Test", projectNumber: "7301", firmName: "PermitZIP" };

function base(): ModelState {
  let m = createDemoModel();
  m = run(m, { type: "create_sheet", sheetId: "s-g", number: "G-001", name: "Cover" });
  m = run(m, { type: "create_view", viewId: "v-list", name: "Sheet list", viewType: "schedule", props: { schedule: { category: "sheet_list", columns: [{ field: "number" }, { field: "name" }] } } });
  return run(m, { type: "place_viewport", viewportId: "vp-list", sheetId: "s-g", viewId: "v-list", center: { x: 200, y: 150 } });
}

const record = (m: ModelState): SetPrintRecord => ({ kind: "set_print", modelId: m.modelId, modelRevision: m.revision, pdfFile: "p.pdf", pdfSha256: "x", sheets: sheetDigests(m, ["s-g"], opts), printedBy: "u", printedAt: "2026-10-23T18:00:00.000Z" });

describe("set print records", () => {
  it("a save elsewhere and the issue's own revision row are not changes to the sheet", () => {
    const m = base();
    const print = record(m);
    const later = run(run(m, { type: "set_sheet_properties", sheetId: "s-g", revisions: [{ number: "1", date: "2026-10-23", description: "ISSUED FOR PERMIT" }] }), { type: "create_view", viewId: "v-x", name: "Unplaced", viewType: "floor_plan", props: { level: "L1" } });
    expect(compareWithPrint(sheetDigests(later, ["s-g"], opts), print).status).toBe("matches_print");
  });

  it("a live schedule that changed is a change to its sheet, said in plain words", () => {
    const m = base();
    const print = record(m);
    const later = run(m, { type: "create_sheet", sheetId: "s-601", number: "M-601", name: "Schedules" });
    const c = compareWithPrint(sheetDigests(later, ["s-g", "s-601"], opts), print);
    expect(c).toMatchObject({ status: "changed_since_print", changed: ["G-001"], unprinted: ["M-601"] });
    expect(describePrintComparison(c)).toBe(`G-001 draws differently than in the set printed at Rev ${m.revision} (a schedule, tag or view changed); M-601 wasn't in that print. Print the set again and check it before issuing.`);
  });

  it("no print at all", () => {
    const c = compareWithPrint(sheetDigests(base(), ["s-g"], opts), null);
    expect(c.status).toBe("not_printed");
    expect(describePrintComparison(c)).toMatch(/G-001 hasn't been printed as a set/);
  });
});
