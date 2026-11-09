/**
 * Live plumbing risers for the electrical suite's diagram metrics: a sanitary
 * main with 200 fixtures, each on its own 2" branch (a large restaurant
 * floor), built through executeCommand as a person would draw it.
 *
 * - diagram.plumbing_riser.evaluate.200: the riser from scratch: the pipe
 *   report, the topology walk, labels, layout, drawing items and pipe targets.
 * - diagram.plumbing_riser.after_edit.200: the same riser after one branch is
 *   resized, the whole riser derived again (never patched).
 * - diagram.plumbing_isometric.evaluate.200: the isometric from scratch.
 *
 * Also counts evaluations of the same model that drew different items
 * (`diagram.nondeterministic`, must be 0).
 */
import { evaluateDiagram, executeCommand, freezeElements, type Command, type ModelState, type PartTypeDefinition, type ViewElement } from "@permitzip/bim-kernel";
import { createFullBimModel } from "@permitzip/bim-first-party/seed";
import { timeSync } from "./lib";

const FT = 304.8;
const IN = 25.4;
const FIXTURES = 200;

const fixture: PartTypeDefinition = {
  familyName: "Floor sink",
  typeName: "Perf",
  category: "plumbing_fixture",
  typeParams: [],
  typeValues: {},
  instanceParams: [],
  connectors: [{ id: "c", label: "c", domain: "pipe", systemKind: "sanitary", position: [0, 0, 0], direction: [1, 0, 0], shape: "none", flow: 5 }],
  geometry: [{ kind: "box", center: [0, 0, 100], size: [300, 300, 200] }],
  symbol: [{ kind: "rect", center: [0, 0], size: [300, 300] }],
  tagFields: ["mark"],
  source: { kind: "builtin", libraryVersion: "perf" },
};

function run(model: ModelState, command: Command): ModelState {
  const r = executeCommand(model, command);
  if (!r.ok) throw new Error(`[perf/plumbing-risers] ${command.type} refused: ${r.error.message}`);
  return r.model;
}

/** A 4" sanitary main 2 ft below the floor, 200 fixtures on 2" branches every 2 ft, an open outfall. */
export function riserModel(): ModelState {
  let model: ModelState = { modelId: "riser-perf", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: createFullBimModel({ floors: 1, zonesPerFloor: 1 }).settings };
  const system = { id: "sys-san", kind: "sanitary" as const, name: "Sanitary" };
  const pvc = (inches: number) => ({ shape: "pipe" as const, nominalMm: inches * IN, material: "pvc" as const });
  model = run(model, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  model = run(model, { type: "route_run", idPrefix: "m", levelId: "lvl-1", domain: "pipe", size: pvc(4), elevationMm: -2 * FT, system, points: [{ x: 0, y: 0 }, { x: (FIXTURES * 2 + 4) * FT, y: 0 }] });
  for (let k = 0; k < FIXTURES; k++) {
    const x = (4 + 2 * k) * FT;
    const prefix = `b${k}`;
    model = run(model, { type: "route_run", idPrefix: prefix, levelId: "lvl-1", domain: "pipe", size: pvc(2), system, points: [{ x, y: 6 * FT }, { x, y: 0 }], to: { kind: "run_branch", segmentId: "m-s1" } });
    const seg = model.elements[`${prefix}-s1`];
    if (seg?.kind !== "run_segment") throw new Error(`[perf/plumbing-risers] no branch ${prefix}`);
    model = run(model, { type: "place_part", partId: `fx${k}`, typeId: "t-fx", ...(k === 0 ? { partType: fixture } : {}), levelId: "lvl-1", position: { x: seg.start.x, y: seg.start.y }, offsetMm: seg.start.z, rotationDeg: -90, mark: `FS-${k + 1}` });
    model = run(model, { type: "connect_runs", a: { elementId: `${prefix}-s1`, port: "start" }, b: { elementId: `fx${k}`, port: "c" } });
  }
  return { ...model, elements: freezeElements({ ...model.elements }) };
}

export function plumbingRiserSamples(samples: number): { riser: number[]; afterEdit: number[]; isometric: number[]; fixtures: number; elements: number; nondeterministic: number } {
  let model = riserModel();
  const riserView = { id: "v-riser", props: { diagram: { kind: "plumbing_riser" as const } } } as Pick<ViewElement, "id" | "props">;
  const isoView = { id: "v-iso", props: { diagram: { kind: "plumbing_isometric" as const } } } as Pick<ViewElement, "id" | "props">;
  const riser: number[] = [];
  const isometric: number[] = [];
  const afterEdit: number[] = [];
  let fixtures = 0;
  let nondeterministic = 0;
  let firstBytes = "";
  for (let i = 0; i < samples; i++) {
    // A fresh element map each sample: no evaluation cache to hit.
    const fresh = { ...model.elements };
    const t = timeSync(() => evaluateDiagram(fresh, riserView));
    riser.push(t.ms);
    fixtures = (t.value?.boxes ?? []).filter((b) => !b.pipe && String(b.elementId).startsWith("fx")).length;
    const bytes = JSON.stringify(t.value?.items ?? []);
    if (!firstBytes) firstBytes = bytes;
    else if (bytes !== firstBytes) nondeterministic += 1;
    const fresh2 = { ...model.elements };
    isometric.push(timeSync(() => evaluateDiagram(fresh2, isoView)).ms);
  }
  for (let i = 0; i < samples; i++) {
    const id = `b${i % FIXTURES}-s1`;
    const seg = model.elements[id];
    const nominal = seg?.kind === "run_segment" && seg.size.shape === "pipe" && seg.size.nominalMm > 2.5 * IN ? 2 : 3;
    model = run(model, { type: "resize_run", segmentId: id, profile: { shape: "pipe", nominalMm: nominal * IN, material: "pvc" } });
    const head = model;
    afterEdit.push(timeSync(() => evaluateDiagram(head.elements, riserView)).ms);
  }
  return { riser, afterEdit, isometric, fixtures, elements: Object.keys(model.elements).length, nondeterministic };
}
