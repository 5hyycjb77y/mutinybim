/**
 * @jest-environment node
 *
 * Drafting annotation: dimensions that follow what they measure, tags whose
 * words come from the element, deterministic non-overlapping auto-tag, notes
 * with several leaders in plans, and the places each annotation may go.
 */
import {
  DEFAULT_DIMENSION_STYLE,
  buildViewScene,
  commandSchema,
  dimensionLabels,
  dimensionValues,
  documentIndex,
  executeCommand,
  formatLength,
  planAutoTags,
  tagHeadBox,
  tagLines,
  type ModelState,
} from "../src";
import { airflowOf } from "@permitzip/bim-pack-mechanical";
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

const texts = (model: ModelState, viewId: string) => buildViewScene(model, viewId).scene.primitives.flatMap((p) => (p.kind === "text" ? [p.text] : []));

function planModel(): ModelState {
  let m = createDemoModel();
  m = run(m, { type: "create_view", viewId: "plan", name: "Plan", viewType: "floor_plan", props: { level: "L1", scale: 48 } });
  return m;
}

const ducts = (m: ModelState) => Object.values(m.elements).filter((e) => e.kind === "duct_segment");
const terminals = (m: ModelState) => Object.values(m.elements).filter((e) => e.kind === "terminal");

describe("formatting", () => {
  it("prints feet and inches with reduced fractions, and metric", () => {
    expect(formatLength(3048, DEFAULT_DIMENSION_STYLE)).toBe(`10'-0"`);
    expect(formatLength(3048 + 25.4 * 6.5, DEFAULT_DIMENSION_STYLE)).toBe(`10'-6 1/2"`);
    expect(formatLength(25.4 * 0.375, DEFAULT_DIMENSION_STYLE)).toBe(`0'-3/8"`);
    expect(formatLength(1234.4, { ...DEFAULT_DIMENSION_STYLE, units: "mm", roundTo: 5 })).toBe("1235");
  });
});

