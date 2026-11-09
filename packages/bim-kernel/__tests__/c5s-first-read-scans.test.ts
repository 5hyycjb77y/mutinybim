/**
 * @jest-environment node
 *
 * Round 5c f-scale (audit §4, M): two first reads after an edit that walked
 * every element now read the kind index: the v1 schedule category bags
 * (`schedules/schedule.ts`, one category listed when a schedule of it is
 * read) and the electrical engine's distribution list
 * (`connections/electrical/engine.ts`, part types and parts only). Each lists
 * exactly what the one-pass reads listed, in the same order.
 *
 * Fails on the old code: both called `elementValues` over the whole model.
 */
import * as store from "../src/store";
import { builtinPartType, evaluateSchedule, executeCommand, type BimElement, type Command, type ModelState, type ScheduleCategory } from "../src";
import { createFullBimModel, FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";
import { distributionOf, CONNECTED_LOAD_ONLY, ElectricalLoadEngine } from "@permitzip/bim-pack-electrical";

jest.mock("../src/store", () => {
  const actual: typeof import("../src/store") = jest.requireActual("../src/store");
  return { ...actual, elementValues: jest.fn(actual.elementValues) };
});
const elementValuesSpy = store.elementValues as jest.MockedFunction<typeof store.elementValues>;

function run(m: ModelState, c: Command): ModelState {
  const r = executeCommand(m, c);
  if (!r.ok) throw new Error(`${c.type}: ${r.error.message}`);
  return r.model;
}

function model(): ModelState {
  const types = ["builtin:rtu-5-ton@1", "builtin:panelboard-225-480@1", "builtin:switchboard-800-480@1", "builtin:transformer-75kva@1"].map((id) => {
    const t = builtinPartType(id);
    if (!t) throw new Error(`starter library is missing ${id}`);
    return t;
  });
  let m = createFullBimModel({ ...FULL_BIM_TIERS.XS, modelId: "c5s-first-reads" });
  m = { ...m, elements: store.freezeElements(m.elements) };
  m = run(m, { type: "create_level", levelId: "lvl-1", name: "L01", elevationMm: 0 });
  for (let i = 0; i < 16; i++) {
    const t = types[i % types.length];
    if (!t) continue;
    m = run(m, { type: "place_part", partId: `p-${i}`, typeId: t.id, ...(i < types.length ? { partType: t.definition } : {}), levelId: "lvl-1", position: { x: i * 4000, y: 0 }, offsetMm: 0, mark: `P-${i}` });
  }
  return m;
}

/** The old one-pass bag: each category's own kinds in model order, then its parts in model order. */
function oldBag(m: ModelState, c: ScheduleCategory): string[] {
  const own: BimElement[] = [];
  const parts: BimElement[] = [];
  for (const el of store.elementValues(m.elements)) {
    if (el.kind === "part") {
      const type = m.elements[el.typeId];
      if (type?.kind === "part_type" && type.definition.category === c) parts.push(el);
    } else if ((c === "mechanical_equipment" && el.kind === "equipment") || (c === "air_terminal" && el.kind === "terminal") || (c === "sheet_list" && el.kind === "sheet" && !el.deleted) || (el.kind === "run_segment" && el.domain === c)) own.push(el);
  }
  return [...own, ...parts].map((el) => el.id);
}

describe("c5s first reads from the kind index", () => {
  it("v1 schedules list the same elements per category as the one-pass bag, without a pass over the model", () => {
    const m = model();
    const categories: ScheduleCategory[] = ["mechanical_equipment", "air_terminal", "sheet_list", "duct", "pipe", "electrical_equipment"];
    const expected = categories.map((c) => oldBag(m, c));
    elementValuesSpy.mockClear();
    const got = categories.map((c) => evaluateSchedule(m, { category: c, columns: [{ field: "mark" }], itemize: true }).elementIds.flat());
    expect(elementValuesSpy).not.toHaveBeenCalled();
    categories.forEach((c, i) => expect({ c, ids: [...(got[i] ?? [])].sort() }).toEqual({ c, ids: [...(expected[i] ?? [])].sort() }));
    expect((got[0] ?? []).length).toBeGreaterThan(0);
  });

  it("the electrical engine lists the same distribution equipment, without a pass over the model", () => {
    const m = model();
    const expected = store
      .elementValues(m.elements)
      .filter((el) => el.kind === "part" && m.elements[el.typeId]?.kind === "part_type")
      .filter((el) => {
        if (el.kind !== "part") return false;
        const t = m.elements[el.typeId];
        return t?.kind === "part_type" && t.definition.category === "electrical_equipment" && distributionOf(m.elements, el) !== null;
      })
      .map((el) => el.id);
    expect(expected.length).toBeGreaterThan(0);
    elementValuesSpy.mockClear();
    const got = new ElectricalLoadEngine(CONNECTED_LOAD_ONLY).distribution(m);
    expect(elementValuesSpy).not.toHaveBeenCalled();
    expect([...got].sort()).toEqual([...expected].sort());
  });
});
