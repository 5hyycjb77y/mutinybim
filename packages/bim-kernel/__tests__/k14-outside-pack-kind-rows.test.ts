/**
 * @jest-environment node
 *
 * Round 14 lane K14 (step 5): the kernel reads a network source, its
 * schedule listing and its authored fields from the kind row, so an outside
 * add-on's kind gets them with no kernel edit. A hydronic add-on's boiler
 * (a tree root with a mark a person sets) is listed by the Mechanical
 * equipment schedule under its own family words, serves a thermal zone, and
 * its mark is an authored value an edit's intent compares. Without the add-on
 * none of that applies and the record is kept as stored.
 *
 * Fails on round 13's code: the schedule listed `equipment` records by name,
 * a zone took only a part or an `equipment` record, and only the five
 * Mechanical kinds had an authored `mark` / `position`.
 */
import {
  ELEMENT_KIND_POINT,
  authoredFieldValue,
  commandSchema,
  evaluateSchedule,
  executeCommand,
  freezeElements,
  type BimElement,
  type ElementKindItem,
  type ModelState,
  type Vec2,
} from "../src";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { PackSet, contribute, definePack, PACK_CONTRACT_VERSION, withPackSet } from "../src/packs";

const isVec = (v: unknown): v is Vec2 => typeof v === "object" && v !== null && typeof Reflect.get(v, "x") === "number" && typeof Reflect.get(v, "y") === "number";

const BOILER: ElementKindItem = {
  kind: "k14hy.boiler",
  label: "Boiler",
  nature: "physical",
  shape: {
    fields: [
      { name: "mark", form: "text", authored: true },
      { name: "typeName", form: "text" },
      { name: "position", form: "point", authored: true },
    ],
  },
  connectorEnds: {
    root: true,
    ends: [{ end: "out", role: "downstream" }],
    point: (el) => {
      const p: unknown = Reflect.get(el, "position");
      return isVec(p) ? p : null;
    },
  },
  scheduleListing: "by_mark",
  scheduleCategory: "mechanical_equipment",
  scheduleFamily: "Boiler",
};

const HYDRONIC = definePack({ id: "k14hy", name: "K14 hydronic", version: "1.0.0", kernel: `^${PACK_CONTRACT_VERSION}` }, [contribute(ELEMENT_KIND_POINT, [BOILER])]);

function model(): ModelState {
  const m = createDemoModel("k14-boiler");
  const boiler = { id: "B-1", version: 1, authoredRev: {}, kind: "k14hy.boiler", mark: "B-1", typeName: "Condensing 500", position: { x: 1000, y: 1000 } } as unknown as BimElement;
  return { ...m, elements: freezeElements({ ...m.elements, [boiler.id]: boiler }) };
}

function createZone(m: ModelState): ReturnType<typeof executeCommand> {
  return executeCommand(m, commandSchema.parse({ type: "create_zone", zoneId: "Z-1", name: "Zone 1", purpose: "thermal", servedBy: "B-1" }));
}

describe("k14 outside add-on's kind reads through its row", () => {
  const m = model();
  const set = PackSet.create([HYDRONIC]);
  const def = { category: "mechanical_equipment" as const, columns: [{ field: "mark" }, { field: "family" }, { field: "type" }] };

  it("the Mechanical equipment schedule lists the boiler beside the units, in its own family words", () => {
    const without = evaluateSchedule(m, def);
    const withAddOn = withPackSet(set, () => evaluateSchedule(m, def));
    expect(without.rows.flat()).not.toContain("B-1");
    expect(without.rows.some((r) => r[1] === "Equipment")).toBe(true);
    // Sorted by mark: B-1 before RTU-1.
    expect(withAddOn.rows).toEqual([["B-1", "Boiler", "Condensing 500"], ...without.rows]);
    // The same model read again without the add-on lists what it listed before (lists are per set).
    expect(evaluateSchedule(m, def).rows).toEqual(without.rows);
  });

  it("serves a thermal zone, because its row starts a tree", () => {
    const r = withPackSet(set, () => createZone(m));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.model.elements["Z-1"]).toMatchObject({ kind: "zone", servedBy: "B-1" });
    const bare = createZone(m);
    expect(bare.ok).toBe(false);
    if (!bare.ok) expect(bare.error.message).toContain("a zone is served by equipment");
  });

  it("its mark and position are authored values; its type name is not", () => {
    const b = m.elements["B-1"];
    if (!b) throw new Error("no boiler");
    expect(withPackSet(set, () => authoredFieldValue(b, "mark"))).toBe("B-1");
    expect(withPackSet(set, () => authoredFieldValue(b, "position"))).toEqual({ x: 1000, y: 1000 });
    expect(withPackSet(set, () => authoredFieldValue(b, "typeName"))).toBeUndefined();
    expect(authoredFieldValue(b, "mark")).toBeUndefined();
    expect(m.elements["B-1"]).toMatchObject({ kind: "k14hy.boiler", mark: "B-1" });
  });
});
