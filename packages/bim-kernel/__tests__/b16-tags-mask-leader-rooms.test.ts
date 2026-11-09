/**
 * @jest-environment node
 *
 * Batch 16-B (review video, Nov 6, items 23, 33): tags with an opaque
 * background, a leader a person can add back on a styled tag, and tags for
 * rooms and spaces.
 *
 * Fails on the code before batch 16-B: a tag spec with `mask` or
 * `leaderOverride` was refused by the strict schema, a styled tag's leader
 * could only follow its style, a tag on a room or space resolved to no point
 * and printed "?", and `room` / `space` weren't tag style kinds.
 */
import {
  DEFAULT_SETTINGS,
  TAG_STYLE_CATEGORIES,
  asElementId,
  commandSchema,
  drawTag,
  executeCommand,
  modelAnchor,
  organizationOf,
  outlineCentroid,
  tagFieldValue,
  tagHasLeader,
  tagLines,
  tagSpecSchema,
  tagStyleCategoryOf,
  withUpgradePolicy,
  type DrawingItem,
  type ModelState,
  type Primitive,
  type Room,
  type TagSpec,
} from "../src";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";

/** A peer that advertises what this release stores (the up-to-date model server). */
function run(model: ModelState, command: Record<string, unknown> & { type: string }): ModelState {
  const r = withUpgradePolicy(
    () => true,
    () => executeCommand(model, commandSchema.parse(command)),
  );
  if (!r.ok) throw new Error(r.error.message);
  return { ...r.model, revision: (model.revision + 1) as ModelState["revision"] };
}

const FT = 304.8;
const square = (x0: number, y0: number, w: number, h: number) => [
  { x: x0, y: y0 },
  { x: x0 + w, y: y0 },
  { x: x0 + w, y: y0 + h },
  { x: x0, y: y0 + h },
];

function terminalModel(): { m: ModelState; terminalId: string } {
  const m = run(createDemoModel(), { type: "create_view", viewId: "plan", name: "Plan", viewType: "floor_plan", props: { level: "L1", scale: 48 } });
  const t = Object.values(m.elements).find((e) => e.kind === "terminal");
  if (!t) throw new Error("demo model has no terminal");
  return { m, terminalId: t.id };
}

function drawn(m: ModelState, tag: TagSpec): Primitive[] {
  const item: DrawingItem = { id: asElementId("tag-x"), version: 1, authoredRev: {}, kind: "drawing_item", ownerId: asElementId("plan"), shape: "tag", points: [{ x: 1000, y: 1000 }], tag };
  const prims: Primitive[] = [];
  drawTag({ model: m, view: null, toPaper: (p) => ({ x: p.x / 48, y: -p.y / 48 }), scale: 48, prims }, item);
  return prims;
}

describe("batch 16-B tags: opaque background", () => {
  it("a masked tag lays a paper-white fill under its head before its words; an unmasked one doesn't", () => {
    const { m, terminalId } = terminalModel();
    const masked = drawn(m, { elementId: terminalId, template: "mark", leader: false, mask: true });
    const fillAt = masked.findIndex((p) => p.kind === "fill" && p.grey === 1);
    const textAt = masked.findIndex((p) => p.kind === "text");
    expect(fillAt).toBeGreaterThanOrEqual(0);
    expect(fillAt).toBeLessThan(textAt);
    const plain = drawn(m, { elementId: terminalId, template: "mark", leader: false });
    expect(plain.some((p) => p.kind === "fill")).toBe(false);
  });

  it("the stored tag spec takes mask and leaderOverride, and a tag saved with them keeps them", () => {
    expect(tagSpecSchema.safeParse({ elementId: "t", template: "mark", leader: true, mask: true, leaderOverride: false }).success).toBe(true);
    const { m, terminalId } = terminalModel();
    const after = run(m, { type: "add_drawing_item", itemId: "tag-m", ownerId: "plan", shape: "tag", points: [{ x: 0, y: 0 }], tag: { elementId: terminalId, template: "mark", leader: true, mask: true } });
    const item = after.elements["tag-m"];
    expect(item?.kind === "drawing_item" ? item.tag?.mask : undefined).toBe(true);
  });

  it("an older model server that doesn't store them is told so in words, and nothing is saved", () => {
    const { m, terminalId } = terminalModel();
    const r = withUpgradePolicy(
      () => false,
      () => executeCommand(m, commandSchema.parse({ type: "add_drawing_item", itemId: "tag-old", ownerId: "plan", shape: "tag", points: [{ x: 0, y: 0 }], tag: { elementId: terminalId, template: "mark", leader: true, mask: true } })),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/older version/);
  });
});

