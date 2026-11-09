/**
 * @jest-environment node
 *
 * A13b: a click inside four walls makes a bounded space of the right area
 * (Product decision, Nov 3, decision 1: the space is the room). The outline is the
 * walls' inner faces, found by a local face walk over the boundary index;
 * a click in no closed region is refused in words naming the gap.
 *
 * Fails on round 12's code: there is no `place_space_in_walls` command, no
 * bounded bounds writer, and `boundarySegmentsOnLevel` refuses as not built.
 */
import { executeSpaceDesignCommand, SPACES_BOUNDED_NOT_YET } from "../src/spaces/space-commands";
import { boundarySegmentsOnLevel } from "../src/spaces/boundaries/point";
import { boundaryIndexStats } from "../src/spaces/boundaries/boundary-index";
import { roomAt } from "../src/spaces/boundaries/room-at";
import { spaceAreaM2 } from "../src/spaces/space-geometry";
import { spaceAt } from "../src/spaces/space-index";
import { SPACES_BOUNDED_FEATURE } from "../src/spaces/boundary-facts";
import { carryRevision, withUpgradePolicy, type BimElement, type ModelState } from "../src";
import { withPackSet } from "../src/packs";
import { box, L1, L2, modelWith, wall, BUILTINS } from "./a13b-fixtures";

const peerReads = <T>(fn: () => T): T => withUpgradePolicy((f) => f === SPACES_BOUNDED_FEATURE, fn);
const run = <T>(fn: () => T): T => withPackSet(BUILTINS, () => peerReads(fn));

