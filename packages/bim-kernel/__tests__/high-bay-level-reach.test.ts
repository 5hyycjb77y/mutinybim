import {
  DEFAULT_SETTINGS,
  asElementId,
  asRevision,
  commandSchema,
  executeCommand,
  floorForPiece,
  isBuildingStoryLevel,
  isRoofDatumLevel,
  modelLevels,
  otherLevelElementsInRange,
  planAutoTopDescription,
  planReachRange,
  type Level,
  type ModelState,
  type RunSegment,
  type ViewElement,
} from "../src/index";

const FT = 304.8;

function runCmd(model: ModelState, command: Record<string, unknown> & { type: string }): ModelState {
  const res = executeCommand(model, commandSchema.parse(command));
  if (!res.ok) throw new Error(res.error.message);
  return { ...res.model, revision: (model.revision + 1) as ModelState["revision"] };
}

function emptyTestModel(): ModelState {
  return {
    modelId: "test-moke",
    revision: asRevision(0),
    settings: DEFAULT_SETTINGS,
    elements: {},
    connections: [],
  };
}

function makeRun(
  id: string,
  level: string,
  levelId: string,
  levelElevFt: number,
  startAbsZFt: number,
  endAbsZFt: number,
): RunSegment {
  return {
    id: asElementId(id),
    kind: "run_segment",
    version: 1,
    authoredRev: {},
    partition: { level, zone: "Z1", discipline: "mechanical" },
    systemId: asElementId("sys-sa"),
    levelId: asElementId(levelId),
    domain: "duct",
    size: { shape: "round", diameter: 400 },
    start: { x: 1000, y: 1000, z: (startAbsZFt - levelElevFt) * FT },
    end: { x: 4000, y: 1000, z: (endAbsZFt - levelElevFt) * FT },
    links: {},
    branches: [],
    flow: 0,
  };
}

function modelWithLevels(
  defs: ReadonlyArray<{ id: string; name: string; elevationFt: number }>,
  extra: Record<string, RunSegment> = {},
): ModelState {
  let m = emptyTestModel();
  for (const d of defs) {
    m = runCmd(m, { type: "create_level", levelId: d.id, name: d.name, elevationMm: d.elevationFt * FT });
  }
  return { ...m, elements: { ...m.elements, ...extra } };
}

const MOKE_DEF = [
  { id: "lvl-1", name: "Level 1", elevationFt: 0 },
  { id: "lvl-rc", name: "Restroom Ceiling", elevationFt: 9 },
  { id: "lvl-lr", name: "Low Roof", elevationFt: 14.25 },
  { id: "lvl-hr", name: "High Roof", elevationFt: 20.33 },
  { id: "lvl-p", name: "Parapet", elevationFt: 22 },
] as const;

const TWO_STORY_DEF = [
  { id: "lvl-1", name: "Level 1", elevationFt: 0 },
  { id: "lvl-clg", name: "L1 Ceiling", elevationFt: 9 },
  { id: "lvl-2", name: "Level 2", elevationFt: 12 },
  { id: "lvl-roof", name: "Roof", elevationFt: 22 },
] as const;