describe("associative dimensions", () => {
  it("a dimension on a duct follows it when the equipment moves the duct", () => {
    let m = planModel();
    const duct = ducts(m)[0];
    if (duct?.kind !== "duct_segment") throw new Error("no duct");
    m = run(m, {
      type: "add_drawing_item",
      itemId: "d1",
      ownerId: "plan",
      shape: "dimension",
      points: [duct.start, duct.end],
      dim: { kind: "aligned", refs: [{ elementId: duct.id, anchor: "start" }, { elementId: duct.id, anchor: "end" }], offsetMm: 8 },
    });
    const item = documentIndex(m).itemsByOwner.get("plan")?.find((i) => i.id === "d1");
    const view = m.elements.plan;
    if (!item || view?.kind !== "view") throw new Error("no dimension");
    const before = dimensionValues(m, view, item)[0];
    expect(before).toBeCloseTo(Math.hypot(duct.end.x - duct.start.x, duct.end.y - duct.start.y), 3);
    expect(texts(m, "plan")).toContain(dimensionLabels(m, view, item)[0]);
    const eq = Object.values(m.elements).find((e) => e.kind === "equipment");
    if (!eq) throw new Error("no equipment");
    m = run(m, { type: "move_equipment", equipmentId: eq.id, delta: { x: -600, y: 0 } });
    const moved = m.elements[duct.id];
    if (moved?.kind !== "duct_segment") throw new Error("duct gone");
    const after = dimensionValues(m, view, item)[0];
    expect(after).toBeCloseTo(Math.hypot(moved.end.x - moved.start.x, moved.end.y - moved.start.y), 3);
    if (moved.start.x !== duct.start.x || moved.end.x !== duct.end.x) expect(after).not.toBeCloseTo(before ?? 0, 3);
  });

  it("in a detail view a dimension follows a detail line's points", () => {
    let m = createDemoModel();
    m = run(m, { type: "create_view", viewId: "det", name: "Detail", viewType: "detail" });
    m = run(m, { type: "add_drawing_item", itemId: "l1", ownerId: "det", shape: "line", points: [{ x: 0, y: 0 }, { x: 1000, y: 0 }] });
    m = run(m, { type: "add_drawing_item", itemId: "dim", ownerId: "det", shape: "dimension", points: [{ x: 0, y: 0 }, { x: 1000, y: 0 }], dim: { kind: "linear", direction: "horizontal", refs: [{ elementId: "l1", anchor: "start" }, { elementId: "l1", anchor: "end" }], offsetMm: 6 } });
    m = run(m, { type: "update_drawing_item", itemId: "l1", points: [{ x: 0, y: 0 }, { x: 1219.2, y: 0 }] });
    const view = m.elements.det;
    const item = m.elements.dim;
    if (view?.kind !== "view" || item?.kind !== "drawing_item") throw new Error("missing");
    expect(dimensionLabels(m, view, item)).toEqual([`4'-0"`]);
    expect(texts(m, "det")).toContain(`4'-0"`);
  });

  it("chains: continuous measures each gap, baseline each from the first; angular and radial", () => {
    let m = createDemoModel();
    m = run(m, { type: "create_view", viewId: "det", name: "Detail", viewType: "detail" });
    const pts = [{ x: 0, y: 0 }, { x: 304.8, y: 0 }, { x: 914.4, y: 0 }];
    m = run(m, { type: "add_drawing_item", itemId: "c", ownerId: "det", shape: "dimension", points: pts, dim: { kind: "linear", direction: "horizontal", chain: "continuous", offsetMm: 6 } });
    m = run(m, { type: "add_drawing_item", itemId: "b", ownerId: "det", shape: "dimension", points: pts, dim: { kind: "linear", direction: "horizontal", chain: "baseline", offsetMm: 6 } });
    m = run(m, { type: "add_drawing_item", itemId: "a", ownerId: "det", shape: "dimension", points: [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 0, y: 1000 }], dim: { kind: "angular", offsetMm: 10 } });
    m = run(m, { type: "add_drawing_item", itemId: "r", ownerId: "det", shape: "dimension", points: [{ x: 0, y: 0 }, { x: 152.4, y: 0 }], dim: { kind: "diameter", offsetMm: 0, style: { units: "in", roundTo: 0.5 } } });
    const view = m.elements.det;
    if (view?.kind !== "view") throw new Error("no view");
    const item = (id: string) => {
      const el = m.elements[id];
      if (el?.kind !== "drawing_item") throw new Error(id);
      return el;
    };
    expect(dimensionLabels(m, view, item("c"))).toEqual([`1'-0"`, `2'-0"`]);
    expect(dimensionLabels(m, view, item("b"))).toEqual([`1'-0"`, `3'-0"`]);
    expect(dimensionLabels(m, view, item("a"))).toEqual(["90°"]);
    expect(dimensionLabels(m, view, item("r"))).toEqual([`Ø 12"`]);
  });

  it("text override, prefix and suffix print in place of or around the value", () => {
    let m = createDemoModel();
    m = run(m, { type: "create_view", viewId: "det", name: "Detail", viewType: "detail" });
    m = run(m, { type: "add_drawing_item", itemId: "o", ownerId: "det", shape: "dimension", points: [{ x: 0, y: 0 }, { x: 609.6, y: 0 }], dim: { kind: "aligned", offsetMm: 6, prefix: "MIN. ", suffix: " CLR" } });
    expect(texts(m, "det")).toContain(`MIN. 2'-0" CLR`);
  });

  it("spot elevation of a duct in a plan reads its height", () => {
    let m = planModel();
    const duct = ducts(m)[0];
    if (!duct) throw new Error("no duct");
    m = run(m, { type: "add_drawing_item", itemId: "se", ownerId: "plan", shape: "dimension", points: [{ x: 0, y: 0 }, { x: 500, y: 500 }], dim: { kind: "spot_elevation", refs: [{ elementId: duct.id, anchor: "mid" }], offsetMm: 0 } });
    expect(texts(m, "plan").some((t) => t.startsWith("EL. +9'-0"))).toBe(true);
  });
});

