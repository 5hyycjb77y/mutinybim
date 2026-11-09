/**
 * @jest-environment node
 *
 * Viewport size/centre validation for sheet rendering (finding f668fe10,
 * E-701: a live diagram whose stored frame was the 120" x 96" empty-content
 * default on a 36" x 24" sheet exported blank). Two guarantees:
 *
 *   1. The stored frame of a placed schedule or live diagram always matches
 *      what it draws from the model now, so its anchor never drifts off the
 *      paper when its content changes (the corruption that made E-701 blank).
 *   2. Whatever a stored viewport says, the frame the sheet renders overlaps
 *      the paper — a viewport that would draw wholly off the paper is pulled
 *      back until it shows, so a sheet export is never blank.
 */
import {
  buildSheetSceneFor,
  canonicalJson,
  commandSchema,
  executeCommand,
  frameForViewport,
  sheetPaper,
  type Viewport,
} from "../src";
import { Building, referenceBuilding } from "./fixtures/electrical-building";

const ARCH_D = { x: 36 * 25.4, y: 24 * 25.4 };

/** A one-line diagram view and an E-701 sheet to place it on. */
function withDiagramSheet(b = new Building()): Building {
  b.ok({ type: "create_view", viewId: "v-one-line", name: "One-line diagram", viewType: "detail", props: { diagram: { kind: "one_line" } } });
  b.ok({ type: "create_sheet", sheetId: "s-e701", number: "E-701", name: "Electrical one-line diagram" });
  return b;
}

function viewportOf(b: Building, id: string): Viewport {
  const vp = b.head.elements[id];
  if (vp?.kind !== "viewport") throw new Error(`missing viewport ${id}`);
  return vp;
}

/** Primitives that land inside the paper: what the sheet actually shows (writers clip the rest at the page edge). */
function visibleInk(scene: ReturnType<typeof buildSheetSceneFor>): number {
  const within = (v: { x: number; y: number }) => v.x >= -0.01 && v.x <= scene.paper.x + 0.01 && v.y >= -0.01 && v.y <= scene.paper.y + 0.01;
  return scene.primitives.filter((p) => {
    switch (p.kind) {
      case "line":
        return within(p.a) || within(p.b);
      case "rect":
        return true;
      case "fill":
        return p.points.some(within);
      case "text":
        return within(p.at);
    }
  }).length;
}

/** A viewport record as `restore_document_elements` takes it back (undo writes records without re-validating). */
function restored(b: Building, id: string, patch: Partial<Viewport>): void {
  const current = viewportOf(b, id);
  const before = { ...(JSON.parse(canonicalJson(current)) as Viewport), ...patch };
  b.ok({ type: "restore_document_elements", items: [{ elementId: id, before, expectedVersion: current.version }] });
}

