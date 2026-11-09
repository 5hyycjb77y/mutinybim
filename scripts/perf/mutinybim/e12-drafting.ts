/**
 * Round 12 E12 drafting bundle on the electrical suite's synthetic
 * distribution (the 9303-shaped circuited model, `--zones` per floor):
 *
 * - edit.ghost.connect_to_source: the "+" grip's hover answer (`sourcesFor`
 *   through the network adapter) for an unconnected receptacle; nothing sent.
 *   Budget 4 / 8 ms (p50 / p95) at 250k and 1M.
 * - electrical.plan.circuiting: every branch circuit drawn on one plan with
 *   wire hash marks on (`drawCircuitGraphics`). Budget 50 / 100 ms at 1,200 circuits.
 * - diagram.one_line.evaluate: the one-line graph with fault current at each
 *   bus, laid out (`electricalDiagramGraph` + the radial layout). Budget 40 / 80 ms at 150 nodes.
 *
 *   node --expose-gc --import tsx scripts/perf/mutinybim/e12-drafting.ts --zones=4
 */
import { DEFAULT_SETTINGS, asElementId, elementsOfKind, freezeElements, layoutOneLine, sourcesFor, type ElementId, type ModelState, type OneLineNode, type PartInstance, type Primitive, type ViewElement } from "@permitzip/bim-kernel";
import { drawCircuitGraphics, electricalDiagramGraph, syntheticDistribution } from "@permitzip/bim-pack-electrical";
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import { gc, percentile, round, timeSync } from "./lib";

installFirstPartyAddOns();

const zones = Number(process.argv.find((a) => a.startsWith("--zones="))?.slice(8) ?? "4");
if (!Number.isInteger(zones) || zones < 1) throw new Error(`--zones must be a whole number of zones, got ${zones}`);
const SAMPLES = 9;
const SCALE = 48;

const syn = syntheticDistribution({ floors: 1, zonesPerFloor: zones });
// The receptacle the grip hovers: taken off its circuit so it has no source.
const elements = { ...syn.elements };
const receptacle = elements[syn.receptacleId];
if (receptacle?.kind !== "part") throw new Error("[perf/e12-drafting] the synthetic distribution has no receptacle");
elements[syn.receptacleId] = { ...receptacle, served: undefined } as PartInstance;
const model: ModelState = { modelId: "perf-e12", revision: 0 as ModelState["revision"], elements: freezeElements(elements), connections: [], settings: DEFAULT_SETTINGS };
const parts = elementsOfKind(model.elements, "part");
const shown = new Map<string, PartInstance>(parts.map((p) => [p.id, p]));
const branches = elementsOfKind(model.elements, "service_link").filter((l) => l.role === "branch").length;

function stats(run: () => unknown): { p50: number; p95: number } {
  const ms: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    gc();
    ms.push(timeSync(run).ms);
  }
  return { p50: round(percentile(ms, 0.5) ?? 0, 3), p95: round(percentile(ms, 0.95) ?? 0, 3) };
}

const view: ViewElement = { id: asElementId("v-e12"), kind: "view", version: 0, authoredRev: {}, name: "Power plan", viewType: "floor_plan", cropMin: { x: -1e7, y: -1e7 }, cropMax: { x: 1e7, y: 1e7 }, props: { discipline: "electrical", scale: SCALE, circuitGraphics: { style: "orthogonal", hashMarks: "hots_neutral_ground" } } } as ViewElement;

const ghost = stats(() => sourcesFor(model, { elementId: syn.receptacleId as ElementId }));
const circuiting = stats(() => {
  const prims: Primitive[] = [];
  drawCircuitGraphics({ toPaper: (p) => ({ x: p.x / SCALE, y: -p.y / SCALE }), scale: SCALE, window: { min: { x: -1e6, y: -1e6 }, max: { x: 1e6, y: 1e6 } }, prims }, model, view, shown);
});
let nodes = 0;
const oneLine = stats(() => {
  const graph = electricalDiagramGraph(model.elements, { faultCurrent: true });
  const toSpec = (n: (typeof graph.roots)[number]): OneLineNode => ({ id: n.id, kind: n.kind, name: n.name, ...(n.children.length > 0 ? { children: n.children.map(toSpec) } : {}) });
  const roots = graph.roots.slice(0, 8).map(toSpec);
  nodes = graph.roots.length;
  if (roots.length > 0) layoutOneLine({ roots });
});

console.log(JSON.stringify({ zones, parts: parts.length, branches, roots: nodes, "edit.ghost.connect_to_source": ghost, "electrical.plan.circuiting": circuiting, "diagram.one_line.evaluate": oneLine }));
