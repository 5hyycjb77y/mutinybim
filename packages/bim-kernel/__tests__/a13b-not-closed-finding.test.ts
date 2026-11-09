/**
 * @jest-environment node
 *
 * A13b: when an edit leaves a bounded space's seed in no closed region (its
 * east wall dragged past the corners, or removed), the space keeps its last
 * outline, says where it opened, and the one problems list carries "Office
 * 101 is no longer closed: a wall was moved or removed near the east side"
 * with the space and the wall as subjects (Select) and Undo as the fix.
 * Closing the walls again clears it.
 *
 * Fails on round 12's code: there are no bounded spaces and no source of
 * "no longer closed" findings.
 */
import { canonicalJson, type BimElement } from "../src";
import { FindingLedger } from "../src/findings/api";
import { bindModelPacks, PackSet, unbindModelPacks } from "../src/packs";
import { modelWith, wall } from "./a13b-fixtures";
import { Log } from "./a13a-fixtures";

const ID = "a13b-open";

beforeAll(() => bindModelPacks(ID, PackSet.create([])));
afterAll(() => unbindModelPacks(ID));

function office(): Log {
  const walls: BimElement[] = [
    wall("W-10", { x: 0, y: 0 }, { x: 6000, y: 0 }),
    wall("W-12", { x: 6000, y: 0 }, { x: 6000, y: 4000 }),
    wall("W-11", { x: 6000, y: 4000 }, { x: 0, y: 4000 }),
    wall("W-13", { x: 0, y: 4000 }, { x: 0, y: 0 }),
  ];
  const m = new Log(modelWith(walls, ID));
  m.ok({ type: "place_space_in_walls", spaceId: "s-101", levelId: "L1", seed: { x: 2500, y: 2000 }, number: "101", name: "Office" });
  return m;
}

function space(m: Log) {
  const s = m.head.elements["s-101"];
  if (s?.kind !== "space" || s.bounds.kind !== "bounded") throw new Error("not bounded");
  return s.bounds;
}

const WORDS = "Office 101 is no longer closed: a wall was moved or removed near the east side";

/** What a person sees: every record without its revision stamps (an undo is a new revision) or the class the first edit recognised. */
function content(elements: Readonly<Record<string, BimElement>>): string {
  const strip = (el: BimElement | undefined) => {
    if (!el) return null;
    const { version: _v, authoredRev: _a, classId: _c, classSource: _s, schemaVersion: _sv, ...rest } = el as BimElement & { classId?: unknown; classSource?: unknown; schemaVersion?: unknown };
    return rest;
  };
  return canonicalJson(Object.fromEntries(Object.keys(elements).sort().map((k) => [k, strip(elements[k])])));
}

describe("a13b not closed finding", () => {
  // Round 16: a moved wall carries the walls joined to it, so pulling one off its corners takes Disjoin (as in Revit).
  it("dragging the east wall past the corners keeps the outline and posts the finding with Select and Undo", () => {
    const m = office();
    const ledger = new FindingLedger();
    ledger.open(m.head);
    const outline = canonicalJson(space(m).outline);
    const cs = m.ok({ type: "move_wall", wallId: "W-12", delta: { x: 1000, y: 0 }, disjoin: true });
    expect(cs.elements.map((e) => e.id).sort()).toEqual(["W-12", "s-101"]);
    expect(canonicalJson(space(m).outline)).toBe(outline);
    expect(space(m).open?.elementId).toBe("W-12");
    ledger.apply(m.head, cs.elements.map((e) => e.id as string));
    const found = ledger.findings().filter((f) => f.source.kind === "space_not_closed");
    expect(found.map((f) => [f.words, f.subjects, f.fix?.commandHint, f.severity])).toEqual([[WORDS, ["W-12", "s-101"], "undo", "warning"]]);
  });

  it("a second edit that leaves it open writes nothing more; closing it again clears the finding", () => {
    const m = office();
    m.ok({ type: "move_wall", wallId: "W-12", delta: { x: 1000, y: 0 }, disjoin: true });
    const again = m.ok({ type: "move_wall", wallId: "W-12", delta: { x: 500, y: 0 }, disjoin: true });
    expect(again.elements.map((e) => e.id)).toEqual(["W-12"]);
    const ledger = new FindingLedger();
    ledger.open(m.head);
    expect(ledger.findings().some((f) => f.source.kind === "space_not_closed")).toBe(true);
    const back = m.ok({ type: "move_wall", wallId: "W-12", delta: { x: -1500, y: 0 } });
    expect(back.elements.map((e) => e.id).sort()).toEqual(["W-12", "s-101"]);
    expect(space(m).open).toBeUndefined();
    ledger.apply(m.head, back.elements.map((e) => e.id as string));
    expect(ledger.findings().some((f) => f.source.kind === "space_not_closed")).toBe(false);
  });

  it("undo of the move takes the space back to closed exactly", () => {
    const m = office();
    const before = content(m.head.elements);
    const cs = m.ok({ type: "move_wall", wallId: "W-12", delta: { x: 1000, y: 0 }, disjoin: true });
    m.ok({ type: "undo", revision: cs.revision });
    expect(content(m.head.elements)).toBe(before);
  });
});
