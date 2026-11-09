/**
 * @jest-environment node
 *
 * A13b, the product owner's decision 2 (Nov 3): splitting a room keeps the room. A
 * separation line across Office 101 makes two sub-rooms nested under it
 * (101A west, 101B east), each first-class with its own number and the same
 * use. The parent keeps its name and total area. The by-area lighting load
 * shares by each sub-room's area; the copier (a typed load) goes to the
 * sub-room the person names, and the split is refused in words until they
 * do; a receptacle placed in the west half now reads as in 101A. Load totals
 * add up the sub-rooms, never the parent and its sub-rooms twice. Schedules
 * show them nested, children only, or parents only.
 *
 * Fails on round 12's code: there is no `split_space`, no separator row, and
 * no nested sub-rooms.
 */
import { asElementId } from "../src";
import { bindModelPacks, PackSet, unbindModelPacks } from "../src/packs";
import { nestedRows } from "../src/spaces/nesting";
import { SPACES_SPLIT_NOT_YET } from "../src/spaces/space-commands";
import { spaceAreaM2 } from "../src/spaces/space-geometry";
import { spaceOf, spacesOnLevel } from "../src/spaces/space-index";
import { L1 } from "./a13b-fixtures";
import { type Policy } from "./a13a-fixtures";
import { LINE, officeWithLoads as office, space, vaOn } from "./a13b-split-fixtures";

const ID = "a13b-split";

beforeAll(() => bindModelPacks(ID, PackSet.create([])));
afterAll(() => unbindModelPacks(ID));
const officeWithLoads = () => office(ID);

describe("a13b split two spaces", () => {
  it("refuses in words until the person names who keeps the copier", () => {
    const m = officeWithLoads();
    expect(m.refused({ type: "split_space", spaceId: "s-101", line: LINE })).toBe("Office 101 carries 1 load that isn't by area. Say which sub-room keeps it: 101A or 101B");
    expect(m.refused({ type: "split_space", spaceId: "s-101", line: LINE, typedLoadsTo: "101C" })).toBe("101C isn't one of the new sub-rooms (101A or 101B)");
  });

  it("is refused in words to a peer without separators and nested spaces", () => {
    const m = officeWithLoads();
    const noNesting: Policy = (f) => f !== "spaces:nested";
    expect(m.refused({ type: "split_space", spaceId: "s-101", line: LINE, typedLoadsTo: "101A" }, noNesting)).toBe(SPACES_SPLIT_NOT_YET);
  });

  it("a line that doesn't reach both walls splits nothing", () => {
    const m = officeWithLoads();
    expect(m.refused({ type: "split_space", spaceId: "s-101", line: { start: { x: 3000, y: 500 }, end: { x: 3000, y: 2000 } }, typedLoadsTo: "101A" })).toBe("That line doesn't cross Office 101 from one side to the other. Draw it from wall to wall");
  });

  it("makes two sub-rooms under the kept parent; loads re-share; the receptacle re-homes; totals count once", () => {
    const m = officeWithLoads();
    const totalBefore = vaOn(m, "s-101");
    expect(totalBefore).toBeCloseTo(5.8 * 3.8 * 10 + 200, 6);
    expect(spaceOf(m.head.elements, asElementId("lp-recep"))?.id).toBe("s-101");

    m.ok({ type: "split_space", spaceId: "s-101", line: LINE, typedLoadsTo: "101A" });
    const parent = space(m, "s-101");
    const west = space(m, "s-101-A");
    const east = space(m, "s-101-B");
    expect([west.number, east.number]).toEqual(["101A", "101B"]);
    expect([west.parentId, east.parentId]).toEqual(["s-101", "s-101"]);
    expect([west.name, east.name, west.use?.useId, east.use?.useId]).toEqual(["Office", "Office", "office", "office"]);
    expect(spaceAreaM2(m.head.elements, parent)).toBeCloseTo(5.8 * 3.8, 6);
    expect(spaceAreaM2(m.head.elements, west)).toBeCloseTo(2.9 * 3.8, 6);
    expect(spaceAreaM2(m.head.elements, east)).toBeCloseTo(2.9 * 3.8, 6);
    expect(west.bounds.kind === "bounded" && west.bounds.boundary.some((b) => b.elementId === "s-101:line")).toBe(true);
    expect(parent.bounds.kind === "bounded" && parent.bounds.boundary.some((b) => b.elementId === "s-101:line")).toBe(false);

    expect(vaOn(m, "s-101")).toBe(0);
    expect(vaOn(m, "s-101-A")).toBeCloseTo(2.9 * 3.8 * 10 + 200, 6);
    expect(vaOn(m, "s-101-B")).toBeCloseTo(2.9 * 3.8 * 10, 6);
    expect(vaOn(m, "s-101-A") + vaOn(m, "s-101-B")).toBeCloseTo(totalBefore, 6);
    expect(m.head.elements["lp-lights"]).toBeUndefined();
    expect(spaceOf(m.head.elements, asElementId("lp-recep"))?.id).toBe("s-101-A");
  });

  it("schedules list them nested, children only, or parents only", () => {
    const m = officeWithLoads();
    m.ok({ type: "split_space", spaceId: "s-101", line: LINE, typedLoadsTo: "101B" });
    const spaces = spacesOnLevel(m.head.elements, L1);
    const rows = (d: "nested" | "children_only" | "parents_only") => nestedRows(m.head.elements, spaces, d).map((r) => `${"  ".repeat(r.depth)}${r.record.kind === "space" ? r.record.number : r.record.name}`);
    expect(rows("nested")).toEqual(["101", "  101A", "  101B"]);
    expect(rows("children_only")).toEqual(["101A", "101B"]);
    expect(rows("parents_only")).toEqual(["101"]);
  });

  it("a split room's walls still move its sub-rooms, and the parent keeps the whole outline", () => {
    const m = officeWithLoads();
    m.ok({ type: "split_space", spaceId: "s-101", line: LINE, typedLoadsTo: "101A" });
    const cs = m.ok({ type: "move_wall", wallId: "W-e", delta: { x: -1000, y: 0 } });
    // Round 16: the walls joined to W-e follow it.
    expect(cs.elements.map((e) => e.id).sort()).toEqual(["W-e", "W-n", "W-s", "s-101", "s-101-B"]);
    expect(spaceAreaM2(m.head.elements, space(m, "s-101"))).toBeCloseTo(4.8 * 3.8, 6);
    expect(spaceAreaM2(m.head.elements, space(m, "s-101-A"))).toBeCloseTo(2.9 * 3.8, 6);
    expect(spaceAreaM2(m.head.elements, space(m, "s-101-B"))).toBeCloseTo(1.9 * 3.8, 6);
  });
});