describe("placing a content-sized viewport", () => {
  it("records the diagram's real content size, never the 120\" x 96\" empty-content default", () => {
    const b = withDiagramSheet(referenceBuilding());
    b.ok({ type: "place_viewport", viewportId: "vp-1", sheetId: "s-e701", viewId: "v-one-line", center: { x: 381, y: 254 } });
    const vp = viewportOf(b, "vp-1");
    expect(vp.size).not.toEqual({ x: 3048, y: 2438.4 });
    expect(vp.center).toEqual({ x: 381, y: 254 });
  });

  it("keeps the stored frame at the real content size when its hints change (the E-701 corruption)", () => {
    const b = withDiagramSheet(referenceBuilding());
    b.ok({ type: "place_viewport", viewportId: "vp-1", sheetId: "s-e701", viewId: "v-one-line", center: { x: 381, y: 254 } });
    // Toggle the utility hint (the E-701 re-test): the stored frame follows the diagram's
    // real content, not the 120" x 96" default crop that corrupted E-701's viewport.
    b.ok({ type: "set_view_properties", viewId: "v-one-line", props: { diagram: { kind: "one_line", hints: { utility: true } } } });
    const after = viewportOf(b, "vp-1");
    expect(after.size).not.toEqual({ x: 3048, y: 2438.4 });
    const view = b.head.elements["v-one-line"];
    if (view?.kind !== "view") throw new Error("missing view");
    // The rendered frame is the stored frame: no drift between what is saved and what prints.
    const frame = frameForViewport(b.head, after, view);
    expect(frame.size).toEqual(after.size);
    expect(frame.center).toEqual(after.center);
  });

  it("refuses a centre off the paper, the one placement that can never show anything", () => {
    const b = withDiagramSheet(referenceBuilding());
    const r = executeCommand(
      b.head,
      commandSchema.parse({ type: "place_viewport", viewportId: "vp-1", sheetId: "s-e701", viewId: "v-one-line", center: { x: 381, y: 254 + ARCH_D.y } }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("invalid_value");
      expect(r.error.message).toContain("centre is off sheet E-701");
    }
  });

  it("still allows content wider than the paper, anchored so the paper shows its top-left corner", () => {
    const b = withDiagramSheet(referenceBuilding());
    // Drafting lines 4 m apart make the diagram wider than any sheet we print.
    b.ok({ type: "add_drawing_item", itemId: "spread-1", ownerId: "v-one-line", shape: "line", points: [{ x: 0, y: 0 }, { x: 4000, y: 0 }] });
    b.ok({ type: "add_drawing_item", itemId: "spread-2", ownerId: "v-one-line", shape: "line", points: [{ x: 0, y: 0 }, { x: 0, y: 400 }] });
    b.ok({ type: "place_viewport", viewportId: "vp-1", sheetId: "s-e701", viewId: "v-one-line", center: { x: 381, y: 254 } });
    const scene = buildSheetSceneFor(b.head, "s-e701", { projectName: "Test" });
    expect(visibleInk(scene)).toBeGreaterThan(4);
    const lines = scene.primitives.filter((p) => p.kind === "line");
    expect(lines.length).toBeGreaterThan(0);
  });

  it("keeps allowing a plan viewport bigger than the paper: the sheet layout tool fits those by scale", () => {
    const b = new Building();
    b.ok({ type: "create_sheet", sheetId: "s-1", number: "M-101", name: "Plan", titleBlock: "ansi_b_mutinybim" });
    b.ok({ type: "create_view", viewId: "v-plan", name: "Big plan", viewType: "floor_plan", props: { level: "Level 1" }, crop: { min: { x: 0, y: 0 }, max: { x: 60000, y: 40000 } } });
    b.ok({ type: "place_viewport", viewportId: "vp-1", sheetId: "s-1", viewId: "v-plan", center: { x: 150, y: 120 }, scale: 192 });
    b.ok({ type: "set_viewport_scale", viewportId: "vp-1", scale: 24 });
    const vp = viewportOf(b, "vp-1");
    const sheet = b.head.elements["s-1"];
    if (sheet?.kind !== "sheet") throw new Error("missing sheet");
    expect(vp.size.x).toBeGreaterThan(sheetPaper(sheet).x);
    expect(vp.center.x).toBeLessThanOrEqual(sheetPaper(sheet).x);
  });
});

describe("rendering a valid diagram on a sheet", () => {
  it("places it, prints its title and its diagram, all inside the paper", () => {
    const b = withDiagramSheet(referenceBuilding());
    b.ok({ type: "place_viewport", viewportId: "vp-1", sheetId: "s-e701", viewId: "v-one-line", center: { x: 381, y: 254 } });
    const scene = buildSheetSceneFor(b.head, "s-e701", { projectName: "Test" });
    const texts = scene.primitives.flatMap((p) => (p.kind === "text" ? [p.text] : []));
    expect(texts.some((t) => t.startsWith("1  "))).toBe(true);
    expect(texts.some((t) => /[A-Z]/.test(t) && !t.startsWith("1  ") && t !== "MUTINYBIM")).toBe(true);
    expect(visibleInk(scene)).toBeGreaterThan(4);
  });

  it("leaves a frame that already overlaps the paper exactly where it was placed", () => {
    const b = withDiagramSheet(referenceBuilding());
    b.ok({ type: "place_viewport", viewportId: "vp-1", sheetId: "s-e701", viewId: "v-one-line", center: { x: 381, y: 254 } });
    const vp = viewportOf(b, "vp-1");
    const view = b.head.elements["v-one-line"];
    if (view?.kind !== "view") throw new Error("missing view");
    const frame = frameForViewport(b.head, vp, view);
    expect(frame.center).toEqual(vp.center);
    expect(frame.size).toEqual(vp.size);
  });
});

describe("rendering a stored oversized viewport (E-701 as it sits in the model today)", () => {
  it("pulls a 120\" x 96\" frame whose anchor drifted off the paper back onto the paper instead of exporting a blank sheet", () => {
    // The stored state from the finding: centre (381, 254) mm, size 3048 x 2438.4 mm on a
    // 36" x 24" sheet, with real diagram content much smaller than the stored frame.
    const b = withDiagramSheet(referenceBuilding());
    b.ok({ type: "place_viewport", viewportId: "vp-1", sheetId: "s-e701", viewId: "v-one-line", center: { x: 381, y: 254 } });
    restored(b, "vp-1", { center: { x: 381, y: 254 }, size: { x: 3048, y: 2438.4 } });
    expect(viewportOf(b, "vp-1").size).toEqual({ x: 3048, y: 2438.4 });

    const vp = viewportOf(b, "vp-1");
    const view = b.head.elements["v-one-line"];
    if (view?.kind !== "view") throw new Error("missing view");
    const frame = frameForViewport(b.head, vp, view);

    // As placed, the frame's centre sat far off the paper — the blank-sheet geometry.
    const staleCenter = { x: 381 - 3048 / 2 + frame.size.x / 2, y: 254 - 2438.4 / 2 + frame.size.y / 2 };
    expect(staleCenter.x).toBeLessThan(0);
    expect(staleCenter.y).toBeLessThan(0);
    // The rendered frame overlaps the paper on both axes, so the drawing shows.
    expect(frame.center.x + frame.size.x / 2).toBeGreaterThan(0);
    expect(frame.center.x - frame.size.x / 2).toBeLessThan(ARCH_D.x);
    expect(frame.center.y + frame.size.y / 2).toBeGreaterThan(0);
    expect(frame.center.y - frame.size.y / 2).toBeLessThan(ARCH_D.y);

    const scene = buildSheetSceneFor(b.head, "s-e701", { projectName: "Test" });
    const texts = scene.primitives.flatMap((p) => (p.kind === "text" ? [p.text] : []));
    expect(texts.some((t) => t.startsWith("1  "))).toBe(true);
    expect(texts.some((t) => /[A-Z]/.test(t) && !t.startsWith("1  ") && t !== "MUTINYBIM")).toBe(true);
    expect(visibleInk(scene)).toBeGreaterThan(4);
  });
});
