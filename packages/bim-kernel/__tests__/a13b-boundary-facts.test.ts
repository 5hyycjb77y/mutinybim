/**
 * @jest-environment node
 *
 * A13b: a room made from its walls publishes what is around it. Office A
 * (west) and Store B (east) share wall W-mid with a door in it; A's west
 * wall has a 1.2 × 1.5 m window. A's facts list each edge's wall, length,
 * height, what is beyond (B's id across W-mid, outside elsewhere) and the
 * opening in it; its quantity bag carries exterior length, exterior wall
 * area net of the window, the window area, the door count and the interior
 * wall area net of the door. A requirement reads
 * `space.qto.boundary.window_area` like any other input.
 *
 * Fails on round 12's code: `spaceBoundaryFacts` refuses as not built and no
 * space has `qto.boundary.*` quantities.
 */
import { asElementId, bindRequirementsSnapshot, requirementsAt, unbindRequirementsSnapshot, type BimElement, type ElementId, type RequirementsSnapshot, type RuleRecord } from "../src";
import { isPackRefusal } from "../src/packs";
import { measuredValue } from "../src/qto/measure";
import { spaceBoundaryFacts } from "../src/spaces/boundary-facts";
import { modelWith, wall } from "./a13b-fixtures";
import { Log } from "./a13a-fixtures";

const ID = "a13b-facts";
const OFFICE = { libraryId: "test", useId: "office", name: "Office" };

const RULE: RuleRecord = {
  ruleId: "daylight",
  provider: "zz.study",
  title: "Daylight glazing",
  summary: "Glazing at least the test multiple of the window area (made up for the test).",
  discipline: "general",
  applies: { spaceUses: ["office"] },
  reads: ["space.qto.boundary.window_area"],
  produces: [{ key: "zz.glazing", anchor: "space", value: "{space.qto.boundary.window_area} * 2", unit: "m2", compare: "at_least" }],
  citation: { instrument: "Test Building Code", edition: "2024", section: "T-9.1" },
  verification: { status: "verified", by: "Test author" },
};
const STUDY: RequirementsSnapshot = { source: { id: "zz.study", label: "Test study", version: "1.0.0", contract: "^1.0.0", capabilities: { rules: true }, visibility: "firm" }, revision: "r1", rules: [RULE] };

beforeAll(() => bindRequirementsSnapshot(ID, STUDY));
afterAll(() => unbindRequirementsSnapshot(ID));

function opening(id: string, hostId: string, type: "door" | "window", offset: number, width: number, height: number, position: { x: number; y: number }): BimElement {
  return { id: asElementId(id), kind: "opening", version: 1, authoredRev: {}, partition: { level: "Level 1", zone: "A", discipline: "architecture" }, openingType: type, mark: id, hostId, offset, width, height, position } as unknown as BimElement;
}

function twoRooms(): Log {
  const m = new Log(
    modelWith(
      [
        wall("W-s1", { x: 0, y: 0 }, { x: 6000, y: 0 }),
        wall("W-s2", { x: 6000, y: 0 }, { x: 10000, y: 0 }),
        wall("W-e", { x: 10000, y: 0 }, { x: 10000, y: 4000 }),
        wall("W-n2", { x: 10000, y: 4000 }, { x: 6000, y: 4000 }),
        wall("W-n1", { x: 6000, y: 4000 }, { x: 0, y: 4000 }),
        wall("W-w", { x: 0, y: 4000 }, { x: 0, y: 0 }),
        wall("W-mid", { x: 6000, y: 0 }, { x: 6000, y: 4000 }),
        opening("WIN-1", "W-w", "window", 2000, 1200, 1500, { x: 0, y: 2000 }),
        opening("D-1", "W-mid", "door", 2000, 900, 2100, { x: 6000, y: 2000 }),
      ],
      ID,
    ),
  );
  m.ok({ type: "place_space_in_walls", spaceId: "s-a", levelId: "L1", seed: { x: 3000, y: 2000 }, number: "101", name: "Office", use: OFFICE });
  m.ok({ type: "place_space_in_walls", spaceId: "s-b", levelId: "L1", seed: { x: 8000, y: 2000 }, number: "102", name: "Store" });
  return m;
}

describe("a13b boundary facts", () => {
  it("lists each edge: its wall, length, height, what is beyond, and the opening in it", () => {
    const m = twoRooms();
    const facts = spaceBoundaryFacts(m.head, asElementId("s-a"));
    if (isPackRefusal(facts)) throw new Error(facts.refused);
    const byWall = new Map(facts.map((f) => [f.elementId as string, f]));
    expect([...byWall.keys()].sort()).toEqual(["W-mid", "W-n1", "W-s1", "W-w"]);
    expect(byWall.get("W-mid")?.otherSide).toEqual({ kind: "space", spaceId: "s-b" });
    for (const id of ["W-s1", "W-n1", "W-w"]) expect(byWall.get(id)?.otherSide).toEqual({ kind: "outside" });
    expect(byWall.get("W-s1")?.lengthMm).toBeCloseTo(5800, 6);
    expect(byWall.get("W-w")?.lengthMm).toBeCloseTo(3800, 6);
    expect(byWall.get("W-w")?.heightMm).toBe(3000);
    expect(byWall.get("W-w")?.openings.map((o) => [o.elementId, o.label, o.role])).toEqual([["WIN-1", "Window", "fill"]]);
    expect(byWall.get("W-w")?.openings[0]?.areaM2).toBeCloseTo(1.8, 6);
    expect(byWall.get("W-mid")?.openings.map((o) => o.label)).toEqual(["Door"]);
    expect(facts.every((f) => !f.virtual)).toBe(true);
  });

  it("the room's quantity bag carries the boundary quantities", () => {
    const m = twoRooms();
    const q = (key: string) => measuredValue(m.head.elements, "s-a", `qto.boundary.${key}`);
    expect(q("exterior_length")).toBeCloseTo(5.8 + 5.8 + 3.8, 6);
    expect(q("exterior_wall_area")).toBeCloseTo((5.8 + 5.8 + 3.8) * 3 - 1.8, 6);
    expect(q("window_area")).toBeCloseTo(1.8, 6);
    expect(q("door_count")).toBe(1);
    expect(q("interior_wall_area")).toBeCloseTo(3.8 * 3 - 0.9 * 2.1, 6);
    expect(q("rated_length")).toBe(0);
    const b = (key: string) => measuredValue(m.head.elements, "s-b", `qto.boundary.${key}`);
    expect(b("window_area")).toBe(0);
    expect(b("door_count")).toBe(1);
  });

  it("a requirement reads the window area like any other input", () => {
    const m = twoRooms();
    const r = requirementsAt(m.head, { kind: "space", id: "s-a" as ElementId }).find((x) => x.key === "zz.glazing");
    expect(Number(r?.value)).toBeCloseTo(3.6, 6);
  });

  it("a space that isn't bounded by walls says so in words", () => {
    const m = twoRooms();
    m.ok({ type: "create_space", spaces: [{ spaceId: "s-t", number: "900", name: "Typed" }] });
    const r = spaceBoundaryFacts(m.head, asElementId("s-t"));
    expect(isPackRefusal(r) && r.refused).toBe("Typed 900 isn't bounded by walls, so it has no wall-by-wall facts. Make it from its walls (Room from walls) to get them");
  });
});
