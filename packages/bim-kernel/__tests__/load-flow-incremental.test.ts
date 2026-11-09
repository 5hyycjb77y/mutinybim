/**
 * @jest-environment node
 *
 * Editing one load point refolds only its path to the system's root
 * (routing/derive.ts deriveRunsAfter, routing/flow-trees.ts) instead of walking
 * the whole system. The numbers must be the full walk's numbers: after every
 * random edit (units, DFU, gal/h, MBH, inlet pressure, connection type, delete
 * and re-add a point, resize a pipe) a from-scratch recompute changes nothing.
 * Values are hundredths, which binary floating point can't hold exactly, so a
 * total folded in a different order than the full walk's would show up.
 * The local path is taken for a value edit on a system it kept; a structural
 * edit, or a system a water heater joins to another, walks in full.
 */
import {
  DEFAULT_SETTINGS,
  loadPointId,
  planCommit,
  recomputeDerived,
  runDeriveStats,
  runEndOf,
  type Command,
  type LoadPointElement,
  type ModelState,
  type QuantityBag,
  type QuantityKey,
} from "../src";
import { deriveRunsAfter } from "../src/routing/derive";
import { flowForestOf, type FlowTree } from "../src/routing/flow-trees";
import { buildGasLine, GAS_LINE_SYSTEM } from "./fixtures/gas-pe-line";
import { sampleMarketLoadPointCommand, sampleMarket } from "./fixtures/sample-market";

const NOW = () => "2026-10-28T12:00:00.000Z";
let key = 0;

function commit(model: ModelState, command: Command): ModelState | null {
  const d = planCommit(model, [], { idempotencyKey: `flow-${++key}`, baseRevision: model.revision, actor: { id: "avery", name: "Avery", kind: "human" }, command }, NOW);
  return d.ok ? d.model : null;
}

function commitOk(model: ModelState, command: Command): ModelState {
  const next = commit(model, command);
  if (!next) throw new Error(`${command.type} was refused`);
  return next;
}

/** Deterministic PRNG (mulberry32), so a failure reproduces. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleMarketModel(): ModelState {
  let m: ModelState = { modelId: "flow", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  const build = sampleMarket();
  for (const c of build.setup) m = commitOk(m, c);
  return commitOk(m, sampleMarketLoadPointCommand(build.points));
}

function loadPoints(m: ModelState): LoadPointElement[] {
  return Object.values(m.elements).filter((e): e is LoadPointElement => e.kind === "load_point");
}

function systemOf(m: ModelState, lp: LoadPointElement): string | null {
  const at = runEndOf(lp);
  const host = at ? m.elements[at.elementId] : undefined;
  return host?.kind === "run_segment" || host?.kind === "run_fitting" ? host.systemId : null;
}

/** The quantity each system's loads are counted in, for a value edit. */
const QUANTITY: Readonly<Record<string, QuantityKey>> = { "sys-san": "dfu", "sys-cw": "wsfu_cold", "sys-hw": "wsfu_hot", [GAS_LINE_SYSTEM]: "mbh" };
/** Systems a water heater joins (Example A's cold and hot water): their loads aren't local to one walk. */
const COUPLED = new Set(["sys-cw", "sys-hw"]);

function expectFullyDerived(m: ModelState, after: string): void {
  const fresh = recomputeDerived(m);
  if (fresh.changedIds.length > 0) throw new Error(`after ${after}, a full recompute still changes ${fresh.changedIds.slice(0, 8).join(", ")}`);
  expectKeptWalksExact(m, after);
}

/** Every kept walk's raw totals (before rounding) are the full walk's, bit for bit. */
function expectKeptWalksExact(m: ModelState, after: string): void {
  const forest = flowForestOf(m.elements);
  if (!forest) return;
  const saved = { ...runDeriveStats };
  for (const tree of new Set<FlowTree>(forest.treeOf.values())) {
    const root = tree.order[0];
    if (root === undefined) continue;
    const els = { ...m.elements };
    deriveRunsAfter({}, els, [], [root.includes("#") ? (tree.order.find((n) => !n.includes("#")) ?? root) : root] as never);
    const fresh = flowForestOf(els)?.treeOf.get(tree.order.find((n) => !n.includes("#")) ?? root);
    if (!fresh) throw new Error(`after ${after}, no fresh walk of ${root}`);
    for (const n of tree.order) {
      if (!Object.is(fresh.total.get(n), tree.total.get(n))) throw new Error(`after ${after}, kept total of ${n} is ${tree.total.get(n)}, a full walk folds ${fresh.total.get(n)}`);
    }
  }
  Object.assign(runDeriveStats, saved);
}

function stats(): { local: number; full: number } {
  return { ...runDeriveStats };
}

