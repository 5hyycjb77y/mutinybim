/**
 * @jest-environment node
 *
 * Product decision, Oct 24 2026: "none of our tags can move … make our tags configurable,
 * saving different types of tags … really smart, dynamic tag options … and
 * agents should be able to place them, with situational awareness about what
 * it looks like." Tag styles grow prefix / suffix, units, outline shapes,
 * words turned along their run (never upside down), and the kinds they apply
 * to; tags read the same field paths schedules and diagrams read (a pipe's
 * `{pipe.size}`); a trade registers ready-made presets; an existing tag can be
 * moved to the first clear spot; an agent reads what a tag collides with.
 * Diagram text (one-line, riser) moves by a hint and keeps reading the model.
 */
import {
  DEFAULT_SETTINGS,
  buildViewScene,
  clearSpotForTag,
  commandSchema,
  createTagStyleFromPreset,
  diagramTextKey,
  evaluateDiagram,
  executeCommand,
  planCommit,
  readableAngleDeg,
  TAG_STYLE_PRESET_POINT,
  sceneToSvg,
  tagLines,
  tagSituation,
  tagStylePreset,
  tagStylePresets,
  type Command,
  type DrawingItem,
  type ModelState,
  type RunSize,
  type ViewElement,
} from "../src";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { PackSet, contribute, definePack, withPackSet } from "../src/packs";
import { referenceBuilding } from "./fixtures/electrical-building";

const FT = 304.8;
const IN = 25.4;

function run(model: ModelState, command: Record<string, unknown> & { type: string }): ModelState {
  const r = executeCommand(model, commandSchema.parse(command));
  if (!r.ok) throw new Error(r.error.message);
  return { ...r.model, revision: (model.revision + 1) as ModelState["revision"] };
}

function refused(model: ModelState, command: Record<string, unknown> & { type: string }): { code: string; message: string } {
  const r = executeCommand(model, commandSchema.parse(command));
  if (r.ok) throw new Error(`${command.type} was accepted`);
  return { code: r.error.code, message: r.error.message };
}

let n = 0;
function commit(model: ModelState, command: Command): ModelState {
  const d = planCommit(model, [], { idempotencyKey: `tag-types-${++n}`, baseRevision: model.revision, actor: { id: "avery", name: "Avery", kind: "human" }, command }, () => "2026-10-24T00:00:00.000Z");
  if (!d.ok) throw new Error(`${command.type}: ${d.error.message}`);
  return d.model;
}

const pvc = (inches: number): RunSize => ({ shape: "pipe", nominalMm: inches * IN, material: "pvc" });
const SAN = { id: "sys-san", kind: "sanitary" as const, name: "Sanitary" };

