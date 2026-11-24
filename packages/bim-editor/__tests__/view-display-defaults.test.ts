/**
 * @jest-environment node
 *
 * Verifies default paper-space (`drawing`) vs live-model (`model`) display
 * selection for every view type.
 */
import { defaultViewDisplay, newViewDisplay } from "../src/editor/views-sheets/use-view-display-prefs";

describe("view display defaults (paper space vs live model)", () => {
  it("defaults every 2D orthographic view to paper space ('drawing') and 3D/schedules to 'model'", () => {
    for (const vt of ["floor_plan", "ceiling_plan", "section", "elevation", "detail"] as const) {
      expect(defaultViewDisplay(vt)).toBe("drawing");
      expect(newViewDisplay(vt)).toBe("drawing");
    }
    expect(defaultViewDisplay("three_d")).toBe("model");
    expect(newViewDisplay("three_d")).toBe("model");
    expect(defaultViewDisplay("schedule")).toBe("model");
    expect(newViewDisplay("schedule")).toBe("model");
  });
});
