/**
 * Load columns in schedules (fields/providers/loads.ts) on the same synthetic
 * model as requirements-engine.ts: one space per 20 parts with a density
 * estimate, a device load on every part, and every device naming one of 200
 * sources (servedBy), so a panel list has ~110 loads per row.
 *
 * - requirements.columns.space_list: after one device edit (advance by its
 *   id), read estimate, devices so far and counted for every space: the cost
 *   of re-reading a whole space schedule's load columns. Per-space figures come
 *   from the engine's scope index and stay remembered except for the scopes
 *   the edit touched; every space is checked against a fresh build at the end.
 * - requirements.columns.panel_list: after one device edit carried the way a
 *   commit carries it (`shareRequirementsEngine` with that id), read the three
 *   columns for every source through the field provider: only the edited
 *   load's source re-reads its loads (indexed by servedBy).
 * - requirements.columns.panel_list_cold: the same read on a state nothing was
 *   carried to (a freshly loaded model): every source reads its loads once.
 *
 *   node --expose-gc --import tsx scripts/perf/mutinybim/requirements-columns.ts --tier=250k
 */
import { LOADS_FIELD_PROVIDER, RequirementsEngine, asElementId, draftElements, elementsOfKind, fixedSpaceLocator, freezeElements, shareRequirementsEngine, type BimElement, type ElementId, type LoadPointElement, type ModelState, type Space, type SpaceMeasure } from "@permitzip/bim-kernel";
import { FULL_BIM_TIERS, createFullBimModel } from "@permitzip/bim-first-party/seed";
import { syntheticDistribution } from "@permitzip/bim-pack-electrical";
import { gc, percentile, round, timeSync } from "./lib";

type Tier = keyof typeof FULL_BIM_TIERS;
const arg = process.argv.find((a) => a.startsWith("--tier="))?.slice(7) ?? "250k";
if (!(arg in FULL_BIM_TIERS)) throw new Error(`Unknown tier ${arg}; one of ${Object.keys(FULL_BIM_TIERS).join(", ")}`);
const tier = arg as Tier;
const SAMPLES = 9;
const PARTS_PER_SPACE = 20;
const SOURCES = 200;

const opts = FULL_BIM_TIERS[tier];
const base = createFullBimModel(opts);
const syn = syntheticDistribution({ floors: opts.floors, zonesPerFloor: opts.zonesPerFloor });
const merged = { ...base.elements, ...syn.elements };
const parts = elementsOfKind(merged, "part");
const level = elementsOfKind(merged, "level")[0];
if (parts.length < SOURCES || !level) throw new Error("[perf/requirements-columns] the synthetic model has too few parts or no level");
const sources = parts.slice(0, SOURCES).map((p) => p.id);

const added: Record<string, BimElement> = {};
const spaceOf: Record<string, ElementId> = {};
const measures: Record<string, SpaceMeasure> = {};
const spaceIds: ElementId[] = [];
const load = (id: string, rest: Omit<LoadPointElement, "id" | "kind" | "version" | "authoredRev" | "connectionType">): LoadPointElement => ({ id: asElementId(id), kind: "load_point", version: 1, authoredRev: {}, connectionType: "", ...rest });
parts.forEach((p, i) => {
  const sid = asElementId(`perf-sp-${Math.floor(i / PARTS_PER_SPACE)}`);
  const source = sources[i % SOURCES];
  if (!added[sid]) {
    const space: Space = { id: sid, kind: "space", version: 1, authoredRev: {}, number: sid, name: sid, levelId: level.id, bounds: { kind: "none" }, origin: { kind: "typed" } };
    added[sid] = space;
    spaceIds.push(sid);
    measures[sid] = { areaSqM: 100, occupants: 10 };
    added[`perf-est-${sid}`] = load(`perf-est-${sid}`, { anchor: { kind: "space", id: sid }, basis: "density", rates: [{ key: "va", per: "area", value: 10 }], values: {}, ...(source ? { servedBy: source } : {}) });
  }
  spaceOf[p.id] = sid;
  added[`perf-dev-${p.id}`] = load(`perf-dev-${p.id}`, { anchor: { kind: "part", partId: p.id }, values: { va: 500 }, ...(source ? { servedBy: source } : {}) });
});
const locator = fixedSpaceLocator({ spaceOf, measures });
const model: ModelState = { ...base, elements: freezeElements({ ...merged, ...added }) };
const devices = elementsOfKind(model.elements, "load_point").filter((l) => l.anchor?.kind === "part");

const field = (path: string) => {
  const f = LOADS_FIELD_PROVIDER.fields?.find((x) => x.path === path);
  if (!f?.read) throw new Error(`[perf/requirements-columns] no reader for ${path}`);
  return f.read;
};
const columns = ["loads.allocated.va", "loads.actual.va", "loads.counted.va"].map(field);

const spaceList: number[] = [];
const panelList: number[] = [];
const panelCold: number[] = [];
const readPanels = (elements: ModelState["elements"]) => {
  for (const id of sources) {
    const el = elements[id];
    if (!el) continue;
    for (const read of columns) {
      const v = read(el, { elements });
      if (typeof v === "number") checksum += v;
    }
  }
  return checksum;
};
let checksum = 0;
const engine = new RequirementsEngine({ locator });
engine.progress(model);
let head = model;
for (let i = 0; i < SAMPLES; i++) {
  gc();
  const dev = devices[(i * 7919) % devices.length];
  if (!dev) throw new Error("[perf/requirements-columns] no device to edit");
  // As a commit builds the next record (applyChangeset): a draft over the head, so kind indexes carry.
  const draft = draftElements(head.elements);
  draft[dev.id] = { ...dev, version: dev.version + 1, values: { va: 500 + 100 * (i + 1) } };
  const next: ModelState = { ...head, revision: (head.revision + 1) as ModelState["revision"], elements: freezeElements(draft) };
  spaceList.push(
    timeSync(() => {
      engine.advance(next, [dev.id]);
      for (const id of spaceIds) {
        const f = engine.scopeFigures(next, { kind: "space", id });
        checksum += f.allocated.va + f.actual.va + f.counted.va;
      }
      return checksum;
    }).ms,
  );
  if (i === 0) panelCold.push(timeSync(() => readPanels(head.elements)).ms);
  else readPanels(head.elements);
  shareRequirementsEngine(head.elements, next.elements, [dev.id]);
  panelList.push(timeSync(() => readPanels(next.elements)).ms);
  const unloaded = freezeElements(draftElements(next.elements));
  if (i > 0) panelCold.push(timeSync(() => readPanels(unloaded)).ms);
  head = next;
}

const fresh = new RequirementsEngine({ locator });
for (const id of spaceIds) {
  if (JSON.stringify(fresh.scopeFigures(head, { kind: "space", id })) !== JSON.stringify(engine.scopeFigures(head, { kind: "space", id }))) {
    throw new Error(`[perf/requirements-columns] incremental figures for ${id} drifted from a fresh build`);
  }
}

const summary = (v: readonly number[]) => ({ p50: round(percentile(v, 0.5) ?? 0, 3), p95: round(percentile(v, 0.95) ?? 0, 3) });
console.log(
  JSON.stringify({
    tier,
    elements: Object.keys(model.elements).length,
    spaces: spaceIds.length,
    sources: sources.length,
    loads_per_source: Math.round(devices.length / SOURCES),
    "requirements.columns.space_list": summary(spaceList),
    "requirements.columns.panel_list": summary(panelList),
    "requirements.columns.panel_list_cold": summary(panelCold),
  }),
);
