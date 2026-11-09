/**
 * @jest-environment node
 *
 * One live block, two placements (ROADMAP F5, KERNEL-REQUIREMENTS-MODEL §3.6):
 * the sheet draws the block where its item sits, and a report holds only the
 * block's id and renders the same definition through `renderModelBlock`. An
 * edit to the definition (`edit_field_block`) or to what it reads changes both
 * the same way, and the hash a set freezes is the same from either side.
 * Plus the gas schedule as a fourth block kind.
 *
 * Fails on the old code: `modelBlocks`, `renderModelBlock`, `blockTextTable`
 * and the gas table did not exist (the imports are undefined), and
 * `add_field_block` refused `table: { kind: "gas" }` at the schema.
 */
import { DEFAULT_SETTINGS, GAS_TABLE_ZONE_REFUSAL, LOAD_SUMMARY_TEMPLATE, LOAD_SUMMARY_TITLE, blockHashInput, blockTextTable, executeCommand, fieldBlockTextBlock, modelBlock, modelBlocks, renderFieldBlock, renderModelBlock, type Command, type DrawingItem, type ModelState } from "../src";
import { GAS_TABLE_HEADER } from "@permitzip/bim-pack-plumbing";
import { referenceBuilding, type Building } from "./fixtures/electrical-building";
import { CAFE_GAS } from "./loads-7329-fixture";

const SHEET = "s-e101";
const ITEM = "blk-1";

function placed(): Building {
  const b = referenceBuilding();
  b.ok({ type: "create_sheet", sheetId: SHEET, number: "E-101", name: "Power plan" });
  b.ok({ type: "add_field_block", itemId: ITEM, sheetId: SHEET, at: { x: 40, y: 60 }, block: { template: LOAD_SUMMARY_TEMPLATE, title: LOAD_SUMMARY_TITLE } });
  return b;
}

const item = (m: ModelState, id = ITEM): DrawingItem => {
  const el = m.elements[id];
  if (el?.kind !== "drawing_item") throw new Error(`${id} is not a drawing item`);
  return el;
};

/** What the sheet draws, minus the bold title line, joined back into text. */
function sheetText(m: ModelState): string {
  const lines = (fieldBlockTextBlock(m, item(m))?.layout.lines ?? []).map((l) => l.pieces.map((p) => p.text).join(""));
  return lines.slice(1).join("\n");
}

function reportText(m: ModelState): string {
  const r = renderModelBlock(m, ITEM);
  if (!r) throw new Error("block not found");
  return r.rendered.text;
}

describe("one block, two placements", () => {
  it("lists the block with its home sheet and kind", () => {
    const b = placed();
    expect(modelBlocks(b.head)).toEqual([expect.objectContaining({ blockId: ITEM, sheetId: SHEET, sheetNumber: "E-101", sheetName: "Power plan", kind: "text", title: LOAD_SUMMARY_TITLE })]);
    expect(modelBlock(b.head, "nope")).toBeNull();
  });

  it("the report renders exactly what the sheet draws, before and after an edit to what it reads", () => {
    const b = placed();
    const before = reportText(b.head);
    expect(before).toMatch(/Total connected/);
    expect(sheetText(b.head).replace(/\s+/g, " ")).toBe(before.replace(/\s+/g, " "));

    b.ok({ type: "set_parameters", id: "k1", scope: "instance", values: { load_va: 2500 } });
    const after = reportText(b.head);
    expect(after).not.toBe(before);
    expect(sheetText(b.head).replace(/\s+/g, " ")).toBe(after.replace(/\s+/g, " "));
  });

  it("editing the one definition (from either host, it is the same command) changes both", () => {
    const b = placed();
    b.ok({ type: "edit_field_block", itemId: ITEM, template: "Service {service.name}: {service.connected_kva} kVA", title: "SERVICE" });
    const r = renderModelBlock(b.head, ITEM);
    expect(r?.title).toBe("SERVICE");
    expect(r?.rendered.text).toMatch(/^Service .+: .+ kVA$/);
    expect(sheetText(b.head)).toBe(r?.rendered.text);
    expect(item(b.head).block).toEqual(r?.spec);
  });

  it("the hash a set freezes is the same from either placement, steady across unrelated edits, and moves with a real one", () => {
    const b = placed();
    const fromSheet = blockHashInput(renderFieldBlock(b.head, item(b.head).block as NonNullable<DrawingItem["block"]>));
    const fromReport = blockHashInput(renderModelBlock(b.head, ITEM)?.rendered ?? { text: "", unresolved: [] });
    expect(fromReport).toBe(fromSheet);
    b.ok({ type: "create_level", levelId: "lvl-9", name: "Roof", elevationMm: 9000 });
    expect(blockHashInput(renderModelBlock(b.head, ITEM)?.rendered ?? { text: "", unresolved: [] })).toBe(fromSheet);
    b.ok({ type: "set_parameters", id: "k1", scope: "instance", values: { load_va: 2500 } });
    expect(blockHashInput(renderModelBlock(b.head, ITEM)?.rendered ?? { text: "", unresolved: [] })).not.toBe(fromSheet);
  });

  it("a deleted block is gone from every placement", () => {
    const b = placed();
    b.ok({ type: "delete_drawing_item", itemId: ITEM });
    expect(modelBlock(b.head, ITEM)).toBeNull();
    expect(modelBlocks(b.head)).toEqual([]);
  });
});

