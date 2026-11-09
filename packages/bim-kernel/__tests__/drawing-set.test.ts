/**
 * @jest-environment node
 *
 * Drawing-set kernel: batches of views/sheets commands commit all or nothing,
 * schedules print what the model says and size their frames from their rows,
 * sheets carry a revision table, and sheet layout is deterministic and stays
 * inside the drawing area.
 */
import {
  buildSheetSceneFor,
  commandSchema,
  documentIndex,
  evaluateSchedule,
  executeCommand,
  layoutSheet,
  scheduleTable,
  sheetDependsOn,
  sheetDrawingArea,
  viewportFrameSize,
  type ModelState,
  type ScheduleDefinition,
} from "../src";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";

function run(model: ModelState, command: Record<string, unknown> & { type: string }): ModelState {
  const r = executeCommand(model, commandSchema.parse(command));
  if (!r.ok) throw new Error(r.error.message);
  return { ...r.model, revision: (model.revision + 1) as ModelState["revision"] };
}

const terminals: ScheduleDefinition = { category: "air_terminal", columns: [{ field: "mark" }, { field: "type" }, { field: "cfm" }] };

function texts(model: ModelState, sheetId: string): string[] {
  return buildSheetSceneFor(model, sheetId, { projectName: "Test" }).primitives.flatMap((p) => (p.kind === "text" ? [p.text] : []));
}

