import { DEFAULT_SETTINGS, executeCommand, withUpgradePolicy, type ModelState, type Revision } from "@permitzip/bim-kernel";
import { PROTOCOL_FEATURES } from "@permitzip/bim-sync";
import { runScript, sliceModel } from "@permitzip/bim-script";
import mechanicalDetails from "../../bim-script/examples/mechanical-details";

/**
 * CAD Drafting Showcase (`BIM_DEV_MODEL=mechanical-details`):
 * Runs the worked `mechanical-details` script to produce permit-ready Sheet M-501
 * with Detail 1 (Carrier 50FEQ RTU on 14" Roof Curb w/ Acoustic Dog-Leg & Concentric Diffuser)
 * and Detail 2 (Ceiling Toilet Exhaust Fan EF-1A/1B w/ 6" Hooded Wall Cap).
 *
 * Run with: `npm run demo:details`
 */
export async function createMechanicalDetailsDemoModel(modelId = "mechanical-details-demo"): Promise<ModelState> {
  const features = Object.values(PROTOCOL_FEATURES);
  const reads = new Set<string>(features);
  let m: ModelState = {
    modelId,
    revision: 0 as Revision,
    elements: {},
    connections: [],
    settings: DEFAULT_SETTINGS,
  };
  const out = await runScript(mechanicalDetails, {
    slice: sliceModel(m, mechanicalDetails.manifest.reads, [], features),
    values: {},
    scriptHash: "mechanical-details-demo",
  });
  if (out.kind !== "edits") throw new Error(`[bim-devserver] mechanical-details returned ${out.kind}`);
  for (const batch of out.batches) {
    const r = withUpgradePolicy(
      (f) => reads.has(f),
      () => executeCommand(m, batch),
    );
    if (!r.ok) throw new Error(`[bim-devserver] mechanical-details model: ${batch.type}: ${r.error.message}`);
    m = { ...r.model, revision: (m.revision + 1) as Revision };
  }
  return m;
}
