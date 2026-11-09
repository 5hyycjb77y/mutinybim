/**
 * @jest-environment node
 *
 * Field-bound text blocks (ROADMAP F5 core): a block renders deterministically
 * at a revision, lists what it depends on for incremental re-render, and its
 * value hash covers only the rendered text and library pins, so a kitchen
 * item's load change changes it and an unrelated edit or a no-op edit does not.
 */
import { canonicalJson, fieldProviderRegistryBuilder, toDocumentRecord, type ModelState } from "../src";
import { blockAffectedBy, blockFreshness, blockHashInput, fieldBlockTemplateProblem, LOAD_SUMMARY_TEMPLATE, LOAD_SUMMARY_TITLE, renderFieldBlock, serviceOf, UNRESOLVED_TOKEN_TEXT } from "../src/blocks/render";
import { fieldBlockTextBlock } from "../src/blocks/sheet-block";
import { blockFieldChoices } from "../src/blocks/fields";
import type { DrawingItem } from "../src/documents";
import type { ElementId } from "../src/types";
import { referenceBuilding } from "./fixtures/electrical-building";

const LOAD = { template: LOAD_SUMMARY_TEMPLATE, title: LOAD_SUMMARY_TITLE };
const lineTexts = (block: ReturnType<typeof fieldBlockTextBlock>) => (block?.layout.lines ?? []).map((l) => l.pieces.map((p) => p.text).join(""));
const hashOf = (model: Pick<ModelState, "elements">, spec = LOAD) => blockHashInput(renderFieldBlock(model, spec));

describe("field blocks: rendering", () => {
  const b = referenceBuilding();

  it("reads the project's service with no subject: MDP's connected load, current and voltage", () => {
    expect(serviceOf(b.head, undefined)).toBe("mdp");
    const r = renderFieldBlock(b.head, LOAD);
    const first = r.text.split("\n")[0];
    expect(first).toBe("Total connected 72.74 kVA = 87 A at 480Y/277V");
    expect(r.unresolved).toEqual([]);
  });

  it("climbs from a subject to the service that feeds it", () => {
    expect(serviceOf(b.head, "l1" as ElementId)).toBe("mdp");
    expect(serviceOf(b.head, "k1" as ElementId)).toBe("mdp");
    const own = renderFieldBlock(b.head, { template: "{name}: {connected_kva} kVA of {service.name}", subjectId: "l1" as ElementId });
    expect(own.text).toBe("L1: 12.24 kVA of MDP");
  });

  it("prints a dash for a token that reads nothing and lists it; a fallback prints instead", () => {
    const r = renderFieldBlock(b.head, { template: "Spare {service.no_such_field} kVA, {service.also_missing|none}" });
    expect(r.text).toBe(`Spare ${UNRESOLVED_TOKEN_TEXT} kVA, none`);
    expect(r.unresolved).toEqual(["service.no_such_field"]);
  });

  it("keeps newlines and is the same text and hash for the same model, however it was copied", () => {
    const copy: ModelState = JSON.parse(canonicalJson(b.head));
    expect(renderFieldBlock(copy, LOAD)).toEqual(renderFieldBlock(b.head, LOAD));
    expect(hashOf(copy)).toBe(hashOf(b.head));
    expect(renderFieldBlock(b.head, LOAD).text.split("\n")).toHaveLength(3);
  });

  it("depends on the service's whole distribution, not on the model", () => {
    const r = renderFieldBlock(b.head, LOAD);
    for (const id of ["mdp", "h1", "t1", "l1", "f-t1", "f-l1", "c-k1", "k1", "type-kitchen"]) expect(r.dependsOn).toContain(id);
    expect(r.dependsOn).not.toContain("lvl-1");
    expect([...r.dependsOn].sort()).toEqual(r.dependsOn);
  });

  it("refuses a template that can't be read, naming the line", () => {
    expect(fieldBlockTemplateProblem("ok {name}\nbad {name")).toBe("Line 2: A { has no closing }.");
    expect(fieldBlockTemplateProblem(LOAD_SUMMARY_TEMPLATE)).toBeNull();
  });
});

