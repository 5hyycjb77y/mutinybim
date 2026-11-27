/**
 * @jest-environment node
 */
import {
  DEFAULT_MARKER_COLOR,
  DEFAULT_MARKER_WIDTH_MM,
  DEFAULT_SETTINGS,
  SHEET_MARKUPS_FEATURE,
  buildSheetSceneFor,
  documentIndex,
  executeCommand,
  gatedRecordFeatures,
  markupBounds,
  markupViewportContext,
  sceneToSvg,
  withUpgradePolicy,
  type Command,
  type ModelState,
  type Revision,
} from "../src/index";

function run(model: ModelState, cmd: Command): ModelState {
  const r = withUpgradePolicy((f) => f === SHEET_MARKUPS_FEATURE, () =>
    executeCommand(model, cmd, { actorId: "reviewer", at: "2026-11-25T12:00:00.000Z" }),
  );
  if (!r.ok) throw new Error(`${cmd.type} failed: ${r.error.message}`);
  return r.model;
}

function modelWithSheet(): ModelState {
  let m: ModelState = { modelId: "markup-test", revision: 0 as Revision, elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  m = run(m, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  m = run(m, { type: "create_view", viewId: "view-plan", name: "Level 1 Plan", viewType: "floor_plan", props: { level: "Level 1", scale: 48 } });
  m = run(m, { type: "create_sheet", sheetId: "sheet-m101", number: "M-101", name: "MECHANICAL PLAN" });
  m = run(m, { type: "place_viewport", viewportId: "vp-1", sheetId: "sheet-m101", viewId: "view-plan", center: { x: 300, y: 250 } });
  return m;
}

describe("sheet review markups", () => {
  it("stores felt-tip and highlighter strokes in markupsBySheet separately from CAD itemsByOwner", () => {
    let m = modelWithSheet();
    m = run(m, {
      type: "add_sheet_markup",
      itemId: "mk-1",
      sheetId: "sheet-m101",
      points: [{ x: 100, y: 120 }, { x: 180, y: 120 }, { x: 180, y: 170 }],
      markup: { tool: "marker", color: "#dc2626", widthMm: 2.4, note: "Move duct north" },
    });
    m = run(m, {
      type: "add_sheet_markup",
      itemId: "mk-2",
      sheetId: "sheet-m101",
      points: [{ x: 200, y: 200 }, { x: 260, y: 200 }],
      markup: { tool: "highlighter", color: "#eab308", widthMm: 9.0 },
    });

    const idx = documentIndex(m);
    const sheetMarkups = idx.markupsBySheet.get("sheet-m101") ?? [];
    expect(sheetMarkups.map((i) => i.id)).toEqual(["mk-1", "mk-2"]);
    // CAD drawing items on the sheet must not include review markups.
    expect(idx.itemsByOwner.get("sheet-m101") ?? []).toHaveLength(0);

    const bounds = markupBounds(sheetMarkups[0]!);
    expect(bounds).not.toBeNull();
    expect(bounds!.min.x).toBeLessThan(100);
    expect(bounds!.min.y).toBeLessThan(120);
    expect(bounds!.max.x).toBeGreaterThan(180);
    expect(bounds!.max.y).toBeGreaterThan(170);
  });

  it("supports redline -> yellow-line addressed -> resolved lifecycle and selective clearing", () => {
    let m = modelWithSheet();
    m = run(m, {
      type: "add_sheet_markup",
      itemId: "mk-open",
      sheetId: "sheet-m101",
      points: [{ x: 50, y: 50 }, { x: 90, y: 80 }],
    });
    m = run(m, {
      type: "add_sheet_markup",
      itemId: "mk-addr",
      sheetId: "sheet-m101",
      points: [{ x: 120, y: 50 }, { x: 160, y: 80 }],
    });
    m = run(m, {
      type: "update_sheet_markup",
      itemId: "mk-addr",
      status: "addressed",
      addressedNote: "Re-routed branch duct cleanly around beam.",
    });

    const addrItem = documentIndex(m).markupsBySheet.get("sheet-m101")?.find((i) => i.id === "mk-addr");
    expect(addrItem?.markup?.status).toBe("addressed");
    expect(addrItem?.markup?.addressedNote).toBe("Re-routed branch duct cleanly around beam.");
    expect(addrItem?.markup?.color).toBe(DEFAULT_MARKER_COLOR);
    expect(addrItem?.markup?.widthMm).toBe(DEFAULT_MARKER_WIDTH_MM);

    // Clear only addressed markups — open redline stays untouched.
    m = run(m, { type: "clear_sheet_markups", sheetId: "sheet-m101", statuses: ["addressed"] });
    const remaining = documentIndex(m).markupsBySheet.get("sheet-m101") ?? [];
    expect(remaining.map((i) => i.id)).toEqual(["mk-open"]);
  });

  it("hides markups on permit sheets by default and renders vivid full-colour markups over monochrome sheets when enabled", () => {
    let m = modelWithSheet();
    m = run(m, {
      type: "add_sheet_markup",
      itemId: "mk-red",
      sheetId: "sheet-m101",
      points: [{ x: 120, y: 120 }, { x: 220, y: 160 }],
      markup: { tool: "marker", color: "#dc2626", widthMm: 2.4, status: "open" },
    });
    m = run(m, {
      type: "add_sheet_markup",
      itemId: "mk-yellow",
      sheetId: "sheet-m101",
      points: [{ x: 120, y: 190 }, { x: 220, y: 210 }],
      markup: { tool: "marker", color: "#dc2626", widthMm: 2.4, status: "addressed" },
    });
    m = run(m, {
      type: "add_sheet_markup",
      itemId: "mk-done",
      sheetId: "sheet-m101",
      points: [{ x: 120, y: 240 }, { x: 220, y: 250 }],
      markup: { tool: "marker", color: "#9333ea", widthMm: 2.4, status: "resolved" },
    });

    // Default permit scene omits all review markups.
    const permitScene = buildSheetSceneFor(m, "sheet-m101", { projectName: "Test" });
    expect(permitScene.primitives.some((p) => p.kind === "stroke")).toBe(false);

    // Review scene includes open + addressed (with yellow-line underlay), omits resolved by default.
    const reviewScene = buildSheetSceneFor(m, "sheet-m101", { projectName: "Test", includeMarkups: true });
    const strokes = reviewScene.primitives.filter((p) => p.kind === "stroke");
    // 1 open redline + 2 strokes for addressed (yellow highlight underlay + redline on top)
    expect(strokes).toHaveLength(3);
    expect(strokes.some((s) => s.color === "#facc15")).toBe(true);
    expect(strokes.some((s) => s.color === "#9333ea")).toBe(false);

    // Monochrome sheet SVG keeps review markup ink vivid colour.
    const monoSvg = sceneToSvg(reviewScene, { monochrome: true });
    expect(monoSvg).toContain("#dc2626");
    expect(monoSvg).toContain("#facc15");

    // Opting into resolved markups shows the purple stroke too.
    const allScene = buildSheetSceneFor(m, "sheet-m101", { projectName: "Test", includeMarkups: true, includeResolvedMarkups: true });
    expect(allScene.primitives.some((p) => p.kind === "stroke" && p.color === "#9333ea")).toBe(true);
  });

  it("refuses markups via add_drawing_item and enforces the rolling peer feature gate", () => {
    const m = modelWithSheet();
    const bad = executeCommand(m, {
      type: "add_drawing_item",
      itemId: "bad-1",
      ownerId: "sheet-m101",
      shape: "markup",
      points: [{ x: 10, y: 10 }, { x: 20, y: 20 }],
    });
    expect(bad.ok).toBe(false);

    const gated = withUpgradePolicy(() => false, () =>
      executeCommand(m, {
        type: "add_sheet_markup",
        itemId: "mk-gated",
        sheetId: "sheet-m101",
        points: [{ x: 10, y: 10 }, { x: 20, y: 20 }],
      }),
    );
    expect(gated.ok).toBe(false);
    expect(SHEET_MARKUPS_FEATURE).toBe("documents:sheet_markups");
    expect(gatedRecordFeatures()).toContain(SHEET_MARKUPS_FEATURE);
  });

  it("maps sheet paper markups to overlapping viewport model coordinates", () => {
    let m = modelWithSheet();
    m = run(m, {
      type: "add_sheet_markup",
      itemId: "mk-vp",
      sheetId: "sheet-m101",
      points: [{ x: 295, y: 245 }, { x: 305, y: 255 }],
    });
    const item = documentIndex(m).markupsBySheet.get("sheet-m101")![0]!;
    const ctx = markupViewportContext(m, "sheet-m101", item);
    expect(ctx.length).toBeGreaterThanOrEqual(1);
    expect(ctx[0]!.viewId).toBe("view-plan");
    expect(ctx[0]!.scale).toBe(48);
  });

  it("cascades sheet markups on delete_sheet and delete_elements (cascade), and paints markup ink after text blocks", () => {
    let m = modelWithSheet();
    m = run(m, {
      type: "create_text_note",
      itemId: "note-1",
      ownerId: "sheet-m101",
      at: { x: 100, y: 100 },
      width: 60,
      textSize: 3,
      paragraphs: [{ runs: [{ text: "GENERAL NOTE" }] }],
    });
    m = run(m, {
      type: "add_sheet_markup",
      itemId: "mk-over-note",
      sheetId: "sheet-m101",
      points: [{ x: 95, y: 95 }, { x: 135, y: 110 }],
      markup: { color: "#dc2626", widthMm: 2.4, tool: "marker", status: "open" },
    });
    const scene = buildSheetSceneFor(m, "sheet-m101", { projectName: "Test", includeMarkups: true });
    expect(scene.textBlocks?.length).toBeGreaterThan(0);
    const svg = sceneToSvg(scene);
    const noteIdx = svg.indexOf('data-note-id="note-1"');
    const markupIdx = svg.indexOf('data-markup-id="mk-over-note"');
    expect(noteIdx).toBeGreaterThan(-1);
    expect(markupIdx).toBeGreaterThan(noteIdx);

    // delete_sheet cascades markups cleanly
    const afterDeleteSheet = run(m, { type: "delete_sheet", sheetId: "sheet-m101" });
    const deletedViaSheet = afterDeleteSheet.elements["mk-over-note"];
    expect(deletedViaSheet?.kind === "drawing_item" && deletedViaSheet.deleted).toBe(true);
    expect(documentIndex(afterDeleteSheet).markupsBySheet.get("sheet-m101")).toBeUndefined();

    // delete_elements (cascade) also removes markups cleanly
    const afterCascade = run(m, { type: "delete_elements", ids: ["sheet-m101"], policy: "cascade" });
    expect(afterCascade.elements["mk-over-note"]).toBeUndefined();
    expect(documentIndex(afterCascade).markupsBySheet.get("sheet-m101")).toBeUndefined();
  });
});
