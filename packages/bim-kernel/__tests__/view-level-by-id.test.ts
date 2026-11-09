/**
 * @jest-environment node
 *
 * A script names the level it made by id (`documents.planView({ level })`).
 * Views store their level by name, so a Level 2 plan made that way drew
 * nothing live and printed from floor 0 (Nov 8 showcase): Level 1's items, no
 * Level 2 walls. Level 1 only worked because its id "level-1" reads like its
 * name. A view now stores the level's name, and a view that already stored
 * the id still reads as that level.
 */
import {
  DEFAULT_SETTINGS,
  asElementId,
  planCommit,
  viewFloorMm,
  viewLevelElements,
  viewModelLevel,
  withUpgradePolicy,
  type Command,
  type ModelState,
  type ViewElement,
} from "../src";

const NOW = () => "2026-11-08T00:00:00.000Z";
let seq = 0;
function ok(head: ModelState, command: Command): ModelState {
  seq += 1;
  const d = withUpgradePolicy(() => true, () => planCommit(head, [], { idempotencyKey: `k-${seq}`, baseRevision: head.revision, actor: { id: "a", name: "A", kind: "human" }, command, clientSessionId: "t" }, NOW, []));
  if (!d.ok) throw new Error(`${command.type} refused: ${d.error.message}`);
  return d.model;
}
const wall = (elementId: string, levelId: string): Command => ({ type: "create_element", elementId, kind: "wall", levelId, placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 3000, y: 0 } } });

function twoFloors(): ModelState {
  let m: ModelState = { modelId: "m", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  m = ok(m, { type: "create_level", levelId: "level-1", name: "Level 1", elevationMm: 0 });
  m = ok(m, { type: "create_level", levelId: "level-346ddca0", name: "Level 2", elevationMm: 3657.6 });
  m = ok(m, wall("w-ground", "level-1"));
  m = ok(m, wall("w-upper", "level-346ddca0"));
  return m;
}
const ids = (m: ModelState, v: ViewElement) => viewLevelElements(m, v).filter((e) => e.kind === "wall").map((e) => e.id).sort();
const viewOf = (m: ModelState, id: string): ViewElement => {
  const v = m.elements[id];
  if (v?.kind !== "view") throw new Error(`${id} is not a view`);
  return v;
};

describe("a plan that names its level by id", () => {
  it("is stored with the level's name and draws only that floor", () => {
    let m = twoFloors();
    m = ok(m, { type: "create_view", viewId: "v-2", name: "Level 2 - Plan", viewType: "floor_plan", props: { level: "level-346ddca0" } });
    const v = viewOf(m, "v-2");
    expect(v.props?.level).toBe("Level 2");
    expect(ids(m, v)).toEqual(["w-upper"]);
    expect(viewFloorMm(m, v.props?.level, v.props?.levelElevationMm)).toBe(3657.6);
  });

  it("set_view_properties with a level id stores the name too", () => {
    let m = twoFloors();
    m = ok(m, { type: "create_view", viewId: "v-1", name: "Plan", viewType: "floor_plan", props: { level: "Level 1" } });
    m = ok(m, { type: "set_view_properties", viewId: "v-1", props: { level: "level-346ddca0" } });
    expect(viewOf(m, "v-1").props?.level).toBe("Level 2");
  });

  it("a view that already stored the id reads as that level: its floor, its walls, not Level 1's", () => {
    const m = twoFloors();
    const legacy: ViewElement = { id: asElementId("v-old"), kind: "view", version: 0, authoredRev: {}, name: "Old", viewType: "floor_plan", cropMin: { x: -5000, y: -5000 }, cropMax: { x: 5000, y: 5000 }, props: { level: "level-346ddca0" } };
    expect(ids(m, legacy)).toEqual(["w-upper"]);
    expect(viewFloorMm(m, "level-346ddca0")).toBe(3657.6);
    expect(viewModelLevel(m, "level-346ddca0")?.name).toBe("Level 2");
  });

  it("a name is still a name, even when another level's id spells it", () => {
    let m = twoFloors();
    m = ok(m, { type: "create_level", levelId: "Level 2", name: "Mezzanine", elevationMm: 1800 });
    m = ok(m, { type: "create_view", viewId: "v-n", name: "By name", viewType: "floor_plan", props: { level: "Level 2" } });
    expect(viewOf(m, "v-n").props?.level).toBe("Level 2");
    expect(ids(m, viewOf(m, "v-n"))).toEqual(["w-upper"]);
  });
});