describe("a13b place a space in walls", () => {
  it("four walls make a bounded space of the inside area, its edges named by wall", () => {
    const m = modelWith(box("w", 0, 0, 6000, 4000));
    const r = run(() => executeSpaceDesignCommand(m, { type: "place_space_in_walls", spaceId: "s-101", levelId: "L1", seed: { x: 2500, y: 1500 }, number: "101", name: "Office" }));
    if (!r.ok) throw new Error(r.error.message);
    const s = r.model.elements["s-101"];
    if (s?.kind !== "space" || s.bounds.kind !== "bounded") throw new Error("no bounded space");
    expect(spaceAreaM2(r.model.elements, s)).toBeCloseTo(5.8 * 3.8, 6);
    expect(s.bounds.seed).toEqual({ x: 2500, y: 1500 });
    expect(s.bounds.outline).toHaveLength(4);
    expect(s.bounds.boundary.map((b) => b.elementId).sort()).toEqual(["w-e", "w-n", "w-s", "w-w"]);
    expect(s.levelId).toBe(L1);
    expect(r.summary?.[0]).toMatch(/^Made space 101 Office from the walls around it \(\d+ sq ft\)$/);
    expect(spaceAt(r.model.elements, L1, { x: 2500, y: 1500 })?.id).toBe("s-101");
  });

  it("a wall across the room makes two rooms; a click in each finds its own", () => {
    const m = modelWith([...box("w", 0, 0, 6000, 4000), wall("w-mid", { x: 3000, y: 0 }, { x: 3000, y: 4000 })]);
    const west = run(() => roomAt(m.elements, L1, { x: 1000, y: 2000 }));
    const east = run(() => roomAt(m.elements, L1, { x: 5000, y: 2000 }));
    if (!west.ok || !east.ok) throw new Error("not closed");
    const area = (o: readonly { x: number; y: number }[]) => Math.abs(o.reduce((s, p, i) => s + p.x * (o[(i + 1) % o.length]?.y ?? 0) - (o[(i + 1) % o.length]?.x ?? 0) * p.y, 0)) / 2 / 1e6;
    expect(area(west.outline)).toBeCloseTo(2.8 * 3.8, 6);
    expect(area(east.outline)).toBeCloseTo(2.8 * 3.8, 6);
    expect(west.boundary.map((b) => b.elementId)).toContain("w-mid");
  });

  it("a click where the walls leave a gap is refused in words, naming the wall", () => {
    const walls = box("w", 0, 0, 6000, 4000).filter((w) => w.id !== "w-n");
    const m = modelWith(walls);
    const r = run(() => executeSpaceDesignCommand(m, { type: "place_space_in_walls", spaceId: "s-1", levelId: "L1", seed: { x: 2500, y: 1500 } }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/^No closed room here: the walls leave a gap near the end of wall w-[ew]\. Close the gap, or draw the room's outline instead$/);
    expect(r.error.elementIds?.length).toBe(1);
  });

  it("a level with nothing bounding says so; walls on another level don't bound this one", () => {
    const m = modelWith(box("w", 0, 0, 6000, 4000));
    const r = run(() => executeSpaceDesignCommand(m, { type: "place_space_in_walls", spaceId: "s-1", levelId: "L2", seed: { x: 2500, y: 1500 } }));
    expect(!r.ok && r.error.message).toMatch(/nothing on this level bounds rooms yet/);
    expect(run(() => boundarySegmentsOnLevel(m, L2))).toEqual([]);
    expect(run(() => boundarySegmentsOnLevel(m, L1))).toHaveLength(8);
  });

  it("a second click in the same room is refused; a retried id is refused", () => {
    const m = modelWith(box("w", 0, 0, 6000, 4000));
    const made = run(() => executeSpaceDesignCommand(m, { type: "place_space_in_walls", spaceId: "s-1", levelId: "L1", seed: { x: 2500, y: 1500 }, name: "Office" }));
    if (!made.ok) throw new Error(made.error.message);
    const again = run(() => executeSpaceDesignCommand(made.model, { type: "place_space_in_walls", spaceId: "s-2", levelId: "L1", seed: { x: 1000, y: 1000 } }));
    expect(!again.ok && again.error.message).toBe("Office already fills this room");
    const retry = run(() => executeSpaceDesignCommand(made.model, { type: "place_space_in_walls", spaceId: "s-1", levelId: "L1", seed: { x: 1000, y: 1000 } }));
    expect(!retry.ok && retry.error.code).toBe("already_exists");
  });

  it("is refused in words to a peer that doesn't store bounded spaces", () => {
    const m = modelWith(box("w", 0, 0, 6000, 4000));
    const r = withPackSet(BUILTINS, () => executeSpaceDesignCommand(m, { type: "place_space_in_walls", spaceId: "s-1", levelId: "L1", seed: { x: 2500, y: 1500 } }));
    expect(!r.ok && r.error.message).toBe(SPACES_BOUNDED_NOT_YET);
  });

  it("the index reads a level once, then follows wall edits by changed ids", () => {
    const m = modelWith(box("w", 0, 0, 6000, 4000), "a13b-carry");
    run(() => roomAt(m.elements, L1, { x: 2500, y: 1500 }));
    expect(run(() => boundaryIndexStats(m.elements)).levelBuilds).toBe(1);
    const moved: BimElement = { ...(m.elements["w-e"] as BimElement), start: { x: 7000, y: 0 }, end: { x: 7000, y: 4000 } } as BimElement;
    const sMoved: BimElement = { ...(m.elements["w-s"] as BimElement), end: { x: 7000, y: 0 } } as BimElement;
    const nMoved: BimElement = { ...(m.elements["w-n"] as BimElement), start: { x: 7000, y: 4000 } } as BimElement;
    const next: ModelState = { ...m, elements: { ...m.elements, "w-e": moved, "w-s": sMoved, "w-n": nMoved } };
    run(() => carryRevision(m.elements, next.elements, ["w-e", "w-s", "w-n"]));
    const found = run(() => roomAt(next.elements, L1, { x: 2500, y: 1500 }));
    if (!found.ok) throw new Error("not closed");
    const stats = run(() => boundaryIndexStats(next.elements));
    expect(stats).toEqual({ levelBuilds: 1, advances: 1 });
    const xs = found.outline.map((p) => p.x);
    expect(Math.max(...xs)).toBeCloseTo(6900, 6);
  });
});
