/**
 * @jest-environment node
 *
 * Industry-standard 2D schematic representation and detail-level configuration
 * for plumbing, gas, conduit, and duct runs:
 * - Single-line schematic fittings (curved elbows with joint ticks, rise dot vs
 *   drop through-line circles, tee ticks, swept wyes, conical reducers, caps).
 * - Repeating inline service codes (CW, SAN, G, V…) configurable per system
 *   (`set_system_graphics({ lineCode })`) and toggleable per view (`showLineCodes`).
 * - Per-category / per-service `detailLevel` and `singleLineBelowMm` size
 *   thresholds in `categoryOverrides`.
 * - Fine detail switches pipe and conduit to true double-line with fitting bodies.
 */
import {
  CATEGORY_OVERRIDES_FEATURE,
  VIEW_SCHEMATIC_DETAIL_FEATURE,
  DEFAULT_SETTINGS,
  buildViewScene,
  planCommit,
  systemLineCode,
  withUpgradePolicy,
  type Command,
  type ModelState,
  type Primitive,
  type RunSize,
  type ViewPropsPatch,
} from "../src";
import { isSingleLineRun } from "../src/drawing/runs";

const FT = 304.8;
const IN = 25.4;

let seq = 0;
function commit(model: ModelState, command: Command): ModelState {
  const d = withUpgradePolicy(
    (f) => f === CATEGORY_OVERRIDES_FEATURE || f === VIEW_SCHEMATIC_DETAIL_FEATURE,
    () =>
      planCommit(
        model,
        [],
        {
          idempotencyKey: `psd-${++seq}`,
          baseRevision: model.revision,
          actor: { id: "avery", name: "Avery", kind: "human" },
          command,
        },
        () => "2026-11-20T00:00:00.000Z",
      ),
  );
  if (!d.ok) throw new Error(`${command.type}: ${d.error.message}`);
  return d.model;
}

const copper = (inches: number): RunSize => ({ shape: "pipe", nominalMm: inches * IN, material: "copper" });
const pvc = (inches: number): RunSize => ({ shape: "pipe", nominalMm: inches * IN, material: "pvc" });

