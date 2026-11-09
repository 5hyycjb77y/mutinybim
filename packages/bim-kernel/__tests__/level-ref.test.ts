/**
 * @jest-environment node
 *
 * One rule for a level as an agent or a person names it (bug log #24): its
 * id, else the one level with that name (exact, then ignoring case,
 * punctuation and leading zeros). Two levels with the name, or none, is a
 * miss naming the candidates, never an empty match. Model areas also accept a
 * partition level that holds elements without a level element (older and
 * generated models, "L1").
 */
import { DEFAULT_SETTINGS, executeCommand, resolveLevelRef, resolveModelLevel, type Command, type ModelState } from "../src";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";

const FT = 304.8;

function withLevels(...levels: Array<{ id: string; name: string; ft: number }>): ModelState {
  let model: ModelState = { modelId: "m", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  for (const l of levels) {
    const command: Command = { type: "create_level", levelId: l.id, name: l.name, elevationMm: l.ft * FT };
    const r = executeCommand(model, command);
    if (!r.ok) throw new Error(r.error.message);
    model = r.model;
  }
  return model;
}

const levels = [
  { id: "lvl-1", name: "Level 1" },
  { id: "lvl-2", name: "Level 2" },
  { id: "lvl-roof", name: "Roof" },
];

describe("resolveLevelRef", () => {
  test("an id, an exact name and a near-miss name all find the level", () => {
    expect(resolveLevelRef(levels, "lvl-2")).toEqual({ ok: true, level: levels[1] });
    expect(resolveLevelRef(levels, "Level 2")).toEqual({ ok: true, level: levels[1] });
    expect(resolveLevelRef(levels, "LEVEL 1")).toEqual({ ok: true, level: levels[0] });
    expect(resolveLevelRef(levels, " level-01 ")).toEqual({ ok: true, level: levels[0] });
    expect(resolveLevelRef(levels, "ROOF")).toEqual({ ok: true, level: levels[2] });
  });

  test("an exact name wins over a loose match on another level", () => {
    const two = [{ id: "a", name: "LEVEL 1" }, { id: "b", name: "Level 1" }];
    expect(resolveLevelRef(two, "Level 1")).toEqual({ ok: true, level: two[1] });
  });

  test("two levels that read the same refuse and name both", () => {
    const two = [{ id: "a", name: "LEVEL 1" }, { id: "b", name: "Level 01" }];
    const r = resolveLevelRef(two, "level 1");
    expect(r).toMatchObject({ ok: false, reason: "ambiguous", candidates: two });
    if (r.ok) throw new Error("matched");
    expect(r.message).toBe('2 levels are called "level 1" (LEVEL 1 (a), Level 01 (b)); give the level id.');
  });

  test("an unknown name refuses with every level, closest first", () => {
    const r = resolveLevelRef(levels, "Level 3");
    if (r.ok) throw new Error("matched");
    expect(r.reason).toBe("unknown");
    expect(r.candidates.map((l) => l.id)).toEqual(["lvl-1", "lvl-2", "lvl-roof"]);
    expect(r.message).toBe('No level "Level 3" in this model. Levels: Level 1 (lvl-1), Level 2 (lvl-2), Roof (lvl-roof).');
    const empty = resolveLevelRef([], "Level 1");
    expect(empty).toMatchObject({ ok: false, reason: "unknown", candidates: [], message: 'No level "Level 1" in this model. It has no levels yet; create one first.' });
  });
});

describe("resolveModelLevel", () => {
  test("returns the level element's canonical name for an id or a near-miss", () => {
    const model = withLevels({ id: "lvl-1", name: "Level 1", ft: 0 }, { id: "lvl-roof", name: "Roof", ft: 24 });
    expect(resolveModelLevel(model, "lvl-roof")).toMatchObject({ ok: true, name: "Roof", level: { id: "lvl-roof" } });
    expect(resolveModelLevel(model, "LEVEL 1")).toMatchObject({ ok: true, name: "Level 1", level: { id: "lvl-1" } });
    expect(resolveModelLevel(model, "Mezzanine")).toMatchObject({ ok: false, reason: "unknown" });
  });

  test("a partition level that holds elements counts when no level element has the name", () => {
    const demo = createDemoModel();
    expect(resolveModelLevel(demo, "L1")).toEqual({ ok: true, name: "L1", level: null });
    expect(resolveModelLevel(demo, "L9")).toMatchObject({ ok: false, reason: "unknown" });
  });
});
