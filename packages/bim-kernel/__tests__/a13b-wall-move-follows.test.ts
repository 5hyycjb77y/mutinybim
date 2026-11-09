/**
 * @jest-environment node
 *
 * A13b: a bounded space follows its walls. Moving a wall re-traces only the
 * bounded spaces whose outline meets the wall's old or new place, in the
 * same revision (the space is in the changeset, so undo restores both
 * exactly); an edit elsewhere re-traces nothing. The requirement anchored to
 * the space re-opens with the cause named: "Wall W-12 moved: Office 101's
 * area changed from 22 m² to 18.2 m²".
 *
 * Fails on round 12's code: there are no bounded spaces to follow, no edit
 * hook may add the spaces it rewrites, and the graph names only "wall
 * bounding Office 101 changed".
 */
import { canonicalJson, dependsOn, requirementsOf, unbindRequirementsSnapshot, type BimElement } from "../src";
import { bindModelPacks, PackSet, unbindModelPacks } from "../src/packs";
import { modelWith, wall } from "./a13b-fixtures";
import { Log } from "./a13a-fixtures";
import { bindStudy } from "./g7-fixtures";

const ID = "a13b-follow";
const OFFICE = { libraryId: "test", useId: "office", name: "Office" };

beforeAll(() => {
  bindModelPacks(ID, PackSet.create([]));
  bindStudy(ID);
});
afterAll(() => {
  unbindModelPacks(ID);
  unbindRequirementsSnapshot(ID);
});

/** Office 101 inside W-10..W-13 (6 × 4 m on centrelines), and a second room far east inside W-20..W-23. */
function floorWalls(): BimElement[] {
  return [
    wall("W-10", { x: 0, y: 0 }, { x: 6000, y: 0 }),
    wall("W-12", { x: 6000, y: 0 }, { x: 6000, y: 4000 }),
    wall("W-11", { x: 6000, y: 4000 }, { x: 0, y: 4000 }),
    wall("W-13", { x: 0, y: 4000 }, { x: 0, y: 0 }),
    wall("W-20", { x: 30000, y: 0 }, { x: 34000, y: 0 }),
    wall("W-21", { x: 34000, y: 0 }, { x: 34000, y: 4000 }),
    wall("W-22", { x: 34000, y: 4000 }, { x: 30000, y: 4000 }),
    wall("W-23", { x: 30000, y: 4000 }, { x: 30000, y: 0 }),
  ];
}

function floor(): Log {
  const m = new Log(modelWith(floorWalls(), ID));
  m.ok({ type: "place_space_in_walls", spaceId: "s-101", levelId: "L1", seed: { x: 2500, y: 2000 }, number: "101", name: "Office", use: OFFICE });
  m.ok({ type: "place_space_in_walls", spaceId: "s-201", levelId: "L1", seed: { x: 32000, y: 2000 }, number: "201", name: "Office", use: OFFICE });
  return m;
}

function bounded(m: Log, id: string) {
  const s = m.head.elements[id];
  const b = s?.kind === "space" ? s.bounds : null;
  if (b?.kind !== "bounded") throw new Error(`${id} is not bounded`);
  return b;
}

const area = (outline: readonly { x: number; y: number }[]) => Math.abs(outline.reduce((s, p, i) => s + p.x * (outline[(i + 1) % outline.length]?.y ?? 0) - (outline[(i + 1) % outline.length]?.x ?? 0) * p.y, 0)) / 2 / 1e6;

/** What a person sees: every record without its revision stamps (an undo is a new revision) or the class the first edit recognised. */
function content(elements: Readonly<Record<string, BimElement>>): string {
  const strip = (el: BimElement | undefined) => {
    if (!el) return null;
    const { version: _v, authoredRev: _a, classId: _c, classSource: _s, schemaVersion: _sv, ...rest } = el as BimElement & { classId?: unknown; classSource?: unknown; schemaVersion?: unknown };
    return rest;
  };
  return canonicalJson(Object.fromEntries(Object.keys(elements).sort().map((k) => [k, strip(elements[k])])));
}

describe("a13b wall move follows", () => {
  it("moving a wall in re-traces the room it bounds, in the same changeset, and nothing else", () => {
    const m = floor();
    expect(area(bounded(m, "s-101").outline)).toBeCloseTo(5.8 * 3.8, 6);
    const far = canonicalJson(m.head.elements["s-201"]);
    const cs = m.ok({ type: "move_wall", wallId: "W-12", delta: { x: -1000, y: 0 } });
    // Round 16: the two walls joined to W-12 follow it (joins/carry.ts), so the room stays closed.
    expect(cs.elements.map((e) => e.id).sort()).toEqual(["W-10", "W-11", "W-12", "s-101"]);
    const s = bounded(m, "s-101");
    expect(area(s.outline)).toBeCloseTo(4.8 * 3.8, 6);
    expect(Math.max(...s.outline.map((p) => p.x))).toBe(4900);
    expect(s.seed).toEqual({ x: 2500, y: 2000 });
    expect(s.open).toBeUndefined();
    expect(canonicalJson(m.head.elements["s-201"])).toBe(far);
  });

  it("undo restores the wall and the room exactly", () => {
    const m = floor();
    const before = content(m.head.elements);
    const cs = m.ok({ type: "move_wall", wallId: "W-12", delta: { x: -1000, y: 0 } });
    m.ok({ type: "undo", revision: cs.revision });
    expect(content(m.head.elements)).toBe(before);
  });

  it("an edit away from any bounded room re-traces nothing", () => {
    const m = new Log(modelWith([...floorWalls(), wall("W-90", { x: 60000, y: 0 }, { x: 64000, y: 0 })], ID));
    m.ok({ type: "place_space_in_walls", spaceId: "s-101", levelId: "L1", seed: { x: 2500, y: 2000 }, number: "101", name: "Office", use: OFFICE });
    const cs = m.ok({ type: "move_wall", wallId: "W-90", delta: { x: 0, y: 500 } });
    expect(cs.elements.map((e) => e.id)).toEqual(["W-90"]);
  });

  it("the space's requirement re-opens with the wall and the area change named", () => {
    const m = floor();
    const before = m.head;
    requirementsOf(before);
    const r = m.submit({ type: "move_wall", wallId: "W-12", delta: { x: -1000, y: 0 } });
    if (!r.ok) throw new Error(r.message);
    const answer = dependsOn(before, { changedIds: r.changeset.elements.map((e) => e.id as string), after: m.head.elements });
    const causes = answer.items.flatMap((i) => i.edges?.map((e) => e.cause) ?? []);
    expect(causes.some((c) => c.startsWith("Wall W-12 moved: Office 101's area changed from 22 m² to 18.2 m²"))).toBe(true);
    expect(answer.items.map((i) => i.label)).toContain("Occupant load in Office 101");
  });

  it("a wall of another room moves only that room", () => {
    const m = floor();
    const cs = m.ok({ type: "move_wall", wallId: "W-21", delta: { x: 200, y: 0 } });
    expect(cs.elements.map((e) => e.id).sort()).toEqual(["W-20", "W-21", "W-22", "s-201"]);
    expect(canonicalJson(m.head.elements["s-101"])).toBe(canonicalJson(floor().head.elements["s-101"]));
  });
});
