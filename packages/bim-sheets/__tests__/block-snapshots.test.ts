/**
 * @jest-environment node
 *
 * Issue snapshots of live sheet blocks (ROADMAP F5 core): one snapshot per
 * block on the issued sheets, a sha-256 over the rendered text and library
 * pins, and freshness against the latest snapshot. The 7303 step at this
 * layer: issue SD, change a kitchen item's load, and the block reads
 * "changed since SD issue" while the SD snapshot (what the issued copy
 * draws) still says the issued value.
 */
import { asElementId, type BimElement, type DrawingItem, type ModelState } from "@permitzip/bim-kernel";
import { blockStatuses, blockSnapshotsAt, blockValueHash, frozenBlocksFrom, sheetBlockValues } from "../src/blocks";
import { LOAD_SUMMARY_TEMPLATE, LOAD_SUMMARY_TITLE } from "../../bim-kernel/src/blocks/render";
import { fieldBlockTextBlock } from "../../bim-kernel/src/blocks/sheet-block";
import { referenceBuilding } from "../../bim-kernel/__tests__/fixtures/electrical-building";

const BLOCK_ID = asElementId("blk-load");

/** The reference building with a sheet carrying the load summary (the block sits beside the one-line and panel schedule). */
function withLoadSummary(): { b: ReturnType<typeof referenceBuilding>; item: DrawingItem } {
  const b = referenceBuilding();
  b.ok({ type: "create_sheet", sheetId: "e-001", number: "E-001", name: "Load study" });
  const sheet = b.head.elements["e-001"] as BimElement;
  const item: DrawingItem = { id: BLOCK_ID, version: 1, authoredRev: {}, kind: "drawing_item", ownerId: sheet.id, shape: "field_block", points: [{ x: 600, y: 40 }], block: { template: LOAD_SUMMARY_TEMPLATE, title: LOAD_SUMMARY_TITLE }, partition: sheet.partition };
  // Until add_field_block lands with the contracts seam, the item goes in as the command will write it.
  b.head = { ...b.head, elements: { ...b.head.elements, [item.id]: item } };
  return { b, item };
}

const textOf = (model: ModelState, item: DrawingItem, frozen?: ReturnType<typeof frozenBlocksFrom>) =>
  (fieldBlockTextBlock(model, item, frozen ? { frozen } : {})?.layout.lines ?? []).map((l) => l.pieces.map((p) => p.text).join("")).join("\n");

describe("block snapshots at issue", () => {
  it("one snapshot per block on the issued sheets, hashed with sha-256", () => {
    const { b } = withLoadSummary();
    const snaps = blockSnapshotsAt(b.head, ["e-001"], { libraryPins: { "permitzip-electrical": "3" } });
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({ sheetId: "e-001", blockId: BLOCK_ID, modelRevision: b.head.revision, libraryPins: { "permitzip-electrical": "3" } });
    expect(snaps[0]?.valueHash).toMatch(/^[0-9a-f]{64}$/);
    expect(snaps[0]?.valueHash).toBe(blockValueHash(snaps[0]!.rendered, { "permitzip-electrical": "3" }));
    expect(blockSnapshotsAt(b.head, [], {})).toEqual([]);
  });

  it("issue SD, change a kitchen item's kW: live text and hash move, the sheet says changed since SD, the issued copy keeps the SD value", () => {
    const { b, item } = withLoadSummary();
    const sd = blockSnapshotsAt(b.head, ["e-001"]);
    const latest = new Map(sd.map((s) => [s.blockId, { valueHash: s.valueHash, issueLabel: "SD", rendered: s.rendered }]));
    expect(blockStatuses(sheetBlockValues(b.head, ["e-001"]), latest)[0]?.freshness).toEqual({ state: "frozen_current", issueLabel: "SD" });

    b.ok({ type: "set_parameters", id: "k1", scope: "instance", values: { load_va: 2500 } });

    const [status] = blockStatuses(sheetBlockValues(b.head, ["e-001"]), latest);
    expect(status?.freshness).toEqual({ state: "changed_since", issueLabel: "SD" });
    expect(status?.rendered.text.split("\n")[0]).toBe("Total connected 73.74 kVA = 89 A at 480Y/277V");
    expect(status?.issuedText?.split("\n")[0]).toBe("Total connected 72.74 kVA = 87 A at 480Y/277V");
    // The live sheet draws the new value; the issued copy draws its snapshot.
    expect(textOf(b.head, item)).toContain("73.74 kVA");
    expect(textOf(b.head, item, frozenBlocksFrom(sd))).toContain("72.74 kVA");
    expect(textOf(b.head, item, frozenBlocksFrom(sd))).not.toContain("73.74");
  });

  it("an unrelated edit after issue leaves the block matching the issue", () => {
    const { b } = withLoadSummary();
    const sd = blockSnapshotsAt(b.head, ["e-001"]);
    const latest = new Map(sd.map((s) => [s.blockId, { valueHash: s.valueHash, issueLabel: "SD", rendered: s.rendered }]));
    b.ok({ type: "create_level", levelId: "lvl-2", name: "Level 2", elevationMm: 4000 });
    expect(blockStatuses(sheetBlockValues(b.head, ["e-001"]), latest)[0]?.freshness.state).toBe("frozen_current");
  });

  it("a block that was never issued is live", () => {
    const { b } = withLoadSummary();
    expect(blockStatuses(sheetBlockValues(b.head, ["e-001"]), new Map())[0]?.freshness).toEqual({ state: "live" });
  });
});