describe("tags", () => {
  it("say what the element says, and change when it does", () => {
    let m = planModel();
    const t = terminals(m)[0];
    if (t?.kind !== "terminal") throw new Error("no terminal");
    expect(tagLines(m, { elementId: t.id, template: "auto", leader: false })).toEqual([t.mark, `${Math.round(airflowOf(t) ?? 0)} CFM`]);
    m = run(m, { type: "add_drawing_item", itemId: "tg", ownerId: "plan", shape: "tag", points: [{ x: t.position.x + 600, y: t.position.y }], tag: { elementId: t.id, template: "air_terminal", leader: true } });
    m = run(m, { type: "set_terminal_cfm", terminalId: t.id, cfm: 333 });
    expect(texts(m, "plan")).toEqual(expect.arrayContaining([t.mark, "333 CFM"]));
  });

  it("go only in plans and sections, and only on model elements", () => {
    let m = planModel();
    m = run(m, { type: "create_sheet", sheetId: "s", number: "M-101", name: "Plan" });
    const t = terminals(m)[0];
    if (!t) throw new Error("no terminal");
    expect(refused(m, { type: "add_drawing_item", itemId: "x", ownerId: "s", shape: "tag", points: [{ x: 10, y: 10 }], tag: { elementId: t.id, template: "auto", leader: false } })).toMatch(/plan or a section/);
    expect(refused(m, { type: "add_drawing_item", itemId: "x", ownerId: "plan", shape: "tag", points: [{ x: 10, y: 10 }], tag: { elementId: "plan", template: "auto", leader: false } })).toMatch(/model elements/);
    expect(refused(m, { type: "add_drawing_item", itemId: "x", ownerId: "plan", shape: "tag", points: [{ x: 10, y: 10 }], tag: { elementId: "gone", template: "auto", leader: false } })).toMatch(/doesn't exist/);
    expect(refused(m, { type: "add_drawing_item", itemId: "x", ownerId: "s", shape: "dimension", points: [{ x: 0, y: 0 }, { x: 50, y: 0 }], dim: { kind: "aligned", offsetMm: 5 } })).toMatch(/measure a view/);
  });
});

describe("auto-tag", () => {
  it("tags every duct and terminal once, the same way every time, with no two tags overlapping", () => {
    const m = planModel();
    const opts = { categories: ["duct", "air_terminal", "equipment"] as const, idPrefix: "at", minRunPaperMm: 4 };
    const a = planAutoTags(m, "plan", opts);
    expect(planAutoTags(m, "plan", opts)).toEqual(a);
    expect(a.items.length + a.skipped.length).toBe(ducts(m).length + terminals(m).length + 1);
    const boxes = a.items.map((it) => {
      const lines = tagLines(m, it.tag) ?? [];
      return tagHeadBox(it.itemId, lines, { x: it.at.x / 48, y: -it.at.y / 48 }, 2.4);
    });
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const p = boxes[i];
        const q = boxes[j];
        if (!p || !q) continue;
        expect(p.max.x <= q.min.x || q.max.x <= p.min.x || p.max.y <= q.min.y || q.max.y <= p.min.y).toBe(true);
      }
    let tagged = m;
    tagged = run(tagged, { type: "batch_documents", commands: a.items.map((it) => ({ type: "add_drawing_item", itemId: it.itemId, ownerId: "plan", shape: "tag", points: [it.at], tag: it.tag })) });
    const again = planAutoTags(tagged, "plan", { ...opts, idPrefix: "at2" });
    expect(again.items).toEqual([]);
    expect(again.alreadyTagged).toBe(a.items.length);
  });
});

describe("notes in plans", () => {
  it("a plan takes a rich note with several leaders, one elbowed with a dot", () => {
    let m = planModel();
    m = run(m, {
      type: "create_text_note",
      itemId: "n",
      ownerId: "plan",
      at: { x: 1000, y: 3000 },
      width: 40,
      paragraphs: [{ runs: [{ text: "SEAL ALL JOINTS" }] }],
      leaders: [{ to: { x: 0, y: 0 } }, { to: { x: 2000, y: 0 }, elbow: { x: 1500, y: 1500 }, arrow: "dot" }],
    });
    const note = m.elements.n;
    if (note?.kind !== "drawing_item") throw new Error("no note");
    expect(note.note?.leader).toEqual({ to: { x: 0, y: 0 } });
    expect(note.note?.leaders).toEqual([{ to: { x: 2000, y: 0 }, elbow: { x: 1500, y: 1500 }, arrow: "dot" }]);
    const { scene } = buildViewScene(m, "plan");
    expect(scene.textBlocks?.some((b) => b.itemId === "n")).toBe(true);
    m = run(m, { type: "move_text_note", itemId: "n", leaders: [] });
    const cleared = m.elements.n;
    expect(cleared?.kind === "drawing_item" && cleared.note?.leader).toBeFalsy();
  });
});
