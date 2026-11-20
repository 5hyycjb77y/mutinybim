/** @jest-environment node */
import { readFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_SETTINGS, commandSchema, executeCommand, withUpgradePolicy, renderTagStyleLines, type ModelState, type ScheduleDefinitionV2 } from "@permitzip/bim-kernel";
import { buildRowSet } from "@permitzip/bim-kernel/schedules";
import { PackSet, packFieldRegistry, modelPackSet, runPackConformance, unbindModelPacks, withModelPacks } from "../src";
import { createPlanterDemoModel, installPlanterDemoHost } from "./fixtures/planter-demo";
import { PLANTER_CLASS, PLANTER_PACK, PLANTER_SCHEDULE, PLANTER_TAGS, PLANTER_TYPE, PLANTER_TYPE_ID } from "../../bim-pack-tutorial/src";

const MODEL_ID = "tutorial-planter";
afterEach(() => unbindModelPacks(MODEL_ID));

function placePlanter(): ModelState { return createPlanterDemoModel(MODEL_ID); }

describe("the first add-on tutorial", () => {
  it("conforms to the current contract", () => {
    expect(runPackConformance(PLANTER_PACK)).toEqual({ ok: true, problems: [] });
  });

  it("pins the pack, places its type, classes it and stores typed values", () => {
    const model = placePlanter();
    expect(model.elements.P1).toMatchObject({ kind: "part", classId: PLANTER_CLASS, typeId: PLANTER_TYPE_ID, values: { "garden.soil_volume": 0.12, "garden.plant": "Lavender" } });
    expect(model.elements[PLANTER_TYPE_ID]).toMatchObject({ kind: "part_type", definition: PLANTER_TYPE.definition });
  });

  it("reads the placed planter through the schedule and tag engines", () => {
    const model = placePlanter();
    const definition = PLANTER_SCHEDULE.item.definition as unknown as ScheduleDefinitionV2;
    const rows = withModelPacks(MODEL_ID, () => buildRowSet(model, definition, { viewId: "tutorial", revision: model.revision, registry: packFieldRegistry(modelPackSet(MODEL_ID)!) }));
    expect(rows.rowCount).toBe(1);
    expect(rows.rowKeys).toEqual(["P1"]);
    expect(rows.values.get("mark")?.values[0]).toBe("P1");
    expect(rows.values.get("plant")?.values[0]).toBe("Lavender");
    expect(rows.values.get("soil")?.values[0]).toBeCloseTo(0.12, 8);
    expect(rows.columns.find((c) => c.id === "soil")).toMatchObject({ quantityKind: "volume", unit: "m3" });
    const planter = model.elements.P1;
    if (!planter) throw new Error("P1 was not placed");
    expect(withModelPacks(MODEL_ID, () => renderTagStyleLines(model, planter, PLANTER_TAGS[0]!.preset.lines))).toEqual(["P1", "600 mm square"]);
  });

  it("can switch the installed pack on through the demo host's command path", () => {
    const undo = installPlanterDemoHost();
    try {
      const model: ModelState = { modelId: MODEL_ID, revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
      const result = withUpgradePolicy(() => true, () => executeCommand(model, commandSchema.parse({ type: "set_model_addon", packId: "garden", version: "0.1.0", on: true })));
      if (!result.ok) throw new Error(result.error.message);
      expect(Object.values(result.model.elements)).toEqual(expect.arrayContaining([expect.objectContaining({ entry: expect.objectContaining({ packId: "garden", on: true }) })]));
    } finally {
      undo();
    }
  });

  it("has only the authoring contract dependency and imports no other packages", () => {
    const dir = path.resolve(__dirname, "../../bim-pack-tutorial");
    const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    expect(pkg.dependencies).toEqual({ "@permitzip/bim-pack": "*" });
    const source = readFileSync(path.join(dir, "src/index.ts"), "utf8");
    expect([...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1])).toEqual(["@permitzip/bim-pack/runtime"]);
    expect(() => PackSet.create([PLANTER_PACK])).not.toThrow();
  });
});
