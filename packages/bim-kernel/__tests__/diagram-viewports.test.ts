import { buildSheetSceneFor, executeCommand, layoutSheet, sheetDrawingArea, sheetViewportOverhangs, type Command, type ExecuteOk, type SheetScene, type Viewport } from "../src";
import { referenceBuilding, type Building } from "./fixtures/electrical-building";

/**
 * Live diagrams on sheets (reference building 7352, E-701, bug log #38 / #41): a live
 * one-line placed on a 36 x 24 in sheet, then its hints changed in place
 * (the existing-view path), then resized and laid out. The frame stays on the
 * sheet and the sheet prints the diagram, not just its title.
 */

const IN = 25.4;

function run(b: Building, command: Command): ExecuteOk {
  const r = executeCommand(b.head, command);
  if (!r.ok) throw new Error(r.error.message);
  b.ok(command);
  return r;
}

function e701(): Building {
  const b = referenceBuilding();
  b.ok({ type: "create_sheet", sheetId: "s-e701", number: "E-701", name: "One-line diagram" });
  run(b, {
    type: "batch_documents",
    commands: [
      { type: "create_view", viewId: "v-sld", name: "E-701 One-line", viewType: "detail", props: { diagram: { kind: "one_line", hints: { utility: true } } } },
      { type: "place_viewport", viewportId: "vp-sld", sheetId: "s-e701", viewId: "v-sld", center: { x: 10 * IN, y: 10 * IN }, scale: 1 },
    ],
  });
  return b;
}

function viewport(b: Building): Viewport {
  const vp = b.head.elements["vp-sld"];
  if (vp?.kind !== "viewport") throw new Error("no viewport");
  return vp;
}

/** Every piece of text a sheet scene prints, with where it starts on paper. */
function sheetTexts(scene: SheetScene): Array<{ text: string; x: number; y: number }> {
  const out: Array<{ text: string; x: number; y: number }> = [];
  for (const p of scene.primitives) if (p.kind === "text") out.push({ text: p.text, x: p.at.x, y: p.at.y });
  for (const block of scene.textBlocks ?? []) {
    for (const line of block.layout.lines) out.push({ text: line.pieces.map((g) => g.text).join(""), x: block.origin.x + line.left, y: block.origin.y + line.baseline });
  }
  return out;
}

function expectDiagramOnPaper(b: Building): void {
  const scene = buildSheetSceneFor(b.head, "s-e701", { projectName: "REFERENCE BUILDING" });
  const texts = sheetTexts(scene);
  const on = (t: { x: number; y: number }) => t.x >= 0 && t.y >= 0 && t.x <= scene.paper.x && t.y <= scene.paper.y;
  // The diagram's own words, on the paper; not just the viewport title under an empty frame.
  for (const word of ["MDP", "H1", "L1"]) expect(texts.filter((t) => t.text === word && on(t))).not.toHaveLength(0);
}

