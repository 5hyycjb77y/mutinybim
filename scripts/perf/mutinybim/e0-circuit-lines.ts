/**
 * Square circuit lines (E0 B7) on a busy electrical plan: every branch
 * circuit of the electrical suite's synthetic distribution drawn on one plan.
 * Its devices sit in one long row, the worst case for square runs (every
 * circuit's run wants the same line), so each join searches its offsets.
 *
 * - circuits.square.derive: `deriveCircuitGraphics` with style "orthogonal".
 * - circuits.arcs.derive: the same plan in the default arcs style, for scale.
 *
 *   node --expose-gc --import tsx scripts/perf/mutinybim/e0-circuit-lines.ts --zones=4
 */
import { deriveCircuitGraphics } from "@permitzip/bim-pack-electrical";
import { DEFAULT_SETTINGS, asElementId, elementsOfKind, freezeElements, type ModelState, type PartInstance, type ViewElement } from "@permitzip/bim-kernel";
import type { CircuitGraphicStyle } from "@permitzip/bim-pack-electrical";
import { syntheticDistribution } from "@permitzip/bim-pack-electrical";
import { gc, percentile, round, timeSync } from "./lib";

const zones = Number(process.argv.find((a) => a.startsWith("--zones="))?.slice(8) ?? "4");
if (!Number.isInteger(zones) || zones < 1) throw new Error(`--zones must be a whole number of zones, got ${zones}`);
const SAMPLES = 9;
const SCALE = 48;

const syn = syntheticDistribution({ floors: 1, zonesPerFloor: zones });
const model: ModelState = { modelId: "perf-e0", revision: 0 as ModelState["revision"], elements: freezeElements(syn.elements), connections: [], settings: DEFAULT_SETTINGS };
const parts = elementsOfKind(model.elements, "part");
if (parts.length === 0) throw new Error("[perf/e0-circuit-lines] the synthetic distribution has no parts");
const shown = new Map<string, PartInstance>(parts.map((p) => [p.id, p]));
const branches = elementsOfKind(model.elements, "service_link").filter((l) => l.role === "branch").length;

function planView(style: CircuitGraphicStyle): ViewElement {
  return { id: asElementId(`v-${style}`), kind: "view", version: 0, authoredRev: {}, name: "Power plan", viewType: "floor_plan", cropMin: { x: -1e7, y: -1e7 }, cropMax: { x: 1e7, y: 1e7 }, props: { discipline: "electrical", scale: SCALE, circuitGraphics: { style } } };
}

function measure(style: CircuitGraphicStyle): { p50: number; p95: number; joins: number } {
  const v = planView(style);
  const ms: number[] = [];
  let joins = 0;
  for (let i = 0; i < SAMPLES; i++) {
    gc();
    const t = timeSync(() => deriveCircuitGraphics(model, v, shown, SCALE));
    ms.push(t.ms);
    joins = t.value.reduce((s, g) => s + g.joins.length, 0);
  }
  return { p50: round(percentile(ms, 0.5) ?? 0, 3), p95: round(percentile(ms, 0.95) ?? 0, 3), joins };
}

console.log(JSON.stringify({ zones, parts: parts.length, branches, "circuits.square.derive": measure("orthogonal"), "circuits.arcs.derive": measure("arcs") }));
