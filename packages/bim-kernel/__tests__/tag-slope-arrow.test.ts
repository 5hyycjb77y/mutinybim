/**
 * @jest-environment node
 *
 * Plumbing follow-ups (Nov 7): a tag style may draw an arrow under its words
 * along the run it labels, towards the run's lower end (`down_slope`) or its
 * higher end (`up_slope`), worked out on the view's paper. So it points the
 * right way on a plan turned to the working angle, in the live view and on a
 * printed sheet alike (both draw through `drawTag`).
 *
 * Fails on the old code: tag styles had no arrow (`arrow` was refused by the
 * strict schema and nothing drew one).
 */
import {
  DEFAULT_SETTINGS,
  TAGS_SLOPE_ARROW_FEATURE,
  buildSheetSceneFor,
  buildViewScene,
  commandSchema,
  executeCommand,
  planCommit,
  withUpgradePolicy,
  type Command,
  type ModelState,
  type RunSize,
  type Vec2,
} from "../src";

const FT = 304.8;
const IN = 25.4;
const SAN = { id: "sys-san", kind: "sanitary" as const, name: "Sanitary" };
const pvc = (inches: number): RunSize => ({ shape: "pipe", nominalMm: inches * IN, material: "pvc" });
const READS_ARROW = (f: string) => f === TAGS_SLOPE_ARROW_FEATURE;

function run(model: ModelState, command: Record<string, unknown> & { type: string }, policy: (f: string) => boolean = READS_ARROW): ModelState {
  const r = withUpgradePolicy(policy, () => executeCommand(model, commandSchema.parse(command)));
  if (!r.ok) throw new Error(r.error.message);
  return { ...r.model, revision: (model.revision + 1) as ModelState["revision"] };
}

let n = 0;
function commit(model: ModelState, command: Command): ModelState {
  const d = planCommit(model, [], { idempotencyKey: `slope-arrow-${++n}`, baseRevision: model.revision, actor: { id: "avery", name: "Avery", kind: "human" }, command }, () => "2026-11-07T00:00:00.000Z");
  if (!d.ok) throw new Error(`${command.type}: ${d.error.message}`);
  return d.model;
}

/**
 * A 4" drain drawn west to east, 30 ft. `flow`: with the points it falls east
 * (drawn downhill); against them it falls west (drawn uphill). `props`: the
 * plan view's own settings; with `orientation: "true_north"` the site's true
 * north is set 90° from plan north first, so the plan turns a quarter turn.
 */
function drainPlan(flow: "with_points" | "against_points", props: Record<string, unknown> = {}, arrow: "down_slope" | "up_slope" | null = "down_slope"): ModelState {
  let m: ModelState = { modelId: "slope-arrow", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  m = commit(m, { type: "create_level", levelId: "L1", name: "L1", elevationMm: 0 });
  m = commit(m, { type: "route_run", idPrefix: "d", levelId: "L1", domain: "pipe", size: pvc(4), elevationMm: -2 * FT, system: SAN, flow, points: [{ x: 0, y: 0 }, { x: 30 * FT, y: 0 }] });
  if (props.orientation === "true_north") m = commit(m, { type: "set_true_north", angleDeg: 90 });
  m = run(m, { type: "create_view", viewId: "plan", name: "Plan", viewType: "floor_plan", props: { level: "L1", scale: 48, ...props } });
  m = run(m, { type: "create_tag_style", styleId: "tst-slope", name: "Slope", lines: ["{pipe.slope}"], orientation: "along", ...(arrow ? { arrow } : {}) });
  return run(m, { type: "add_drawing_item", itemId: "t1", ownerId: "plan", shape: "tag", points: [{ x: 15 * FT, y: 2 * FT }], tag: { elementId: "d-s1", template: "fields", leader: false, styleId: "tst-slope" } });
}

type Seg = readonly [Vec2, Vec2];
const key = (s: Seg) => JSON.stringify(s);
const lines = (m: ModelState): Seg[] => buildViewScene(m, "plan").scene.primitives.flatMap((p) => (p.kind === "line" ? [[p.a, p.b] as const] : []));

/** The plan placed on a sheet at 1/4" = 1'-0": the printed lines. */
function sheetLines(m: ModelState): Seg[] {
  let s = run(m, { type: "create_sheet", sheetId: "s-1", number: "P-101", name: "Plumbing plan" });
  s = run(s, { type: "place_viewport", viewportId: "vp", sheetId: "s-1", viewId: "plan", center: { x: 320, y: 260 }, scale: 48 });
  return buildSheetSceneFor(s, "s-1", { projectName: "Sample Warehouse" }).primitives.flatMap((p) => (p.kind === "line" ? [[p.a, p.b] as const] : []));
}

/** The arrow the style added (the three strokes not drawn without it), as a unit direction on paper: tail to tip. */
function arrowOnPaper(flow: "with_points" | "against_points", props: Record<string, unknown> = {}, read: (m: ModelState) => Seg[] = lines): Vec2 {
  const without = new Set(read(drainPlan(flow, props, null)).map(key));
  const added = read(drainPlan(flow, props)).filter((s) => !without.has(key(s)));
  expect(added).toHaveLength(3);
  const near = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y) < 1e-6;
  const tip = [added[0]![0], added[0]![1]].find((p) => added.every((s) => near(s[0], p) || near(s[1], p)));
  if (!tip) throw new Error("no tip shared by the shaft and the head");
  const shaft = added.reduce((a, b) => (Math.hypot(b[1].x - b[0].x, b[1].y - b[0].y) > Math.hypot(a[1].x - a[0].x, a[1].y - a[0].y) ? b : a));
  const tail = near(shaft[0], tip) ? shaft[1] : shaft[0];
  const l = Math.hypot(tip.x - tail.x, tip.y - tail.y);
  return { x: (tip.x - tail.x) / l, y: (tip.y - tail.y) / l };
}