function run(seed: number, start: ModelState, steps: number): { local: number; full: number } {
  const next = rng(seed);
  let m = start;
  const removed: Array<{ hostId: string; port: string; connectionType?: string; mark?: string; values?: LoadPointElement["values"] }> = [];
  const counted = { local: 0, full: 0 };
  for (let step = 0; step < steps; step++) {
    const points = loadPoints(m).filter((lp) => systemOf(m, lp) !== null);
    const pick = <T,>(xs: readonly T[]): T | undefined => xs[Math.floor(next() * xs.length)];
    // With every point deleted (a one-point gas line), put one back first.
    const roll = points.length === 0 && removed.length > 0 ? 0.8 : next();
    if (roll < 0.55 && points.length > 0) {
      // A value edit, made twice: the second must take the local path on a system nobody joins.
      const lp = pick(points);
      if (!lp) continue;
      const system = systemOf(m, lp) ?? "";
      const q: QuantityKey = roll < 0.1 && system === GAS_LINE_SYSTEM ? "min_inlet_pressure" : roll < 0.15 && system === "sys-hw" ? "gph_demand" : (QUANTITY[system] ?? "dfu");
      for (let twice = 0; twice < 2; twice++) {
        const before = stats();
        const values = { [q]: Math.round(next() * 1000) / 100 + 0.01 } as QuantityBag;
        const edited = commit(m, { type: "edit_load_point", loadPointId: lp.id, values });
        if (!edited) continue;
        m = edited;
        expectFullyDerived(m, `edit ${lp.id} ${q} (seed ${seed}, step ${step})`);
        const after = stats();
        counted.local += after.local - before.local;
        counted.full += after.full - before.full;
        if (twice === 1 && !COUPLED.has(system)) expect(after.local - before.local).toBe(1);
        if (COUPLED.has(system)) expect(after.local - before.local).toBe(0);
      }
    } else if (roll < 0.65) {
      // Another connection type of the same trade: a value change through the catalog.
      const lp = pick(points.filter((p) => p.connectionType));
      const others = lp ? [...new Set(loadPoints(m).filter((p) => p.connectionType && p.connectionType !== lp.connectionType && systemOf(m, p) === systemOf(m, lp)).map((p) => p.connectionType ?? ""))] : [];
      const ct = pick(others);
      if (!lp || !ct) continue;
      const edited = commit(m, { type: "edit_load_point", loadPointId: lp.id, connectionType: ct });
      if (!edited) continue;
      m = edited;
      expectFullyDerived(m, `retype ${lp.id} to ${ct} (seed ${seed}, step ${step})`);
    } else if (roll < 0.78) {
      // Delete a point: the pipe end is open again, a different shape.
      const lp = pick(points);
      const at = lp ? runEndOf(lp) : null;
      if (!lp || !at) continue;
      const before = stats();
      const edited = commit(m, { type: "delete_load_points", loadPointIds: [lp.id] });
      if (!edited) continue;
      removed.push({ hostId: at.elementId, port: at.port, values: lp.values, ...(lp.connectionType ? { connectionType: lp.connectionType } : {}), ...(lp.mark ? { mark: lp.mark } : {}) });
      m = edited;
      expectFullyDerived(m, `delete ${lp.id} (seed ${seed}, step ${step})`);
      expect(stats().local - before.local).toBe(0);
    } else if (roll < 0.9 && removed.length > 0) {
      // Put a deleted point back.
      const at = removed[removed.length - 1];
      if (!at) continue;
      const before = stats();
      const edited = commit(m, { type: "create_load_point", points: [at] });
      if (!edited) throw new Error(`re-adding ${loadPointId(at.hostId, at.port)} was refused (seed ${seed}, step ${step})`);
      removed.pop();
      m = edited;
      expectFullyDerived(m, `re-add ${loadPointId(at.hostId, at.port)} (seed ${seed}, step ${step})`);
      expect(stats().local - before.local).toBe(0);
    } else {
      // Resize a pipe that carries loads: a pipe edit is never a load-only edit.
      const seg = pick(Object.values(m.elements).filter((e) => e.kind === "run_segment" && e.flow > 0 && e.size.shape === "pipe"));
      if (seg?.kind !== "run_segment" || seg.size.shape !== "pipe") continue;
      const before = stats();
      const edited = commit(m, { type: "resize_run", segmentId: seg.id, profile: { ...seg.size, nominalMm: seg.size.nominalMm === 25.4 ? 31.75 : 25.4 } });
      if (!edited) continue;
      m = edited;
      expectFullyDerived(m, `resize ${seg.id} (seed ${seed}, step ${step})`);
      expect(stats().local - before.local).toBe(0);
    }
  }
  return counted;
}

describe("a load-point edit refolds only its path, with the full walk's numbers", () => {
  it.each([1, 7, 42])("Example A (water, hot water through a heater, sanitary): random edits, seed %i", (seed) => {
    const counted = run(seed, sampleMarketModel(), 60);
    expect(counted.local).toBeGreaterThan(0);
  });

  it.each([3, 11])("a gas line (MBH, inlet pressure on a regulated service): random edits, seed %i", (seed) => {
    const m = buildGasLine({ fuel: "natural", end: { loadPointMbh: 120 } });
    const counted = run(seed, m, 30);
    expect(counted.local).toBeGreaterThan(0);
  });

  it("the second edit of a sanitary point is local and moves only its path to the outfall", () => {
    let m = sampleMarketModel();
    const fd = loadPoints(m).find((lp) => systemOf(m, lp) === "sys-san");
    if (!fd) throw new Error("no sanitary point");
    m = commitOk(m, { type: "edit_load_point", loadPointId: fd.id, values: { dfu: 3 } });
    const before = stats();
    const d = planCommit(m, [], { idempotencyKey: `flow-${++key}`, baseRevision: m.revision, actor: { id: "avery", name: "Avery", kind: "human" }, command: { type: "edit_load_point", loadPointId: fd.id, values: { dfu: 5 } } }, NOW);
    if (!d.ok) throw new Error(d.error.message);
    expect(stats()).toEqual({ local: before.local + 1, full: before.full });
    expectFullyDerived(d.model, "the second sanitary edit");
    // An older head still reads its own numbers (the kept walk is a snapshot, not shared state).
    expectFullyDerived(m, "the head before it");
  });
});
