/**
 * The "planned parts" index (ROADMAP F1) on the synthetic full-BIM model
 * plus the electrical suite's synthetic distribution:
 *
 * - planned.index.cold: `plannedParts` on a record it has never seen (built
 *   from the per-kind index: parts only, never the whole model).
 * - planned.index.after_edit: one part taken off the drawing, then
 *   `advancePlannedIndex` with that id and `plannedParts` on the new record.
 *   Must not grow with model size.
 *
 *   node --expose-gc --import tsx scripts/perf/mutinybim/planned-parts.ts --tier=250k
 */
import { advancePlannedIndex, elementsOfKind, freezeElements, plannedParts, type BimElement } from "@permitzip/bim-kernel";
import { FULL_BIM_TIERS, createFullBimModel } from "@permitzip/bim-first-party/seed";
import { syntheticDistribution } from "@permitzip/bim-pack-electrical";
import { emit, gc, percentile, round, timeSync } from "./lib";

type Tier = keyof typeof FULL_BIM_TIERS;
const arg = process.argv.find((a) => a.startsWith("--tier="))?.slice(7) ?? "250k";
if (!(arg in FULL_BIM_TIERS)) throw new Error(`Unknown tier ${arg}; one of ${Object.keys(FULL_BIM_TIERS).join(", ")}`);
const tier = arg as Tier;
const SAMPLES = 9;

const opts = FULL_BIM_TIERS[tier];
const base = createFullBimModel(opts);
// The tier's building plus the electrical suite's distribution (427 loads per zone): the parts live there.
const syn = syntheticDistribution({ floors: opts.floors, zonesPerFloor: opts.zonesPerFloor });
const model = { ...base, elements: freezeElements({ ...base.elements, ...syn.elements }) };
const parts = elementsOfKind(model.elements, "part");
if (parts.length === 0) throw new Error("[perf/planned-parts] the synthetic model has no parts");

const cold: number[] = [];
const afterEdit: number[] = [];
for (let i = 0; i < SAMPLES; i++) {
  // A fresh record per sample, so nothing is cached for it.
  const fresh = freezeElements({ ...model.elements });
  gc();
  cold.push(timeSync(() => plannedParts(fresh)).ms);
  const part = parts[i % parts.length];
  if (!part) continue;
  const edited: Record<string, BimElement> = { ...fresh, [part.id]: { ...part, planned: { levelHint: part.levelId } } };
  const next = freezeElements(edited);
  afterEdit.push(
    timeSync(() => {
      advancePlannedIndex(fresh, next, [part.id]);
      return plannedParts(next).length;
    }).ms,
  );
}

const summary = (v: readonly number[]) => ({ p50: round(percentile(v, 0.5) ?? 0, 3), p95: round(percentile(v, 0.95) ?? 0, 3) });
console.error(JSON.stringify({ tier, elements: Object.keys(model.elements).length, parts: parts.length, "planned.index.cold": summary(cold), "planned.index.after_edit": summary(afterEdit) }));
const counts = { totalElements: Object.keys(model.elements).length };
emit({
  suite: "batch",
  workload: { tier, samples: SAMPLES },
  network: "in-process (no network, no Postgres)",
  participants: 1,
  info: { parts: parts.length },
  samples: [
    { metric: "planned.index.cold", values: cold.map((v) => round(v, 3)), counts, note: "plannedParts on a record it has never seen (per-kind part index, never the whole model)." },
    { metric: "planned.index.after_edit", values: afterEdit.map((v) => round(v, 3)), counts, note: "One part taken off the drawing, advancePlannedIndex with its id, then plannedParts." },
  ],
});
