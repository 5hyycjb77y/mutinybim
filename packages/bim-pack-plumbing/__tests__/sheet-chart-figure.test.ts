/**
 * @jest-environment node
 *
 * A chart as a sheet figure, foundation for "the Hunter curve on a sheet".
 * Before, the Hunter chart was only a screen widget (recharts in the
 * Plumbing tab): nothing could draw it onto paper. Now any registered chart
 * kind evaluates from the model and draws as ordinary sheet linework and
 * text inside its frame (so it prints with the sheet), series told apart by
 * pen and dash, the curve the model uses heavier, each water system's
 * design point marked. A chart that can't draw says why inside its frame.
 */
import { DEFAULT_SETTINGS, chartKinds, chartPrimitives, evaluateFigure, figurePrimitives, planCommit, registerChartKind, type Command, type ModelState, type Primitive, type Vec2 } from "@permitzip/bim-kernel";
import { sampleMarketLoadPointCommand, sampleMarket } from "../../bim-kernel/__tests__/fixtures/sample-market";
import { BIM_CALC_CHART_KINDS, HUNTER_CHART_KIND } from "../src";

function commit(head: ModelState, command: Command): ModelState {
  const d = planCommit(head, [], { idempotencyKey: `k-${head.revision}-${command.type}`, baseRevision: head.revision, actor: { id: "avery", name: "Avery", kind: "human" }, command }, () => "2026-10-25T06:00:00.000Z", []);
  if (!d.ok) throw new Error(`${command.type}: ${d.error.message}`);
  return d.model;
}

