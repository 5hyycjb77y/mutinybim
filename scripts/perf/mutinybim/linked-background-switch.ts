/**
 * U7 (Electrical Demo 2, 0:09–1:31): switching to a sheet whose plans carry
 * the architect's background took several seconds. Each viewport is a
 * different plan cut, the view-backgrounds route cuts them one at a time, and
 * every cut re-parsed the whole IFC with web-ifc `OpenModel` before cutting.
 *
 * Measured on the sheets suite's large synthetic floor (furnitureIfc grid 40:
 * 1,600 rooms, 6,400 furniture elements), a sheet of four plan viewports
 * (four distinct cut requests):
 *
 *  - linked.background.open         one OpenModel of the IFC (the re-parse every cut paid)
 *  - linked.background.switch.cold  four cuts, each opening the model (the old server path)
 *  - linked.background.switch.open  four cuts on a model kept open (what a server open-model cache would save; not built, the open is a small share)
 *  - linked.background.switch.warm  the same sheet after the cuts were warmed on load (client cache hit: no server work)
 *
 *   node --expose-gc --import tsx scripts/perf/mutinybim/linked-background-switch.ts [--samples=3] [--grid=40]
 */
import * as WebIFC from "web-ifc";
import { cutIfcPlan } from "../../../packages/bim-sheets/src/ifc-plan";
import { IDENTITY4 } from "../../../packages/bim-sheets/src/plan-geometry";
import { furnitureIfc } from "../../../packages/bim-sheets/__tests__/fixtures/furniture-ifc";
import { FIRST_PARTY_LINKED_DISPLAY } from "../../../packages/bim-sheets/__tests__/fixtures/linked-display";
import { emit, memoryMB, round, type Sample } from "./lib";

const FT = 304.8;
const args = process.argv.slice(2);
const arg = (name: string): string | undefined => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const SAMPLES = Number(arg("samples") ?? 3);
const GRID = Number(arg("grid") ?? 40);
/** Four plan viewports on one sheet: four different cuts of the same storey. */
const VIEWPORT_CUTS_FT = [4, 3.5, 5, 6] as const;

function cut(api: WebIFC.IfcAPI, modelId: number, bytes: Uint8Array, cutFt: number): number {
  const { stats } = cutIfcPlan(api, modelId, { id: "perf-arch", file: "perf-furniture.ifc", bytes, discipline: "architecture", ifcToHostMetres: IDENTITY4, storeyName: "Level 1", cutAboveLevelMm: cutFt * FT, display: FIRST_PARTY_LINKED_DISPLAY });
  return stats.elementsWithGeometry;
}

async function main(): Promise<void> {
  const api = new WebIFC.IfcAPI();
  await api.Init();
  const bytes = new TextEncoder().encode(furnitureIfc({ grid: GRID }));
  const open: number[] = [];
  const cold: number[] = [];
  const kept: number[] = [];
  const warm: number[] = [];
  let elements = 0;
  for (let s = 0; s < SAMPLES; s++) {
    // Old path: every viewport's cut opens the IFC again.
    let t0 = performance.now();
    for (const ft of VIEWPORT_CUTS_FT) {
      const o0 = performance.now();
      const id = api.OpenModel(bytes, { COORDINATE_TO_ORIGIN: false });
      open.push(performance.now() - o0);
      try {
        elements = cut(api, id, bytes, ft);
      } finally {
        api.CloseModel(id);
      }
    }
    cold.push(performance.now() - t0);

    // If the server kept the model open: one parse, four cuts.
    t0 = performance.now();
    const id = api.OpenModel(bytes, { COORDINATE_TO_ORIGIN: false });
    try {
      for (const ft of VIEWPORT_CUTS_FT) cut(api, id, bytes, ft);
    } finally {
      api.CloseModel(id);
    }
    kept.push(performance.now() - t0);

    // Warmed on load: the sheet reads four answers the tab already holds.
    const held = new Map<string, number>(VIEWPORT_CUTS_FT.map((ft) => [`plan:${ft}`, ft]));
    t0 = performance.now();
    for (const ft of VIEWPORT_CUTS_FT) if (!held.has(`plan:${ft}`)) throw new Error("warm cache miss");
    warm.push(performance.now() - t0);
  }
  const counts = { totalElements: elements, bytes: bytes.length };
  const samples: Sample[] = [
    { metric: "linked.background.open", values: open.map((v) => round(v)), counts, note: "web-ifc OpenModel of the large synthetic architect's floor: the parse every cut used to repeat." },
    { metric: "linked.background.switch.cold", values: cold.map((v) => round(v)), counts, note: `A sheet of ${VIEWPORT_CUTS_FT.length} plan viewports, nothing cached: each cut opens the IFC (today's server path).` },
    { metric: "linked.background.switch.open", values: kept.map((v) => round(v)), counts, note: `The same ${VIEWPORT_CUTS_FT.length} cuts on one open model (an open-model cache on the server would get this; not built).` },
    { metric: "linked.background.switch.warm", values: warm.map((v) => round(v, 4)), counts, note: "The same sheet after its plans' backgrounds were warmed when the model opened: answers come from the tab, no server cut." },
  ];
  emit({ suite: "sheets", network: "in-process (no network, no Postgres)", participants: 1, workload: { grid: GRID, viewports: VIEWPORT_CUTS_FT.length, samples: SAMPLES }, samples, info: { memory: memoryMB() } });
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error("[perf] linked background switch failed", err);
  process.exit(1);
});
