/**
 * @jest-environment node
 *
 * Round 15 (lane SH15): a title block is a library row. A sheet that takes a
 * row keeps a copy of it; the row sets the paper, the border with its binding
 * margin, the strip and the drawing area, with zero kernel edits for a new
 * firm's block. Built-in title blocks print as before. The key plan follows
 * the main plan's crop. Fails on round 14: create_sheet dropped
 * `titleBlockRow` and there was no key plan.
 */
import {
  buildSheetSceneFor,
  commandSchema,
  executeCommand,
  keyPlanPrimitives,
  sheetDrawingArea,
  sheetPaperSize,
  titleBlockDefinitionSchema,
  type BimElement,
  type ModelState,
  type Primitive,
  type Sheet,
  type TitleBlockDefinition,
  type TitleBlockRow,
} from "../src";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";

const IN = 25.4;
const font = (weight: number) => ({ family: "Acme Sans", weight, file: `/fonts/acme-${weight}.ttf`, capHeight: 0.7 });

/** An outside firm's title block: nothing about it is in the kernel. */
const acme: TitleBlockDefinition = titleBlockDefinitionSchema.parse({
  schema: 1,
  paperName: "ARCH E1",
  paperMm: { x: 42 * IN, y: 30 * IN },
  marginsMm: { top: 0.5 * IN, right: 0.5 * IN, bottom: 0.5 * IN, left: 1.5 * IN },
  stripWidthMm: 4 * IN,
  colors: { ink: "#111111", label: "#444444", accent: "#0055AA" },
  fonts: { display: font(500), displayBold: font(700), body: font(400) },
  lines: { borderMm: 0.7, dividerMm: 0.35, ruleMm: 0.18 },
  slots: [
    { kind: "firm", heightMm: 30, lines: ["Acme Engineers", "Springfield"] },
    { kind: "project", heightMm: 40 },
    { kind: "key_plan", heightMm: 2 * IN + 14, boxMm: { x: 3 * IN, y: 2 * IN } },
    { kind: "revisions" },
    { kind: "qr", heightMm: 28 },
    { kind: "sheet_id", heightMm: 50, titleCapMm: 4, numberCapMm: 12 },
  ],
});
const row: TitleBlockRow = { id: "acme:title_block:e1", revision: 3, name: "Acme 30x42", definition: acme };

function run(model: ModelState, command: Record<string, unknown> & { type: string }): ModelState {
  const r = executeCommand(model, commandSchema.parse(command));
  if (!r.ok) throw new Error(r.error.message);
  return { ...r.model, revision: (model.revision + 1) as ModelState["revision"] };
}

function withWalls(model: ModelState): ModelState {
  const corners = [
    { x: -6000, y: -8000 },
    { x: 34000, y: -8000 },
    { x: 34000, y: 22000 },
    { x: -6000, y: 22000 },
  ];
  const elements: Record<string, BimElement> = { ...model.elements };
  corners.forEach((start, i) => {
    const id = `w-${i}`;
    elements[id] = { id, version: 1, authoredRev: {}, kind: "wall", start, end: corners[(i + 1) % 4] ?? start, thickness: 200, height: 3600, wallType: "generic" } as BimElement;
  });
  return { ...model, elements };
}

function sheetWith(model: ModelState, extra: Record<string, unknown> = {}): ModelState {
  let m = run(model, { type: "create_sheet", sheetId: "s1", number: "M-101", name: "Plan", titleBlockRow: row, ...extra });
  m = run(m, { type: "create_view", viewId: "v1", name: "L1", viewType: "floor_plan", crop: { min: { x: -6000, y: -8000 }, max: { x: 14000, y: 7000 } }, props: { level: "L1" } });
  return run(m, { type: "place_viewport", viewportId: "vp1", sheetId: "s1", viewId: "v1", center: { x: 400, y: 300 }, scale: 48 });
}

const sheetOf = (m: ModelState): Sheet => {
  const s = m.elements["s1"];
  if (s?.kind !== "sheet") throw new Error("no sheet");
  return s;
};

