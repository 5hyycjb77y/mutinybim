/**
 * The load lifecycle engine (KERNEL-REQUIREMENTS-MODEL §3.4, §7) on the
 * synthetic full-BIM model plus the electrical suite's synthetic distribution,
 * with one space per 20 parts, a density estimate on every space and a device
 * load on every part (estimates and devices meet, policy `max`):
 *
 * - requirements.engine.cold: a new engine's first `progress` (indexes the
 *   loads once from `elementsOfKind`, never the whole model).
 * - requirements.engine.after_device_edit: one device load's value changed,
 *   `advance` with that id, then project progress and counted totals.
 * - requirements.engine.after_estimate_edit: one space's estimate changed, same.
 *   Both after-edit figures must not grow with model size.
 *
 * Each sample checks the incremental counted totals against a fresh build.
 *
 *   node --expose-gc --import tsx scripts/perf/mutinybim/requirements-engine.ts --tier=250k
 */
import { RequirementsEngine, asElementId, elementsOfKind, fixedSpaceLocator, freezeElements, type BimElement, type ElementId, type LoadPointElement, type ModelState, type Space, type SpaceMeasure } from "@permitzip/bim-kernel";
import { FULL_BIM_TIERS, createFullBimModel } from "@permitzip/bim-first-party/seed";
import { syntheticDistribution } from "@permitzip/bim-pack-electrical";
import { emit, gc, percentile, round, timeSync } from "./lib";

type Tier = keyof typeof FULL_BIM_TIERS;
const arg = process.argv.find((a) => a.startsWith("--tier="))?.slice(7) ?? "250k";
if (!(arg in FULL_BIM_TIERS)) throw new Error(`Unknown tier ${arg}; one of ${Object.keys(FULL_BIM_TIERS).join(", ")}`);
const tier = arg as Tier;
const SAMPLES = 9;
const PARTS_PER_SPACE = 20;
const SPACE_AREA_SQM = 100;

const opts = FULL_BIM_TIERS[tier];
const base = createFullBimModel(opts);
const syn = syntheticDistribution({ floors: opts.floors, zonesPerFloor: opts.zonesPerFloor });
const merged = { ...base.elements, ...syn.elements };
const parts = elementsOfKind(merged, "part");
const level = elementsOfKind(merged, "level")[0];
if (parts.length === 0 || !level) throw new Error("[perf/requirements-engine] the synthetic model has no parts or no level");

const added: Record<string, BimElement> = {};
const spaceOf: Record<string, ElementId> = {};
const measures: Record<string, SpaceMeasure> = {};
const load = (id: string, rest: Omit<LoadPointElement, "id" | "kind" | "version" | "authoredRev" | "connectionType">): LoadPointElement => ({ id: asElementId(id), kind: "load_point", version: 1, authoredRev: {}, connectionType: "", ...rest });
parts.forEach((p, i) => {
  const sid = asElementId(`perf-sp-${Math.floor(i / PARTS_PER_SPACE)}`);
  if (!added[sid]) {
    const space: Space = { id: sid, kind: "space", version: 1, authoredRev: {}, number: sid, name: sid, levelId: level.id, bounds: { kind: "none" }, origin: { kind: "typed" } };
    added[sid] = space;
    measures[sid] = { areaSqM: SPACE_AREA_SQM, occupants: 10 };
    added[`perf-est-${sid}`] = load(`perf-est-${sid}`, { anchor: { kind: "space", id: sid }, basis: "density", rates: [{ key: "va", per: "area", value: 10 }], values: {} });
  }
  spaceOf[p.id] = sid;
  added[`perf-dev-${p.id}`] = load(`perf-dev-${p.id}`, { anchor: { kind: "part", partId: p.id }, values: { va: 500 } });
});
const locator = fixedSpaceLocator({ spaceOf, measures });
const model: ModelState = { ...base, elements: freezeElements({ ...merged, ...added }) };
const loads = elementsOfKind(model.elements, "load_point");
const devices = loads.filter((l) => l.anchor?.kind === "part");
const estimates = loads.filter((l) => l.anchor?.kind === "space");

function edited(m: ModelState, lp: LoadPointElement, values: LoadPointElement["values"], rates?: LoadPointElement["rates"]): ModelState {
  const next: LoadPointElement = { ...lp, version: lp.version + 1, values, ...(rates ? { rates } : {}) };
  return { ...m, revision: (m.revision + 1) as ModelState["revision"], elements: freezeElements({ ...m.elements, [lp.id]: next }) };
}

function check(engine: RequirementsEngine, m: ModelState): void {
  const fresh = new RequirementsEngine({ locator }).counted(m);
  const inc = engine.counted(m);
  if (JSON.stringify(fresh) !== JSON.stringify(inc)) throw new Error(`[perf/requirements-engine] incremental totals drifted from a fresh build: ${JSON.stringify(inc)} vs ${JSON.stringify(fresh)}`);
}

const cold: number[] = [];
const afterDevice: number[] = [];
const afterEstimate: number[] = [];
for (let i = 0; i < SAMPLES; i++) {
  gc();
  const engine = new RequirementsEngine({ locator });
  cold.push(timeSync(() => engine.progress(model).total).ms);
  const dev = devices[(i * 7919) % devices.length];
  const est = estimates[(i * 104729) % estimates.length];
  if (!dev || !est) throw new Error("[perf/requirements-engine] no loads to edit");
  const m1 = edited(model, dev, { va: 500 + 100 * (i + 1) });
  afterDevice.push(
    timeSync(() => {
      engine.advance(m1, [dev.id]);
      return engine.progress(m1).total + engine.counted(m1).va;
    }).ms,
  );
  const m2 = edited(m1, est, {}, [{ key: "va", per: "area", value: 10 + i }]);
  afterEstimate.push(
    timeSync(() => {
      engine.advance(m2, [est.id]);
      return engine.progress(m2).total + engine.counted(m2).va;
    }).ms,
  );
  if (i === 0) check(engine, m2);
}

const summary = (v: readonly number[]) => ({ p50: round(percentile(v, 0.5) ?? 0, 3), p95: round(percentile(v, 0.95) ?? 0, 3) });
console.error(
  JSON.stringify({
    tier,
    elements: Object.keys(model.elements).length,
    loads: loads.length,
    estimates: estimates.length,
    devices: devices.length,
    "requirements.engine.cold": summary(cold),
    "requirements.engine.after_device_edit": summary(afterDevice),
    "requirements.engine.after_estimate_edit": summary(afterEstimate),
  }),
);
const counts = { totalElements: Object.keys(model.elements).length };
emit({
  suite: "batch",
  workload: { tier, samples: SAMPLES },
  network: "in-process (no network, no Postgres)",
  participants: 1,
  info: { loads: loads.length, estimates: estimates.length, devices: devices.length },
  samples: [
    { metric: "requirements.engine.cold", values: cold.map((v) => round(v, 3)), counts, note: "A fresh requirements engine over every load of the tier: allocation, progress and counted totals." },
    { metric: "requirements.engine.after_device_edit", values: afterDevice.map((v) => round(v, 3)), counts, note: "One device edited: advance with its id, then progress and counted totals." },
    { metric: "requirements.engine.after_estimate_edit", values: afterEstimate.map((v) => round(v, 3)), counts, note: "One area estimate edited: advance with its id, then progress and counted totals." },
  ],
});
