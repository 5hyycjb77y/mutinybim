/**
 * @jest-environment node
 *
 * Regression coverage for the architectural overhaul:
 * - `kernel.material` (`MATERIAL_POINT`) registry & element material resolution
 * - Mitered L-corners, T-join face breaks, and wall cut poché split around openings
 * - Revit-grade door (jambs, 45 mm leaf, smooth 7.5° arc) & window (sills, jambs, double glazing, mullions) plan graphics
 * - Room/space point-in-polygon `isPointInsideHostArea` & room centroid label deduplication
 * - `planAutoTags` for rooms/spaces
 */
import {
  DEFAULT_SETTINGS,
  allMaterials,
  anchorInView,
  assemblyThermalSummary,
  buildViewPickIndex,
  buildViewScene,
  executeCommand,
  gridBubbleEndpoints,
  hostAreaOutlinesInView,
  isPointInsideHostArea,
  lineJoinPlanGraphics,
  materialOf,
  pickAt,
  planAutoTags,
  planGraphicsContext,
  planGraphicsOf,
  referencingSheet,
  resolveElementMaterial,
  sceneToSvg,
  viewportTitleLayout,
  viewTitleBubbleCenter,
  withUpgradePolicy,
  type Command,
  type ModelState,
  type PlanGraphic,
  type Revision,
  type ViewElement,
} from "../src";
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import { asStair, STAIR_KIND_ROW, stairGeometry, stairLayout } from "@permitzip/bim-pack-architecture";

installFirstPartyAddOns();

function runAll(cmds: readonly Command[]): ModelState {
  return withUpgradePolicy(
    () => true,
    () => {
      let m: ModelState = { modelId: "arch-overhaul-test", revision: 0 as Revision, elements: {}, connections: [], settings: DEFAULT_SETTINGS };
      for (const cmd of cmds) {
        const r = executeCommand(m, cmd);
        if (!r.ok) throw new Error(`${cmd.type} failed: ${r.error.message}`);
        m = { ...r.model, revision: (m.revision + 1) as Revision };
      }
      return m;
    },
  );
}

