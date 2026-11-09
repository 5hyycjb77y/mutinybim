/**
 * @jest-environment node
 *
 * A saved plan in the live canvas shows what its drawing shows. The reviewed plan
 * was made for the linked storey "LEVEL 1" (the plan dialog offers the
 * linked model's storeys) while the 14x10 duct was routed on the model level
 * "Level 1". The drawing matched the two; the live canvas cut at the storey's
 * estimated floor + 4 ft, below the duct, so it vanished and couldn't be picked.
 */
import { DEFAULT_SETTINGS, findLevelByName, planCommit, type Command, type ModelState, type ViewElement } from "@permitzip/bim-kernel";
import { liveView, livePlanCutMm, solidsTopMm } from "../src/live-view";
import { DEFAULT_ELEVATIONS, modelSolids } from "../src/native-geometry";

const FT = 304.8;
const IN = 25.4;
const SA = { id: "sa", kind: "supply_air" } as const;

function commit(model: ModelState, command: Command): ModelState {
  const d = planCommit(model, [], { idempotencyKey: `s-${model.revision}-key`, baseRevision: model.revision, actor: { id: "s", name: "S", kind: "human" }, command });
  if (!d.ok) throw new Error(d.error.message);
  return d.model;
}

function twoFloors(): ModelState {
  let m: ModelState = { modelId: "live", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  m = commit(m, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  m = commit(m, { type: "create_level", levelId: "lvl-2", name: "Level 2", elevationMm: 14 * FT });
  m = commit(m, { type: "route_run", idPrefix: "l1", levelId: "lvl-1", domain: "duct", size: { shape: "rect", width: 14 * IN, height: 10 * IN }, elevationMm: 9 * FT, system: SA, points: [{ x: 0, y: 10 * FT }, { x: 0, y: 0 }, { x: 15 * FT, y: 0 }] });
  m = commit(m, { type: "route_run", idPrefix: "l2", levelId: "lvl-2", domain: "duct", size: { shape: "rect", width: 12 * IN, height: 8 * IN }, elevationMm: 9 * FT, system: SA, points: [{ x: 0, y: 0 }, { x: 20 * FT, y: 0 }] });
  return m;
}

/** The plan as the dialog made it: the linked storey's name and its estimated floor. */
const planOnLinkedStorey: Pick<ViewElement, "viewType" | "props"> = {
  viewType: "floor_plan",
  props: { level: "LEVEL 1", levelElevationMm: -150, cutHeightMm: 4 * FT },
};

const onLevel = (m: ModelState, prefix: string, levels: ReadonlySet<string> | null) =>
  modelSolids(m, DEFAULT_ELEVATIONS, levels ?? undefined).filter((s) => s.elementId.startsWith(prefix));

describe("a saved plan in the live canvas", () => {
  it("a plan on linked 'LEVEL 1' shows the ductwork on model level 'Level 1', not the floor above", () => {
    const m = twoFloors();
    const shown = liveView(m, planOnLinkedStorey);
    expect(shown.levels?.has("Level 1")).toBe(true);
    expect(shown.levels?.has("Level 2")).toBe(false);
    expect(onLevel(m, "l1-", shown.levels).length).toBeGreaterThan(0);
    expect(onLevel(m, "l2-", shown.levels)).toHaveLength(0);
    // Exact-name filtering (the old rule) found nothing at all.
    expect(modelSolids(m, DEFAULT_ELEVATIONS, new Set(["LEVEL 1"]))).toHaveLength(0);
  });

  it("stands on the model level's floor, not the linked storey's estimate", () => {
    expect(liveView(twoFloors(), planOnLinkedStorey).floorMm).toBe(0);
  });

  it("cuts above the plan's own duct, so it is drawn and can be picked", () => {
    const m = twoFloors();
    const shown = liveView(m, planOnLinkedStorey);
    const cut = livePlanCutMm(m, planOnLinkedStorey, shown.floorMm ?? 0);
    const ductTop = solidsTopMm(onLevel(m, "l1-", shown.levels));
    expect(ductTop).not.toBeNull();
    expect(cut).toBeGreaterThan(ductTop ?? Infinity);
    // The old cut (storey estimate + 4 ft) sat below the duct.
    expect(-150 + 4 * FT).toBeLessThan(ductTop ?? 0);
    // ...and it does not reach the floor above's duct.
    expect(cut).toBeLessThan(14 * FT + 9 * FT - 6 * IN);
  });

  it("a plan with nothing on its level keeps its cut height", () => {
    const m = twoFloors();
    const empty = { viewType: "floor_plan" as const, props: { level: "Level 3", cutHeightMm: 4 * FT } };
    expect(livePlanCutMm(m, empty, 28 * FT)).toBeCloseTo(32 * FT, 3);
  });

  it("linked storeys match the view's level the same way (isolating 'Level 1' keeps storey 'LEVEL 01')", () => {
    const storeys = [{ name: "LEVEL 01" }, { name: "LEVEL 02" }];
    expect(findLevelByName(storeys, "Level 1")?.name).toBe("LEVEL 01");
    expect(findLevelByName([{ name: "Level 1" }, { name: "LEVEL 1" }], "LEVEL 1")?.name).toBe("LEVEL 1");
    expect(findLevelByName(storeys, "Roof")).toBeUndefined();
  });
});