describe("blockTextTable", () => {
  it("splits a table block into header, rows and the notes after it", () => {
    const t = blockTextTable("Mark | Item | MBH\nOV-1 | Oven | 120\nGWH | Heater | 199\nTotal counted: 319 MBH");
    expect(t).toEqual({ lead: [], header: ["Mark", "Item", "MBH"], rows: [["OV-1", "Oven", "120"], ["GWH", "Heater", "199"]], notes: ["Total counted: 319 MBH"] });
  });

  it("keeps a lead line above the header and gives a text block back as notes", () => {
    expect(blockTextTable("IMC governs\nA | B\n1 | 2").lead).toEqual(["IMC governs"]);
    expect(blockTextTable("Total connected 82 kVA\nDemand 60 kVA")).toEqual({ lead: [], header: null, rows: [], notes: ["Total connected 82 kVA", "Demand 60 kVA"] });
  });
});

// ------------------------------------------------------------------ gas schedule

function run(model: ModelState, command: Command): ModelState {
  const r = executeCommand(model, command);
  if (!r.ok) throw new Error(`${command.type}: ${r.error.message}`);
  return r.model;
}

function cafe(): ModelState {
  let m: ModelState = { modelId: "7929", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  m = run(m, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  m = run(m, { type: "create_load", loads: CAFE_GAS.map((g) => ({ id: `load-gas-${g.tag}`, mark: g.tag, note: g.description, service: "gas" as const, values: { mbh: g.mbh } })) });
  m = run(m, { type: "create_sheet", sheetId: "s-p101", number: "P-101", name: "Plumbing plan" });
  return run(m, { type: "add_field_block", itemId: "blk-gas", sheetId: "s-p101", at: { x: 40, y: 60 }, block: { template: "Gas schedule", title: "GAS SCHEDULE", table: { kind: "gas", scope: { kind: "model" } } } });
}

describe("gas schedule block", () => {
  it("lists each gas load with its input, counted input and cfh, then the counted total the meter is sized for", () => {
    const m = cafe();
    const r = renderModelBlock(m, "blk-gas");
    expect(r?.kind).toBe("gas");
    const t = blockTextTable(r?.rendered.text ?? "");
    expect(t.header?.join(" | ")).toBe(GAS_TABLE_HEADER);
    expect(t.rows.map((row) => row[0])).toEqual(["GWH", "OV-1", "RTU-1", "RTU-2", "RTU-3"]);
    expect(t.rows.find((row) => row[0] === "GWH")).toEqual(["GWH", "Condensing tankless water heater, Rinnai CXP199iN", "199", "199", "199"]);
    expect(t.notes).toEqual(["Total counted: 859 MBH = 859 cfh at 1,000 Btu/cf"]);
    expect(r?.rendered.dependsOn).toEqual(expect.arrayContaining(["load-gas-GWH", "load-gas-OV-1"]));
  });

  it("changes when a load's input changes, and the sheet draws the same text", () => {
    let m = cafe();
    const before = renderModelBlock(m, "blk-gas")?.rendered.text;
    m = run(m, { type: "edit_load_point", loadId: "load-gas-OV-1", values: { mbh: 150 } });
    const after = renderModelBlock(m, "blk-gas")?.rendered.text ?? "";
    expect(after).not.toBe(before);
    expect(after).toMatch(/Total counted: 889 MBH = 889 cfh/);
    const drawn = (fieldBlockTextBlock(m, item(m, "blk-gas"))?.layout.lines ?? []).map((l) => l.pieces.map((p) => p.text).join("")).slice(1).join(" ");
    expect(drawn.replace(/\s+/g, " ")).toBe(after.replace(/\s+/g, " "));
  });

  it("a level-scoped table leaves out loads that sit on no level, and says so when it is empty", () => {
    const m = run(cafe(), { type: "add_field_block", itemId: "blk-gas-l1", sheetId: "s-p101", at: { x: 40, y: 200 }, block: { template: "Gas schedule", table: { kind: "gas", scope: { kind: "level", levelId: "lvl-1" } } } });
    expect(renderModelBlock(m, "blk-gas-l1")?.rendered.text).toBe("No gas loads on this level yet. Add them in the Loads list or place gas equipment.");
  });

  it("refuses a zone-scoped gas schedule in words", () => {
    const r = executeCommand(cafe(), { type: "add_field_block", itemId: "blk-gas-z", sheetId: "s-p101", at: { x: 40, y: 200 }, block: { template: "Gas schedule", table: { kind: "gas", scope: { kind: "zone", zoneId: "z-1" } } } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toBe(GAS_TABLE_ZONE_REFUSAL);
  });

  it("renders the same text twice from the same model (deterministic, so the issue hash is stable)", () => {
    const m = cafe();
    expect(blockHashInput(renderModelBlock(m, "blk-gas")?.rendered ?? { text: "", unresolved: [] })).toBe(blockHashInput(renderModelBlock(m, "blk-gas")?.rendered ?? { text: "x", unresolved: [] }));
  });
});
