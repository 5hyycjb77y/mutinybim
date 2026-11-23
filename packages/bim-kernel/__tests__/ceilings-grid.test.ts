/**
 * @jest-environment node
 *
 * Verifies the real-scale, configurable ceiling tile grid system:
 * - Exact imperial 2'×4' (1219.2 × 609.6 mm) and 2'×2' (609.6 × 609.6 mm) constants
 * - Custom spacing, origin alignment, and grid rotation persisted via create_ceiling / edit_ceiling
 * - Tile-cell snapping (`ceilingGridCellCenter`) for full-cell devices (2'×4' troffers) and
 *   sub-cell devices (2'×2' registers inside 2'×4' bays)
 * - Real-scale RCP tile line generation for flat ceilings (defaulting to exact 2'×4' imperial scale)
 *   and ACT clouds with an explicit grid
 */
import {
  buildViewScene,
  ceilingGrid,
  ceilingGridCellCenter,
  CEILINGS_FEATURE,
  TILE_2FT_MM,
  TILE_4FT_MM,
  withUpgradePolicy,
} from "../src";
import { Building } from "./fixtures/electrical-building";

describe("real-scale configurable ceiling tile grid", () => {
  it("exposes exact imperial 2'×4' and 2'×2' tile pitch constants", () => {
    expect(TILE_2FT_MM).toBeCloseTo(609.6, 5);
    expect(TILE_4FT_MM).toBeCloseTo(1219.2, 5);
  });

  it("snaps full-cell 2'×4' troffers and half-cell 2'×2' diffusers flush inside tile cells, including custom origin and rotation", () => {
    const grid = { spacingXMm: TILE_4FT_MM, spacingYMm: TILE_2FT_MM, origin: { x: 1000, y: 2000 } };

    // 2'×4' fixture snaps to exact center of the (col=1, row=2) tile
    const troffer = ceilingGridCellCenter(grid, { x: 1000 + TILE_4FT_MM * 1.4, y: 2000 + TILE_2FT_MM * 2.2 });
    expect(troffer.x).toBeCloseTo(1000 + TILE_4FT_MM * 1.5, 4);
    expect(troffer.y).toBeCloseTo(2000 + TILE_2FT_MM * 2.5, 4);

    // 2'×2' diffuser inside a 2'×4' bay snaps to the exact left or right 2'×2' half-cell center
    const leftHalf = ceilingGridCellCenter(
      grid,
      { x: 1000 + TILE_4FT_MM * 0.2, y: 2000 + TILE_2FT_MM * 0.4 },
      { deviceWidthMm: TILE_2FT_MM, deviceDepthMm: TILE_2FT_MM },
    );
    expect(leftHalf.x).toBeCloseTo(1000 + TILE_2FT_MM * 0.5, 4);
    expect(leftHalf.y).toBeCloseTo(2000 + TILE_2FT_MM * 0.5, 4);

    const rightHalf = ceilingGridCellCenter(
      grid,
      { x: 1000 + TILE_4FT_MM * 0.8, y: 2000 + TILE_2FT_MM * 0.4 },
      { deviceWidthMm: TILE_2FT_MM, deviceDepthMm: TILE_2FT_MM },
    );
    expect(rightHalf.x).toBeCloseTo(1000 + TILE_2FT_MM * 1.5, 4);
    expect(rightHalf.y).toBeCloseTo(2000 + TILE_2FT_MM * 0.5, 4);

    // 90° rotated 2'×4' grid swaps long/short axes cleanly
    const rotGrid = { spacingXMm: TILE_4FT_MM, spacingYMm: TILE_2FT_MM, origin: { x: 0, y: 0 }, rotationDeg: 90 };
    const rotPt = ceilingGridCellCenter(rotGrid, { x: -300, y: 700 });
    expect(rotPt.x).toBeCloseTo(-TILE_2FT_MM / 2, 3);
    expect(rotPt.y).toBeCloseTo(TILE_4FT_MM / 2, 3);
  });

  it("persists custom grid config via create_ceiling and edit_ceiling and renders real-scale RCP tile lines on flat and cloud ceilings", () => {
    const W = TILE_4FT_MM * 3; // exactly 3 tiles wide (12'-0")
    const D = TILE_2FT_MM * 4; // exactly 4 tiles deep (8'-0")
    const b = new Building();
    withUpgradePolicy(
      (f) => f === CEILINGS_FEATURE,
      () => {
        b.ok({
          type: "create_ceiling",
          ceilings: [
            {
              ceilingId: "clg-cloud",
              levelId: "lvl-1",
              outline: [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: D }, { x: 0, y: D }],
              heightMm: 2896,
              form: "cloud",
              grid: { spacingXMm: TILE_4FT_MM, spacingYMm: TILE_2FT_MM, origin: { x: 0, y: 0 } },
            },
          ],
        });
      },
    );
    b.ok({
      type: "create_view",
      viewId: "v-rcp",
      name: "L1 RCP",
      viewType: "ceiling_plan",
      crop: { min: { x: -500, y: -500 }, max: { x: W + 500, y: D + 500 } },
      props: { level: "Level 1", scale: 48 },
    });

    const el = b.head.elements["clg-cloud"];
    expect(el?.kind).toBe("ceiling");
    if (el?.kind === "ceiling") {
      expect(ceilingGrid(el)).toEqual({
        spacingXMm: TILE_4FT_MM,
        spacingYMm: TILE_2FT_MM,
        origin: { x: 0, y: 0 },
        rotationDeg: 0,
      });
    }

    const rcpScene = buildViewScene(b.head, "v-rcp").scene;
    // Scale 1:48 => 4 ft (1219.2 mm) = 25.4 mm on paper, 2 ft (609.6 mm) = 12.7 mm on paper
    const gridLines = rcpScene.primitives.filter((p): p is Extract<typeof p, { kind: "line" }> => p.kind === "line" && !p.dash);
    const vXs = [...new Set(gridLines.filter((l) => Math.abs(l.a.x - l.b.x) < 0.05).map((l) => Math.round(l.a.x * 100) / 100))].sort((a, b) => a - b);
    const hYs = [...new Set(gridLines.filter((l) => Math.abs(l.a.y - l.b.y) < 0.05).map((l) => Math.round(l.a.y * 100) / 100))].sort((a, b) => a - b);
    expect(vXs.length).toBe(3); // x = 0', 4', 8'
    expect(hYs.length).toBe(4); // y = 0', 2', 4', 6'
    expect(vXs[1]! - vXs[0]!).toBeCloseTo(TILE_4FT_MM / 48, 2);
    expect(hYs[1]! - hYs[0]!).toBeCloseTo(TILE_2FT_MM / 48, 2);

    // Edit to 2'×2' grid => vertical pitch halves from 25.4 mm to 12.7 mm on paper
    withUpgradePolicy(
      (f) => f === CEILINGS_FEATURE,
      () => {
        b.ok({
          type: "edit_ceiling",
          ceilingId: "clg-cloud",
          grid: { spacingXMm: TILE_2FT_MM, spacingYMm: TILE_2FT_MM, origin: { x: 0, y: 0 } },
        });
      },
    );
    const rcpScene2x2 = buildViewScene(b.head, "v-rcp").scene;
    const gridLines2x2 = rcpScene2x2.primitives.filter((p): p is Extract<typeof p, { kind: "line" }> => p.kind === "line" && !p.dash);
    const vXs2x2 = [...new Set(gridLines2x2.filter((l) => Math.abs(l.a.x - l.b.x) < 0.05).map((l) => Math.round(l.a.x * 100) / 100))].sort((a, b) => a - b);
    expect(vXs2x2.length).toBe(6); // x = 0', 2', 4', 6', 8', 10'
    expect(vXs2x2[1]! - vXs2x2[0]!).toBeCloseTo(TILE_2FT_MM / 48, 2);
  });
});
