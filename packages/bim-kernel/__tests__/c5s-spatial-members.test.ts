/**
 * @jest-environment node
 *
 * Round 5c f-scale (audit §4, M): the spatial inverse indexes (a level's
 * members, a room's contents, a space's parts and loads) list exactly what a
 * brute-force read lists, in model order, after the index stopped copying a
 * target's whole list for every member it adds (a level of 35,892 members at
 * 250k took 28 s to list on its first read; that is O(members²)).
 *
 * The timing is in scripts/perf/mutinybim/__tests__/c5s-scale-perf.test.ts
 * (`fields.level_members.first_read.250k`); this file holds the answers.
 */
import { elementValues, executeCommand, freezeElements, type Command, type ModelState } from "../src";
import { createFullBimModel, FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";
import { levelOf, roomOf, SPATIAL_FIELD_PROVIDER } from "../src/fields/providers/spatial";

function run(m: ModelState, c: Command): ModelState {
  const r = executeCommand(m, c);
  if (!r.ok) throw new Error(`${c.type}: ${r.error.message}`);
  return r.model;
}

describe("c5s spatial inverse indexes", () => {
  it("level members and room contents equal a brute-force read, before and after an edit", () => {
    let m = createFullBimModel({ ...FULL_BIM_TIERS.XS, modelId: "c5s-spatial" });
    m = { ...m, elements: freezeElements(m.elements) };
    m = run(m, { type: "create_level", levelId: "lvl-1", name: "L01", elevationMm: 0 });
    m = run(m, { type: "create_level", levelId: "lvl-2", name: "L02", elevationMm: 4000 });
    const levelMembers = SPATIAL_FIELD_PROVIDER.resolvers?.level_members;
    const contains = SPATIAL_FIELD_PROVIDER.resolvers?.contains;
    if (!levelMembers || !contains) throw new Error("spatial resolvers missing");
    const check = (model: ModelState) => {
      const all = elementValues(model.elements);
      let checked = 0;
      for (const level of all.filter((e) => e.kind === "level")) {
        const expected = all.filter((e) => levelOf(model.elements, e)?.id === level.id).map((e) => e.id);
        expect({ level: level.id, ids: levelMembers(level, { elements: model.elements }) }).toEqual({ level: level.id, ids: expected });
        checked += expected.length;
      }
      for (const room of all.filter((e) => e.kind === "room").slice(0, 6)) {
        const expected = all.filter((e) => roomOf(model.elements, e)?.id === room.id).map((e) => e.id);
        expect({ room: room.id, ids: contains(room, { elements: model.elements }) }).toEqual({ room: room.id, ids: expected });
      }
      return checked;
    };
    expect(check(m)).toBeGreaterThan(100);
    const wall = elementValues(m.elements).find((e) => e.kind === "wall");
    if (!wall) throw new Error("fixture has no wall");
    m = run(m, { type: "move_elements", ids: [wall.id], delta: { x: 300, y: 0 } });
    check(m);
  });
});
