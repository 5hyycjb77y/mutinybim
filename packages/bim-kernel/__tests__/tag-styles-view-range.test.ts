/**
 * @jest-environment node
 *
 * Mechanical comments, Oct 22 2026: tags as reusable named styles (one edit
 * changes every tag that uses it; a default per kind of element), the top,
 * bottom and depth of a plan applied to our own drawing, and pens for a linked
 * model's cut and beyond lines.
 */
import {
  applyReferenceDisplay,
  buildViewScene,
  commandSchema,
  documentIndex,
  executeCommand,
  organizationOf,
  planAutoTags,
  resolveReferenceDisplay,
  tagLines,
  type ModelState,
  type SheetReference,
} from "../src";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";

function run(model: ModelState, command: Record<string, unknown> & { type: string }): ModelState {
  const r = executeCommand(model, commandSchema.parse(command));
  if (!r.ok) throw new Error(r.error.message);
  return { ...r.model, revision: (model.revision + 1) as ModelState["revision"] };
}

function refused(model: ModelState, command: Record<string, unknown> & { type: string }): string {
  const r = executeCommand(model, commandSchema.parse(command));
  if (r.ok) throw new Error(`${command.type} was accepted`);
  return r.error.message;
}

const FT = 304.8;
const texts = (model: ModelState, viewId: string) => buildViewScene(model, viewId).scene.primitives.flatMap((p) => (p.kind === "text" ? [p.text] : []));
const lineCount = (model: ModelState, viewId: string) => buildViewScene(model, viewId).scene.primitives.filter((p) => p.kind === "line").length;

function planModel(): ModelState {
  let m = createDemoModel();
  m = run(m, { type: "create_view", viewId: "plan", name: "Plan", viewType: "floor_plan", props: { level: "L1", scale: 48 } });
  return m;
}

function tagEveryTerminal(m: ModelState): ModelState {
  const terminals = Object.values(m.elements).filter((e) => e.kind === "terminal");
  terminals.forEach((t, i) => {
    if (t.kind !== "terminal") return;
    m = run(m, { type: "add_drawing_item", itemId: `tag-${i}`, ownerId: "plan", shape: "tag", points: [{ x: t.position.x + 900, y: t.position.y }], tag: { elementId: t.id, template: "mark", leader: false } });
  });
  return m;
}

const tagItems = (m: ModelState) => (documentIndex(m).itemsByOwner.get("plan") ?? []).filter((i) => i.tag && !i.deleted);

describe("tag styles", () => {
  it("applying a style to many tags, then editing the style, changes every one of them", () => {
    let m = tagEveryTerminal(planModel());
    const items = tagItems(m);
    expect(items.length).toBeGreaterThan(1);
    m = run(m, { type: "create_tag_style", styleId: "tst-cfm", name: "Mark and CFM", lines: ["{mark}", "{cfm} CFM"], box: "box" });
    m = run(m, { type: "batch_documents", label: "use Mark and CFM", commands: items.map((it) => ({ type: "update_drawing_item", itemId: it.id, tag: { ...it.tag, styleId: "tst-cfm" } })) });
    for (const it of tagItems(m)) expect(tagLines(m, it.tag!)?.[1]).toMatch(/^\d+ CFM$/);
    expect(texts(m, "plan").filter((t) => / CFM$/.test(t)).length).toBe(items.length);

    m = run(m, { type: "update_tag_style", styleId: "tst-cfm", lines: ["{cfm} cfm supply"] });
    expect(texts(m, "plan").filter((t) => / cfm supply$/.test(t)).length).toBe(items.length);
    expect(texts(m, "plan").filter((t) => / CFM$/.test(t))).toHaveLength(0);
  });

  it("a style's text size and box replace the tag's own", () => {
    let m = tagEveryTerminal(planModel());
    const it = tagItems(m)[0]!;
    m = run(m, { type: "create_tag_style", styleId: "tst-big", name: "Big plain", lines: ["{mark}"], textSizeMm: 4.8, box: "none" });
    m = run(m, { type: "update_drawing_item", itemId: it.id, tag: { ...it.tag, styleId: "tst-big" } });
    const prims = buildViewScene(m, "plan").scene.primitives;
    const big = prims.filter((p) => p.kind === "text" && p.size === 4.8);
    expect(big.length).toBeGreaterThan(0);
  });

  it("a kind is the default of one style at most, and new tags of that kind take it", () => {
    let m = planModel();
    m = run(m, { type: "create_tag_style", styleId: "tst-a", name: "A", lines: ["{mark} A"], defaultFor: ["air_terminal"] });
    m = run(m, { type: "create_tag_style", styleId: "tst-b", name: "B", lines: ["{mark} B"], defaultFor: ["air_terminal", "duct"] });
    const org = organizationOf(m);
    expect(org.tagStyleById.get("tst-a")?.entry.defaultFor).toEqual([]);
    expect(org.tagStyleById.get("tst-b")?.entry.defaultFor).toEqual(["air_terminal", "duct"]);
    const plan = planAutoTags(m, "plan", { categories: ["air_terminal"], idPrefix: "at" });
    expect(plan.items.length).toBeGreaterThan(0);
    for (const item of plan.items) expect(item.tag.styleId).toBe("tst-b");
  });

  it("a style in use can't be deleted; one not in use can, and undoing its use is refused while gone", () => {
    let m = tagEveryTerminal(planModel());
    const it = tagItems(m)[0]!;
    m = run(m, { type: "create_tag_style", styleId: "tst-x", name: "X", lines: ["{mark}"] });
    m = run(m, { type: "update_drawing_item", itemId: it.id, tag: { ...it.tag, styleId: "tst-x" } });
    expect(refused(m, { type: "delete_tag_style", styleId: "tst-x" })).toMatch(/1 tag uses "X"/);
    expect(refused(m, { type: "update_drawing_item", itemId: it.id, tag: { ...it.tag, styleId: "tst-nope" } })).toMatch(/no tag style "tst-nope"/);
    expect(refused(m, { type: "create_tag_style", styleId: "tst-y", name: "x", lines: ["{mark}"] })).toMatch(/already a tag style named "X"/);
  });

  it("reads a part's own parameters, and leaves out a line whose fields are all empty", () => {
    let m = tagEveryTerminal(planModel());
    const it = tagItems(m)[0]!;
    m = run(m, { type: "create_tag_style", styleId: "tst-ins", name: "Ins", lines: ["{mark}", "{insulation}"] });
    m = run(m, { type: "update_drawing_item", itemId: it.id, tag: { ...it.tag, styleId: "tst-ins" } });
    expect(tagLines(m, tagItems(m)[0]!.tag!)).toHaveLength(1);
  });
});

