/**
 * @jest-environment node
 *
 * Scale: a synthetic 5,000-structure storm network (an outfall, a spine of
 * 100 manholes, 49 inlets with a catchment each off every manhole). One
 * catchment edit re-totals only the structures on its way to the outfall
 * (depth + 1 of them), never the network; the read joins pipes to
 * structures through a cell index, not a scan per pipe end. Times are
 * printed for the perf rows in the notes; budgets are lane C's to set.
 */
import { performance } from "node:perf_hooks";
import { qty, to } from "@permitzip/bim-units";
import { CIVIL_CLASS, CIVIL_PARAM, CIVIL_RCP, CIVIL_RUNOFF, CIVIL_STORM_SERVICE } from "../src/ids";
import { DEFAULT_SETTINGS, asElementId, type BimElement, type MepSystem, type ModelState, type PartInstance, type RunSegment, type Zone } from "@permitzip/bim-kernel";
import { PackSet, runPackNetwork } from "@permitzip/bim-pack";
import { solveStormNetwork } from "../src/network";
import { CIVIL_PACK } from "../src/pack";

const FT = 304.8;
const base = { version: 1, authoredRev: {} } as const;
const L = asElementId("lvl-site");
const SYS = asElementId("sys");
const MANHOLES = 100;
const INLETS_PER = 49;

/** Records shaped as the commands write them (the synthetic-site test builds through the commands; 10,000 commands would time the command layer, not the network). */
function part(id: string, classId: string, x: number, y: number, invertMm: number): PartInstance {
  return { ...base, id: asElementId(id), kind: "part", typeId: asElementId("pt"), levelId: L, position: { x, y }, offsetMm: 0, rotationDeg: 0, mark: id, values: { [CIVIL_PARAM.invertElevation]: invertMm }, classId };
}

function seg(id: string, a: string, ax: number, ay: number, b: string, bx: number, by: number): RunSegment {
  return { ...base, id: asElementId(id), kind: "run_segment", domain: "pipe", systemId: SYS, levelId: L, start: { x: ax, y: ay, z: 300 }, end: { x: bx, y: by, z: 300 }, size: { shape: "pipe", nominalMm: 381, material: "pe", materialId: CIVIL_RCP }, links: { start: { elementId: asElementId(a), port: "out" }, end: { elementId: asElementId(b), port: "in" } }, branches: [], flow: 0 };
}

function catchment(id: string, inlet: string, x: number, y: number): Zone {
  const outline = [{ x, y }, { x: x + 50 * FT, y }, { x: x + 50 * FT, y: y + 50 * FT }, { x, y: y + 50 * FT }];
  return { ...base, id: asElementId(id), kind: "zone", name: id, purpose: "drainage_catchment", spaceIds: [], bounds: { kind: "outline", levelId: L, outline }, servedBy: asElementId(inlet), classId: CIVIL_CLASS.catchment, values: { [CIVIL_PARAM.surface]: "paved" } };
}

function bigSite(): Record<string, BimElement> {
  const sys: MepSystem = { ...base, id: SYS, kind: "mep_system", name: "Storm", systemKind: CIVIL_STORM_SERVICE, domain: "pipe", classId: CIVIL_CLASS.stormSystem, values: { [CIVIL_PARAM.designIntensity]: 4 } };
  const els: BimElement[] = [sys, part("OF", CIVIL_CLASS.outfall, 0, 0, 0)];
  let prev = { id: "OF", x: 0 };
  for (let m = 1; m <= MANHOLES; m++) {
    const x = m * 300 * FT;
    const mid = `MH${m}`;
    els.push(part(mid, CIVIL_CLASS.manhole, x, 0, m * 1000), seg(`P${m}`, mid, x, 0, prev.id, prev.x, 0));
    for (let k = 1; k <= INLETS_PER; k++) {
      const iy = k * 100 * FT;
      const iid = `I${m}_${k}`;
      const down = k === 1 ? mid : `I${m}_${k - 1}`;
      els.push(part(iid, CIVIL_CLASS.stormInlet, x, iy, m * 1000 + 500 + k), seg(`P${m}_${k}`, iid, x, iy, down, x, k === 1 ? 0 : iy - 100 * FT), catchment(`C${m}_${k}`, iid, x + FT, iy + FT));
    }
    prev = { id: mid, x };
  }
  return Object.fromEntries(els.map((e) => [e.id, e]));
}

describe("storm network at 5,000 structures", () => {
  it("solves once, then re-totals one catchment edit along its path only", () => {
    const els = bigSite();
    const t0 = performance.now();
    const net = solveStormNetwork(els);
    const solveMs = performance.now() - t0;
    expect(net.site.structures).toHaveLength(1 + MANHOLES * (1 + INLETS_PER));
    expect(net.problems).toEqual([]);
    // Every catchment is 2,500 ft² paved: 0.95 × 4 × 2,500 / 43,200 = 0.219907 cfs; 4,900 of them.
    expect(to(net.totalRunoff.get("OF") ?? qty("flow_liquid", 0, "cfs"), "cfs")).toBeCloseTo((4900 * 0.95 * 4 * 2500) / 43200, 6);

    const live = net.incremental();
    // The deepest inlet: I100_49 → I100_48 … I100_1 → MH100 → … → MH1 → OF: 49 + 100 + 1 = 150 structures.
    const t1 = performance.now();
    const changed = live.setCatchmentRunoff("C100_49", qty("flow_liquid", 1, "cfs"));
    const editMs = performance.now() - t1;
    expect(changed).toHaveLength(150);
    expect(changed[0]).toBe("I100_49");
    expect(changed[changed.length - 1]).toBe("OF");
    const model: ModelState = { modelId: "c5v-scale", revision: 1 as ModelState["revision"], elements: els, connections: [], settings: DEFAULT_SETTINGS };
    const set = PackSet.create([CIVIL_PACK]);
    const t2 = performance.now();
    const kernel = runPackNetwork(model, set, CIVIL_STORM_SERVICE);
    const kernelMs = performance.now() - t2;
    if (!kernel.ok) throw new Error(kernel.reason);
    expect(kernel.totals.get("OF")?.[CIVIL_RUNOFF]).toBeCloseTo(net.totalRunoff.get("OF") ?? Number.NaN, 12);
    process.stdout.write(`[c5v perf] civil.storm.kernel_totals.5k ${kernelMs.toFixed(1)} ms (graph cached from the solve above)\n`);
    process.stdout.write(`[c5v perf] civil.storm.solve.5k ${solveMs.toFixed(1)} ms; civil.storm.one_catchment_edit.5k ${editMs.toFixed(3)} ms\n`);
  });
});
