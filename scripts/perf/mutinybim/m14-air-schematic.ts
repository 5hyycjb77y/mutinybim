/**
 * Round 14 lane M14: the air schematic on the full-BIM model.
 *
 * One supply system is routed into the model through the real command path:
 * a unit, a 14x10 main and a tap every 10 ft to a diffuser (`DIFFUSERS` of
 * them, alternating sides). Then, per sample:
 *
 * - `diagram.air_schematic.layout` (budget 50 / 100 ms p50 / p95 per system):
 *   a full evaluation of a fresh air schematic view (its own view id, so the
 *   kernel's per-view cache never answers), divided by the systems drawn.
 * - `diagram.selection.map` (budget 2 / 4 ms): the selection map built from
 *   that drawing plus the two reads a click and a plan selection make.
 *
 *   node --expose-gc --import tsx scripts/perf/mutinybim/m14-air-schematic.ts [XS|250k|1M] [samples] [diffusers]
 *
 * 250k and 1M only through the shared stack's heavy lock.
 */
import { asElementId, builtinPartType, diagramSelectionIndex, evaluateDiagram, executeCommand, type Command, type ModelState, type ViewElement } from "../../../packages/bim-kernel/src";
import { PackSet, withPackSet } from "../../../packages/bim-kernel/src/packs";
import { airSystems } from "../../../packages/bim-pack-mechanical/src/diagrams/air-schematic";
import { AIR_SCHEMATIC_KIND } from "../../../packages/bim-pack-mechanical/src/ui";
import { createFullBimModel, FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";
import { gc, percentile, round, timeSync } from "./lib";

type Tier = keyof typeof FULL_BIM_TIERS;
const isTier = (value: string): value is Tier => value in FULL_BIM_TIERS;

const tier = process.argv[2] ?? "250k";
const samples = Number(process.argv[3] ?? "200");
const diffusers = Number(process.argv[4] ?? "60");
if (!isTier(tier) || !Number.isInteger(samples) || samples < 1 || !Number.isInteger(diffusers) || diffusers < 1) {
  console.error(`[perf/m14-air-schematic] usage: m14-air-schematic.ts [${Object.keys(FULL_BIM_TIERS).join("|")}] [samples] [diffusers]; got ${process.argv.slice(2).join(" ")}`);
  process.exit(1);
}

const FT = 304.8;
const IN = 25.4;
const SA = { id: "m14-sys-sa", kind: "supply_air" as const, name: "Supply Air (perf)" };

function commit(m: ModelState, command: Command): ModelState {
  const r = executeCommand(m, command);
  if (!r.ok) {
    console.error(`[perf/m14-air-schematic] ${command.type} was refused on the ${tier} model: ${r.error.message}`);
    process.exit(1);
  }
  return r.model;
}

const rtu = builtinPartType("builtin:rtu-5-ton@1");
const sd = builtinPartType("builtin:supply-diffuser-24@1");
if (!rtu || !sd) {
  console.error("[perf/m14-air-schematic] the starter library has no rtu-5-ton / supply-diffuser-24");
  process.exit(1);
}

const built = createFullBimModel({ ...FULL_BIM_TIERS[tier], modelId: `m14-air-${tier}` });
const elementCount = Object.keys(built.elements).length; // full-scan-ok: fixture size
let model: ModelState = built;
model = commit(model, { type: "create_level", levelId: "m14-air-L1", name: "Air level", elevationMm: 0 });
const last = diffusers + 1;
model = commit(model, { type: "place_part", partId: "m14-rtu", typeId: rtu.id, partType: rtu.definition, levelId: "m14-air-L1", position: { x: 0, y: 0 }, offsetMm: 12 * FT, mark: "RTU-P" });
model = commit(model, { type: "place_part", partId: "m14-sd-end", typeId: sd.id, partType: sd.definition, levelId: "m14-air-L1", position: { x: last * 10 * FT, y: 0 }, offsetMm: 8 * FT, mark: "SD-END" });
model = commit(model, { type: "route_run", idPrefix: "m14-trunk", levelId: "m14-air-L1", domain: "duct", size: { shape: "rect", width: 14 * IN, height: 10 * IN }, elevationMm: 10 * FT, system: SA, points: [], from: { kind: "part", partId: "m14-rtu", connectorId: "supply" }, to: { kind: "part", partId: "m14-sd-end", connectorId: "neck" } });
const trunk = Object.values(model.elements).find((e) => e.kind === "run_segment" && e.systemId === SA.id && Math.abs(e.end.x - e.start.x) > 5 * FT); // full-scan-ok: fixture setup
if (!trunk) {
  console.error("[perf/m14-air-schematic] the main has no long level piece to tap");
  process.exit(1);
}
for (let k = 1; k <= diffusers; k++) {
  const y = (k % 2 === 0 ? 1 : -1) * 6 * FT;
  model = commit(model, { type: "place_part", partId: `m14-sd-${k}`, typeId: sd.id, levelId: "m14-air-L1", position: { x: k * 10 * FT, y }, offsetMm: 8 * FT, mark: `SD-${k}` });
  model = commit(model, { type: "route_run", idPrefix: `m14-br${k}`, levelId: "m14-air-L1", domain: "duct", size: { shape: "round", diameter: 8 * IN }, elevationMm: 10 * FT, system: SA, points: [{ x: k * 10 * FT, y: 0 }, { x: k * 10 * FT, y }], from: { kind: "run_branch", segmentId: trunk.id }, to: { kind: "part", partId: `m14-sd-${k}`, connectorId: "neck" } });
}

const set = PackSet.create([]);
const viewOf = (i: number): ViewElement => ({ id: asElementId(`m14-v-air-${i}`), kind: "view", version: 1, authoredRev: {}, name: "Air schematic", viewType: "detail", cropMin: { x: 0, y: 0 }, cropMax: { x: 1, y: 1 }, props: { diagram: { kind: AIR_SCHEMATIC_KIND } } });

const elements = model.elements;
const layout: number[] = [];
const total: number[] = [];
const map: number[] = [];
/** Every duct system the drawing walks: the seed's own and the routed one. */
const systems = airSystems(elements).length;
let entries = 0;
gc();
withPackSet(set, () => {
  for (let i = 0; i < samples; i++) {
    const t = timeSync(() => evaluateDiagram(elements, viewOf(i)));
    const ev = t.value;
    if (!ev || ev.boxes.length === 0) {
      console.error(`[perf/m14-air-schematic] the air schematic drew nothing on the ${tier} model`);
      process.exit(1);
    }
    total.push(t.ms);
    layout.push(t.ms / Math.max(1, systems));
    const s = timeSync(() => {
      const index = diagramSelectionIndex(ev);
      const clicked = index.entry(`node:m14-sd-${(i % diffusers) + 1}`);
      return (clicked?.modelIds.length ?? 0) + index.entriesFor([trunk.id]).length;
    });
    entries = diagramSelectionIndex(ev).entries.length;
    map.push(s.ms);
  }
});

console.log(
  JSON.stringify({
    [`diagram.air_schematic.layout.${tier}`]: { p50: round(percentile(layout, 0.5) ?? 0, 3), p95: round(percentile(layout, 0.95) ?? 0, 3), totalP50: round(percentile(total, 0.5) ?? 0, 3), totalP95: round(percentile(total, 0.95) ?? 0, 3), elements: elementCount, diffusers, systems, budget: { p50: 50, p95: 100 } },
    [`diagram.selection.map.${tier}`]: { p50: round(percentile(map, 0.5) ?? 0, 4), p95: round(percentile(map, 0.95) ?? 0, 4), entries, budget: { p50: 2, p95: 4 } },
  }),
);
