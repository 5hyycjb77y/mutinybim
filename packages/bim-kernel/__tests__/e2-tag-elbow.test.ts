/**
 * @jest-environment node
 *
 * U9 tag elbow leaders, the kernel half of what r2-typicals left (patches 2
 * and 3): auto-tag gives every new tag that has a leader an elbow leader, and
 * an elbow placed by hand travels with its tag when the tag is moved or
 * copied.
 *
 * Before: auto-tag's leader tags had no `elbow` (a straight leader), a moved
 * tag left its hand elbow where it was (the leader bent back to the old spot)
 * and a copy pointed its elbow at the original's.
 */
import { commandSchema, documentIndex, executeCommand, paperMapping, planAutoTags, type ModelState, type Vec2 } from "../src";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { planTagSpread } from "../src/annotation/elbow-layout";

function run(model: ModelState, command: Record<string, unknown> & { type: string }): ModelState {
  const r = executeCommand(model, commandSchema.parse(command));
  if (!r.ok) throw new Error(r.error.message);
  return { ...r.model, revision: (model.revision + 1) as ModelState["revision"] };
}

function planModel(): ModelState {
  return run(createDemoModel(), { type: "create_view", viewId: "plan", name: "Plan", viewType: "floor_plan", props: { level: "L1", scale: 48 } });
}

const item = (m: ModelState, owner: string, id: string) => {
  const it = (documentIndex(m).itemsByOwner.get(owner) ?? []).find((i) => i.id === id);
  if (!it) throw new Error(`no item ${id}`);
  return it;
};

function expectNear(got: Vec2 | "auto" | undefined, want: Vec2): void {
  if (got === undefined || got === "auto") throw new Error(`expected a hand elbow, got ${String(got)}`);
  expect(got.x).toBeCloseTo(want.x, 6);
  expect(got.y).toBeCloseTo(want.y, 6);
}

function handTagged(): { m: ModelState; elbow: Vec2; head: Vec2 } {
  const m0 = planModel();
  const t = Object.values(m0.elements).find((e) => e.kind === "terminal");
  if (t?.kind !== "terminal") throw new Error("demo model has no terminal");
  const head = { x: t.position.x + 2000, y: t.position.y + 1200 };
  const elbow = { x: t.position.x + 1500, y: t.position.y + 1200 };
  const m = run(m0, { type: "add_drawing_item", itemId: "tag-a", ownerId: "plan", shape: "tag", points: [head], tag: { elementId: t.id, template: "mark", leader: true, elbow } });
  return { m, elbow, head };
}

describe("U9: elbow leaders from auto-tag, and hand elbows that travel with their tag", () => {
  it("auto-tag gives each new tag with a leader an elbow leader; tags without a leader get none", () => {
    const plan = planAutoTags(planModel(), "plan", { categories: ["duct", "air_terminal", "equipment"], idPrefix: "at", minRunPaperMm: 4, leader: "always" });
    expect(plan.items.length).toBeGreaterThan(0);
    for (const it of plan.items) expect(it.tag).toMatchObject({ leader: true, elbow: "auto" });
    const none = planAutoTags(planModel(), "plan", { categories: ["duct", "air_terminal", "equipment"], idPrefix: "at", minRunPaperMm: 4, leader: "never" });
    for (const it of none.items) expect(it.tag.elbow).toBeUndefined();
  });

  it("moving a tag's head carries its hand elbow by the same amount; a move that sets the tag keeps what it says", () => {
    const { m, elbow, head } = handTagged();
    const moved = run(m, { type: "update_drawing_item", itemId: "tag-a", points: [{ x: head.x + 300, y: head.y - 600 }] });
    expectNear(item(moved, "plan", "tag-a").tag?.elbow, { x: elbow.x + 300, y: elbow.y - 600 });
    const straightened = run(m, { type: "update_drawing_item", itemId: "tag-a", points: [{ x: head.x + 300, y: head.y }], tag: { ...item(m, "plan", "tag-a").tag, elbow: "auto" } });
    expect(item(straightened, "plan", "tag-a").tag?.elbow).toBe("auto");
  });

  it("a copied tag's hand elbow moves with the copy", () => {
    const { m, elbow } = handTagged();
    const copied = run(m, { type: "copy_drawing_items", itemIds: ["tag-a"], toOwnerId: "plan", idPrefix: "cp", offset: { x: 4000, y: 0 } });
    expectNear(item(copied, "plan", "cp-tag-a").tag?.elbow, { x: elbow.x + 4000, y: elbow.y });
    expect(item(copied, "plan", "tag-a").tag?.elbow).toEqual(elbow);
  });

  it("paperMapping is the one view-to-paper mapping Spread tags and auto-tag share", () => {
    const { m } = handTagged();
    const view = m.elements.plan;
    if (view?.kind !== "view") throw new Error("plan");
    expect(paperMapping(view).toPaper({ x: 480, y: 960 })).toEqual({ x: 10, y: -20 });
    // Spread tags leaves the hand elbow alone and says why.
    const spread = planTagSpread(m, "plan", ["tag-a"]);
    expect(spread.updates).toEqual([]);
    expect(spread.kept.map((k) => k.itemId)).toEqual(["tag-a"]);
  });
});