describe("High-bay / stepped-roof building-story level classification & plan reach (Moke fix)", () => {
  it("classifies ceiling/roof/parapet datums as non-story levels while honoring explicit buildingStory overrides", () => {
    expect(isBuildingStoryLevel({ name: "Level 1" })).toBe(true);
    expect(isBuildingStoryLevel({ name: "Level 2" })).toBe(true);
    expect(isBuildingStoryLevel({ name: "Mezzanine" })).toBe(true);
    expect(isBuildingStoryLevel({ name: "Restroom Ceiling" })).toBe(false);
    expect(isBuildingStoryLevel({ name: "Low Roof" })).toBe(false);
    expect(isBuildingStoryLevel({ name: "High Roof" })).toBe(false);
    expect(isBuildingStoryLevel({ name: "Parapet" })).toBe(false);
    expect(isBuildingStoryLevel({ name: "Roof", buildingStory: true })).toBe(true);
    expect(isBuildingStoryLevel({ name: "Mezzanine", buildingStory: false })).toBe(false);

    expect(isRoofDatumLevel({ name: "Low Roof" })).toBe(true);
    expect(isRoofDatumLevel({ name: "High Roof" })).toBe(true);
    expect(isRoofDatumLevel({ name: "Restroom Ceiling" })).toBe(false);
    expect(isRoofDatumLevel({ name: "Parapet" })).toBe(false);
  });

  it("floorForPiece keeps single-story high-bay runs on Level 1 instead of re-filing onto ceiling or stepped roof datums", () => {
    const mokeLevels: readonly Level[] = modelLevels(modelWithLevels(MOKE_DEF));
    const l1 = mokeLevels[0]!;
    expect(floorForPiece(mokeLevels, l1, 9.44 * FT).name).toBe("Level 1");
    expect(floorForPiece(mokeLevels, l1, 15.0 * FT).name).toBe("Level 1");
    expect(floorForPiece(mokeLevels, l1, 18.5 * FT).name).toBe("Level 1");
    expect(floorForPiece(mokeLevels, l1, 21.0 * FT).name).toBe("Level 1");

    // Multi-story buildings still separate Level 1 from Level 2 across a ceiling datum.
    const twoLevels: readonly Level[] = modelLevels(modelWithLevels(TWO_STORY_DEF));
    const l1Multi = twoLevels[0]!;
    expect(floorForPiece(twoLevels, l1Multi, 9.5 * FT).name).toBe("Level 1");
    expect(floorForPiece(twoLevels, l1Multi, 13.0 * FT).name).toBe("Level 2");
  });

  it("Level 1 plan on a single-story stepped-roof building reaches up to High Roof and pulls in existing runs filed on ceiling/roof levels", () => {
    let model = modelWithLevels(MOKE_DEF, {
      "r-exh": makeRun("r-exh", "Restroom Ceiling", "lvl-rc", 9, 9.44, 9.44),
      "r-low": makeRun("r-low", "Low Roof", "lvl-lr", 14.25, 14.5, 18.5),
      "r-high": makeRun("r-high", "High Roof", "lvl-hr", 20.33, 19.25, 21.72),
      "r-above": makeRun("r-above", "Parapet", "lvl-p", 22, 22.5, 23.0),
    });
    model = runCmd(model, {
      type: "create_view",
      viewId: "v-m101",
      viewType: "floor_plan",
      name: "Level 1 Mechanical Plan",
      props: { level: "Level 1", discipline: "mechanical" },
    });
    const view = model.elements["v-m101"] as ViewElement;
    expect(modelLevels(model)).toHaveLength(5);

    const reach = planReachRange(model, view);
    expect(reach).not.toBeNull();
    expect(reach!.lowMm).toBeCloseTo(0, 1);
    expect(reach!.highMm).toBeCloseTo(20.33 * FT, 1);
    expect(planAutoTopDescription(model, view)).toBe("Auto (to High Roof, 20.3 ft)");

    const pulledIds = new Set(otherLevelElementsInRange(model, view).map((e) => e.id));
    expect(pulledIds.has(asElementId("r-exh"))).toBe(true);
    expect(pulledIds.has(asElementId("r-low"))).toBe(true);
    expect(pulledIds.has(asElementId("r-high"))).toBe(true);
    // An element wholly above High Roof (21.5–22 ft) stays off the Level 1 floor plan.
    expect(pulledIds.has(asElementId("r-above"))).toBe(false);
  });

  it("multi-story Level 1 plan still stops at Level 2 (ignoring L1 Ceiling datum) and respects explicit viewTopMm", () => {
    let model = modelWithLevels(TWO_STORY_DEF);
    model = runCmd(model, {
      type: "create_view",
      viewId: "v-l1",
      viewType: "floor_plan",
      name: "Level 1 Plan",
      props: { level: "Level 1", discipline: "mechanical" },
    });
    const view = model.elements["v-l1"] as ViewElement;

    const reach = planReachRange(model, view);
    expect(reach!.highMm).toBeCloseTo(12 * FT, 1);
    expect(planAutoTopDescription(model, view)).toBe("Auto (to Level 2, 12 ft)");

    const cappedView: ViewElement = {
      ...view,
      props: { ...view.props, viewTopMm: 10 * FT },
    };
    expect(planReachRange(model, cappedView)!.highMm).toBeCloseTo(10 * FT, 1);
  });
});
