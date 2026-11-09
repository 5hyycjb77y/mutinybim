import { planFit } from "../src/plan-fit";

/**
 * A new plan's crop box opened under the properties panel, so its east grip
 * couldn't be reached (ergonomics pass, Oct 23 2026): the fit used the whole
 * canvas although the panel covers its right 320 px.
 */
describe("planFit", () => {
  const box = { minX: -20, maxX: 20, minZ: -5, maxZ: 5 }; // 40 m east-west, 10 m north-south
  const canvas = { width: 1000, height: 600 };

  /** Where a scene point lands on screen (px from the canvas's top-left) for north-up plans. */
  const onScreen = (fit: ReturnType<typeof planFit>, x: number, z: number) => {
    const perPixel = (2 * fit.half) / canvas.height;
    return { px: canvas.width / 2 + (x - fit.center.x) / perPixel, py: canvas.height / 2 + (z - fit.center.z) / perPixel };
  };

  it("without panels, centres the rectangle with room for the grips on every side", () => {
    const fit = planFit(box, 0, canvas);
    expect(fit.center).toEqual({ x: 0, z: 0 });
    expect(onScreen(fit, box.minX, 0).px).toBeGreaterThanOrEqual(16);
    expect(onScreen(fit, box.maxX, 0).px).toBeLessThanOrEqual(canvas.width - 16);
  });

  it("keeps both east and west sides clear of a 320 px panel on the right", () => {
    const fit = planFit(box, 0, canvas, { left: 0, right: 320, top: 0, bottom: 0 });
    const west = onScreen(fit, box.minX, 0);
    const east = onScreen(fit, box.maxX, 0);
    expect(west.px).toBeGreaterThan(0);
    expect(east.px).toBeLessThanOrEqual(canvas.width - 320 - 16);
    // Centred in what is still visible.
    expect((west.px + east.px) / 2).toBeCloseTo((canvas.width - 320) / 2, 6);
  });

  it("a fit that ignores the panel puts the east side under it (the old behaviour)", () => {
    const fit = planFit(box, 0, canvas);
    expect(onScreen(fit, box.maxX, 0).px).toBeGreaterThan(canvas.width - 320);
  });

  it("a plan turned 90° for true north fits its turned extents", () => {
    const turned = planFit(box, 90, canvas);
    // Screen-up is now east: the 40 m side runs up the screen.
    const perPixel = Math.max(10 / (1000 - 32), 40 / (600 - 32)) * 1.04;
    expect(turned.half).toBeCloseTo((perPixel * 600) / 2, 6);
  });
});