/** A plan with a horizontal 4" drain and a vertical 3" one (on paper, it runs up the sheet). */
function pipePlan(): ModelState {
  let m: ModelState = { modelId: "tags", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  m = commit(m, { type: "create_level", levelId: "L1", name: "L1", elevationMm: 0 });
  m = commit(m, { type: "route_run", idPrefix: "h", levelId: "L1", domain: "pipe", size: pvc(4), elevationMm: -2 * FT, system: SAN, points: [{ x: 0, y: 0 }, { x: 30 * FT, y: 0 }] });
  m = commit(m, { type: "route_run", idPrefix: "v", levelId: "L1", domain: "pipe", size: pvc(3), elevationMm: -2 * FT, system: SAN, points: [{ x: 50 * FT, y: 0 }, { x: 50 * FT, y: 30 * FT }] });
  return run(m, { type: "create_view", viewId: "plan", name: "Plan", viewType: "floor_plan", props: { level: "L1", scale: 48 } });
}

const textPrims = (m: ModelState, viewId: string) => buildViewScene(m, viewId).scene.primitives.flatMap((p) => (p.kind === "text" ? [p] : []));
const item = (m: ModelState, id: string): DrawingItem => {
  const el = m.elements[id];
  if (el?.kind !== "drawing_item") throw new Error(`no item ${id}`);
  return el;
};

describe("tag styles: units, prefix and suffix, shared field paths", () => {
  it("a pipe tag reads {pipe.size} and {pipe.length_lf} through the resolver schedules and risers use", () => {
    let m = pipePlan();
    m = run(m, { type: "create_tag_style", styleId: "tst-pipe", name: "Pipe size and length", lines: ["{pipe.size}", "{pipe.length_lf}"] });
    m = run(m, { type: "add_drawing_item", itemId: "t1", ownerId: "plan", shape: "tag", points: [{ x: 15 * FT, y: 2 * FT }], tag: { elementId: "h-s1", template: "fields", leader: false, styleId: "tst-pipe" } });
    // Before: tags only routed dotted paths through the resolver for parts, so a pipe printed "?".
    expect(tagLines(m, item(m, "t1").tag!)).toEqual(['4"', "30 LF"]);
  });

  it("prefix, suffix and units change what every tag on the style prints", () => {
    let m = pipePlan();
    m = run(m, { type: "create_tag_style", styleId: "tst-len", name: "Length", lines: ["{size}", "{length}"], prefix: "(N) ", suffix: " TYP." });
    m = run(m, { type: "add_drawing_item", itemId: "t1", ownerId: "plan", shape: "tag", points: [{ x: 15 * FT, y: 2 * FT }], tag: { elementId: "h-s1", template: "fields", leader: false, styleId: "tst-len" } });
    expect(tagLines(m, item(m, "t1").tag!)).toEqual(['(N) 4" PVC', `30'-0" TYP.`]);
    m = run(m, { type: "update_tag_style", styleId: "tst-len", units: "mm", suffix: "" });
    expect(tagLines(m, item(m, "t1").tag!)).toEqual(['(N) 4" PVC', "9144"]);
    expect(textPrims(m, "plan").map((p) => p.text)).toContain("9144");
  });
});

describe("tag styles: shape and words along the run", () => {
  it("along: a vertical pipe's tag reads up the sheet, a horizontal one level; both print turned in SVG", () => {
    let m = pipePlan();
    m = run(m, { type: "create_tag_style", styleId: "tst-along", name: "Size along", lines: ["{size}"], orientation: "along" });
    m = run(m, { type: "add_drawing_item", itemId: "th", ownerId: "plan", shape: "tag", points: [{ x: 15 * FT, y: 1 * FT }], tag: { elementId: "h-s1", template: "fields", leader: false, styleId: "tst-along" } });
    m = run(m, { type: "add_drawing_item", itemId: "tv", ownerId: "plan", shape: "tag", points: [{ x: 51 * FT, y: 15 * FT }], tag: { elementId: "v-s1", template: "fields", leader: false, styleId: "tst-along" } });
    const prims = textPrims(m, "plan");
    const vertical = prims.find((p) => p.text === '3" PVC');
    const level = prims.find((p) => p.text === '4" PVC');
    expect(vertical?.rotate).toBe(-90);
    expect(level?.rotate).toBeUndefined();
    expect(sceneToSvg(buildViewScene(m, "plan").scene)).toMatch(/transform="rotate\(-90\.00 /);
  });

  it("never upside down or reading downward", () => {
    expect(readableAngleDeg(0)).toBe(0);
    expect(readableAngleDeg(180)).toBe(0);
    expect(readableAngleDeg(90)).toBe(-90);
    expect(readableAngleDeg(-90)).toBe(-90);
    expect(readableAngleDeg(135)).toBe(-45);
    expect(readableAngleDeg(-135)).toBe(45);
    expect(readableAngleDeg(45)).toBe(45);
  });

  it("a hexagon outline is drawn as six lines instead of the square box", () => {
    let m = pipePlan();
    m = run(m, { type: "create_tag_style", styleId: "tst-hex", name: "Hex", lines: ["{size}"], box: "hexagon" });
    const before = buildViewScene(m, "plan").scene.primitives.filter((p) => p.kind === "line").length;
    m = run(m, { type: "add_drawing_item", itemId: "t1", ownerId: "plan", shape: "tag", points: [{ x: 15 * FT, y: 5 * FT }], tag: { elementId: "h-s1", template: "fields", leader: false, styleId: "tst-hex" } });
    const scene = buildViewScene(m, "plan").scene;
    expect(scene.primitives.filter((p) => p.kind === "line").length - before).toBe(6);
    expect(scene.primitives.some((p) => p.kind === "rect")).toBe(false);
  });
});

describe("tag styles: what they apply to", () => {
  it("a pipe-only style refuses to label an air terminal, and can't be the terminals' default", () => {
    let m = createDemoModel();
    m = run(m, { type: "create_view", viewId: "plan", name: "Plan", viewType: "floor_plan", props: { level: "L1", scale: 48 } });
    m = run(m, { type: "create_tag_style", styleId: "tst-pipe", name: "Pipe only", lines: ["{size}"], appliesTo: ["pipe"] });
    const terminal = Object.values(m.elements).find((e) => e.kind === "terminal");
    if (terminal?.kind !== "terminal") throw new Error("no terminal");
    const r = refused(m, { type: "add_drawing_item", itemId: "t1", ownerId: "plan", shape: "tag", points: [terminal.position], tag: { elementId: terminal.id, template: "mark", leader: false, styleId: "tst-pipe" } });
    expect(r.code).toBe("wrong_kind");
    expect(r.message).toMatch(/labels pipe, not air terminal/);
    expect(refused(m, { type: "update_tag_style", styleId: "tst-pipe", defaultFor: ["air_terminal"] }).message).toMatch(/only be the default for kinds it labels/);
  });
});

describe("tag style presets", () => {
  it("a trade registers a preset; the style made from it is the project's own and its name never clashes", () => {
    // Round 6: a pack's row of TAG_STYLE_PRESET_POINT, in force inside its set.
    const sizeLength = { id: "test.size_length", trade: "gas" as const, name: "Pipe size and length", description: "Size, then length.", lines: ["{pipe.size}", "{pipe.length_lf}"], appliesTo: ["pipe" as const] };
    const set = PackSet.create([definePack({ id: "test", name: "Test presets", version: "1.0.0", kernel: "^1.3.0" }, [contribute(TAG_STYLE_PRESET_POINT, [{ id: sizeLength.id, rank: 50, preset: sizeLength }])])]);
    expect(withPackSet(set, () => tagStylePresets().map((p) => p.id))).toContain("test.size_length");
    expect(tagStylePresets().map((p) => p.id)).not.toContain("test.size_length");
    expect(() => definePack({ id: "test", name: "Test presets", version: "1.0.0", kernel: "^1.3.0" }, [contribute(TAG_STYLE_PRESET_POINT, [{ id: sizeLength.id, rank: 50, preset: sizeLength }, { id: sizeLength.id, rank: 50, preset: { ...sizeLength, name: "Other" } }])])).toThrow(/contributed twice/);
    const preset = withPackSet(set, () => tagStylePreset("test.size_length"));
    if (!preset) throw new Error("not registered");
    let m = pipePlan();
    const first = createTagStyleFromPreset(preset, "tst-a", []);
    m = run(m, first);
    const second = createTagStyleFromPreset(preset, "tst-b", ["Pipe size and length"]);
    expect(second.name).toBe("Pipe size and length 2");
    m = run(m, { type: "add_drawing_item", itemId: "t1", ownerId: "plan", shape: "tag", points: [{ x: 15 * FT, y: 2 * FT }], tag: { elementId: "h-s1", template: "fields", leader: false, styleId: "tst-a" } });
    expect(tagLines(m, item(m, "t1").tag!)).toEqual(['4"', "30 LF"]);
  });

  it("every built-in preset makes a valid style command", () => {
    for (const p of tagStylePresets()) expect(() => commandSchema.parse(createTagStyleFromPreset(p, `tst-${p.id.replace(".", "-")}`, []))).not.toThrow();
  });
});

describe("smart placement of an existing tag, and what an agent reads about it", () => {
  it("a tag dropped on another is reported as overlapping, and the clear spot it moves to overlaps nothing", () => {
    let m = pipePlan();
    m = run(m, { type: "add_drawing_item", itemId: "a", ownerId: "plan", shape: "tag", points: [{ x: 15 * FT, y: 3 * FT }], tag: { elementId: "h-s1", template: "pipe_size", leader: false } });
    m = run(m, { type: "add_drawing_item", itemId: "b", ownerId: "plan", shape: "tag", points: [{ x: 15 * FT, y: 3 * FT }], tag: { elementId: "h-s1", template: "mark", leader: false } });
    const before = tagSituation(m, "plan", item(m, "b"));
    expect(before?.clear).toBe(false);
    expect(before?.overlaps.map((o) => o.itemId)).toEqual(["a"]);
    const spot = clearSpotForTag(m, "plan", "b");
    if (!spot) throw new Error("no clear spot");
    m = run(m, { type: "update_drawing_item", itemId: "b", points: [spot.at] });
    const after = tagSituation(m, "plan", item(m, "b"));
    expect(after?.overlaps).toEqual([]);
    expect(after?.clear).toBe(true);
    // Still beside its own pipe, not flung across the sheet.
    expect(after?.distanceToElementMm).toBeLessThan(20);
  });

  it("reports model lines a tag's box crosses (not its own pipe)", () => {
    let m = pipePlan();
    // Right on the vertical pipe, tagging the horizontal one.
    m = run(m, { type: "add_drawing_item", itemId: "t", ownerId: "plan", shape: "tag", points: [{ x: 50 * FT, y: 10 * FT }], tag: { elementId: "h-s1", template: "pipe_size", leader: true } });
    const s = tagSituation(m, "plan", item(m, "t"));
    expect(s?.crossesLines).toBe(1);
    expect(s?.distanceToElementMm).toBeGreaterThan(5);
  });
});

describe("movable diagram text", () => {
  function oneLine(hints: Record<string, unknown> = {}) {
    const b = referenceBuilding();
    b.ok({ type: "create_view", viewId: "v1", name: "One-line diagram", viewType: "detail", props: { diagram: { kind: "one_line", hints } } });
    return b;
  }
  const viewOf = (els: ModelState["elements"]): ViewElement => {
    const v = els.v1;
    if (v?.kind !== "view") throw new Error("no view");
    return v;
  };

  it("each block of text has a stable key, and moving one moves only it, with a leader home; it keeps reading the model", () => {
    const b = oneLine();
    const ev = evaluateDiagram(b.head.elements, viewOf(b.head.elements));
    const h1 = ev?.texts.find((t) => t.elementId === "h1" && t.key === diagramTextKey("h1", "equipment", 0));
    if (!ev || !h1) throw new Error("no H1 text");
    expect(h1.text).toBe("H1");
    const h1Box = ev.boxes.find((x) => x.elementId === "h1");

    b.ok({ type: "set_view_properties", viewId: "v1", props: { diagram: { kind: "one_line", hints: { textOffsets: { [h1.key]: { dx: 40, dy: -25 } } } } } });
    const moved = evaluateDiagram(b.head.elements, viewOf(b.head.elements));
    const after = moved?.texts.find((t) => t.key === h1.key);
    expect(after?.moved).toBe(true);
    expect(after?.min.x).toBeCloseTo(h1.min.x + 40, 1);
    expect(after?.min.y).toBeCloseTo(h1.min.y - 25, 1);
    // Nothing else moved.
    for (const t of moved?.texts ?? []) if (t.key !== h1.key) expect(ev.texts.find((x) => x.key === t.key)?.min).toEqual(t.min);
    // One thin leader back home, and the equipment's own hit box stays where the equipment is.
    expect((moved?.items.length ?? 0) - ev.items.length).toBe(1);
    expect(moved?.boxes.find((x) => x.elementId === "h1")?.max.x).toBeLessThanOrEqual(h1Box?.max.x ?? 0);

    // The text still comes from the model: bus 225 → 400 shows at the moved spot.
    b.ok({ type: "set_parameters", id: "h1", scope: "type", values: { bus_rating: 400 } });
    const live = evaluateDiagram(b.head.elements, viewOf(b.head.elements));
    const block = live?.items.find((i) => i.shape === "text" && i.note?.paragraphs.some((p) => p.runs.some((r) => r.text === "400A BUS MLO")));
    expect(block?.points[0]?.x).toBeCloseTo((h1.min.x + 40), 0);
  });

  it("no leader while the moved text still overlaps where it was (it would run through its own words)", () => {
    const b = oneLine();
    const key = diagramTextKey("h1", "equipment", 0);
    const base = evaluateDiagram(b.head.elements, viewOf(b.head.elements));
    b.ok({ type: "set_view_properties", viewId: "v1", props: { diagram: { kind: "one_line", hints: { textOffsets: { [key]: { dx: 8, dy: -2 } } } } } });
    expect(evaluateDiagram(b.head.elements, viewOf(b.head.elements))?.items.length).toBe(base?.items.length);
  });

  it("leader: false moves the text with no leader", () => {
    const b = oneLine();
    const key = diagramTextKey("h1", "equipment", 0);
    const base = evaluateDiagram(b.head.elements, viewOf(b.head.elements));
    b.ok({ type: "set_view_properties", viewId: "v1", props: { diagram: { kind: "one_line", hints: { textOffsets: { [key]: { dx: 40, dy: 0, leader: false } } } } } });
    expect(evaluateDiagram(b.head.elements, viewOf(b.head.elements))?.items.length).toBe(base?.items.length);
  });

  it("the same model and hints give the same keys and bytes", () => {
    const hints = { textOffsets: { [diagramTextKey("t1", "equipment", 0)]: { dx: 12, dy: 8 } } };
    const one = oneLine(hints);
    const two = oneLine(hints);
    const a = evaluateDiagram(one.head.elements, viewOf(one.head.elements));
    const c = evaluateDiagram(two.head.elements, viewOf(two.head.elements));
    expect(JSON.stringify(a?.items)).toBe(JSON.stringify(c?.items));
    expect(a?.texts.map((t) => t.key)).toEqual(c?.texts.map((t) => t.key));
  });
});
