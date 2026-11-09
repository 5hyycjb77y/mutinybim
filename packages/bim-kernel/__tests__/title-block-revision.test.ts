/**
 * @jest-environment node
 *
 * A sheet's title block shows the sheet's own issue revision, not the model's
 * save counter. Before, a brand-new sheet read "Rev 177" (QA, Oct 25): the
 * number of saves to the whole model, which means nothing on paper.
 */
import { DEFAULT_SETTINGS, buildSheetSceneFor, executeCommand, type Command, type ModelState } from "../src";

function build(commands: readonly Command[]): ModelState {
  let m: ModelState = { modelId: "tb", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  for (const c of commands) {
    const r = executeCommand(m, c);
    if (!r.ok) throw new Error(r.error.message);
    m = { ...r.model, revision: (m.revision + 50) as ModelState["revision"] };
  }
  return m;
}

const texts = (m: ModelState) => buildSheetSceneFor(m, "s-1", { projectName: "P" }).primitives.flatMap((p) => (p.kind === "text" ? [p.text] : []));

describe("title block revision", () => {
  it("says NOT ISSUED on a sheet never issued, whatever the model's revision", () => {
    const m = build([{ type: "create_sheet", sheetId: "s-1", number: "M-101", name: "Plan" }]);
    expect(m.revision).toBeGreaterThan(0);
    expect(texts(m)).toEqual(expect.arrayContaining(["REVISION", "NOT ISSUED"]));
    expect(texts(m).some((t) => /^Rev \d+$/.test(t))).toBe(false);
  });

  it("shows the sheet's latest issue revision once it has one", () => {
    const m = build([
      { type: "create_sheet", sheetId: "s-1", number: "M-101", name: "Plan" },
      { type: "set_sheet_properties", sheetId: "s-1", revisions: [{ number: "0", date: "2026-10-01", description: "Permit" }, { number: "1", date: "2026-10-20", description: "Comments" }] },
    ]);
    expect(texts(m)).toEqual(expect.arrayContaining(["REVISION"]));
    const i = texts(m).indexOf("REVISION");
    expect(texts(m)[i + 1]).toBe("1");
  });
});