describe("sh15-title-block-rows", () => {
  it("a sheet keeps the row it took: the row sets the paper, the binding-margin border and the drawing area", () => {
    const m = sheetWith(withWalls(createDemoModel()));
    const sheet = sheetOf(m);
    expect(sheet.props?.titleBlockRow?.id).toBe("acme:title_block:e1");
    expect(sheetPaperSize(sheet)).toEqual({ x: 42 * IN, y: 30 * IN });
    const area = sheetDrawingArea(sheet);
    expect(area.min.x).toBeCloseTo(1.5 * IN + 6, 5);
    expect(area.max.x).toBeCloseTo(42 * IN - 0.5 * IN - 4 * IN - 6, 5);
    const scene = buildSheetSceneFor(m, "s1", { projectName: "Acme job", projectNumber: "1234" });
    expect(scene.paper).toEqual({ x: 42 * IN, y: 30 * IN });
    const border = scene.primitives.find((p): p is Extract<Primitive, { kind: "rect" }> => p.kind === "rect" && p.at.x === 1.5 * IN);
    expect(border?.widthMm).toBe(0.7);
    expect(scene.fonts?.map((f) => f.family)).toEqual(["Acme Sans", "Acme Sans", "Acme Sans"]);
    const texts = scene.primitives.flatMap((p) => (p.kind === "text" ? [p.text] : []));
    expect(texts).toEqual(expect.arrayContaining(["ACME ENGINEERS", "ACME JOB", "1234", "M-101", "PLAN"]));
    // The QR slot is where an issued sheet's Verify code goes.
    expect(scene.codeSlot && scene.codeSlot.left).toBeGreaterThan(42 * IN - 0.5 * IN - 4 * IN);
  });

  it("null goes back to the built-in title block; a malformed row is refused before it reaches the sheet", () => {
    let m = sheetWith(createDemoModel());
    m = run(m, { type: "set_sheet_properties", sheetId: "s1", titleBlockRow: null });
    expect(sheetOf(m).props?.titleBlockRow).toBeUndefined();
    expect(sheetPaperSize(sheetOf(m))).toEqual({ x: 36 * IN, y: 24 * IN });
    const bad = { ...row, definition: { ...acme, slots: [{ kind: "revisions" }, { kind: "revisions" }] } };
    expect(commandSchema.safeParse({ type: "set_sheet_properties", sheetId: "s1", titleBlockRow: bad }).success).toBe(false);
  });

  it("a built-in title block prints as before: no scene fonts, no styled primitives, no library code slot", () => {
    let m = run(createDemoModel(), { type: "create_sheet", sheetId: "s1", number: "M-101", name: "Plan" });
    m = run(m, { type: "create_view", viewId: "v1", name: "L1", viewType: "floor_plan", props: { level: "L1" } });
    m = run(m, { type: "place_viewport", viewportId: "vp1", sheetId: "s1", viewId: "v1", center: { x: 300, y: 300 } });
    const scene = buildSheetSceneFor(m, "s1", { projectName: "Test" });
    expect(scene.fonts).toBeUndefined();
    expect(scene.codeSlot).toBeUndefined();
    expect(scene.primitives.some((p) => "color" in p || "widthMm" in p || "font" in p)).toBe(false);
    expect(scene.primitives[0]).toEqual({ kind: "rect", at: { x: 12.7, y: 12.7 }, size: { x: 36 * IN - 25.4, y: 24 * IN - 25.4 }, pen: "heavy" });
  });
});

describe("sh15-key-plan-follows-crop", () => {
  const box = { at: { x: 0, y: 0 }, size: { x: 3 * IN, y: 2 * IN } };
  const hatchRect = (prims: Primitive[]) => prims.filter((p): p is Extract<Primitive, { kind: "rect" }> => p.kind === "rect").at(-1);

  it("draws the level's walls and outlines the shown area; moving the crop moves it", () => {
    const m = sheetWith(withWalls(createDemoModel()));
    const before = keyPlanPrimitives(m, sheetOf(m), box);
    expect(before.filter((p) => p.kind === "line" && p.pen === "medium")).toHaveLength(4);
    const a = hatchRect(before);
    const moved = run(m, { type: "set_view_crop", viewId: "v1", crop: { min: { x: 14000, y: 7000 }, max: { x: 34000, y: 22000 } }, keepViewportCenter: true });
    const b = hatchRect(keyPlanPrimitives(moved, sheetOf(moved), box));
    expect(a && b).toBeTruthy();
    // The shown area moved right and up (paper y is down).
    expect(b!.at.x).toBeGreaterThan(a!.at.x + 10);
    expect(b!.at.y).toBeLessThan(a!.at.y - 10);
    // Hatching stays inside the shown area.
    for (const p of keyPlanPrimitives(moved, sheetOf(moved), box)) {
      if (p.kind !== "line" || p.widthMm !== 0.13) continue;
      for (const q of [p.a, p.b]) {
        expect(q.x).toBeGreaterThanOrEqual(b!.at.x - 1e-6);
        expect(q.x).toBeLessThanOrEqual(b!.at.x + b!.size.x + 1e-6);
      }
    }
  });

  it("an edit that writes no wall, floor or level keeps the outline; moving a wall redraws it", () => {
    const m = sheetWith(withWalls(createDemoModel()));
    const before = keyPlanPrimitives(m, sheetOf(m), box);
    const other = run(m, { type: "set_sheet_properties", sheetId: "s1", name: "Plan renamed" });
    expect(keyPlanPrimitives(other, sheetOf(other), box)).toEqual(before);
    const moved = run(other, { type: "move_wall", wallId: "w-0", delta: { x: 0, y: -3000 } });
    const after = keyPlanPrimitives(moved, sheetOf(moved), box);
    expect(after).not.toEqual(before);
    // The moved wall's line is drawn where the wall now is (lower on paper: model -y is paper down).
    const walls = (prims: Primitive[]) => prims.filter((p): p is Extract<Primitive, { kind: "line" }> => p.kind === "line" && p.pen === "medium");
    expect(Math.max(...walls(after).map((p) => p.a.y))).toBeGreaterThan(Math.max(...walls(before).map((p) => p.a.y)) - 1e-6);
  });

  it("is empty on a sheet with no plan (the box stays blank)", () => {
    const m = run(createDemoModel(), { type: "create_sheet", sheetId: "s1", number: "M-001", name: "Notes", titleBlockRow: row });
    expect(keyPlanPrimitives(m, sheetOf(m), box)).toEqual([]);
  });
});
