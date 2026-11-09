/**
 * @jest-environment node
 *
 * Live block commands: place a load summary on a sheet, change what it says,
 * move it, remove it and undo each step through the ordinary commit path,
 * and an issued copy keeps what it said at issue after the model moves on.
 * Everything is imported from the kernel's public index, the way the surface
 * and the agent tools reach it.
 */
import {
  LOAD_SUMMARY_TEMPLATE,
  LOAD_SUMMARY_TITLE,
  blockFreshness,
  blockHashInput,
  fieldBlockTextBlock,
  isBlockCommand,
  renderFieldBlock,
  sheetFieldBlocks,
  toDocumentRecord,
  type DrawingItem,
  type RenderedBlock,
} from "../src";
import { referenceBuilding, type Building } from "./fixtures/electrical-building";

const SHEET = "s-e001";
const ITEM = "blk-1";
const LOAD = { template: LOAD_SUMMARY_TEMPLATE, title: LOAD_SUMMARY_TITLE };

function withSheet(): Building {
  const b = referenceBuilding();
  b.ok({ type: "create_sheet", sheetId: SHEET, number: "E-001", name: "Electrical power plan" });
  return b;
}

function placed(): Building {
  const b = withSheet();
  b.ok({ type: "add_field_block", itemId: ITEM, sheetId: SHEET, at: { x: 40, y: 60 }, block: LOAD });
  return b;
}

const item = (b: Building, id = ITEM): DrawingItem => {
  const el = b.el(id);
  if (el.kind !== "drawing_item") throw new Error(`${id} is a ${el.kind}`);
  return el;
};
const drawnLines = (b: Building, frozen?: Readonly<Record<string, RenderedBlock>>): string[] =>
  (fieldBlockTextBlock(b.head, item(b), frozen ? { frozen } : {})?.layout.lines ?? []).map((l) => l.pieces.map((p) => p.text).join(""));

describe("block commands: add", () => {
  it("are block commands the dispatcher routes", () => {
    expect(isBlockCommand({ type: "add_field_block" })).toBe(true);
    expect(isBlockCommand({ type: "edit_field_block" })).toBe(true);
    expect(isBlockCommand({ type: "add_drawing_item" })).toBe(false);
  });

  it("places a live load summary on the sheet that draws today's service numbers", () => {
    const b = placed();
    const it = item(b);
    expect(it).toMatchObject({ shape: "field_block", ownerId: SHEET, points: [{ x: 40, y: 60 }], block: LOAD });
    expect(sheetFieldBlocks(b.head, it.ownerId).map((x) => x.id)).toEqual([ITEM]);
    const lines = drawnLines(b);
    expect(lines[0]).toBe(LOAD_SUMMARY_TITLE);
    expect(lines.join(" ")).toContain("Total connected 72.74 kVA = 87 A at 480Y/277V");
    b.valid();
  });

  it("refuses in words: a template that can't be read, a missing subject, not a sheet, off the paper", () => {
    const b = withSheet();
    expect(b.refused({ type: "add_field_block", itemId: ITEM, sheetId: SHEET, at: { x: 40, y: 60 }, block: { template: "ok {name}\nbad {name" } })).toBe("The block's text can't be used. Line 2: A { has no closing }.");
    expect(b.refused({ type: "add_field_block", itemId: ITEM, sheetId: SHEET, at: { x: 40, y: 60 }, block: { template: "{name}", subjectId: "nope" } })).toMatch(/no longer exists/);
    expect(b.refused({ type: "add_field_block", itemId: ITEM, sheetId: "lvl-1", at: { x: 40, y: 60 }, block: LOAD })).toBe("Live blocks go on sheets. Open a sheet and place it there.");
    expect(b.refused({ type: "add_field_block", itemId: ITEM, sheetId: SHEET, at: { x: -5, y: 60 }, block: LOAD })).toMatch(/off the sheet/);
    expect(b.refused({ type: "add_drawing_item", itemId: ITEM, ownerId: SHEET, shape: "field_block", points: [{ x: 40, y: 60 }] })).toMatch(/add_field_block/);
    expect(b.head.elements[ITEM]).toBeUndefined();
  });

  it("never reuses an id", () => {
    const b = placed();
    expect(b.refused({ type: "add_field_block", itemId: ITEM, sheetId: SHEET, at: { x: 10, y: 10 }, block: LOAD })).toMatch(/already used/);
  });
});