function sampleMarketModel(): ModelState {
  let m: ModelState = { modelId: "7492", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  const build = sampleMarket();
  for (const c of build.setup) m = commit(m, c);
  m = commit(m, sampleMarketLoadPointCommand(build.points));
  return commit(m, { type: "save_catalog_entry", entry: { type: "plumbing_settings", name: "Project", sizingMode: "check", buildingType: "restaurant" } });
}

const MIN: Vec2 = { x: 500, y: 300 };
const MAX: Vec2 = { x: 700, y: 440 };
const pointsOf = (p: Primitive): Vec2[] => (p.kind === "line" ? [p.a, p.b] : p.kind === "rect" ? [p.at, { x: p.at.x + p.size.x, y: p.at.y + p.size.y }] : p.kind === "fill" ? [...p.points] : [p.at]);
const texts = (prims: readonly Primitive[]) => prims.flatMap((p) => (p.kind === "text" ? [p.text] : []));

beforeAll(() => {
  for (const kind of BIM_CALC_CHART_KINDS) registerChartKind(kind);
});

describe("chart figures on sheets", () => {
  it("offers the Hunter curve as a chart kind a host registers", () => {
    expect(chartKinds().map((k) => k.id)).toContain("plumbing.hunter_curve");
  });

  it("reads the Hunter chart live from the model: the restaurant's 43.25 WSFU at 48 gpm on Curve A", () => {
    const data = evaluateFigure(sampleMarketModel(), { kind: "chart", chart: HUNTER_CHART_KIND.id });
    if ("reason" in data) throw new Error(data.reason);
    expect(data.markers.map((m) => m.label)).toContain("Domestic Cold Water: 43.25 WSFU, 48 gpm");
    expect(data.series.find((s) => s.id === "ashrae_a")?.emphasis).toBe(true);
    expect(data.series.find((s) => s.id === "ashrae_d")?.emphasis).toBe(false);
  });

  it("draws inside its frame on paper, the used curve heavier, the design point marked and labelled", () => {
    const prims = figurePrimitives(sampleMarketModel(), { kind: "chart", chart: HUNTER_CHART_KIND.id, title: "WATER DEMAND" }, MIN, MAX);
    for (const p of prims) for (const pt of pointsOf(p)) {
      expect(pt.x).toBeGreaterThanOrEqual(MIN.x - 1e-6);
      expect(pt.x).toBeLessThanOrEqual(MAX.x + 1e-6);
      expect(pt.y).toBeGreaterThanOrEqual(MIN.y - 1e-6);
      expect(pt.y).toBeLessThanOrEqual(MAX.y + 1e-6);
    }
    expect(texts(prims)).toEqual(expect.arrayContaining(["WATER DEMAND", "Fixture units", "Gallons per minute", "Domestic Cold Water: 43.25 WSFU, 48 gpm"]));
    expect(prims.some((p) => p.kind === "line" && p.pen === "wide")).toBe(true);
    // Curves are told apart without colour: at least two dash patterns among the series.
    const dashes = new Set(prims.flatMap((p) => (p.kind === "line" && p.tone !== "halftone" ? [JSON.stringify(p.dash ?? null)] : [])));
    expect(dashes.size).toBeGreaterThanOrEqual(2);
  });

  it("keeps the legend and every label inside the frame, even in a small frame (QA: the legend ran off the right edge)", () => {
    const small = { x: MIN.x + 110, y: MIN.y + 80 };
    const prims = figurePrimitives(sampleMarketModel(), { kind: "chart", chart: HUNTER_CHART_KIND.id }, MIN, small);
    for (const p of prims) {
      if (p.kind !== "text" || p.rotate) continue;
      const width = p.text.length * p.size * 0.62;
      const from = p.anchor === "start" ? p.at.x : p.anchor === "end" ? p.at.x - width : p.at.x - width / 2;
      expect(from).toBeGreaterThanOrEqual(MIN.x - 0.5);
      expect(from + width).toBeLessThanOrEqual(small.x + 0.5);
    }
  });

  it("clips curves to the plot instead of running past the axes (QA: the top curve left the plot)", () => {
    const data = { title: "T", x: { label: "x", min: 0, max: 10, step: 5 }, y: { label: "y", min: 0, max: 10, step: 5 }, series: [{ id: "s", label: "steep", points: [{ x: 0, y: 0 }, { x: 10, y: 40 }], emphasis: true }], markers: [] };
    const prims = chartPrimitives(data, MIN, MAX);
    const axes = prims.filter((p): p is Extract<Primitive, { kind: "line" }> => p.kind === "line" && p.pen === "medium");
    const top = Math.min(...axes.flatMap((l) => [l.a.y, l.b.y]));
    const curve = prims.filter((p): p is Extract<Primitive, { kind: "line" }> => p.kind === "line" && p.pen === "wide" && p.a.y !== p.b.y && Math.abs(p.a.x - p.b.x) > 3);
    expect(curve.length).toBeGreaterThan(0);
    for (const l of curve) expect(Math.min(l.a.y, l.b.y)).toBeGreaterThanOrEqual(top - 1e-6);
  });

  it("scales the Hunter chart tall enough for every curve it draws", () => {
    const data = evaluateFigure(sampleMarketModel(), { kind: "chart", chart: HUNTER_CHART_KIND.id });
    if ("reason" in data) throw new Error(data.reason);
    for (const s of data.series) for (const p of s.points) if (p.x <= data.x.max) expect(p.y).toBeLessThanOrEqual(data.y.max);
  });

  it("limits the chart to the curves asked for", () => {
    const data = evaluateFigure(sampleMarketModel(), { kind: "chart", chart: HUNTER_CHART_KIND.id, params: { curves: "ashrae_a" } });
    if ("reason" in data) throw new Error(data.reason);
    expect(data.series.map((s) => s.id)).toEqual(["ashrae_a"]);
  });

  it("says why inside the frame when it can't draw, never a blank box", () => {
    expect(texts(figurePrimitives(sampleMarketModel(), { kind: "chart", chart: "nope" }, MIN, MAX))).toEqual(['This MutinyBIM has no "nope" chart']);
    expect(texts(figurePrimitives(sampleMarketModel(), { kind: "chart", chart: HUNTER_CHART_KIND.id, params: { curves: "zz" } }, MIN, MAX))[0]).toMatch(/^No demand curve zz/);
  });
});