describe("batch 16-B tags: the leader comes back on a styled tag", () => {
  it("leaderOverride wins over the tag style's leader, both ways", () => {
    const { m: m0, terminalId } = terminalModel();
    const m = run(m0, { type: "create_tag_style", styleId: "ts-mark", name: "Mark", lines: ["{mark}"], leader: false });
    expect(organizationOf(m).tagStyleById.get("ts-mark")?.entry.leader).toBe(false);
    const styled: TagSpec = { elementId: terminalId, template: "auto", leader: true, styleId: "ts-mark" };
    expect(tagHasLeader(m, styled)).toBe(false);
    expect(tagHasLeader(m, { ...styled, leaderOverride: true })).toBe(true);
    const leadered = run(m, { type: "update_tag_style", styleId: "ts-mark", leader: true });
    expect(tagHasLeader(leadered, { ...styled, leaderOverride: false })).toBe(false);
  });
});

describe("batch 16-B tags: rooms and spaces", () => {
  const room: Room = { id: asElementId("rm-101"), version: 1, authoredRev: {}, kind: "room", number: "101", name: "Office", outline: square(0, 0, 20 * FT, 10 * FT), areaSqM: 0, partition: { level: "L1", zone: "*", discipline: "architecture" } };

  function spaceModel(): ModelState {
    let m: ModelState = { modelId: "b16-tags", revision: 0 as ModelState["revision"], elements: { [room.id]: room }, connections: [], settings: DEFAULT_SETTINGS };
    m = run(m, { type: "create_level", levelId: "lvl-1", name: "L1", elevationMm: 0 });
    m = run(m, { type: "create_space", spaces: [{ spaceId: "sp-1", number: "102", name: "Classroom", levelId: "lvl-1", outline: square(30 * FT, 0, 30 * FT, 20 * FT) }] });
    return m;
  }

  it("a room or space anchors at the middle of its floor, so its tag has somewhere to point", () => {
    const m = spaceModel();
    const r = modelAnchor(m, { elementId: "rm-101", anchor: "insertion" });
    expect(r?.x).toBeCloseTo(10 * FT, 3);
    expect(r?.y).toBeCloseTo(5 * FT, 3);
    const s = modelAnchor(m, { elementId: "sp-1", anchor: "mid" });
    expect(s?.x).toBeCloseTo(45 * FT, 3);
    expect(outlineCentroid(square(0, 0, 2, 2))).toEqual({ x: 1, y: 1 });
  });

  it("an automatic tag prints the room's or space's name over its number; style lines read {name}, {number} and {area}", () => {
    const m = spaceModel();
    expect(tagLines(m, { elementId: "rm-101", template: "auto", leader: false })).toEqual(["Office", "101"]);
    expect(tagLines(m, { elementId: "sp-1", template: "auto", leader: false })).toEqual(["Classroom", "102"]);
    const space = m.elements["sp-1"];
    if (!space) throw new Error("no space");
    expect(tagFieldValue(m, space, "area")).toBe("600 SF");
    expect(tagFieldValue(m, room, "area")).toBe("200 SF");
  });

  it("rooms and spaces are tag style kinds, so a style can be their default", () => {
    expect(TAG_STYLE_CATEGORIES).toEqual(expect.arrayContaining(["room", "space"]));
    const m = spaceModel();
    expect(tagStyleCategoryOf(m, room)).toBe("room");
    const withStyle = run(m, { type: "create_tag_style", styleId: "ts-room", name: "Room", lines: ["{name}", "{number}"], box: "box", defaultFor: ["room", "space"], appliesTo: ["room", "space"] });
    expect(organizationOf(withStyle).tagStyleById.get("ts-room")?.entry.defaultFor).toEqual(["room", "space"]);
  });
});
