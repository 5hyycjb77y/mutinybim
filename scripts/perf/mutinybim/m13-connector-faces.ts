/**
 * Round 13 lane M13: what listing one record's connector faces costs
 * (`kernel.connector_face`), measured on the full-BIM model.
 *
 * - connector_faces.enumerate.<tier>: `connectorFacesOf` for one record with
 *   faces (kernel straight runs, Mechanical's duct segments), read through a
 *   pack set holding Mechanical's face rows, p50 / p95 ms. Budget 1 / 2 ms.
 *
 *   node --expose-gc --import tsx scripts/perf/mutinybim/m13-connector-faces.ts [XS|250k|1M] [samples]
 *
 * 250k and 1M only through the shared stack's heavy lock (lane Q13 runs them).
 */
import { CONNECTOR_FACE_POINT, connectorFacesOf, freezeElements, type BimElement } from "../../../packages/bim-kernel/src";
import { PackSet, contribute, definePack, withPackSet } from "../../../packages/bim-kernel/src/packs";
import { MECHANICAL_CONNECTOR_FACE_ROWS } from "../../../packages/bim-pack-mechanical/src/connections/taps-faces";
import { createFullBimModel, FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";
import { gc, percentile, round, timeSync } from "./lib";

type Tier = keyof typeof FULL_BIM_TIERS;

function isTier(value: string): value is Tier {
  return value in FULL_BIM_TIERS;
}

const tier = process.argv[2] ?? "250k";
const samples = Number(process.argv[3] ?? "200");
if (!isTier(tier) || !Number.isInteger(samples) || samples < 1) {
  console.error(`[perf/m13-connector-faces] usage: m13-connector-faces.ts [${Object.keys(FULL_BIM_TIERS).join("|")}] [samples]; got ${process.argv.slice(2).join(" ")}`);
  process.exit(1);
}

const built = createFullBimModel({ ...FULL_BIM_TIERS[tier], modelId: `m13-faces-${tier}` });
const elements = freezeElements(built.elements);
const runs = Object.values(elements).filter((e): e is BimElement => e.kind === "run_segment" || e.kind === "duct_segment");
if (runs.length === 0) {
  console.error(`[perf/m13-connector-faces] the ${tier} model has no straight runs or duct segments; nothing to measure`);
  process.exit(1);
}
const set = PackSet.create([definePack({ id: "mechanical", name: "Mechanical (face rows only)", version: "1.0.0", kernel: "^1.0.0", firstParty: true }, [contribute(CONNECTOR_FACE_POINT, MECHANICAL_CONNECTOR_FACE_ROWS)])]);

const ms: number[] = [];
let faces = 0;
withPackSet(set, () => {
  // Warm the pack set's face table once (not timed).
  connectorFacesOf(runs[0] as BimElement, elements);
  gc();
  for (let i = 0; i < samples; i++) {
    const run = runs[(i * 7919) % runs.length] as BimElement;
    const t = timeSync(() => connectorFacesOf(run, elements).length);
    faces = Math.max(faces, t.value);
    ms.push(t.ms);
  }
});

console.log(JSON.stringify({ [`connector_faces.enumerate.${tier}`]: { p50: round(percentile(ms, 0.5) ?? 0, 4), p95: round(percentile(ms, 0.95) ?? 0, 4), runs: runs.length, facesMax: faces } }));
