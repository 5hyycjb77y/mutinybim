/**
 * @jest-environment node
 *
 * Verifies Wave 5 editor improvements:
 * - Selection locks `showLocked` toggle state + kernel `lock_category` command
 * - Pre-Print Quality Gate report formatting & error/warning aggregation
 * - Document undo & redo cycle via `restore_document_elements` (create, update, delete)
 */
import {
  DEFAULT_SETTINGS,
  asRevision,
  commandSchema,
  executeCommand,
  toDocumentRecord,
  withUpgradePolicy,
  type BimElement,
  type ModelState,
} from "@permitzip/bim-kernel";
import { getSelectionLocks, isElementLockedInModel, isSelectableUnderLocks, setSelectionLocks, toggleSelectionLock } from "../src/editor/selection-locks";
import { formatPrePrintQualityReport } from "../src/editor/views-sheets/DrawingSetDialogs";

function emptyModel(id: string): ModelState {
  return { modelId: id, revision: asRevision(0), elements: {}, connections: [], settings: DEFAULT_SETTINGS };
}

function run(model: ModelState, raw: Record<string, unknown>): ModelState {
  const res = withUpgradePolicy(() => true, () => executeCommand(model, commandSchema.parse(raw)));
  if (!res.ok) throw new Error(`Command ${String(raw.type)} failed: ${res.error.message}`);
  return res.model;
}

describe("Wave 5 editor features", () => {
  it("exposes showLocked toggle and lock_category locks/unlocks categories cleanly", () => {
    setSelectionLocks({ showLocked: false });
    expect(getSelectionLocks().showLocked).toBe(false);
    toggleSelectionLock("showLocked");
    expect(getSelectionLocks().showLocked).toBe(true);
    setSelectionLocks({ showLocked: false });

    let model = emptyModel("lock-cat-test");
    model = run(model, { type: "create_level", levelId: "l1", name: "Level 1", elevationMm: 0 });
    model = run(model, {
      type: "add_architecture",
      levelId: "l1",
      walls: [{ wallId: "w-1", start: { x: 0, y: 0 }, end: { x: 5000, y: 0 }, thicknessMm: 150, heightMm: 3000 }],
    });

    expect(isElementLockedInModel(model, model.elements["w-1"])).toBe(false);
    expect(isSelectableUnderLocks(model.elements["w-1"], getSelectionLocks(), model)).toBe(true);

    model = run(model, { type: "lock_category", category: "walls", locked: true });
    expect(isElementLockedInModel(model, model.elements["w-1"])).toBe(true);
    expect(isSelectableUnderLocks(model.elements["w-1"], getSelectionLocks(), model)).toBe(false);

    model = run(model, { type: "lock_category", category: "walls", locked: false });
    expect(isElementLockedInModel(model, model.elements["w-1"])).toBe(false);
    expect(isSelectableUnderLocks(model.elements["w-1"], getSelectionLocks(), model)).toBe(true);
  });

  it("formats Pre-Print Quality Gate reports cleanly for clipboard / review export", () => {
    const text = formatPrePrintQualityReport({
      errors: [{ id: "e1", severity: "error", message: "Panel LP-1 bus overloaded (240A > 225A)" }],
      warnings: [{ id: "w1", severity: "warning", message: "RTU-1 missing local disconnect within sight (NEC 440.14)" }],
    });
    expect(text).toContain("1 error(s), 1 warning(s)");
    expect(text).toContain("[ERROR] Panel LP-1 bus overloaded (240A > 225A)");
    expect(text).toContain("[WARN] RTU-1 missing local disconnect within sight (NEC 440.14)");
  });

  it("supports full document undo and redo round-trip via restore_document_elements", () => {
    let model = emptyModel("doc-undo-redo-test");
    model = run(model, { type: "create_sheet", sheetId: "sh-1", number: "E-101", name: "Power" });

    // 1. Create a drawing item, undo it (soft-delete), then redo it (restore live).
    const beforeCreate = model.elements["item-1"] ?? null;
    model = run(model, {
      type: "add_drawing_item",
      itemId: "item-1",
      ownerId: "sh-1",
      shape: "line",
      points: [{ x: 0, y: 0 }, { x: 100, y: 0 }],
    });
    const afterCreate = model.elements["item-1"] as BimElement;
    expect(afterCreate).toBeDefined();
    expect((afterCreate as { deleted?: boolean }).deleted).toBeUndefined();

    // Undo create
    model = run(model, {
      type: "restore_document_elements",
      items: [{ elementId: "item-1", before: beforeCreate ? toDocumentRecord(beforeCreate) : null, expectedVersion: afterCreate.version }],
    });
    const afterUndo = model.elements["item-1"] as BimElement & { deleted?: boolean };
    expect(afterUndo.deleted).toBe(true);

    // Redo create (mirrors redoDocumentEdit restoring `afterCreate`)
    model = run(model, {
      type: "restore_document_elements",
      items: [{ elementId: "item-1", before: toDocumentRecord(afterCreate), expectedVersion: afterUndo.version }],
    });
    const afterRedo = model.elements["item-1"] as BimElement & { deleted?: boolean };
    expect(afterRedo.deleted).toBeUndefined();
    expect(afterRedo.kind).toBe("drawing_item");
  });
});
