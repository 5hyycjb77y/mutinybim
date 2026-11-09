/**
 * @jest-environment node
 *
 * A live load-summary block is part of the shared sheet scene, so the screen,
 * the PDF and the print-check digests all draw it: live text on a working
 * sheet, the frozen text on an issued copy, and an edit to the distribution it
 * summarises counts as a change to the sheet (and an unrelated edit does not).
 */
import { buildSheetSceneFor, sheetDependsOn, type ModelState } from "../src";
import { LOAD_SUMMARY_TEMPLATE, LOAD_SUMMARY_TITLE } from "../src/blocks/render";
import type { DrawingItem } from "../src/documents";
import type { ElementId } from "../src/types";
import { referenceBuilding } from "./fixtures/electrical-building";

const BLOCK_ID = "blk-1";
const OPTS = { projectName: "Load study" };

function sheetWithBlock(): ModelState {
  const b = referenceBuilding();
  b.ok({ type: "create_sheet", sheetId: "s1", number: "E-001", name: "Load study" });
  const sheet = b.head.elements["s1"];
  const item: DrawingItem = { id: BLOCK_ID as ElementId, version: 1, authoredRev: {}, kind: "drawing_item", ...(sheet?.partition ? { partition: sheet.partition } : {}), ownerId: "s1" as ElementId, shape: "field_block", points: [{ x: 600, y: 40 }], block: { template: LOAD_SUMMARY_TEMPLATE, title: LOAD_SUMMARY_TITLE } };
  return { ...b.head, elements: { ...b.head.elements, [BLOCK_ID]: item } };
}

function blockLines(model: ModelState, opts: Parameters<typeof buildSheetSceneFor>[2] = OPTS): string[] {
  const block = (buildSheetSceneFor(model, "s1", opts).textBlocks ?? []).find((t) => t.itemId === BLOCK_ID);
  return (block?.layout.lines ?? []).map((l) => l.pieces.map((p) => p.text).join(""));
}

describe("field blocks in the sheet scene", () => {
  it("draws the live load summary at its point, title first", () => {
    const model = sheetWithBlock();
    const block = (buildSheetSceneFor(model, "s1", OPTS).textBlocks ?? []).find((t) => t.itemId === BLOCK_ID);
    expect(block?.origin).toEqual({ x: 600, y: 40 });
    const lines = blockLines(model);
    expect(lines[0]).toBe(LOAD_SUMMARY_TITLE);
    expect(lines[1]).toBe("Total connected 72.74 kVA = 87 A at 480Y/277V");
  });

  it("an issued copy draws the text frozen at issue, not today's", () => {
    const model = sheetWithBlock();
    const lines = blockLines(model, { ...OPTS, frozenBlocks: { [BLOCK_ID]: { text: "Total connected 1 kVA", unresolved: [], dependsOn: [] } } });
    expect(lines).toEqual([LOAD_SUMMARY_TITLE, "Total connected 1 kVA"]);
  });

  it("a sheet with no block draws no block text", () => {
    const b = referenceBuilding();
    b.ok({ type: "create_sheet", sheetId: "s1", number: "E-001", name: "Load study" });
    expect(buildSheetSceneFor(b.head, "s1", OPTS).textBlocks).toEqual([]);
  });

  it("the sheet depends on the distribution the block summarises, not on unrelated elements", () => {
    const model = sheetWithBlock();
    const depends = sheetDependsOn(model, "s1");
    for (const id of ["mdp", "l1", "k1"]) expect(depends(id, model.elements[id])).toBe(true);
    expect(depends("lvl-1", model.elements["lvl-1"])).toBe(false);
  });
});
