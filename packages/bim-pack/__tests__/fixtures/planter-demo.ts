import { DEFAULT_SETTINGS, commandSchema, executeCommand, installModelSetupHost, withUpgradePolicy, type ModelState } from "@permitzip/bim-kernel";
import { bindModelPacks, installedFirstPartyPacks, resolvePackPins, withModelPacks } from "@permitzip/bim-pack";
import { PLANTER_CLASS, PLANTER_PACK, PLANTER_TYPE, PLANTER_TYPE_ID } from "../../../bim-pack-tutorial/src";

/** Local-demo host glue, not part of the add-on or a production host. */
export function createPlanterDemoModel(modelId = "tutorial-planter"): ModelState {
  const pins = [{ id: "garden", version: "0.1.0" }];
  const resolved = resolvePackPins([...installedFirstPartyPacks(), PLANTER_PACK], pins);
  if (resolved.missing.length > 0) throw new Error("The tutorial garden pack is not available");
  bindModelPacks(modelId, resolved.set);
  let model: ModelState = { modelId, revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: { ...DEFAULT_SETTINGS, packs: pins } };
  // This host runs the current checkout's kernel and accepts its feature upgrades.
  for (const input of [
    { type: "create_level", levelId: "garden-level", name: "Garden", elevationMm: 0 },
    { type: "place_part", partId: "P1", typeId: PLANTER_TYPE_ID, partType: PLANTER_TYPE.definition, levelId: "garden-level", position: { x: 0, y: 0 }, mark: "P1" },
    { type: "set_element_class", elementIds: ["P1"], classId: PLANTER_CLASS },
    { type: "set_element_values", elementIds: ["P1"], values: { "garden.soil_volume": 0.12, "garden.plant": "Lavender" } },
  ]) {
    const result = withModelPacks(modelId, () => withUpgradePolicy(() => true, () => executeCommand(model, commandSchema.parse(input))));
    if (!result.ok) throw new Error(result.error.message);
    model = result.model;
  }
  return model;
}

/** Install before starting the local server; call the returned function to undo. */
export function installPlanterDemoHost(): () => void {
  return installModelSetupHost(() => [PLANTER_PACK]);
}
