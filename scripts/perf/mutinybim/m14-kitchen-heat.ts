/**
 * Round 14 lane M14: what the heat a space gains costs after an edit
 * (`heat_gain.space.after_edit`), on the full-BIM model.
 *
 * Fourteen levels of 5 m rooms (400 a level) and one placed part per ten model
 * elements, one in 25 of them a fryer (a firm table row). Each sample moves one appliance 100 mm through the real
 * command path (not timed; it carries the parts-by-space index to the new
 * revision), then times `spaceHeatGainNeed` for the space it stands in: the
 * index catching up on the moved part plus the space's appliances read against
 * the table. Budget 5 / 10 ms p50 / p95. The first read (every part located
 * once) is printed beside it; it runs again only when a space is re-measured.
 *
 *   node --expose-gc --import tsx scripts/perf/mutinybim/m14-kitchen-heat.ts [XS|250k|1M] [samples]
 *
 * 250k and 1M only through the shared stack's heavy lock.
 */
import { asElementId, executeCommand, freezeElements, modelSpaceLocator, modelSpaceParts, spaceOf, type BimElement, type ElementId, type ModelState, type PartTypeDefinition } from "../../../packages/bim-kernel/src";
import type { LookupTable } from "../../../packages/bim-kernel/src/policy";
import { KITCHEN_APPLIANCE_PARAM, KITCHEN_HEAT_TABLE_SLOT, KITCHEN_HOODED_PARAM } from "../../../packages/bim-pack-mechanical/src/heat-gain/kitchen";
import { heatGainLocator, spaceHeatGainNeed } from "../../../packages/bim-pack-mechanical/src/facets/heat-gain-row";
import { createFullBimModel, FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";
import { gc, percentile, round, timeSync } from "./lib";

type Tier = keyof typeof FULL_BIM_TIERS;

function isTier(value: string): value is Tier {
  return value in FULL_BIM_TIERS;
}

const tier = process.argv[2] ?? "250k";
const samples = Number(process.argv[3] ?? "400");
if (!isTier(tier) || !Number.isInteger(samples) || samples < 1) {
  console.error(`[perf/m14-kitchen-heat] usage: m14-kitchen-heat.ts [${Object.keys(FULL_BIM_TIERS).join("|")}] [samples]; got ${process.argv.slice(2).join(" ")}`);
  process.exit(1);
}

const FRYER_TYPE = "t-m14-fryer";
const BOX_TYPE = "t-m14-box";
const FRYER: PartTypeDefinition = {
  familyName: "Kitchen appliance",
  typeName: "Fryer 40 lb",
  category: "mechanical_equipment",
  typeParams: [
    { name: KITCHEN_APPLIANCE_PARAM, label: "Kitchen appliance", kind: "text" },
    { name: KITCHEN_HOODED_PARAM, label: "Under a hood", kind: "boolean" },
  ],
  typeValues: { [KITCHEN_APPLIANCE_PARAM]: "Fryer", [KITCHEN_HOODED_PARAM]: true },
  instanceParams: [],
  tagFields: [],
  geometry: [{ kind: "box", center: [0, 0, 450], size: [600, 800, 900] }],
  symbol: [{ kind: "rect", center: [0, 0], size: [600, 800] }],
  connectors: [],
  source: { kind: "builtin", libraryVersion: "perf" },
};
const FIRM: LookupTable = {
  id: "firm-kitchen-heat",
  slot: KITCHEN_HEAT_TABLE_SLOT,
  name: "Kitchen heat (perf)",
  columns: [
    { key: "appliance", label: "Appliance" },
    { key: "hooded", label: "Hooded" },
    { key: "sensible_btuh", label: "Sensible", unit: "Btu/h" },
    { key: "latent_btuh", label: "Latent", unit: "Btu/h" },
  ],
  rows: [["Fryer", "yes", 14500, 2100]],
  citation: { source: "Perf fixture" },
};

const built = createFullBimModel({ ...FULL_BIM_TIERS[tier], modelId: `m14-kitchen-${tier}` });
/** Fourteen storeys: the full-BIM seed names no level elements, so the rooms and parts get their own. */
const levels = Array.from({ length: 14 }, (_, i) => `m14-L${i + 1}`);
const elementCount = Object.keys(built.elements).length; // full-scan-ok: fixture size
/** A 5 m grid of rooms per level, and one placed part per 10 elements of the model, one in 25 of them a fryer. */
const GRID = 20;
const CELL = 5000;
const partCount = Math.round(elementCount / 10);
const raw: Record<string, BimElement> = {
  ...built.elements,
  [FRYER_TYPE]: { id: FRYER_TYPE, kind: "part_type", version: 1, authoredRev: {}, definition: FRYER } as unknown as BimElement,
  [BOX_TYPE]: { id: BOX_TYPE, kind: "part_type", version: 1, authoredRev: {}, definition: { ...FRYER, familyName: "Box", typeName: "Box", typeParams: [], typeValues: {} } } as unknown as BimElement,
};
const appliances: ElementId[] = [];
for (let i = 0; i < partCount; i++) {
  const levelId = levels[i % levels.length] ?? "";
  const cell = Math.floor(i / levels.length) % (GRID * GRID);
  const x = (cell % GRID) * CELL + 500 + ((i * 37) % 4000);
  const y = Math.floor(cell / GRID) * CELL + 500 + ((i * 53) % 4000);
  const fryer = i % 25 === 0;
  const id = `m14-p${i}`;
  raw[id] = { id, kind: "part", version: 1, authoredRev: {}, typeId: fryer ? FRYER_TYPE : BOX_TYPE, levelId, position: { x, y }, offsetMm: 0, rotationDeg: 0, mark: `P-${i}`, values: {} } as unknown as BimElement;
  if (fryer) appliances.push(asElementId(id));
}
let model: ModelState = { ...built, elements: freezeElements(raw) };
for (const [i, levelId] of levels.entries()) {
  const r = executeCommand(model, { type: "create_level", levelId, name: `Level ${i + 1}`, elevationMm: i * 4000 });
  if (!r.ok) {
    console.error(`[perf/m14-kitchen-heat] create_level was refused: ${r.error.message}`);
    process.exit(1);
  }
  model = r.model;
}
for (const levelId of levels) {
  for (let b = 0; b < GRID * GRID; b += 200) {
    const spaces = Array.from({ length: Math.min(200, GRID * GRID - b) }, (_, k) => {
      const c = b + k;
      const x0 = (c % GRID) * CELL;
      const y0 = Math.floor(c / GRID) * CELL;
      return { spaceId: `m14-s-${levelId}-${c}`, number: String(c), name: `Room ${c}`, levelId, outline: [{ x: x0, y: y0 }, { x: x0 + CELL, y: y0 }, { x: x0 + CELL, y: y0 + CELL }, { x: x0, y: y0 + CELL }] };
    });
    const r = executeCommand(model, { type: "create_space", spaces });
    if (!r.ok) {
      console.error(`[perf/m14-kitchen-heat] create_space was refused: ${r.error.message}`);
      process.exit(1);
    }
    model = r.model;
  }
}
const inSpace = appliances.filter((id) => spaceOf(model.elements, id) !== null);
if (inSpace.length === 0) {
  console.error(`[perf/m14-kitchen-heat] none of the ${appliances.length} appliances on the ${tier} model stands in a space; nothing to measure`);
  process.exit(1);
}
const parts = partCount;

gc();
const firstApp = inSpace[0];
const firstSpace = firstApp ? spaceOf(model.elements, firstApp)?.id : undefined;
if (!firstSpace) process.exit(1);
const first = timeSync(() => modelSpaceParts(model.elements, firstSpace));
const ms: number[] = [];
let appliancesMax = 0;
let dx = 100;
for (let i = 0; i < samples; i++) {
  const id = inSpace[(i * 7919) % inSpace.length];
  if (!id) continue;
  const moved = executeCommand(model, { type: "move_elements", ids: [id], delta: { x: dx, y: 0 } });
  if (!moved.ok) {
    console.error(`[perf/m14-kitchen-heat] moving ${id} was refused on the ${tier} model: ${moved.error.message}`);
    process.exit(1);
  }
  model = moved.model;
  dx = -dx;
  const elements = model.elements;
  const t = timeSync(() => {
    const locator = heatGainLocator(elements);
    const space = locator.spaceOf(id);
    if (space === undefined) return 0;
    const need = spaceHeatGainNeed(elements, space, { firm: [FIRM] }, locator);
    return need?.partIds.length ?? 0;
  });
  appliancesMax = Math.max(appliancesMax, t.value);
  ms.push(t.ms);
}

/** Round 13's read, for comparison: the model's locator with no parts-by-space read, so every part is asked where it is. */
const walk: number[] = [];
for (let i = 0; i < Math.min(samples, 40); i++) {
  const id = inSpace[(i * 7919) % inSpace.length];
  if (!id) continue;
  const plain = modelSpaceLocator(model.elements);
  const space = plain.spaceOf(id);
  if (space === undefined) continue;
  walk.push(timeSync(() => spaceHeatGainNeed(model.elements, space, { firm: [FIRM] }, plain)?.partIds.length ?? 0).ms);
}

console.log(JSON.stringify({ [`heat_gain.space.after_edit.${tier}`]: { p50: round(percentile(ms, 0.5) ?? 0, 4), p95: round(percentile(ms, 0.95) ?? 0, 4), firstReadMs: round(first.ms, 2), elements: elementCount, parts, spaces: levels.length * GRID * GRID, appliances: inSpace.length, appliancesMax, round13WalkP50: round(percentile(walk, 0.5) ?? 0, 3), budget: { p50: 5, p95: 10 } } }));