describe("architectural overhaul", () => {
  it("registers architectural materials on MATERIAL_POINT and resolves element materials", () => {
    const mats = allMaterials();
    expect(mats.length).toBeGreaterThanOrEqual(10);
    expect(materialOf("architecture.brick_red")?.pattern).toBe("brick");
    expect(materialOf("Red Brick")?.id).toBe("architecture.brick_red");

    const m = runAll([
      { type: "create_level", levelId: "L1", name: "Level 1", elevationMm: 0 },
      {
        type: "create_element",
        elementId: "w1",
        levelId: "L1",
        kind: "wall",
        placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 4000, y: 0 } },
        size: { thicknessMm: 200 },
        values: { "material.id": "architecture.brick_red" },
      },
    ]);
    const w1 = m.elements["w1"]!;
    expect(resolveElementMaterial(m, w1)?.id).toBe("architecture.brick_red");
  });

  it("draws wall poché split around openings and breaks through-wall face lines at T-joins", () => {
    const m = runAll([
      { type: "create_level", levelId: "L1", name: "Level 1", elevationMm: 0 },
      {
        type: "create_elements",
        idPrefix: "w",
        levelId: "L1",
        kind: "wall",
        points: [{ x: 0, y: 0 }, { x: 6000, y: 0 }, { x: 6000, y: 4000 }, { x: 0, y: 4000 }],
        closed: true,
        size: { thicknessMm: 200 },
        values: { "material.id": "architecture.cmu_concrete" },
      },
      {
        type: "create_element",
        elementId: "t1",
        levelId: "L1",
        kind: "wall",
        placement: { kind: "line", start: { x: 3000, y: 0 }, end: { x: 3000, y: 4000 } },
        size: { thicknessMm: 120 },
      },
      {
        type: "create_hosted",
        elementId: "d1",
        kind: "opening",
        openingType: "door",
        hostId: "w-1",
        s: 1500,
        side: 1,
        mark: "D1",
        size: { widthMm: 900, heightMm: 2100 },
      },
      {
        type: "create_hosted",
        elementId: "win1",
        kind: "opening",
        openingType: "window",
        hostId: "w-3",
        s: 3000,
        side: 1,
        mark: "W1",
        size: { widthMm: 1800, heightMm: 1200 },
        values: { "architecture.window_partitioning": "TRIPLE_PANEL_VERTICAL" },
      },
    ]);

    const ctx = planGraphicsContext(m, { scale: 48, levelId: "L1", detail: "fine", drawing: "view" });
    const w1G = lineJoinPlanGraphics(m.elements["w-1"]!, ctx) as readonly PlanGraphic[];
    // Poché splits into 2 polygons around door d1
    const fills = w1G.filter((g) => g.form === "polyline" && g.fill);
    expect(fills).toHaveLength(2);
    // Inner face of w-1 breaks for BOTH door d1 AND tee wall t1 (3 inner segments + 2 outer segments + 2 jamb caps = 7 lines)
    expect(w1G.filter((g) => g.form === "line")).toHaveLength(7);

    // Door graphics: white mask + 2 jambs + 1 thick leaf polygon + 1 swing arc + 1 mark
    const d1G = planGraphicsOf(m.elements["d1"]!, ctx)!;
    expect(d1G.filter((g) => g.form === "polyline" && g.closed)).toHaveLength(4);
    expect(d1G.filter((g) => g.form === "arc")).toHaveLength(1);

    // Triple-panel window graphics: mask + 2 jambs + 2 intermediate mullions = 5 closed polylines, plus 2 sill lines + 2 glazing lines = 4 lines
    const win1G = planGraphicsOf(m.elements["win1"]!, ctx)!;
    expect(win1G.filter((g) => g.form === "polyline" && g.closed)).toHaveLength(5);
    expect(win1G.filter((g) => g.form === "line")).toHaveLength(4);
  });

  it("evaluates point-in-polygon for rooms/spaces, deduplicates tagged room labels, and supports planAutoTags for spaces", () => {
    const m = runAll([
      { type: "create_level", levelId: "L1", name: "Level 1", elevationMm: 0 },
      {
        type: "create_elements",
        idPrefix: "w",
        levelId: "L1",
        kind: "wall",
        points: [{ x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 3000 }, { x: 0, y: 3000 }],
        closed: true,
        size: { thicknessMm: 150 },
      },
      { type: "place_space_in_walls", spaceId: "sp-1", levelId: "L1", seed: { x: 2000, y: 1500 }, number: "101", name: "Office" },
      { type: "create_view", viewId: "v-plan", viewType: "floor_plan", name: "Plan", props: { level: "Level 1", discipline: "architecture", scale: 48 } },
    ]);

    expect(isPointInsideHostArea(m, "sp-1", { x: 2000, y: 1500 })).toBe(true);
    expect(isPointInsideHostArea(m, "sp-1", { x: 5500, y: 1500 })).toBe(false);
    expect(isPointInsideHostArea(m, "w-1", { x: 2000, y: 0 })).toBeNull();

    const plan = planAutoTags(m, "v-plan", { categories: ["space"], idPrefix: "at" });
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]?.elementId).toBe("sp-1");

    const { scene } = buildViewScene(m, "v-plan");
    // Plan includes filled wall poché polygons
    expect(scene.primitives.some((pr) => pr.kind === "fill")).toBe(true);
  });

  it("stretches corner-joined walls cleanly when dragging a wall endpoint with move_line_end", () => {
    const m = runAll([
      { type: "create_level", levelId: "L1", name: "Level 1", elevationMm: 0 },
      {
        type: "create_elements",
        idPrefix: "w",
        levelId: "L1",
        kind: "wall",
        points: [{ x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 3000 }, { x: 0, y: 3000 }],
        closed: true,
        size: { thicknessMm: 200 },
      },
      // Pull the SE corner (end of w-1 / start of w-2) outward by +500 mm in X and -500 mm in Y
      { type: "move_line_end", elementId: "w-1", end: "end", to: { x: 4500, y: -500 } },
    ]);
    const w1 = m.elements["w-1"]!;
    const w2 = m.elements["w-2"]!;
    const p1 = "placement" in w1 ? w1.placement : undefined;
    const p2 = "placement" in w2 ? w2.placement : undefined;
    if (p1?.kind !== "line" || p2?.kind !== "line") {
      throw new Error("expected line walls");
    }
    expect(p1.end.x).toBeCloseTo(4500, 3);
    expect(p1.end.y).toBeCloseTo(-500, 3);
    expect(p2.start.x).toBeCloseTo(4500, 3);
    expect(p2.start.y).toBeCloseTo(-500, 3);
  });

  it("slides doors and windows along their host wall on move_elements without moving the wall", () => {
    const m = runAll([
      { type: "create_level", levelId: "L1", name: "Level 1", elevationMm: 0 },
      {
        type: "create_element",
        elementId: "w1",
        levelId: "L1",
        kind: "wall",
        placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 6000, y: 0 } },
        size: { thicknessMm: 200 },
      },
      {
        type: "create_hosted",
        elementId: "d1",
        kind: "opening",
        openingType: "door",
        hostId: "w1",
        s: 2000,
        side: 1,
        size: { widthMm: 900, heightMm: 2100 },
      },
      // Drag the door +800 mm east and +50 mm north (slight off-axis noise)
      { type: "move_elements", ids: ["d1"], delta: { x: 800, y: 50 } },
    ]);
    const w1 = m.elements["w1"]!;
    const d1 = m.elements["d1"]!;
    if (w1.kind !== "wall" || d1.kind !== "opening") throw new Error("expected wall + opening");
    // Wall did not move
    expect(w1.start).toEqual({ x: 0, y: 0 });
    expect(w1.end).toEqual({ x: 6000, y: 0 });
    // Door slid cleanly along wall to s = 2800
    expect(d1.offset).toBeCloseTo(2800, 2);
    expect(d1.position.x).toBeCloseTo(2800, 2);
    expect(d1.position.y).toBeCloseTo(0, 2);
  });

  it("stretches floor slabs, ceilings, and roofs whose boundary edges lie along a moved exterior wall", () => {
    const m = runAll([
      { type: "create_level", levelId: "L1", name: "Level 1", elevationMm: 0 },
      {
        type: "create_elements",
        idPrefix: "w",
        levelId: "L1",
        kind: "wall",
        points: [{ x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 3000 }, { x: 0, y: 3000 }],
        closed: true,
        size: { thicknessMm: 200 },
      },
      {
        type: "create_element",
        elementId: "slab-1",
        levelId: "L1",
        kind: "slab",
        placement: { kind: "area", outline: [{ x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 3000 }, { x: 0, y: 3000 }] },
        size: { thicknessMm: 150 },
      },
      {
        type: "create_ceiling",
        ceilings: [{ ceilingId: "clg-1", levelId: "L1", outline: [{ x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 3000 }, { x: 0, y: 3000 }], heightMm: 2700 }],
      },
      // Move east exterior wall w-2 outward by +1000 mm in X
      { type: "move_elements", ids: ["w-2"], delta: { x: 1000, y: 0 } },
    ]);
    const slab = m.elements["slab-1"] as unknown as { outline: { x: number; y: number }[] };
    const clg = m.elements["clg-1"] as unknown as { outline: { x: number; y: number }[] };
    expect(Math.max(...slab.outline.map((p) => p.x))).toBeCloseTo(5000, 2);
    expect(Math.max(...clg.outline.map((p) => p.x))).toBeCloseTo(5000, 2);
  });

  it("computes ISO 6946 / ASHRAE building-envelope R-value and U-value from registered material conductivities", () => {
    const summary = assemblyThermalSummary({
      id: "ext-brick-wall",
      layers: [
        { materialId: "architecture.brick_red", thicknessMm: 100 },
        { materialId: "architecture.batt_insulation", thicknessMm: 140 },
        { materialId: "architecture.gypsum_partition", thicknessMm: 16 },
      ],
    });
    expect(summary.totalThicknessMm).toBe(256);
    expect(summary.missingThermalMaterials).toEqual([]);
    // R_si (0.13) + R_se (0.04) + 0.1/0.72 + 0.14/0.038 + 0.016/0.16 ≈ 4.093 m²·K/W ≈ R-23.2
    expect(summary.rSiM2KPerW).toBeGreaterThan(3.9);
    expect(summary.rImperial).toBeGreaterThan(22);
    expect(summary.uValueWPerM2K).toBeLessThan(0.26);
  });

  it("supports L-shape (90°) and U-shape (180° high-rise switchback) stairs with landings and UP/DN plan graphics", () => {
    const m = runAll([
      { type: "create_level", levelId: "L1", name: "Level 1", elevationMm: 0 },
      { type: "create_level", levelId: "L2", name: "Level 2", elevationMm: 3600 },
      { type: "create_level", levelId: "L3", name: "Level 3", elevationMm: 7200 },
      {
        type: "create_element",
        elementId: "stair-u-1",
        levelId: "L1",
        kind: "architecture.stair",
        placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 3000, y: 0 } },
        size: { widthMm: 1100 },
        values: { "architecture.stair_form": "u_shape", "architecture.stair_turn": "right", "architecture.landing_depth_mm": 1200, "architecture.well_gap_mm": 150 },
      },
      {
        type: "create_element",
        elementId: "stair-u-2",
        levelId: "L2",
        kind: "architecture.stair",
        placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 3000, y: 0 } },
        size: { widthMm: 1100 },
        values: { "architecture.stair_form": "u_shape", "architecture.stair_turn": "right", "architecture.landing_depth_mm": 1200, "architecture.well_gap_mm": 150 },
      },
      {
        type: "create_element",
        elementId: "stair-l-1",
        levelId: "L1",
        kind: "architecture.stair",
        placement: { kind: "line", start: { x: 8000, y: 0 }, end: { x: 11000, y: 0 } },
        size: { widthMm: 1100 },
        values: { "architecture.stair_form": "l_shape", "architecture.stair_turn": "left" },
      },
      { type: "create_view", viewId: "v-l1", name: "L1", viewType: "floor_plan", props: { level: "L1", discipline: "architecture", scale: 96 } },
      { type: "create_view", viewId: "v-l2", name: "L2", viewType: "floor_plan", props: { level: "L2", discipline: "architecture", scale: 96 } },
    ]);
    const u1 = asStair(m.elements["stair-u-1"]!)!;
    const u2 = asStair(m.elements["stair-u-2"]!)!;
    const l1 = asStair(m.elements["stair-l-1"]!)!;
    const layoutU1 = stairLayout(u1, stairGeometry(u1, m.elements)!, 0);
    const layoutU2 = stairLayout(u2, stairGeometry(u2, m.elements)!, 3600);
    const layoutL1 = stairLayout(l1, stairGeometry(l1, m.elements)!, 0);

    // U-shape has 2 opposite flights + 1 mid-landing slab at half height; stacks cleanly L1->L2->L3
    expect(layoutU1.flights).toHaveLength(2);
    expect(layoutU1.landings).toHaveLength(1);
    expect(layoutU1.flights[1]!.u.x).toBeCloseTo(-layoutU1.flights[0]!.u.x, 4);
    expect(layoutU1.landings[0]!.zTop).toBeGreaterThan(1700);
    expect(layoutU1.landings[0]!.zTop).toBeLessThan(2000);
    expect(layoutU2.landings[0]!.zTop).toBeCloseTo(layoutU1.landings[0]!.zTop + 3600, 1);

    // L-shape turns 90° orthogonally onto Flight 2 across a square corner landing
    expect(layoutL1.flights).toHaveLength(2);
    expect(layoutL1.landings).toHaveLength(1);
    expect(layoutL1.flights[0]!.u.x * layoutL1.flights[1]!.u.x + layoutL1.flights[0]!.u.y * layoutL1.flights[1]!.u.y).toBeCloseTo(0, 4);

    // Plan views render UP on bottom floor and DN on upper floor
    const svg1 = sceneToSvg(buildViewScene(m, "v-l1").scene);
    const svg2 = sceneToSvg(buildViewScene(m, "v-l2").scene);
    expect(svg1).toContain(">UP<");
    expect(svg2).toContain(">DN<");
  });

  it("exposes pack-extensible KindRow.sectionGraphics + spansLevels, structural grids on all levels/sections, annotative section/level extents, and movable opening auto-tags", () => {
    expect(STAIR_KIND_ROW.spansLevels).toBe(true);
    expect(typeof STAIR_KIND_ROW.sectionGraphics).toBe("function");

    const m = runAll([
      { type: "create_level", levelId: "L1", name: "Level 1", elevationMm: 0 },
      { type: "create_level", levelId: "L2", name: "Level 2", elevationMm: 3200 },
      {
        type: "create_element",
        elementId: "w-solid",
        levelId: "L1",
        kind: "wall",
        placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 8000, y: 0 } },
        size: { thicknessMm: 200, heightMm: 3200 },
      },
      {
        type: "create_hosted",
        elementId: "door-1",
        kind: "opening",
        openingType: "door",
        hostId: "w-solid",
        s: 2500,
        side: 1,
        mark: "D-101",
        size: { widthMm: 915, heightMm: 2134 },
      },
      {
        type: "create_element",
        elementId: "grid-1",
        levelId: "L1",
        kind: "grid",
        placement: { kind: "line", start: { x: 0, y: -1500 }, end: { x: 0, y: 6000 } },
        label: "1",
      },
      {
        type: "create_element",
        elementId: "stair-sec",
        levelId: "L1",
        kind: "architecture.stair",
        placement: { kind: "line", start: { x: 1500, y: 1800 }, end: { x: 4500, y: 1800 } },
        size: { widthMm: 1100 },
        values: { "architecture.stair_form": "u_shape", "architecture.stair_turn": "right" },
      },
      { type: "create_view", viewId: "v-p1", name: "L1 Plan", viewType: "floor_plan", props: { level: "L1", discipline: "architecture", scale: 48 } },
      { type: "create_view", viewId: "v-p2", name: "L2 Plan", viewType: "floor_plan", props: { level: "L2", discipline: "architecture", scale: 48 } },
      {
        type: "create_view",
        viewId: "v-sec",
        name: "Section A-A",
        viewType: "section",
        props: {
          scale: 48,
          levelLeftExtMm: 6,
          levelRightExtMm: 12,
          section: { start: { x: -1000, y: 500 }, end: { x: 9000, y: 500 }, direction: 1, depthMm: 6000, headExtMm: 600, tailExtMm: 600, splitGap: true },
        },
      },
      {
        type: "set_view_crop",
        viewId: "v-sec",
        levelLeftExtMm: 10,
        levelRightExtMm: 14,
        annotationCropOffsetMm: 28,
      },
    ]);

    const secView = m.elements["v-sec"] as unknown as { props?: { levelLeftExtMm?: number; levelRightExtMm?: number; annotationCropOffsetMm?: number; section?: { splitGap?: boolean } } };
    expect(secView.props?.levelLeftExtMm).toBe(10);
    expect(secView.props?.levelRightExtMm).toBe(14);
    expect(secView.props?.annotationCropOffsetMm).toBe(28);
    expect(secView.props?.section?.splitGap).toBe(true);

    // Structural grid "1" renders on BOTH L1 and L2 floor plans AND in the building section
    const svgP1 = sceneToSvg(buildViewScene(m, "v-p1").scene);
    const svgP2 = sceneToSvg(buildViewScene(m, "v-p2").scene);
    const svgSec = sceneToSvg(buildViewScene(m, "v-sec").scene);
    expect(svgP1).toContain(">1<");
    expect(svgP2).toContain(">1<");
    expect(svgSec).toContain(">1<");
    expect(svgSec).toContain("LEVEL 1");
    expect(svgSec).toContain("LEVEL 2");

    // Movable door/window auto-tags work via `planAutoTags(..., { categories: ["opening"] })`
    const plan = planAutoTags(m, "v-p1", { categories: ["opening"], idPrefix: "at" });
    expect(plan.items.some((p) => p.elementId === "door-1")).toBe(true);
  });

  it("supports tagging and moving rooms/spaces inside section views and resolves bidirectional sheet back-references", () => {
    const m = runAll([
      { type: "create_level", levelId: "L1", name: "Level 1", elevationMm: 0 },
      { type: "create_level", levelId: "L2", name: "Level 2", elevationMm: 3200 },
      { type: "create_level", levelId: "ROOF", name: "Roof", elevationMm: 6400 },
      {
        type: "create_space",
        spaces: [
          { spaceId: "sp-l1-cut", levelId: "L1", number: "101", name: "GREAT ROOM", outline: [{ x: 0, y: 0 }, { x: 6000, y: 0 }, { x: 6000, y: 4000 }, { x: 0, y: 4000 }] },
          { spaceId: "sp-l2-cut", levelId: "L2", number: "201", name: "PRIMARY SUITE", outline: [{ x: 0, y: 0 }, { x: 6000, y: 0 }, { x: 6000, y: 4000 }, { x: 0, y: 4000 }] },
          { spaceId: "sp-uncut", levelId: "L1", number: "102", name: "BACK CLOSET", outline: [{ x: 0, y: 5000 }, { x: 4000, y: 5000 }, { x: 4000, y: 8000 }, { x: 0, y: 8000 }] },
        ],
      },
      { type: "create_view", viewId: "v-l1", name: "L1 Plan", viewType: "floor_plan", props: { level: "Level 1", scale: 96 } },
      {
        type: "create_view",
        viewId: "v-sec",
        name: "Section A-A",
        viewType: "section",
        crop: { min: { x: -500, y: -500 }, max: { x: 6500, y: 7000 } },
        props: { scale: 96, section: { start: { x: 0, y: 2000 }, end: { x: 6000, y: 2000 }, direction: 1, depthMm: 6000 } },
      },
      { type: "create_sheet", sheetId: "sh-101", number: "A-101", name: "Floor Plan" },
      { type: "place_viewport", viewportId: "vp-101", sheetId: "sh-101", viewId: "v-l1", center: { x: 300, y: 250 } },
      { type: "create_sheet", sheetId: "sh-201", number: "A-201", name: "Sections" },
      { type: "place_viewport", viewportId: "vp-201", sheetId: "sh-201", viewId: "v-sec", center: { x: 300, y: 250 } },
    ]);

    const secView = m.elements["v-sec"]!;
    if (secView.kind !== "view") throw new Error("expected view");

    // Section slices both cut spaces at their true level heights (L1: 0..3200, L2: 3200..6400) and ignores uncut rooms
    const l1Slices = hostAreaOutlinesInView(m, secView, m.elements["sp-l1-cut"]!);
    const l2Slices = hostAreaOutlinesInView(m, secView, m.elements["sp-l2-cut"]!);
    const uncutSlices = hostAreaOutlinesInView(m, secView, m.elements["sp-uncut"]!);
    expect(l1Slices).toHaveLength(1);
    expect(l2Slices).toHaveLength(1);
    expect(uncutSlices).toHaveLength(0);

    // Anchor sits at each room's vertical mid-height in section space
    const a1 = anchorInView(m, secView, { elementId: "sp-l1-cut", anchor: "mid" })!;
    const a2 = anchorInView(m, secView, { elementId: "sp-l2-cut", anchor: "mid" })!;
    expect(a1.y).toBeCloseTo(1600, 1);
    expect(a2.y).toBeCloseTo(4800, 1);
    expect(anchorInView(m, secView, { elementId: "sp-uncut", anchor: "mid" })).toBeNull();

    // Dragging a space tag inside vs outside the room in section triggers inside/outside leader check cleanly
    expect(isPointInsideHostArea(m, "sp-l1-cut", { x: 3000, y: 1600 }, secView)).toBe(true);
    expect(isPointInsideHostArea(m, "sp-l1-cut", { x: 3000, y: 4800 }, secView)).toBe(false);
    expect(isPointInsideHostArea(m, "sp-l2-cut", { x: 3000, y: 4800 }, secView)).toBe(true);

    // Auto-tagging spaces in section tags both cut spaces (inside without unwanted leader) and skips uncut rooms
    const secTags = planAutoTags(m, "v-sec", { categories: ["space"], idPrefix: "st" });
    expect(secTags.items.map((i) => i.elementId).sort()).toEqual(["sp-l1-cut", "sp-l2-cut"]);
    expect(secTags.items.every((i) => i.tag.leader === false)).toBe(true);

    // Bidirectional sheet back-reference resolves A-101 and viewport title bubble geometry cleanly
    const back = referencingSheet(m, secView);
    expect(back).toEqual({ sheetNumber: "A-101", sheetId: "sh-101", sourceViewId: "v-l1" });
    const bubble = viewTitleBubbleCenter({ center: { x: 300, y: 250 }, size: { x: 200, y: 120 } });
    expect(bubble.x).toBeCloseTo(206.35, 2);
    expect(bubble.y).toBeCloseTo(319.5, 2);

    // Movable viewport title offset & resizable title rule (`set_viewport_title`) update layout & back-ref bubble coordinates
    const moved = runAll([
      { type: "create_level", levelId: "L1", name: "Level 1", elevationMm: 0 },
      { type: "create_view", viewId: "v-1", name: "Level 1 Plan", viewType: "floor_plan", props: { level: "Level 1", scale: 96 } },
      { type: "create_sheet", sheetId: "sh-1", number: "A-101", name: "Floor Plan" },
      { type: "place_viewport", viewportId: "vp-1", sheetId: "sh-1", viewId: "v-1", center: { x: 300, y: 250 } },
      { type: "set_viewport_title", viewportId: "vp-1", titleOffsetMm: { x: 15, y: 14 }, titleRuleMm: 85 },
    ]);
    const vpMoved = moved.elements["vp-1"]!;
    if (vpMoved.kind !== "viewport") throw new Error("expected viewport");
    expect(vpMoved.titleOffsetMm).toEqual({ x: 15, y: 14 });
    expect(vpMoved.titleRuleMm).toBe(85);
    const tl = viewportTitleLayout({ center: { x: 300, y: 250 }, size: { x: 200, y: 120 } }, vpMoved, "Level 1 Plan", false);
    expect(tl.left).toBeCloseTo(215, 2);
    expect(tl.titleY).toBeCloseTo(332, 2);
    expect(tl.ruleEndX - tl.ruleStartX).toBeCloseTo(85, 2);

    // Grid bubble geometry helper returns exact circular bubble centers outside the clipped line tips
    const gb = gridBubbleEndpoints({ x: 0, y: 0 }, { x: 0, y: 10000 }, 96, { x: -2000, y: -2000 }, { x: 12000, y: 12000 }, (p) => ({ x: p.x / 96, y: -p.y / 96 }));
    expect(gb).not.toBeNull();
    expect(gb!.hasBubbleB).toBe(true);
    expect(Math.hypot(gb!.bubbleA.x - gb!.pA.x, gb!.bubbleA.y - gb!.pA.y)).toBeCloseTo(4.2, 2);
  });

  it("scopes boundary carry to the wall's level, flips opening host.side on perpendicular drag, updates room-backed space pick footprints, and scopes opening mark suppression per view", () => {
    // 1. Level-scoped boundary carry: moving L1 wall reshapes L1 slab only, leaving coincident L2 slab intact
    const m1 = runAll([
      { type: "create_level", levelId: "L1", name: "Level 1", elevationMm: 0 },
      { type: "create_level", levelId: "L2", name: "Level 2", elevationMm: 3000 },
      { type: "create_element", elementId: "w-l1", kind: "wall", levelId: "L1", topLevelId: "L2", size: { thicknessMm: 200 }, placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 4000, y: 0 } } },
      { type: "create_element", elementId: "slab-l1", kind: "slab", levelId: "L1", size: { thicknessMm: 200 }, placement: { kind: "area", outline: [{ x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 4000 }, { x: 0, y: 4000 }] } },
      { type: "create_element", elementId: "slab-l2", kind: "slab", levelId: "L2", size: { thicknessMm: 200 }, placement: { kind: "area", outline: [{ x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 4000 }, { x: 0, y: 4000 }] } },
      { type: "move_elements", ids: ["w-l1"], delta: { x: 0, y: -500 } },
    ]);
    const s1 = m1.elements["slab-l1"];
    const s2 = m1.elements["slab-l2"];
    if (s1?.kind !== "slab" || s2?.kind !== "slab") throw new Error("expected slabs");
    expect(Math.min(...s1.outline.map((p) => p.y))).toBe(-500);
    expect(Math.min(...s2.outline.map((p) => p.y))).toBe(0);

    // 2. Perpendicular drag on a hosted door flips values["host.side"]
    const m2 = runAll([
      { type: "create_level", levelId: "L1", name: "Level 1", elevationMm: 0 },
      { type: "create_element", elementId: "w1", kind: "wall", levelId: "L1", size: { thicknessMm: 200 }, placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 4000, y: 0 } } },
      { type: "create_hosted", elementId: "d1", kind: "opening", openingType: "door", mark: "101", hostId: "w1", s: 2000, side: 1, size: { widthMm: 900, heightMm: 2100 } },
      { type: "move_elements", ids: ["d1"], delta: { x: 0, y: -400 } },
    ]);
    const door = m2.elements["d1"];
    if (door?.kind !== "opening") throw new Error("expected opening");
    expect(door.values?.["host.side"]).toBe(-1);

    // 3. Per-view opening mark suppression: tagging on view-a suppresses fallback mark only on view-a, never on view-b, and deleting tag restores it
    const m3 = runAll([
      { type: "create_level", levelId: "L1", name: "Level 1", elevationMm: 0 },
      { type: "create_element", elementId: "w1", kind: "wall", levelId: "L1", size: { thicknessMm: 200 }, placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 4000, y: 0 } } },
      { type: "create_hosted", elementId: "d1", kind: "opening", openingType: "door", mark: "D-101", hostId: "w1", s: 2000, side: 1, size: { widthMm: 900, heightMm: 2100 } },
      { type: "create_view", viewId: "v-a", name: "Plan A", viewType: "floor_plan", props: { level: "Level 1", scale: 96 } },
      { type: "create_view", viewId: "v-b", name: "Plan B", viewType: "floor_plan", props: { level: "Level 1", scale: 96 } },
      { type: "add_drawing_item", itemId: "tag-a", ownerId: "v-a", shape: "tag", points: [{ x: 2000, y: 1200 }], tag: { elementId: "d1", template: "mark", leader: true } },
    ]);
    const textsIn = (m: ModelState, vid: string) =>
      buildViewScene(m, vid).scene.primitives.filter((p) => p.kind === "text").map((p) => p.text);
    // View A has 1 label (its movable tag), View B still has 1 label (its fallback mark)
    expect(textsIn(m3, "v-a").filter((t) => t === "D-101")).toHaveLength(1);
    expect(textsIn(m3, "v-b").filter((t) => t === "D-101")).toHaveLength(1);
    const rDel = executeCommand(m3, { type: "delete_drawing_item", itemId: "tag-a" });
    if (!rDel.ok) throw new Error(JSON.stringify(rDel));
    // Deleting the movable tag on View A restores the fallback mark
    expect(textsIn(rDel.model, "v-a").filter((t) => t === "D-101")).toHaveLength(1);

    // 4. Incremental pick index re-measures room-backed spaces when their referenced room is removed
    const m4 = runAll([
      { type: "create_level", levelId: "L1", name: "Level 1", elevationMm: 0 },
      { type: "add_architecture", levelId: "L1", walls: [], openings: [], casework: [], rooms: [{ roomId: "rm-1", number: "101", name: "Office", outline: [{ x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 4000 }, { x: 0, y: 4000 }] }] },
      { type: "make_spaces_from_rooms", roomIds: ["rm-1"] },
      { type: "create_view", viewId: "v-1", name: "Level 1", viewType: "floor_plan", crop: { min: { x: -1000, y: -1000 }, max: { x: 6000, y: 6000 } }, props: { level: "Level 1", scale: 96, cropView: true } },
    ]);
    const sp1 = Object.values(m4.elements).find((el) => el.kind === "space");
    if (!sp1) throw new Error("expected promoted space");
    const v1 = m4.elements["v-1"] as ViewElement;
    const idx1 = buildViewPickIndex(m4, v1);
    expect(pickAt(idx1, { x: 2000, y: 2000 }, 50)).toContain(sp1.id);
    const m4After: ModelState = { ...m4, elements: Object.fromEntries(Object.entries(m4.elements).filter(([id]) => id !== "rm-1")) };
    const idx2 = buildViewPickIndex(m4After, v1, idx1, ["rm-1"]);
    expect(pickAt(idx2, { x: 2000, y: 2000 }, 50)).not.toContain(sp1.id);

    // 5. Boundary carry requires positive longitudinal overlap: a neighboring slab/ceiling touching only at a wall corner vertex stays intact
    const m5 = runAll([
      { type: "create_level", levelId: "L1", name: "Level 1", elevationMm: 0 },
      { type: "create_element", elementId: "w-mid", kind: "wall", levelId: "L1", size: { thicknessMm: 150 }, placement: { kind: "line", start: { x: 4000, y: 4000 }, end: { x: 4000, y: 8000 } } },
      { type: "create_element", elementId: "slab-border", kind: "slab", levelId: "L1", size: { thicknessMm: 200 }, placement: { kind: "area", outline: [{ x: 4000, y: 4000 }, { x: 8000, y: 4000 }, { x: 8000, y: 8000 }, { x: 4000, y: 8000 }] } },
      { type: "create_element", elementId: "slab-corner-only", kind: "slab", levelId: "L1", size: { thicknessMm: 200 }, placement: { kind: "area", outline: [{ x: 4000, y: 0 }, { x: 8000, y: 0 }, { x: 8000, y: 4000 }, { x: 4000, y: 4000 }] } },
      { type: "move_elements", ids: ["w-mid"], delta: { x: 500, y: 0 } },
    ]);
    const borderSlab = m5.elements["slab-border"];
    const cornerSlab = m5.elements["slab-corner-only"];
    if (borderSlab?.kind !== "slab" || cornerSlab?.kind !== "slab") throw new Error("expected slabs");
    expect(Math.min(...borderSlab.outline.map((p) => p.x))).toBe(4500);
    expect(Math.min(...cornerSlab.outline.map((p) => p.x))).toBe(4000);
  });
});
