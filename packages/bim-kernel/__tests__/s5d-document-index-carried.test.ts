/**
 * @jest-environment node
 *
 * The sheet index (sheets, views, viewports and what is drawn on them), read
 * after edits committed the way the app commits them, always equals a fresh
 * build: other edits leave it as it was, new and renamed sheets show at once,
 * and removing the last note from a sheet leaves no empty entry behind.
 *
 * Fails on the old code: carrying the index to the editor's local prediction
 * past the removal of a sheet's last note kept an empty list for that sheet, so the carried index and a
 * fresh build disagreed (a reader asking "does this sheet have notes?" got a
 * different answer depending on which it read).
 */
import { DEFAULT_SETTINGS, commandSchema, documentIndex, executeCommand, planCommit, withUpgradePolicy, type ModelState } from "../src";

let n = 0;
function commit(m: ModelState, command: Record<string, unknown> & { type: string }): ModelState {
  const d = withUpgradePolicy(() => true, () => planCommit(m, [], { idempotencyKey: `s5d-${++n}-key`, baseRevision: m.revision, actor: { id: "avery", name: "Avery", kind: "human" }, command: commandSchema.parse(command) }, () => "2026-11-07T00:00:00.000Z"));
  if (!d.ok) throw new Error(d.error.message);
  return d.model;
}

/** A fresh build: a copy of the element record has no cached index. */
const fresh = (m: ModelState) => documentIndex({ elements: { ...m.elements }, connections: m.connections });

function withSheets(): ModelState {
  let m: ModelState = { modelId: "s5d-index", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  m = commit(m, { type: "create_level", levelId: "L1", name: "Level 1", elevationMm: 0 });
  m = commit(m, { type: "create_sheet", sheetId: "s1", number: "M-101", name: "Level 1" });
  m = commit(m, { type: "create_view", viewId: "v1", name: "Level 1", viewType: "floor_plan", props: { level: "Level 1" } });
  m = commit(m, { type: "place_viewport", viewportId: "vp1", sheetId: "s1", viewId: "v1", center: { x: 300, y: 300 } });
  return m;
}

describe("s5d: the sheet index stays exact across committed edits", () => {
  it("an edit that touches no document leaves it equal to a fresh build", () => {
    let m = withSheets();
    documentIndex(m);
    m = commit(m, { type: "create_element", elementId: "w1", kind: "wall", levelId: "L1", placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 6000, y: 0 } }, size: { thicknessMm: 200, heightMm: 3000 } });
    expect(documentIndex(m)).toEqual(fresh(m));
  });

  it("new and renamed sheets show at once, exactly as a fresh build lists them", () => {
    let m = withSheets();
    documentIndex(m);
    m = commit(m, { type: "create_sheet", sheetId: "s2", number: "M-102", name: "Level 2" });
    m = commit(m, { type: "set_sheet_properties", sheetId: "s1", number: "M-100", name: "Level 1 renamed" });
    expect(documentIndex(m).sheets.map((s) => [s.id, s.number])).toEqual([["s1", "M-100"], ["s2", "M-102"]]);
    expect(documentIndex(m)).toEqual(fresh(m));
  });

  it("removing a sheet's last note leaves no empty entry, as a fresh build does", () => {
    let m = withSheets();
    m = commit(m, { type: "add_drawing_item", itemId: "n1", ownerId: "s1", shape: "text", points: [{ x: 40, y: 500 }], text: "SEE NOTE 3" });
    documentIndex(m);
    // The editor draws its local prediction straight away from the command's own result, with the index carried to it.
    const predicted = executeCommand(m, commandSchema.parse({ type: "delete_drawing_item", itemId: "n1" }));
    if (!predicted.ok) throw new Error(predicted.error.message);
    expect(documentIndex(predicted.model).itemsByOwner.has("s1")).toBe(false);
    expect(documentIndex(predicted.model)).toEqual(fresh(predicted.model));
    m = commit(m, { type: "delete_drawing_item", itemId: "n1" });
    expect(documentIndex(m)).toEqual(fresh(m));
  });
});