describe("batch_documents", () => {
  it("creates a sheet, a plan and places the plan in one result", () => {
    const m = createDemoModel();
    const r = executeCommand(
      m,
      commandSchema.parse({
        type: "batch_documents",
        label: "Start M-101",
        commands: [
          { type: "create_sheet", sheetId: "s1", number: "M-101", name: "Plan" },
          { type: "create_view", viewId: "v1", name: "L1 Plan", viewType: "floor_plan", props: { level: "L1" } },
          { type: "place_viewport", viewportId: "vp1", sheetId: "s1", viewId: "v1", center: { x: 300, y: 300 } },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.changedIds).toEqual(expect.arrayContaining(["s1", "v1", "vp1"]));
    expect(r.summary?.[0]).toBe("Start M-101: 3 steps");
    // Only elements that existed before the batch are in the read set.
    for (const id of Object.keys(r.readSet)) expect(m.elements[id]).toBeDefined();
    expect(documentIndex(r.model).viewportsBySheet.get("s1")).toHaveLength(1);
  });

  it("is all or nothing, and says which step was refused", () => {
    const m = createDemoModel();
    const r = executeCommand(
      m,
      commandSchema.parse({
        type: "batch_documents",
        commands: [
          { type: "create_sheet", sheetId: "s1", number: "M-101", name: "Plan" },
          { type: "create_sheet", sheetId: "s2", number: "M-101", name: "Duplicate number" },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/^Step 2 of 2 \(create sheet\): Sheet M-101 already exists/);
  });

  it("the document index carried step to step equals a fresh build", () => {
    let m = createDemoModel();
    m = run(m, { type: "create_sheet", sheetId: "s0", number: "M-001", name: "Notes" });
    documentIndex(m);
    const steps = [
      { type: "create_sheet", sheetId: "s1", number: "M-101", name: "Plan" },
      { type: "create_view", viewId: "v1", name: "L1", viewType: "floor_plan", props: { level: "L1" } },
      { type: "create_view", viewId: "d1", name: "Detail", viewType: "detail" },
      { type: "place_viewport", viewportId: "vp1", sheetId: "s1", viewId: "v1", center: { x: 300, y: 300 } },
      { type: "place_viewport", viewportId: "vp2", sheetId: "s1", viewId: "d1", center: { x: 600, y: 300 } },
      ...Array.from({ length: 20 }, (_, k) => ({ type: "add_drawing_item", itemId: `l${k}`, ownerId: "d1", shape: "line", points: [{ x: 0, y: k * 10 }, { x: 500, y: k * 10 }] })),
      { type: "rename_view", viewId: "v1", name: "Level 1" },
      { type: "move_viewport", viewportId: "vp1", center: { x: 310, y: 300 } },
      { type: "delete_drawing_item", itemId: "l3" },
      { type: "remove_viewport", viewportId: "vp2" },
      { type: "set_sheet_properties", sheetId: "s0", name: "Notes and index" },
      { type: "delete_sheet", sheetId: "s0" },
    ];
    const r = executeCommand(m, commandSchema.parse({ type: "batch_documents", commands: steps }));
    if (!r.ok) throw new Error(r.error.message);
    const carried = documentIndex(r.model);
    const fresh = documentIndex({ elements: JSON.parse(JSON.stringify(r.model.elements)), connections: r.model.connections });
    const ids = (i: ReturnType<typeof documentIndex>) => ({
      views: i.views.map((v) => `${v.id}:${v.name}`),
      sheets: i.sheets.map((s) => `${s.id}:${s.title}`),
      viewportsBySheet: [...i.viewportsBySheet].filter(([, l]) => l.length > 0).map(([k, l]) => [k, l.map((v) => `${v.id}@${v.center.x}`)]).sort(),
      viewportByView: [...i.viewportByView].map(([k, v]) => `${k}:${v.id}`).sort(),
      itemsByOwner: [...i.itemsByOwner].filter(([, l]) => l.length > 0).map(([k, l]) => [k, l.map((x) => x.id)]).sort(),
    });
    expect(ids(carried)).toEqual(ids(fresh));
    expect(carried.itemsByOwner.get("d1")).toHaveLength(19);
  });

  it("refuses commands that aren't views or sheets commands", () => {
    expect(commandSchema.safeParse({ type: "batch_documents", commands: [{ type: "move_equipment", equipmentId: "x", delta: { x: 1, y: 0 } }] }).success).toBe(false);
  });
});

describe("schedules", () => {
  it("lists the model's air terminals with their airflow, sorted by mark", () => {
    const m = createDemoModel();
    const evaluated = evaluateSchedule(m, terminals);
    const expected = Object.values(m.elements).filter((e) => e.kind === "terminal");
    expect(expected.length).toBeGreaterThan(0);
    expect(evaluated.rows).toHaveLength(expected.length);
    expect(evaluated.headings).toEqual(["MARK", "TYPE", "CFM"]);
    const marks = evaluated.rows.map((r) => r[0] ?? "");
    expect(marks).toEqual([...marks].sort((a, b) => a.localeCompare(b, "en", { numeric: true })));
  });

  it("itemize off combines identical rows with a count", () => {
    const m = createDemoModel();
    const combined = evaluateSchedule(m, { category: "air_terminal", columns: [{ field: "type" }], itemize: false });
    const total = combined.rows.reduce((n, r) => n + Number(r[r.length - 1]), 0);
    expect(combined.headings).toEqual(["TYPE", "COUNT"]);
    expect(total).toBe(Object.values(m.elements).filter((e) => e.kind === "terminal").length);
  });

  it("filters by value", () => {
    const m = createDemoModel();
    const all = evaluateSchedule(m, terminals);
    const big = evaluateSchedule(m, { ...terminals, filters: [{ field: "cfm", op: "greater_than", value: "150" }] });
    expect(big.rows.every((r) => Number(r[2]) > 150)).toBe(true);
    expect(big.rows.length).toBeLessThanOrEqual(all.rows.length);
  });

  it("is a view placed at its table size, prints its rows, and refuses scales and crops", () => {
    let m = createDemoModel();
    m = run(m, { type: "create_sheet", sheetId: "s1", number: "M-601", name: "Schedules" });
    m = run(m, { type: "create_view", viewId: "sch", name: "Air device schedule", viewType: "schedule", props: { schedule: terminals } });
    m = run(m, { type: "place_viewport", viewportId: "vp", sheetId: "s1", viewId: "sch", center: { x: 200, y: 150 } });
    const view = m.elements.sch;
    if (view?.kind !== "view") throw new Error("no view");
    const vp = documentIndex(m).viewportByView.get("sch");
    expect(vp?.size).toEqual(scheduleTable(m, terminals).size);
    expect(vp?.scale).toBe(1);
    const printed = texts(m, "s1");
    expect(printed).toContain("AIR TERMINALS");
    for (const row of evaluateSchedule(m, terminals).rows) expect(printed).toContain(row[0]);
    // Schedules have no view title strip or scale line.
    expect(printed.some((t) => t.includes("AIR DEVICE SCHEDULE") && t.startsWith("1 "))).toBe(false);
    const refusals = [
      { type: "set_viewport_scale", viewportId: "vp", scale: 48 },
      { type: "resize_viewport", viewportId: "vp", size: { x: 100, y: 100 } },
      { type: "set_view_crop", viewId: "sch", fit: true },
    ];
    for (const c of refusals) expect(executeCommand(m, commandSchema.parse(c)).ok).toBe(false);
    // A placed schedule depends on every level's elements.
    const depends = sheetDependsOn(m, "s1");
    const terminal = Object.values(m.elements).find((e) => e.kind === "terminal");
    expect(terminal && depends(terminal.id, terminal)).toBe(true);
  });

  it("grows down from its top-left corner when its definition changes", () => {
    let m = createDemoModel();
    m = run(m, { type: "create_sheet", sheetId: "s1", number: "M-601", name: "Schedules" });
    m = run(m, { type: "create_view", viewId: "sch", name: "Terminals", viewType: "schedule", props: { schedule: { ...terminals, itemize: false, columns: [{ field: "type" }] } } });
    m = run(m, { type: "place_viewport", viewportId: "vp", sheetId: "s1", viewId: "sch", center: { x: 200, y: 150 } });
    const before = documentIndex(m).viewportByView.get("sch");
    m = run(m, { type: "set_view_properties", viewId: "sch", props: { schedule: terminals } });
    const after = documentIndex(m).viewportByView.get("sch");
    if (!before || !after) throw new Error("not placed");
    expect(after.size.y).toBeGreaterThan(before.size.y);
    expect(after.center.x - after.size.x / 2).toBeCloseTo(before.center.x - before.size.x / 2, 1);
    expect(after.center.y - after.size.y / 2).toBeCloseTo(before.center.y - before.size.y / 2, 1);
  });

  it("the sheet list shows each sheet's latest revision", () => {
    let m = createDemoModel();
    m = run(m, { type: "create_sheet", sheetId: "s1", number: "M-001", name: "Legend", revisions: [{ number: "1", date: "2026-10-01", description: "Permit" }] });
    m = run(m, { type: "create_sheet", sheetId: "s2", number: "M-101", name: "Plan" });
    m = run(m, { type: "set_sheet_properties", sheetId: "s2", revisions: [{ number: "1", date: "2026-10-01", description: "Permit" }, { number: "2", date: "2026-10-20", description: "Revised per comments" }] });
    const list = evaluateSchedule(m, { category: "sheet_list", columns: [{ field: "number" }, { field: "name" }, { field: "revision" }] });
    expect(list.rows).toEqual([
      ["M-001", "Legend", "1"],
      ["M-101", "Plan", "2"],
    ]);
  });
});

describe("sheet revisions", () => {
  it("print in the title block, newest first", () => {
    let m = createDemoModel();
    m = run(m, { type: "create_sheet", sheetId: "s1", number: "M-101", name: "Plan" });
    m = run(m, { type: "set_sheet_properties", sheetId: "s1", revisions: [{ number: "1", date: "2026-10-01", description: "Issued for permit" }, { number: "2", date: "2026-10-20", description: "Revised per comments" }] });
    const printed = texts(m, "s1");
    expect(printed).toEqual(expect.arrayContaining(["REVISIONS", "ISSUED FOR PERMIT", "REVISED PER COMMENTS", "2026-10-20"]));
    expect(printed.indexOf("REVISED PER COMMENTS")).toBeLessThan(printed.indexOf("ISSUED FOR PERMIT"));
  });
});

describe("sheet layout", () => {
  function sheetWithViews(count: number): ModelState {
    let m = createDemoModel();
    m = run(m, { type: "create_sheet", sheetId: "s1", number: "M-501", name: "Details" });
    for (let i = 0; i < count; i++) {
      m = run(m, { type: "create_view", viewId: `d${i}`, name: `Detail ${i + 1}`, viewType: "detail", crop: { min: { x: 0, y: 0 }, max: { x: 1200 + i * 300, y: 900 } } });
      m = run(m, { type: "place_viewport", viewportId: `vp${i}`, sheetId: "s1", viewId: `d${i}`, center: { x: 100, y: 100 } });
    }
    return m;
  }

  it("packs every frame inside the drawing area without overlaps, the same way every time", () => {
    const m = sheetWithViews(6);
    const sheet = m.elements.s1;
    if (sheet?.kind !== "sheet") throw new Error("no sheet");
    const area = sheetDrawingArea(sheet);
    const a = layoutSheet(m, "s1", { mode: "pack" });
    expect(layoutSheet(m, "s1", { mode: "pack" })).toEqual(a);
    expect(a.unplaced).toEqual([]);
    const boxes = a.moves.map((mv) => {
      const view = m.elements[mv.viewportId.replace("vp", "d")];
      if (view?.kind !== "view") throw new Error("no view");
      const size = viewportFrameSize(m, view, 8);
      return { x0: mv.center.x - size.x / 2, x1: mv.center.x + size.x / 2, y0: mv.center.y - size.y / 2, y1: mv.center.y + size.y / 2 + 16 };
    });
    for (const b of boxes) {
      expect(b.x0).toBeGreaterThanOrEqual(area.min.x - 1e-6);
      expect(b.x1).toBeLessThanOrEqual(area.max.x + 1e-6);
      expect(b.y1).toBeLessThanOrEqual(area.max.y + 1e-6);
    }
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const p = boxes[i];
        const q = boxes[j];
        if (!p || !q) continue;
        expect(p.x1 <= q.x0 || q.x1 <= p.x0 || p.y1 <= q.y0 || q.y1 <= p.y0).toBe(true);
      }
  });

  it("aligns a grid's columns", () => {
    const m = sheetWithViews(4);
    const g = layoutSheet(m, "s1", { mode: "grid", columns: 2 });
    const xs = g.moves.map((mv) => mv.center.x);
    expect(xs[0]).toBe(xs[2]);
    expect(xs[1]).toBe(xs[3]);
  });

  it("shrinks a plan's scale to fit when asked, and reports what still won't fit", () => {
    let m = createDemoModel();
    m = run(m, { type: "create_sheet", sheetId: "s1", number: "M-101", name: "Plan", titleBlock: "ansi_b_mutinybim" });
    m = run(m, { type: "create_view", viewId: "p", name: "Big plan", viewType: "floor_plan", props: { level: "L1", scale: 24 }, crop: { min: { x: 0, y: 0 }, max: { x: 60000, y: 40000 } } });
    m = run(m, { type: "place_viewport", viewportId: "vp", sheetId: "s1", viewId: "p", center: { x: 150, y: 120 }, scale: 192 });
    m = run(m, { type: "set_viewport_scale", viewportId: "vp", scale: 24 });
    expect(layoutSheet(m, "s1", { mode: "pack" }).unplaced).toHaveLength(1);
    const fitted = layoutSheet(m, "s1", { mode: "pack", fitScales: true, minScale: 192 });
    expect(fitted.unplaced).toEqual([]);
    expect(fitted.moves[0]?.scale).toBeGreaterThan(24);
  });
});