describe("block commands: edit, move, remove", () => {
  it("edits the text, the title and what it reads; the sheet draws the new words", () => {
    const b = placed();
    b.ok({ type: "edit_field_block", itemId: ITEM, template: "{name}: {connected_kva} kVA of {service.name}", subjectId: "l1", title: "PANEL L1" });
    expect(item(b).block).toEqual({ template: "{name}: {connected_kva} kVA of {service.name}", subjectId: "l1", title: "PANEL L1" });
    expect(drawnLines(b)).toEqual(["PANEL L1", "L1: 12.24 kVA of MDP"]);
    b.ok({ type: "edit_field_block", itemId: ITEM, title: null, subjectId: null, template: "{service.name}" });
    expect(item(b).block).toEqual({ template: "{service.name}" });
    expect(drawnLines(b)).toEqual(["MDP"]);
  });

  it("refuses an edit that changes nothing, a bad template, or a subject that is gone", () => {
    const b = placed();
    expect(b.refused({ type: "edit_field_block", itemId: ITEM })).toMatch(/Nothing to change/);
    expect(b.refused({ type: "edit_field_block", itemId: ITEM, template: "{oops" })).toMatch(/Line 1/);
    expect(b.refused({ type: "edit_field_block", itemId: ITEM, subjectId: "gone" })).toMatch(/no longer exists/);
    expect(item(b).block).toEqual(LOAD);
  });

  it("moves with the ordinary drag command (one point), and its words still come only from the template", () => {
    const b = placed();
    b.ok({ type: "update_drawing_item", itemId: ITEM, points: [{ x: 120, y: 80 }] });
    expect(item(b).points).toEqual([{ x: 120, y: 80 }]);
    expect(b.refused({ type: "update_drawing_item", itemId: ITEM, points: [{ x: 1, y: 1 }, { x: 50, y: 50 }] })).toMatch(/one point/);
    expect(b.refused({ type: "update_drawing_item", itemId: ITEM, text: "typed over" })).toMatch(/edit_field_block/);
  });

  it("removes with delete_drawing_item and leaves the sheet without a block", () => {
    const b = placed();
    b.ok({ type: "delete_drawing_item", itemId: ITEM });
    expect(sheetFieldBlocks(b.head, item(b).ownerId)).toEqual([]);
  });

  it("refuses to edit a removed block", () => {
    const b = placed();
    b.ok({ type: "delete_drawing_item", itemId: ITEM });
    expect(b.refused({ type: "edit_field_block", itemId: ITEM, template: "{service.name}" })).toMatch(/no longer exists/);
  });
});

describe("block commands: undo", () => {
  it("undoes a placement, an edit and a removal through restore_document_elements", () => {
    const b = withSheet();
    b.ok({ type: "add_field_block", itemId: ITEM, sheetId: SHEET, at: { x: 40, y: 60 }, block: LOAD });
    b.ok({ type: "restore_document_elements", items: [{ elementId: ITEM, before: null, expectedVersion: item(b).version }] });
    expect(sheetFieldBlocks(b.head, item(b).ownerId)).toEqual([]);

    const p = placed();
    const beforeEdit = toDocumentRecord(item(p));
    p.ok({ type: "edit_field_block", itemId: ITEM, template: "{service.name}" });
    p.ok({ type: "restore_document_elements", items: [{ elementId: ITEM, before: beforeEdit, expectedVersion: item(p).version }] });
    expect(item(p).block).toEqual(LOAD);

    const beforeDelete = toDocumentRecord(item(p));
    p.ok({ type: "delete_drawing_item", itemId: ITEM });
    p.ok({ type: "restore_document_elements", items: [{ elementId: ITEM, before: beforeDelete, expectedVersion: item(p).version }] });
    expect(sheetFieldBlocks(p.head, item(p).ownerId).map((x) => x.id)).toEqual([ITEM]);
    expect(drawnLines(p)[0]).toBe(LOAD_SUMMARY_TITLE);
  });

  it("won't undo over someone else's later edit", () => {
    const b = placed();
    const before = toDocumentRecord(item(b));
    b.ok({ type: "edit_field_block", itemId: ITEM, template: "{service.name}" });
    const mine = item(b).version;
    b.ok({ type: "edit_field_block", itemId: ITEM, title: "CASEY'S" }, "casey");
    const d = b.submit({ type: "restore_document_elements", items: [{ elementId: ITEM, before, expectedVersion: mine }] });
    expect(d.ok).toBe(false);
    expect(item(b).block?.title).toBe("CASEY'S");
  });
});

describe("block commands: frozen at issue", () => {
  it("an issued copy draws what it said at issue after a load and the template change; the live block says it changed", () => {
    const b = placed();
    const issued = renderFieldBlock(b.head, LOAD);
    const issuedHash = blockHashInput(issued);
    expect(blockFreshness(blockHashInput(renderFieldBlock(b.head, item(b).block ?? LOAD)), { valueHash: issuedHash }, "SD")).toEqual({ state: "frozen_current", issueLabel: "SD" });

    b.ok({ type: "set_parameters", id: "k1", scope: "instance", values: { load_va: 2500 } });
    b.ok({ type: "edit_field_block", itemId: ITEM, title: "LOAD SUMMARY (REV 1)" });
    const live = renderFieldBlock(b.head, item(b).block ?? LOAD);
    expect(live.text).toContain("Total connected 73.74 kVA = 89 A");
    expect(blockFreshness(blockHashInput(live), { valueHash: issuedHash }, "SD")).toEqual({ state: "changed_since", issueLabel: "SD" });

    const frozen = drawnLines(b, { [ITEM]: issued });
    expect(frozen.join(" ")).toContain("Total connected 72.74 kVA = 87 A");
    expect(frozen.join(" ")).not.toContain("73.74");
    expect(drawnLines(b).join(" ")).toContain("73.74");
  });
});