describe("a tag's arrow points downhill on paper", () => {
  it("plan north up: a drain falling east points right", () => {
    const d = arrowOnPaper("with_points");
    expect(d.x).toBeCloseTo(1, 6);
    expect(d.y).toBeCloseTo(0, 6);
  });

  it("a plan turned 90° (true north a quarter turn from plan north): the same drain points up the sheet", () => {
    const d = arrowOnPaper("with_points", { orientation: "true_north" });
    expect(Math.abs(d.x)).toBeLessThan(1e-6);
    // Paper y runs down the sheet: model east turned a quarter turn counter-clockwise reads upward.
    expect(d.y).toBeCloseTo(-1, 6);
  });

  it("printed on a sheet, the turned plan's arrow points up the sheet too", () => {
    const d = arrowOnPaper("with_points", { orientation: "true_north" }, sheetLines);
    expect(Math.abs(d.x)).toBeLessThan(1e-6);
    expect(d.y).toBeCloseTo(-1, 6);
  });

  it("a plan turned 45° to the working angle: the arrow turns with the drain", () => {
    const d = arrowOnPaper("with_points", { orientation: "working_angle", workingAngleDeg: 45 });
    expect(d.x).toBeCloseTo(Math.SQRT1_2, 6);
    expect(Math.abs(d.y)).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it("a drain drawn uphill (falling back towards its start) points left: downhill, not the way it was drawn", () => {
    const d = arrowOnPaper("against_points");
    expect(d.x).toBeCloseTo(-1, 6);
  });

  it("an up-slope arrow points the other way; a level run draws none", () => {
    const up = drainPlan("with_points", {}, "up_slope");
    const down = drainPlan("with_points");
    expect(lines(up).length).toBe(lines(down).length);
    let level: ModelState = { modelId: "level", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
    level = commit(level, { type: "create_level", levelId: "L1", name: "L1", elevationMm: 0 });
    level = commit(level, { type: "route_run", idPrefix: "d", levelId: "L1", domain: "pipe", size: { shape: "pipe", nominalMm: 1 * IN, material: "copper" }, elevationMm: 9 * FT, system: { id: "cw", kind: "domestic_cold_water", name: "CW" }, points: [{ x: 0, y: 0 }, { x: 30 * FT, y: 0 }] });
    level = run(level, { type: "create_view", viewId: "plan", name: "Plan", viewType: "floor_plan", props: { level: "L1", scale: 48 } });
    const before = lines(level).length;
    level = run(level, { type: "create_tag_style", styleId: "tst-slope", name: "Slope", lines: ["{size}"], arrow: "down_slope" });
    level = run(level, { type: "add_drawing_item", itemId: "t1", ownerId: "plan", shape: "tag", points: [{ x: 15 * FT, y: 2 * FT }], tag: { elementId: "d-s1", template: "fields", leader: false, styleId: "tst-slope" } });
    expect(lines(level).length).toBe(before);
  });

  it("an older model server that can't store the arrow refuses it in words; \"none\" clears it", () => {
    let m = drainPlan("with_points");
    expect(() => run(m, { type: "create_tag_style", styleId: "tst-2", name: "Two", lines: ["{size}"], arrow: "down_slope" }, () => false)).toThrow(/arrow can't be saved yet/);
    m = run(m, { type: "update_tag_style", styleId: "tst-slope", arrow: "none" });
    const style = Object.values(m.elements).find((e) => e.kind === "organization" && "entry" in e && e.entry.type === "tag_style" && e.entry.name === "Slope");
    expect(style && "entry" in style && style.entry.type === "tag_style" ? style.entry.arrow : "missing").toBeUndefined();
  });
});
