/**
 * @jest-environment node
 *
 * Nov 8 hosted app: a blank model opened in the editor gets the starter
 * "Level 1"; a script that then made its own "Level 1" (small-office.ts) was
 * refused "There is already a level named Level 1". A level made with the
 * name of an EMPTY starter now replaces it, as the architect's levels do; a
 * starter someone drew on, or any other level of that name, still refuses.
 */
import { DEFAULT_SETTINGS, STARTER_LEVEL_ID, modelLevels, planCommit, withUpgradePolicy, type Command, type ModelState } from "../src";

const NOW = () => "2026-11-08T00:00:00.000Z";
let seq = 0;
function commit(head: ModelState, command: Command) {
  seq += 1;
  return withUpgradePolicy(() => true, () => planCommit(head, [], { idempotencyKey: `k-${seq}`, baseRevision: head.revision, actor: { id: "a", name: "A", kind: "human" }, command, clientSessionId: "t" }, NOW, []));
}
function ok(head: ModelState, command: Command): ModelState {
  const d = commit(head, command);
  if (!d.ok) throw new Error(`${command.type} refused: ${d.error.message}`);
  return d.model;
}
const opened = (): ModelState => ok({ modelId: "m", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS }, { type: "ensure_starter_level" });
const LEVEL_1: Command = { type: "create_level", levelId: "level-abc", name: "Level 1", elevationMm: 0 };

describe("create_level over the starter Level 1", () => {
  it("an empty starter is replaced by the new level, under the id the script chose", () => {
    const m = ok(opened(), LEVEL_1);
    expect(modelLevels(m).map((l) => [l.id, l.name, l.starter ?? false])).toEqual([["level-abc", "Level 1", false]]);
    expect(m.elements[STARTER_LEVEL_ID]).toBeUndefined();
  });

  it("the case of the name doesn't matter, and the new level's height wins", () => {
    const m = ok(opened(), { type: "create_level", levelId: "level-g", name: "LEVEL 1", elevationMm: 300 });
    expect(modelLevels(m).map((l) => [l.id, l.elevationMm])).toEqual([["level-g", 300]]);
  });

  it("a starter someone drew on keeps refusing", () => {
    let m = opened();
    m = ok(m, { type: "create_element", elementId: "w-1", kind: "wall", levelId: STARTER_LEVEL_ID, placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 3000, y: 0 } } });
    const d = commit(m, LEVEL_1);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.error.message).toBe("There is already a level named Level 1");
  });

  it("an ordinary level of that name keeps refusing", () => {
    let m: ModelState = { modelId: "m", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
    m = ok(m, { type: "create_level", levelId: "level-own", name: "Level 1", elevationMm: 0 });
    expect(commit(m, LEVEL_1).ok).toBe(false);
  });
});
