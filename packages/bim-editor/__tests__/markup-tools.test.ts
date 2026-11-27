/**
 * @jest-environment node
 */
import {
  DEFAULT_MARKUP_BRUSH,
  MARKUP_COLOR_SWATCHES,
  applyMarkupShortcut,
  hitTestMarkupStroke,
  recognizeSmartShape,
  simplifyMarkupStroke,
  switchMarkupTool,
} from "../src/editor/views-sheets/markup-tools";
import type { DrawingItem } from "@permitzip/bim-kernel";

describe("sheet markup editor helpers", () => {
  it("simplifies dense strokes while preserving shape", () => {
    const pts = Array.from({ length: 600 }, (_, i) => ({ x: i * 0.5, y: Math.sin(i * 0.1) * 4 }));
    const simplified = simplifyMarkupStroke(pts, 0.5, 400);
    expect(simplified.length).toBeLessThanOrEqual(400);
    expect(simplified.length).toBeGreaterThan(10);
    expect(simplified[0]).toEqual({ x: 0, y: 0 });
  });

  it("snaps near-horizontal freehand lines to exact orthogonal lines when smart shapes are enabled", () => {
    const pts = [
      { x: 100, y: 200 },
      { x: 130, y: 201 },
      { x: 160, y: 202 },
      { x: 200, y: 204 },
    ];
    const snapped = recognizeSmartShape(pts);
    expect(snapped.smartShape).toBe("line");
    expect(snapped.points).toHaveLength(2);
    expect(snapped.points[0]!.y).toBe(snapped.points[1]!.y);
  });

  it("snaps rough hand-drawn circles to clean 36-segment circles", () => {
    const pts = Array.from({ length: 30 }, (_, i) => {
      const t = (i / 29) * Math.PI * 2;
      const wobble = (i % 3 - 1) * 1.2;
      return { x: 200 + Math.cos(t) * (25 + wobble), y: 150 + Math.sin(t) * (25 - wobble) };
    });
    const snapped = recognizeSmartShape(pts);
    expect(snapped.smartShape).toBe("circle");
    expect(snapped.points.length).toBe(37);
  });

  it("snaps rough closed boxes to crisp 5-point rectangles", () => {
    const pts = [
      { x: 100, y: 100 }, { x: 130, y: 101 }, { x: 160, y: 99 }, { x: 180, y: 100 },
      { x: 181, y: 120 }, { x: 179, y: 140 }, { x: 180, y: 160 },
      { x: 150, y: 161 }, { x: 120, y: 159 }, { x: 100, y: 160 },
      { x: 99, y: 135 }, { x: 101, y: 115 }, { x: 100, y: 101 },
    ];
    const snapped = recognizeSmartShape(pts);
    expect(snapped.smartShape).toBe("rect");
    expect(snapped.points).toHaveLength(5);
  });

  it("leaves freehand handwriting/squiggles untouched even with smart shapes on", () => {
    const squiggle = [
      { x: 10, y: 20 }, { x: 14, y: 10 }, { x: 18, y: 22 }, { x: 23, y: 11 },
      { x: 28, y: 21 }, { x: 34, y: 15 }, { x: 40, y: 22 },
    ];
    const out = recognizeSmartShape(squiggle);
    expect(out.smartShape).toBeUndefined();
    expect(out.points).toEqual(squiggle);
  });

  it("hit-tests strokes accurately and switches marker <-> highlighter presets cleanly", () => {
    const item = {
      id: "mk-1",
      kind: "drawing_item",
      ownerId: "sheet-m101",
      shape: "markup",
      points: [{ x: 100, y: 100 }, { x: 200, y: 100 }],
      markup: { tool: "marker", color: "#dc2626", widthMm: 2.4, status: "open" },
    } as unknown as DrawingItem;
    expect(hitTestMarkupStroke(item, { x: 150, y: 102 }, 3)).toBe(true);
    expect(hitTestMarkupStroke(item, { x: 150, y: 130 }, 3)).toBe(false);

    const hi = switchMarkupTool(DEFAULT_MARKUP_BRUSH, "highlighter");
    expect(hi.tool).toBe("highlighter");
    expect(hi.color).toBe("#eab308");
    expect(hi.widthMm).toBe(9);
  });

  it("handles keyboard shortcuts for Marker (M), Highlighter (H), Erase (E), Smart snap (S), and colours (1-6)", () => {
    // From Select: M enters Marker, H enters Highlighter, E/S/1 are ignored outside markup mode
    const mOn = applyMarkupShortcut("m", false, DEFAULT_MARKUP_BRUSH);
    expect(mOn?.nextTool).toBe("markup");
    expect(mOn?.brush.tool).toBe("marker");
    expect(applyMarkupShortcut("e", false, DEFAULT_MARKUP_BRUSH)).toBeNull();
    expect(applyMarkupShortcut("s", false, DEFAULT_MARKUP_BRUSH)).toBeNull();
    expect(applyMarkupShortcut("2", false, DEFAULT_MARKUP_BRUSH)).toBeNull();

    // Pressing M again while in Marker toggles back to Select
    const mOff = applyMarkupShortcut("M", true, mOn!.brush);
    expect(mOff?.nextTool).toBe("select");

    // H switches straight into Highlighter; M switches back to Marker instead of exiting
    const hOn = applyMarkupShortcut("h", true, mOn!.brush);
    expect(hOn?.nextTool).toBe("markup");
    expect(hOn?.brush.tool).toBe("highlighter");
    const backToM = applyMarkupShortcut("m", true, hOn!.brush);
    expect(backToM?.nextTool).toBe("markup");
    expect(backToM?.brush.tool).toBe("marker");

    // In Marker mode: E toggles eraser, 2 picks Purple and clears eraser, S toggles smart snap
    const erased = applyMarkupShortcut("e", true, backToM!.brush);
    expect(erased?.brush.eraser).toBe(true);
    const purple = applyMarkupShortcut("2", true, erased!.brush);
    expect(purple?.brush.eraser).toBe(false);
    expect(purple?.brush.color).toBe(MARKUP_COLOR_SWATCHES[1]!.color);
    const snapped = applyMarkupShortcut("s", true, purple!.brush);
    expect(snapped?.brush.smartShapes).toBe(true);
  });
});
