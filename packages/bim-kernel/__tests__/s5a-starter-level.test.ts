/**
 * @jest-environment node
 *
 * Round 16 s5a: an empty model starts with "Level 1" at 0 so a person can draw
 * the moment it opens. One level however many people open it at once (a fixed
 * id; the second ask is refused because a level exists), never added to a
 * model with levels, an ordinary level afterwards (rename, move, delete once
 * another exists), and the architect's levels replace it while it is empty.
 */
import {
  DEFAULT_SETTINGS,
  LEVELS_STARTER_FEATURE,
  STARTER_LEVEL_ID,
  executeCommand,
  modelLevels,
  needsStarterLevel,
  planCommit,
  planLevelSync,
  withUpgradePolicy,
  type Command,
  type Level,
  type ModelState,
} from "../src";

const NOW = () => "2026-11-07T00:00:00.000Z";
const REF = "ref-arch";
const empty = (): ModelState => ({ modelId: "s5a", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS });

let seq = 0;
function commit(head: ModelState, command: Command, who = "priya") {
  seq += 1;
  // The model server and every client of this release advertise the starter feature.
  return withUpgradePolicy(() => true, () => planCommit(head, [], { idempotencyKey: `${who}-${seq}`, baseRevision: head.revision, actor: { id: who, name: who, kind: "human" }, command, clientSessionId: `tab-${who}` }, NOW, []));
}
function ok(head: ModelState, command: Command, who?: string): ModelState {
  const d = commit(head, command, who);
  if (!d.ok) throw new Error(`${command.type} refused: ${d.error.message}`);
  return d.model;
}
const levelsOf = (m: ModelState): Level[] => modelLevels(m).sort((a, b) => a.elevationMm - b.elevationMm);
const START: Command = { type: "ensure_starter_level" };

describe("starter Level 1", () => {
  it("an empty model gets Level 1 at 0, marked as the starter", () => {
    expect(needsStarterLevel(empty())).toBe(true);
    const m = ok(empty(), START);
    const [only, ...rest] = levelsOf(m);
    expect(rest).toHaveLength(0);
    expect(only).toMatchObject({ id: STARTER_LEVEL_ID, name: "Level 1", elevationMm: 0, starter: true });
    expect(needsStarterLevel(m)).toBe(false);
  });

  it("two people opening the same empty model at once make one level", () => {
    const base = empty();
    // Both decided against the same empty head; the server serialises them.
    const first = commit(base, START, "priya");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = commit(first.model, START, "avery");
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("already_exists");
    expect(levelsOf(first.model)).toHaveLength(1);
  });

  it("is never added to a model that already has levels", () => {
    const m = ok(empty(), { type: "create_level", levelId: "lvl-g", name: "Ground", elevationMm: 0 });
    expect(needsStarterLevel(m)).toBe(false);
    const d = commit(m, START);
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.error.code).toBe("already_exists");
      expect(d.error.message).toContain("already has a level (Ground)");
    }
  });

  it("an older model server refuses it in plain words", () => {
    const d = withUpgradePolicy((f) => f !== LEVELS_STARTER_FEATURE, () => executeCommand(empty(), START));
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.error.message).toMatch(/older version/);
  });

  it("is a real level: renamed or moved it stops being the starter", () => {
    let m = ok(empty(), START);
    m = ok(m, { type: "update_level", levelId: STARTER_LEVEL_ID, name: "First Floor" });
    expect(levelsOf(m)[0]).toMatchObject({ name: "First Floor", elevationMm: 0 });
    expect(levelsOf(m)[0]?.starter).toBeUndefined();
    m = ok(m, { type: "update_level", levelId: STARTER_LEVEL_ID, elevationMm: 300 });
    expect(levelsOf(m)[0]?.elevationMm).toBe(300);
  });

  it("can't be deleted while it is the only level; can once another exists", () => {
    let m = ok(empty(), START);
    const alone = commit(m, { type: "delete_elements", ids: [STARTER_LEVEL_ID], policy: "refuse" });
    expect(alone.ok).toBe(false);
    if (!alone.ok) expect(alone.error.message).toMatch(/only level.*Add another level first/);
    m = ok(m, { type: "create_level", levelId: "lvl-2", name: "Level 2", elevationMm: 4000 });
    m = ok(m, { type: "delete_elements", ids: [STARTER_LEVEL_ID], policy: "refuse" });
    expect(levelsOf(m).map((l) => l.name)).toEqual(["Level 2"]);
  });

  it("the architect's levels replace an empty starter: no level beside it, it takes the storey's name", () => {
    let m = ok(empty(), START);
    const storeys = [
      { storeyId: "g1", name: "LEVEL 01", elevationMm: 0, levelId: "lvl-a1" },
      { storeyId: "g2", name: "LEVEL 02", elevationMm: 4200, levelId: "lvl-a2" },
    ];
    m = ok(m, { type: "sync_levels", referenceId: REF, storeys });
    const levels = levelsOf(m);
    expect(levels.map((l) => [l.id, l.name, l.elevationMm])).toEqual([
      [STARTER_LEVEL_ID, "LEVEL 01", 0],
      ["lvl-a2", "LEVEL 02", 4200],
    ]);
    expect(levels[0]?.starter).toBeUndefined();
    expect(levels[0]?.source).toMatchObject({ referenceId: REF, storeyId: "g1" });
  });

  it("an empty starter takes the architect's lowest floor even when no storey is at 0 or named Level 1", () => {
    const m = ok(empty(), START);
    const plan = planLevelSync(m, REF, [
      { storeyId: "b", name: "BASEMENT", elevationMm: -3600, levelId: "lvl-b" },
      { storeyId: "m", name: "MAIN", elevationMm: 1200, levelId: "lvl-m" },
    ]);
    expect(plan.rows.map((r) => [r.storeyName, r.action, r.levelId, r.name])).toEqual([
      ["BASEMENT", "update", STARTER_LEVEL_ID, "BASEMENT"],
      ["MAIN", "add", "lvl-m", "MAIN"],
    ]);
  });

  it("a starter someone has drawn on is matched like any level of theirs (it keeps its name)", () => {
    let m = ok(empty(), START);
    m = ok(m, { type: "create_element", elementId: "w-1", kind: "wall", levelId: STARTER_LEVEL_ID, placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 3000, y: 0 } } });
    const plan = planLevelSync(m, REF, [{ storeyId: "g1", name: "LEVEL 01", elevationMm: 0, levelId: "lvl-a1" }]);
    expect(plan.rows[0]).toMatchObject({ action: "match", levelId: STARTER_LEVEL_ID, name: "Level 1" });
  });
});