function plumbingModel(viewProps: ViewPropsPatch = {}): ModelState {
  let m: ModelState = { modelId: "psd", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  m = commit(m, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  // 2" copper cold water with an L-turn (elbow) and a vertical rise at the end.
  m = commit(m, {
    type: "route_run",
    idPrefix: "cw",
    levelId: "lvl-1",
    domain: "pipe",
    size: copper(2),
    elevationMm: 9 * FT,
    system: { id: "sys-cw", kind: "domestic_cold_water", name: "DCW-1" },
    points: [
      { x: 0, y: 0 },
      { x: 20 * FT, y: 0 },
      { x: 20 * FT, y: 12 * FT },
      { x: 20 * FT, y: 12 * FT, elevationMm: 14 * FT },
    ],
  });
  // 4" PVC sanitary straight main.
  m = commit(m, {
    type: "route_run",
    idPrefix: "san",
    levelId: "lvl-1",
    domain: "pipe",
    size: pvc(4),
    elevationMm: -2 * FT,
    system: { id: "sys-san", kind: "sanitary", name: "SAN-1" },
    points: [
      { x: 0, y: 20 * FT },
      { x: 24 * FT, y: 20 * FT },
    ],
  });
  m = commit(m, {
    type: "create_view",
    viewId: "v-plumb",
    name: "Level 1 - Plumbing",
    viewType: "floor_plan",
    crop: { min: { x: -4 * FT, y: -4 * FT }, max: { x: 30 * FT, y: 26 * FT } },
    props: { level: "Level 1", scale: 48, detailLevel: "medium", ...viewProps },
  });
  return m;
}

type LinePrim = Extract<Primitive, { kind: "line" }>;
type TextPrim = Extract<Primitive, { kind: "text" }>;

const linesOf = (prims: readonly Primitive[]): LinePrim[] => prims.filter((p): p is LinePrim => p.kind === "line");
const textsOf = (prims: readonly Primitive[]): TextPrim[] => prims.filter((p): p is TextPrim => p.kind === "text");

describe("isSingleLineRun: domain-neutral detail level and size threshold", () => {
  it("coarse = all single-line, medium = duct double-line & pipe/conduit single-line, fine = all double-line", () => {
    const ductSize: RunSize = { shape: "rect", width: 14 * IN, height: 10 * IN };
    const pipe2 = copper(2);
    const pipe4 = pvc(4);
    expect(isSingleLineRun("duct", ductSize, "coarse")).toBe(true);
    expect(isSingleLineRun("duct", ductSize, "medium")).toBe(false);
    expect(isSingleLineRun("duct", ductSize, "fine")).toBe(false);
    expect(isSingleLineRun("pipe", pipe2, "coarse")).toBe(true);
    expect(isSingleLineRun("pipe", pipe2, "medium")).toBe(true);
    expect(isSingleLineRun("pipe", pipe2, "fine")).toBe(false);
    expect(isSingleLineRun("conduit", pipe2, "medium")).toBe(true);
    expect(isSingleLineRun("conduit", pipe2, "fine")).toBe(false);
    // Size threshold: < 4" single-line, >= 4" double-line.
    expect(isSingleLineRun("pipe", pipe2, "medium", 4 * IN)).toBe(true);
    expect(isSingleLineRun("pipe", pipe4, "medium", 4 * IN)).toBe(false);
    expect(isSingleLineRun("pipe", pipe2, "medium", 0)).toBe(false);
  });
});

describe("schematic fittings, inline service codes, and per-category detail level", () => {
  it("prints repeating inline service codes (CW, SAN) on single-line runs at medium detail, and respects system and view overrides", () => {
    const m = plumbingModel({ detailLevel: "medium" });
    expect(systemLineCode(m.elements, "sys-cw")).toBe("CW");
    expect(systemLineCode(m.elements, "sys-san")).toBe("SAN");

    const texts = textsOf(buildViewScene(m, "v-plumb").scene.primitives).map((t) => t.text);
    expect(texts).toContain("CW");
    expect(texts).toContain("SAN");

    // System override changes the inline code; "" suppresses it; null restores default.
    const renamed = commit(m, { type: "set_system_graphics", systemId: "sys-cw", lineCode: "DCW" });
    expect(textsOf(buildViewScene(renamed, "v-plumb").scene.primitives).map((t) => t.text)).toContain("DCW");

    const hidden = commit(renamed, { type: "set_system_graphics", systemId: "sys-cw", lineCode: "" });
    expect(textsOf(buildViewScene(hidden, "v-plumb").scene.primitives).map((t) => t.text)).not.toContain("DCW");
    expect(textsOf(buildViewScene(hidden, "v-plumb").scene.primitives).map((t) => t.text)).not.toContain("CW");

    const restored = commit(hidden, { type: "set_system_graphics", systemId: "sys-cw", lineCode: null });
    expect(systemLineCode(restored.elements, "sys-cw")).toBe("CW");

    // View-level showLineCodes: false suppresses all inline codes in that view.
    const viewOff = plumbingModel({ detailLevel: "medium", showLineCodes: false });
    const offTexts = textsOf(buildViewScene(viewOff, "v-plumb").scene.primitives).map((t) => t.text);
    expect(offTexts).not.toContain("CW");
    expect(offTexts).not.toContain("SAN");
  });

  it("draws curved single-line schematic elbows with perpendicular joint ticks instead of bare right angles", () => {
    const m = plumbingModel({ detailLevel: "medium", showLineCodes: false });
    const ls = linesOf(buildViewScene(m, "v-plumb").scene.primitives);
    // Horizontal elbow draws 2 thin perpendicular joint ticks + 4 curved bend chords (diagonal segments, neither purely horizontal nor vertical).
    const diagonalBendChords = ls.filter((l) => Math.abs(l.b.x - l.a.x) > 0.05 && Math.abs(l.b.y - l.a.y) > 0.05 && l.pen === "medium");
    expect(diagonalBendChords.length).toBeGreaterThanOrEqual(4);
    const thinTicks = ls.filter((l) => l.pen === "thin");
    expect(thinTicks.length).toBeGreaterThanOrEqual(2);
  });

  it("switches pipes to true double-line at fine detail, or per-service / by singleLineBelowMm size threshold", () => {
    // Helper: count distinct Y rows for long horizontal lines near y = 20 ft (the 4" sanitary main) vs y = 0 (the 2" copper run).
    const horizontalRowCounts = (props: ViewPropsPatch) => {
      const m = plumbingModel({ showLineCodes: false, ...props });
      const ls = linesOf(buildViewScene(m, "v-plumb").scene.primitives);
      const longH = ls.filter((l) => Math.abs(l.a.y - l.b.y) < 1e-4 && Math.abs(l.b.x - l.a.x) > 30);
      const ys = [...new Set(longH.map((l) => Math.round(l.a.y * 10) / 10))].sort((a, b) => a - b);
      // Two bands in paper Y (y=0 and y=20ft are ~127 mm apart on paper at 1:48).
      const topBand = ys.filter((y) => Math.abs(y - (ys[0] ?? 0)) < 10);
      const bottomBand = ys.filter((y) => Math.abs(y - (ys[ys.length - 1] ?? 0)) < 10);
      return { topBand: topBand.length, bottomBand: bottomBand.length };
    };

    // Medium: both 2" CW and 4" SAN are single-line (1 row each).
    expect(horizontalRowCounts({ detailLevel: "medium" })).toEqual({ topBand: 1, bottomBand: 1 });

    // Fine: both 2" CW and 4" SAN are double-line (2 rows each).
    expect(horizontalRowCounts({ detailLevel: "fine" })).toEqual({ topBand: 2, bottomBand: 2 });

    // Size threshold on `pipe`: singleLineBelowMm = 4" -> 4" SAN draws double-line (2 rows), 2" CW stays single-line (1 row).
    const bySize = horizontalRowCounts({ detailLevel: "medium", categoryOverrides: { pipe: { singleLineBelowMm: 4 * IN } } });
    expect([bySize.topBand, bySize.bottomBand].sort()).toEqual([1, 2]);

    // Per-service override: service:sanitary = fine -> SAN double-line (2 rows), CW single-line (1 row).
    const byService = horizontalRowCounts({ detailLevel: "medium", categoryOverrides: { "service:sanitary": { detailLevel: "fine" } } });
    expect([byService.topBand, byService.bottomBand].sort()).toEqual([1, 2]);
  });
});