describe("a live diagram's viewport stays on its sheet (#38)", () => {
  it("places at the diagram's size, inside a 36 x 24 in sheet, and prints the diagram", () => {
    const b = e701();
    const vp = viewport(b);
    const area = sheetDrawingArea({ props: undefined });
    expect(vp.size.x).toBeLessThan(area.max.x - area.min.x);
    expect(vp.size.y).toBeLessThan(area.max.y - area.min.y);
    expect(sheetViewportOverhangs(b.head, "s-e701")).toEqual([]);
    expectDiagramOnPaper(b);
  });

  it("changing the diagram's hints in place keeps the frame the diagram's size (was 3048 x 2438 mm: the 10 x 8 ft default crop)", () => {
    const b = e701();
    const before = viewport(b);
    run(b, { type: "set_view_properties", viewId: "v-sld", props: { diagram: { kind: "one_line", hints: { utility: true, showLoads: true } }, scale: 1, cropView: false } });
    const after = viewport(b);
    // Old code: 3048 x 2438.4 mm (120 x 96 in), centred where it was, so the diagram drew off the paper.
    expect(after.size.x).toBeLessThan(36 * IN);
    expect(after.size.y).toBeLessThan(24 * IN);
    // The diagram grows down and right from where its top-left corner sat.
    expect(after.center.x - after.size.x / 2).toBeCloseTo(before.center.x - before.size.x / 2, 1);
    expect(after.center.y - after.size.y / 2).toBeCloseTo(before.center.y - before.size.y / 2, 1);
    expect(sheetViewportOverhangs(b.head, "s-e701")).toEqual([]);
    expectDiagramOnPaper(b);
  });

  it("fitting the crop of a diagram view is refused in words: it is as big as what it draws", () => {
    const b = e701();
    const r = executeCommand(b.head, { type: "set_view_crop", viewId: "v-sld", fit: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/live diagram .* as big as what it draws/);
  });
});

describe("resizing a live diagram's viewport (#41)", () => {
  it("is refused with the diagram's real frame size, and the sheet still prints the diagram", () => {
    const b = e701();
    const vp = viewport(b);
    const r = executeCommand(b.head, { type: "resize_viewport", viewportId: "vp-sld", size: { x: 12 * IN, y: 8 * IN }, center: { x: 13 * IN, y: 10 * IN } });
    // Old code forced the crop on and centred it on the 10 x 8 ft default window, so the clip missed the diagram.
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toBe(`"E-701 One-line" is a live diagram: its frame is as big as what it draws (${(vp.size.x / IN).toFixed(1)} x ${(vp.size.y / IN).toFixed(1)} in), like a schedule. Move it, or change what it draws (hints: orientation, hidden, roots) to change its size.`);
    expectDiagramOnPaper(b);
  });

  it("a diagram that was cropped before the fix prints whole: a live diagram ignores its crop box", () => {
    const b = e701();
    // What E-701 holds after the old resize: crop on, at a window nowhere near the diagram.
    const v = b.head.elements["v-sld"];
    if (v?.kind !== "view") throw new Error("no view");
    b.head = { ...b.head, elements: { ...b.head.elements, "v-sld": { ...v, cropMin: { x: 1371.6, y: 1117.6 }, cropMax: { x: 1676.4, y: 1320.8 }, props: { ...v.props, cropView: true } } } };
    expectDiagramOnPaper(b);
  });

  it("auto layout with fit_scales keeps a diagram at its own size (no drawing scale)", () => {
    const b = e701();
    const layout = layoutSheet(b.head, "s-e701", { mode: "pack", fitScales: true });
    expect(layout.unplaced).toEqual([]);
    expect(layout.moves.every((m) => m.scale === undefined)).toBe(true);
    const move = layout.moves[0];
    if (!move) throw new Error("no move");
    run(b, { type: "move_viewport", viewportId: move.viewportId, center: move.center });
    expectDiagramOnPaper(b);
  });

  it("rescaling a diagram is refused: it prints at its own size", () => {
    const b = e701();
    const r = executeCommand(b.head, { type: "set_viewport_scale", viewportId: "vp-sld", scale: 48 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/live diagram prints at its own size/);
  });
});

describe("a viewport frame bigger than the sheet's drawing area is reported", () => {
  it("warns in the edit's summary and in the sheet check, in inches, with what to do", () => {
    const b = referenceBuilding();
    b.ok({ type: "create_sheet", sheetId: "s-m101", number: "M-101", name: "Plan" });
    b.ok({ type: "create_view", viewId: "v-big", name: "Big detail", viewType: "detail", crop: { min: { x: 0, y: 0 }, max: { x: 60 * 12 * IN, y: 40 * 12 * IN } }, props: { scale: 24 } });
    const r = run(b, { type: "place_viewport", viewportId: "vp-big", sheetId: "s-m101", viewId: "v-big", center: { x: 18 * IN, y: 12 * IN } });
    // 60 x 40 ft at 1/2" = 1'-0" (scale 24): 720 / 24 = 30 in by 480 / 24 = 20 in, centred at 18 in, so it spans 3 to 33 in across.
    // The drawing area: x 0.5 in border + 6 mm to 36 in − 0.5 in − 100 mm title block − 6 mm = 18.7 to 795.7 mm (30.6 in wide, right edge 31.3 in);
    // y 18.7 to 590.9 mm (22.5 in). 33 in > 31.3 in, so it overhangs on the right.
    const message = 'Viewport "Big detail" on sheet M-101 is 30.0 x 20.0 in and runs past the sheet\'s drawing area (inside the border, left of the title block: 30.6 x 22.5 in on a 36.0 x 24.0 in sheet), so part of it falls outside the border or under the title block. Move it, resize it (crop), use a smaller scale, or a bigger title block.';
    expect(r.summary).toEqual([message]);
    expect(sheetViewportOverhangs(b.head, "s-m101").map((o) => o.message)).toEqual([message]);
  });
});
