/**
 * @jest-environment node
 *
 * U9: tags drag away with an elbow leader. A tag's `elbow` ("auto" or a hand
 * point) draws a level shoulder and one bend, the same size on paper at every
 * scale; tags without it draw exactly as before; "spread tags" puts piled-up
 * tags clear of each other with elbow leaders and leaves hand elbows alone.
 */
import { commandSchema, documentIndex, drawTag, executeCommand, tagItemBox, type ModelState, type Primitive, type Vec2, type ViewElement } from "../src";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { planTagSpread, tagElbowLeader } from "../src/annotation/elbow-layout";
import { SHOULDER_MM } from "../src/annotation/elbow-leader";

function run(model: ModelState, command: Record<string, unknown> & { type: string }): ModelState {
  const r = executeCommand(model, commandSchema.parse(command));
  if (!r.ok) throw new Error(r.error.message);
  return { ...r.model, revision: (model.revision + 1) as ModelState["revision"] };
}

function planModel(scale = 48): ModelState {
  return run(createDemoModel(), { type: "create_view", viewId: "plan", name: "Plan", viewType: "floor_plan", props: { level: "L1", scale } });
}

function terminals(m: ModelState) {
  return Object.values(m.elements).flatMap((e) => (e.kind === "terminal" ? [e] : []));
}

function viewOf(m: ModelState): ViewElement {
  const v = m.elements["plan"];
  if (v?.kind !== "view") throw new Error("no plan view");
  return v;
}

const item = (m: ModelState, id: string) => {
  const it = (documentIndex(m).itemsByOwner.get("plan") ?? []).find((i) => i.id === id);
  if (!it) throw new Error(`no item ${id}`);
  return it;
};

/** The tag's own primitives, drawn the way the plan draws them. */
function tagLines(m: ModelState, id: string): Array<{ a: Vec2; b: Vec2 }> {
  const view = viewOf(m);
  const s = view.props?.scale ?? 48;
  const prims: Primitive[] = [];
  drawTag({ model: m, view, toPaper: (p) => ({ x: p.x / s, y: -p.y / s }), scale: s, prims }, item(m, id));
  return prims.flatMap((p) => (p.kind === "line" ? [{ a: p.a, b: p.b }] : []));
}

function tagged(scale: number, elbow?: unknown): { m: ModelState; id: string } {
  let m = planModel(scale);
  const t = terminals(m)[0];
  if (!t) throw new Error("demo model has no terminal");
  // Head 40 paper mm right of and 25 paper mm above the terminal, whatever the scale.
  m = run(m, { type: "add_drawing_item", itemId: "tag-a", ownerId: "plan", shape: "tag", points: [{ x: t.position.x + 40 * scale, y: t.position.y + 25 * scale }], tag: { elementId: t.id, template: "mark", leader: true, ...(elbow !== undefined ? { elbow } : {}) } });
  return { m, id: "tag-a" };
}

describe("elbow leaders on tags", () => {
  it("a tag without an elbow still draws one straight leader, exactly as before", () => {
    const { m, id } = tagged(48);
    const withLeader = tagLines(m, id);
    const noLeader = tagLines(run(m, { type: "update_drawing_item", itemId: id, tag: { ...item(m, id).tag, leader: false } }), id);
    expect(withLeader.length - noLeader.length).toBe(1);
    expect(tagElbowLeader(m, viewOf(m), item(m, id))).toBeNull();
  });

  it("elbow auto draws a level shoulder off the tag, then one bend to the element, the same size on paper at 1/4 and 1/8 scale", () => {
    for (const scale of [48, 96]) {
      const { m, id } = tagged(scale, "auto");
      const leader = tagElbowLeader(m, viewOf(m), item(m, id));
      expect(leader?.points).toHaveLength(3);
      const [start, bend] = leader?.points ?? [];
      expect(start?.y).toBe(bend?.y);
      expect(Math.abs((bend?.x ?? 0) - (start?.x ?? 0))).toBeCloseTo(SHOULDER_MM, 6);
      expect(leader?.side).toBe("left");
      // The drawing has the shoulder and the run to the element as two lines.
      const lines = tagLines(m, id);
      expect(lines.some((l) => l.a.x === start?.x && l.a.y === start?.y && l.b.x === bend?.x && l.b.y === bend?.y)).toBe(true);
      expect(lines.some((l) => l.a.x === bend?.x && l.a.y === bend?.y)).toBe(true);
    }
  });

  it("a hand elbow is where the leader bends, and an update can set it on an existing tag", () => {
    let { m, id } = tagged(48);
    const t = terminals(m)[0]!;
    const hand = { x: t.position.x + 10 * 48, y: t.position.y + 25 * 48 };
    m = run(m, { type: "update_drawing_item", itemId: id, tag: { ...item(m, id).tag, elbow: hand } });
    const leader = tagElbowLeader(m, viewOf(m), item(m, id));
    expect(leader?.handElbow).toBe(true);
    expect(leader?.points[1]?.x).toBeCloseTo(hand.x / 48, 2);
    expect(leader?.points[1]?.y).toBeCloseTo(-hand.y / 48, 2);
  });

  it("spread tags puts tags piled on one spot clear of each other with elbow leaders, and leaves a hand elbow alone", () => {
    let m = planModel(48);
    const ts = Object.values(m.elements).filter((e) => (e.kind === "terminal" || e.kind === "duct_segment" || e.kind === "equipment"));
    expect(ts.length).toBeGreaterThan(4);
    const first = terminals(m)[0]!;
    const pile = { x: first.position.x, y: first.position.y };
    ts.forEach((t, i) => {
      m = run(m, { type: "add_drawing_item", itemId: `tag-${i}`, ownerId: "plan", shape: "tag", points: [pile], tag: { elementId: t.id, template: "auto", leader: false } });
    });
    m = run(m, { type: "update_drawing_item", itemId: "tag-0", tag: { ...item(m, "tag-0").tag, leader: true, elbow: { x: pile.x + 480, y: pile.y + 480 } } });
    const ids = ts.map((_, i) => `tag-${i}`);
    const plan = planTagSpread(m, "plan", [...ids, "nope"]);
    expect(plan.kept).toEqual(expect.arrayContaining([{ itemId: "tag-0", reason: "its elbow was placed by hand" }, { itemId: "nope", reason: "not a drawing item in this view" }]));
    expect(plan.updates.map((u) => u.itemId).sort()).toEqual(ids.slice(1).sort());
    m = run(m, { type: "batch_documents", label: "spread tags", commands: plan.updates.map((u) => ({ type: "update_drawing_item", itemId: u.itemId, points: [u.at], tag: u.tag })) });
    const toPaper = (p: Vec2) => ({ x: p.x / 48, y: -p.y / 48 });
    const boxes = ids.map((id) => tagItemBox(m, viewOf(m), item(m, id), toPaper)!);
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        expect({ pair: [ids[i], ids[j]], overlap: a.min.x < b.max.x && a.max.x > b.min.x && a.min.y < b.max.y && a.max.y > b.min.y }).toEqual({ pair: [ids[i], ids[j]], overlap: false });
      }
    for (const u of plan.updates) expect(item(m, u.itemId).tag?.elbow).toBe("auto");
    expect(item(m, "tag-0").points[0]?.x).toBeCloseTo(pile.x, 6);
    expect(item(m, "tag-0").points[0]?.y).toBeCloseTo(pile.y, 6);
  });
});