describe("what a plan shows", () => {
  it("the top of the view drops our ductwork above it; clearing it brings it back", () => {
    let m = planModel();
    const all = lineCount(m, "plan");
    // The demo's ducts sit at 9 ft.
    m = run(m, { type: "set_view_properties", viewId: "plan", props: { viewTopMm: 6 * FT } });
    const capped = lineCount(m, "plan");
    expect(capped).toBeLessThan(all);
    m = run(m, { type: "set_view_properties", viewId: "plan", props: { viewTopMm: null } });
    expect(lineCount(m, "plan")).toBe(all);
    const view = m.elements.plan;
    expect(view?.kind === "view" ? view.props?.viewTopMm : "not a view").toBeUndefined();
  });

  it("refuses a top below the cut or a bottom above it, in plain words", () => {
    const m = planModel();
    expect(refused(m, { type: "set_view_properties", viewId: "plan", props: { viewTopMm: 2 * FT } })).toMatch(/top of the view must be at or above the cut height/);
    expect(refused(m, { type: "set_view_properties", viewId: "plan", props: { viewBottomMm: 6 * FT } })).toMatch(/bottom of the view must be at or below the cut height/);
  });

  it("a bottom with no depth hides what lies wholly below it; adding depth reaches it again", () => {
    let m = planModel();
    const all = lineCount(m, "plan");
    // Bottom at the cut (4 ft): the 9 ft ducts are above it and still draw; nothing is lost.
    m = run(m, { type: "set_view_properties", viewId: "plan", props: { viewBottomMm: 4 * FT, viewDepthMm: 0 } });
    expect(lineCount(m, "plan")).toBe(all);
  });
});

describe("linked model pens", () => {
  const ref: SheetReference = {
    plan: { id: "arch", source: { file: "a.ifc", sha256: "x" }, level: { name: "L1", elevationMm: 0 }, cutHeightMm: 1200, bounds: { min: { x: 0, y: 0 }, max: { x: 1, y: 1 } }, layers: [{ id: "l", discipline: "architecture", kind: "cut", category: "IFCWALL", segments: [0, 0, 1, 1] }], labels: [] },
    pen: "medium",
    tone: "ink",
    strokes: { cut: { pen: "wide", tone: "ink" }, projection: { pen: "thin", tone: "ink" } },
  };

  it("a view's cut and beyond pens replace the background's, and stay halftone", () => {
    const shown = applyReferenceDisplay(ref, resolveReferenceDisplay({ visible: true, halftone: true, cutPen: "heavy", beyondPen: "medium" }, "drawing", "architecture"));
    expect(shown?.strokes?.cut).toEqual({ pen: "heavy", tone: "halftone" });
    expect(shown?.strokes?.projection).toEqual({ pen: "medium", tone: "halftone" });
  });

  it("without pens the background keeps its own", () => {
    const shown = applyReferenceDisplay(ref, resolveReferenceDisplay(undefined, "drawing", "architecture"));
    expect(shown?.strokes?.cut?.pen).toBe("wide");
    expect(shown?.strokes?.projection?.pen).toBe("thin");
  });
});
