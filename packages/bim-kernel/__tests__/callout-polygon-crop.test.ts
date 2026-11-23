import {
  DEFAULT_SETTINGS,
  buildViewScene,
  calloutBoundaryPolygon,
  calloutSyncCommands,
  clipPolygonToPieces,
  clipSegmentToPolygon,
  decomposePolygonConvex,
  enlargedPlanCommands,
  isAxisAlignedRectPolygon,
  planCommit,
  pointInPolygon,
  sceneToSvg,
  tagLines,
  tagShape,
  withUpgradePolicy,
  type Command,
  type DrawingItem,
  type ModelState,
  type Vec2,
  type ViewElement,
} from "../src";

let seq = 0;
function emptyModel(): ModelState {
  return { modelId: "m-callout-poly", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
}

function runAll(model: ModelState, cmds: readonly Command[]): ModelState {
  let cur = model;
  for (const cmd of cmds) {
    const res = planCommit(
      cur,
      [],
      { idempotencyKey: `cp-${++seq}`, baseRevision: cur.revision, actor: { id: "tester", name: "Tester", kind: "human" }, command: cmd },
      () => "2026-11-22T00:00:00.000Z",
    );
    if (!res.ok) throw new Error(`Command ${cmd.type} refused: ${res.error.code} — ${res.error.message}`);
    cur = res.model;
  }
  return cur;
}

const FT = 304.8;
const pt = (xFt: number, yFt: number): Vec2 => ({ x: Math.round(xFt * FT), y: Math.round(yFt * FT) });

// 6-corner L-shape wrapping SW(0..20', 0..10') + NW(0..10', 10..20'), notching out NE(10..20', 10..20')!
const L_POLY: Vec2[] = [pt(0, 0), pt(20, 0), pt(20, 10), pt(10, 10), pt(10, 20), pt(0, 20)];

describe("Non-convex polygonal crop clipping & Revit-style P-line callouts", () => {
  test("polygon-clip handles non-convex L-shapes accurately for points, segments, and fills", () => {
    expect(isAxisAlignedRectPolygon(L_POLY)).toBe(false);
    expect(isAxisAlignedRectPolygon([pt(0, 0), pt(10, 0), pt(10, 8), pt(0, 8)])).toBe(true);

    // Inside both L arms, outside the notched-out NE quadrant
    expect(pointInPolygon(pt(5, 5), L_POLY)).toBe(true);
    expect(pointInPolygon(pt(15, 5), L_POLY)).toBe(true);
    expect(pointInPolygon(pt(5, 15), L_POLY)).toBe(true);
    expect(pointInPolygon(pt(15, 15), L_POLY)).toBe(false);

    // A diagonal from NW(8,18) through the concave notch(13,13) to SE(18,8) splits into TWO clipped segments!
    const segs = clipSegmentToPolygon(pt(8, 18), pt(18, 8), L_POLY);
    expect(segs.length).toBe(2);
    for (const [a, b] of segs) {
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      expect(pointInPolygon(mid, L_POLY)).toBe(true);
    }

    // Fill clipping a big square [0..20', 0..20'] against L_POLY covers exact L area (300 sq ft, NOT 400 sq ft)
    const pieces = decomposePolygonConvex(L_POLY);
    const clippedFills = clipPolygonToPieces([pt(0, 0), pt(20, 0), pt(20, 20), pt(0, 20)], pieces, 0);
    expect(clippedFills.length).toBeGreaterThanOrEqual(2);
    let areaMm2 = 0;
    for (const poly of clippedFills) {
      let a = 0;
      for (let i = 0; i < poly.length; i++) {
        const p0 = poly[i]!;
        const p1 = poly[(i + 1) % poly.length]!;
        a += p0.x * p1.y - p1.x * p0.y;
      }
      areaMm2 += Math.abs(a) / 2;
    }
    const areaSqFt = areaMm2 / (FT * FT);
    expect(areaSqFt).toBeCloseTo(300, 1);
  });

  test("enlargedPlanCommands with custom L-shape polygon clips enlarged plan geometry and excludes notched-out corner", () => {
    let m = emptyModel();
    m = runAll(m, [
      { type: "create_level", levelId: "L1", name: "Level 1", elevationMm: 0 },
      {
        type: "add_architecture",
        levelId: "L1",
        walls: [
          // Wall completely inside the L-shape bottom arm
          { wallId: "w-in", start: pt(2, 5), end: pt(18, 5), heightMm: 3000, thicknessMm: 200 },
          // Wall completely inside the notched-out NE quadrant (12..18', y=15') — must be clipped OUT of the L-cropped enlarged plan!
          { wallId: "w-notch", start: pt(12, 15), end: pt(18, 15), heightMm: 3000, thicknessMm: 200 },
        ],
        openings: [],
        rooms: [],
        casework: [],
      },
      { type: "create_view", viewId: "v-plan", name: "Level 1 Plan", viewType: "floor_plan", crop: { min: pt(-2, -2), max: pt(24, 24) }, props: { level: "Level 1", scale: 96 } },
    ]);

    const cmds = enlargedPlanCommands(m, {
      parentViewId: "v-plan",
      viewId: "v-enlarged",
      calloutId: "co-lshape",
      name: "Enlarged L-Shape Core",
      polygon: L_POLY,
      scale: 48,
    });
    expect(Array.isArray(cmds)).toBe(true);
    if (typeof cmds === "string") throw new Error(cmds);
    m = runAll(m, cmds);

    const enlarged = m.elements["v-enlarged"] as ViewElement;
    const callout = m.elements["co-lshape"] as DrawingItem;
    expect(enlarged.props?.cropPolygon?.length).toBe(6);
    expect(callout.callout?.boundary?.length).toBe(6);
    expect(calloutBoundaryPolygon(callout)?.length).toBe(6);

    // Parent plan renders rounded-corner dashed L-shape callout cleanly
    const parentBuilt = buildViewScene(m, "v-plan");
    expect(parentBuilt).not.toBeNull();
    expect(sceneToSvg(parentBuilt!.scene)).toContain("ENLARGED L-SHAPE CORE");

    // Enlarged plan clipped to L_POLY has fewer line/fill primitives than the same view with cropPolygon cleared (because w-notch is excluded!)
    const lBuilt = buildViewScene(m, "v-enlarged");
    expect(lBuilt).not.toBeNull();
    const lPrimCount = lBuilt!.scene.primitives.length;

    const mRect = runAll(m, [{ type: "set_view_crop", viewId: "v-enlarged", cropPolygon: null }]);
    const rectBuilt = buildViewScene(mRect, "v-enlarged");
    expect(rectBuilt).not.toBeNull();
    expect(rectBuilt!.scene.primitives.length).toBeGreaterThan(lPrimCount);
  });

  test("calloutSyncCommands reshapes rectangular -> L-shape -> rectangle and keeps target cropPolygon synced", () => {
    let m = emptyModel();
    m = runAll(m, [
      { type: "create_level", levelId: "L1", name: "Level 1", elevationMm: 0 },
      { type: "create_view", viewId: "v-plan", name: "Level 1 Plan", viewType: "floor_plan", crop: { min: pt(-2, -2), max: pt(24, 24) }, props: { level: "Level 1", scale: 96 } },
    ]);
    const init = enlargedPlanCommands(m, {
      parentViewId: "v-plan",
      viewId: "v-enlarged",
      calloutId: "co-1",
      name: "Enlarged Room",
      box: { min: pt(0, 0), max: pt(12, 12) },
      scale: 48,
    });
    if (typeof init === "string") throw new Error(init);
    m = runAll(m, init);

    // 1. Reshape rectangular callout into 6-corner L-shape
    const toL = calloutSyncCommands(m, m.elements["co-1"] as DrawingItem, L_POLY);
    if (typeof toL === "string") throw new Error(toL);
    expect(toL.length).toBe(2);
    m = runAll(m, toL);
    expect((m.elements["co-1"] as DrawingItem).callout?.boundary?.length).toBe(6);
    expect((m.elements["v-enlarged"] as ViewElement).props?.cropPolygon?.length).toBe(6);

    // 2. Reset back to a 4-corner axis-aligned rectangle -> clears custom boundary & cropPolygon
    const rectBoundary = [pt(0, 0), pt(16, 0), pt(16, 12), pt(0, 12)];
    const toRect = calloutSyncCommands(m, m.elements["co-1"] as DrawingItem, rectBoundary);
    if (typeof toRect === "string") throw new Error(toRect);
    m = runAll(m, toRect);
    expect((m.elements["co-1"] as DrawingItem).callout?.boundary).toBeUndefined();
    expect((m.elements["v-enlarged"] as ViewElement).props?.cropPolygon).toBeUndefined();
    expect((m.elements["v-enlarged"] as ViewElement).cropMax.x).toBeCloseTo(16 * FT, 0);
  });

  test("moving/tagging a space or room auto-label preserves its real name and number (never '?')", () => {
    let m = emptyModel();
    const runUpgraded = (cmds: readonly Command[]) => {
      for (const cmd of cmds) {
        const res = withUpgradePolicy(
          () => true,
          () =>
            planCommit(
              m,
              [],
              { idempotencyKey: `sp-${++seq}`, baseRevision: m.revision, actor: { id: "tester", name: "Tester", kind: "human" }, command: cmd },
              () => "2026-11-22T00:00:00.000Z",
            ),
        );
        if (!res.ok) throw new Error(`${cmd.type}: ${res.error.message}`);
        m = res.model;
      }
    };
    runUpgraded([
      { type: "create_level", levelId: "L2", name: "Level 2", elevationMm: 3658 },
      {
        type: "create_space",
        spaces: [{ spaceId: "sp-203", levelId: "L2", number: "203", name: "MEZZANINE LOFT", outline: [pt(0, 0), pt(20, 0), pt(20, 20), pt(0, 20)] }],
      },
    ]);

    // Standard auto-template space tag (no mark-only style)
    expect(tagLines(m, { elementId: "sp-203", template: "auto", leader: false })).toEqual(["MEZZANINE LOFT", "203"]);
    expect(tagShape(m, { elementId: "sp-203", template: "auto", leader: false })).toBe("none");
    // Even if a mark-only style like `tst-mark-clean` was previously saved on a space tag, falls back cleanly instead of "?"
    expect(tagLines(m, { elementId: "sp-203", template: "auto", styleId: "tst-mark-clean", leader: false })).toEqual(["MEZZANINE LOFT", "203"]);
  });
});