describe("field blocks: what changes the hash", () => {
  it("a kitchen item's load change changes the text and the hash, and the block knows it was affected", () => {
    const b = referenceBuilding();
    const before = renderFieldBlock(b.head, LOAD);
    const cs = b.ok({ type: "set_parameters", id: "k1", scope: "instance", values: { load_va: 2500 } });
    const after = renderFieldBlock(b.head, LOAD);
    expect(after.text.split("\n")[0]).toBe("Total connected 73.74 kVA = 89 A at 480Y/277V");
    expect(blockHashInput(after)).not.toBe(blockHashInput(before));
    expect(blockAffectedBy(before, cs.elements.map((e) => e.id))).toBe(true);
  });

  it("an unrelated edit leaves the text and the hash alone and is not an affecting change", () => {
    const b = referenceBuilding();
    const before = renderFieldBlock(b.head, LOAD);
    const cs = b.ok({ type: "create_level", levelId: "lvl-2", name: "Level 2", elevationMm: 4000 });
    expect(blockHashInput(renderFieldBlock(b.head, LOAD))).toBe(blockHashInput(before));
    expect(blockAffectedBy(before, cs.elements.map((e) => e.id))).toBe(false);
  });

  it("an edit that puts the value back is not a change: the hash ignores the revision", () => {
    const b = referenceBuilding();
    const before = hashOf(b.head);
    b.ok({ type: "set_parameters", id: "k1", scope: "instance", values: { load_va: 2500 } });
    b.ok({ type: "set_parameters", id: "k1", scope: "instance", values: { load_va: 1500 } });
    expect(b.head.revision).toBeGreaterThan(0);
    expect(hashOf(b.head)).toBe(before);
  });

  it("library pins are part of the hash", () => {
    const b = referenceBuilding();
    const r = renderFieldBlock(b.head, LOAD);
    expect(blockHashInput(r, { "permitzip-electrical": "3" })).not.toBe(blockHashInput(r, { "permitzip-electrical": "4" }));
  });

  it("freshness: live before an issue, matching after, changed since once the value moves", () => {
    expect(blockFreshness("a", null, "SD")).toEqual({ state: "live" });
    expect(blockFreshness("a", { valueHash: "a" }, "SD")).toEqual({ state: "frozen_current", issueLabel: "SD" });
    expect(blockFreshness("b", { valueHash: "a" }, "SD")).toEqual({ state: "changed_since", issueLabel: "SD" });
  });
});

describe("field blocks: fields registered later appear without a change here", () => {
  // A provider like the loads builder's allocated-vs-actual totals, registered on the panel class.
  const registry = fieldProviderRegistryBuilder()
    .addProvider({
      id: "test.service-totals",
      fields: [
        { path: "allocated_kva", label: "Allocated load", classes: ["mep.electrical_equipment"], valueType: "quantity", kind: "power_apparent", unit: "kVA", writer: { kind: "none", reason: "Added up from the estimates." }, group: "Loads", read: () => 1234.5 },
      ],
    })
    .build();

  it("resolves a registry field on the service and offers it in the picker", () => {
    const b = referenceBuilding();
    const r = renderFieldBlock(b.head, { template: "Allocated {service.allocated_kva} kVA" }, { registry });
    expect(r.text).toBe("Allocated 1,234.5 kVA");
    expect(blockFieldChoices(b.head, undefined, registry).map((c) => c.path)).toEqual(expect.arrayContaining(["service.connected_kva", "service.allocated_kva"]));
  });
});

describe("field blocks: the shared drawing-item commands", () => {
  it("refuses a field block through the plain drawing command (it would skip the template check)", () => {
    const b = referenceBuilding();
    b.ok({ type: "create_sheet", sheetId: "s1", number: "E-001", name: "Load study" });
    expect(b.refused({ type: "add_drawing_item", itemId: "blk-raw", ownerId: "s1", shape: "field_block", points: [{ x: 600, y: 40 }] })).toMatch(/add_field_block/);
  });

  it("undo keeps a block's template: the document record carries it", () => {
    const item: DrawingItem = { id: "blk-1" as ElementId, version: 3, authoredRev: {}, kind: "drawing_item", ownerId: "s1" as ElementId, shape: "field_block", points: [{ x: 600, y: 40 }], block: { ...LOAD, subjectId: "mdp" as ElementId } };
    const record = toDocumentRecord(item);
    expect(record).not.toBeNull();
    expect(record && record.kind === "drawing_item" ? record.block : null).toEqual({ ...LOAD, subjectId: "mdp" });
  });
});

describe("field blocks: on a sheet", () => {
  it("draws as a text box at its point, title first, from the live value or a frozen one", () => {
    const b = referenceBuilding();
    const item: DrawingItem = { id: "blk-1" as ElementId, version: 1, authoredRev: {}, kind: "drawing_item", ownerId: "s1" as ElementId, shape: "field_block", points: [{ x: 600, y: 40 }], block: LOAD };
    const live = fieldBlockTextBlock(b.head, item);
    expect(live?.origin).toEqual({ x: 600, y: 40 });
    const text = lineTexts(live).join("\n");
    expect(text.startsWith(`${LOAD_SUMMARY_TITLE}\nTotal connected 72.74 kVA`)).toBe(true);
    const frozen = fieldBlockTextBlock(b.head, item, { frozen: { "blk-1": { text: "Total connected 1 kVA", unresolved: [], dependsOn: [] } } });
    expect(lineTexts(frozen)).toEqual([LOAD_SUMMARY_TITLE, "Total connected 1 kVA"]);
  });
});
