/**
 * @jest-environment node
 *
 * The indexed / incremental kernel must decide every command exactly as the
 * original full-scan kernel did (frozen in ./reference): same errors, same
 * changed elements in the same order, same changeset bytes.
 */
import {
  canonicalJson,
  executeCommand,
  planCommit,
  slideLimit,
  validateModel,
  type Changeset,
  type ModelState,
  type Profile,
  plainElements,
} from "../src";
import { HEAVY_TIERS, createDemoModel, createHeavyModel } from "@permitzip/bim-pack-mechanical/seed";
import { executeCommand as refExecute, slideLimit as refSlideLimit, type Command as RefCommand } from "./reference/commands";
import { planCommit as refPlan, type Changeset as RefChangeset, type CommandRequest as RefCommandRequest } from "./reference/changeset";
import { validateModel as refValidate } from "./reference/validate";
import { asReference } from "./reference/adapt";
import type { ModelState as RefModelState } from "./reference/types";

const FT = 304.8;
const NOW = () => "2026-10-17T00:00:00.000Z";

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function pick<T>(items: readonly T[], r: () => number): T {
  const item = items[Math.floor(r() * items.length)];
  if (item === undefined) throw new Error("pick from empty list");
  return item;
}

const PROFILES: readonly Profile[] = [
  { shape: "rect", width: 10 * 25.4, height: 8 * 25.4 },
  { shape: "rect", width: 12 * 25.4, height: 8 * 25.4 },
  { shape: "rect", width: 30 * 25.4, height: 12 * 25.4 },
  { shape: "round", diameter: 9 * 25.4 },
];

function randomCommand(model: ModelState, r: () => number): RefCommand {
  const all = Object.values(model.elements);
  const taps = all.filter((el) => el.kind === "tap");
  const terminals = all.filter((el) => el.kind === "terminal");
  const segments = all.filter((el) => el.kind === "duct_segment");
  const units = all.filter((el) => el.kind === "equipment");
  const roll = r();
  if (roll < 0.45) {
    const tap = pick(taps, r);
    return { type: "slide_branch", tapId: tap.id, s: Math.round((tap.s + (r() - 0.5) * 8 * FT) * 10) / 10 };
  }
  if (roll < 0.75) {
    const t = pick(terminals, r);
    // Fractional values on purpose: airflow sums must add up in the same order.
    return { type: "set_terminal_cfm", terminalId: t.id, cfm: Math.round(r() * 90000) / 100 };
  }
  if (roll < 0.9) return { type: "resize_run", segmentId: pick(segments, r).id, profile: pick(PROFILES, r) };
  const along = r() < 0.5;
  const d = Math.round((r() - 0.5) * 4 * FT);
  return { type: "move_equipment", equipmentId: pick(units, r).id, delta: along ? { x: d, y: 0 } : { x: 0, y: d } };
}

/** Same data, fresh objects: what a backend sees after loading from storage (no identity caches). */
function cold(model: ModelState): ModelState {
  return structuredClone({ ...model, elements: plainElements(model.elements) });
}

interface Chain {
  head: ModelState;
  log: Changeset[];
  refHead: RefModelState;
  refLog: RefChangeset[];
}

/**
 * Fields the part-command work added to every result and changeset (structural
 * changes, and the prior records undo restores from). The reference kernel
 * predates them; with no structural change they carry nothing it decided.
 */
function withoutAdditions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutAdditions);
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === "before") continue;
    if ((k === "removedIds" || k === "removedConnections" || k === "addedConnections") && Array.isArray(v) && v.length === 0) continue;
    out[k] = k === "elements" || k === "model" || k === "changeset" ? withoutAdditions(v) : v;
  }
  return out;
}

function step(chain: Chain, r: () => number, i: number): { ok: boolean } {
  const command = randomCommand(chain.head, r);
  const stale = chain.log.length > 2 && r() < 0.3;
  const baseRevision = stale ? chain.head.revision - 2 : chain.head.revision;
  const actor = r() < 0.5 ? { id: "priya", name: "Priya", kind: "human" as const } : { id: "agent-1", name: "Agent-1", kind: "agent" as const };
  const request: RefCommandRequest = { idempotencyKey: `step-${i}-key`, baseRevision, actor, command };

  const exec = executeCommand(chain.head, command);
  const refExec = refExecute(chain.refHead, command);
  expect(canonicalJson(withoutAdditions(exec))).toBe(canonicalJson(refExec));

  const decision = planCommit(chain.head, chain.log.filter((cs) => cs.revision > baseRevision), request, NOW);
  const refDecision = refPlan(chain.refHead, chain.refLog.filter((cs) => cs.revision > baseRevision), request, NOW);
  expect(canonicalJson(withoutAdditions(decision))).toBe(canonicalJson(refDecision));
  if (decision.ok) expect(decision.changeset.before).toBeDefined();
  if (decision.ok && refDecision.ok) {
    chain.head = decision.model;
    chain.log.push(decision.changeset);
    chain.refHead = refDecision.model;
    chain.refLog.push(refDecision.changeset);
  }
  return { ok: decision.ok };
}

function runChain(start: ModelState, steps: number, seed: number, coldEvery = 0): { committed: number; rejected: number } {
  const r = rng(seed);
  const chain: Chain = { head: start, log: [], refHead: asReference(start), refLog: [] };
  let committed = 0;
  for (let i = 0; i < steps; i++) {
    if (coldEvery > 0 && i > 0 && i % coldEvery === 0) chain.head = cold(chain.head);
    if (step(chain, r, i).ok) committed += 1;
  }
  expect(canonicalJson(chain.head)).toBe(canonicalJson(chain.refHead));
  expect(validateModel(chain.head)).toEqual(refValidate(chain.refHead));
  return { committed, rejected: steps - committed };
}

describe("indexed kernel decides exactly like the full-scan kernel", () => {
  it("demo model: 300 random commands, mixed bases and actors", () => {
    const { committed, rejected } = runChain(createDemoModel(), 300, 7, 37);
    expect(committed).toBeGreaterThan(20);
    expect(rejected).toBeGreaterThan(20);
  });

  it("tier S (~2k elements): 40 random commands, some after a cold reload", () => {
    const { committed } = runChain(createHeavyModel(HEAVY_TIERS.S), 40, 11, 9);
    expect(committed).toBeGreaterThan(5);
  }, 120_000);

  it("tier M (~10k elements): 3 random commands", () => {
    const { committed } = runChain(createHeavyModel(HEAVY_TIERS.M), 3, 5);
    expect(committed).toBeGreaterThan(0);
  }, 300_000);

  it("a base that is already invalid: both kernels let unrelated edits through and decide the same (bug log #18)", () => {
    const valid = createHeavyModel({ units: 2, segmentsPerTrunk: 3 });
    const tap = valid.elements["tap-u2-s3-b2"];
    if (!tap || tap.kind !== "tap") throw new Error("fixture tap missing");
    const broken: ModelState = { ...valid, elements: { ...valid.elements, [tap.id]: { ...tap, s: 100 } } };
    expect(refValidate(asReference(broken)).length).toBeGreaterThan(0);
    const { committed } = runChain(broken, 25, 3);
    expect(committed).toBeGreaterThan(0);
  });

  it("drag limits match on the demo model and on tier S", () => {
    const demo = createDemoModel();
    for (const [tapId, s] of [["tap-1", 18 * FT], ["tap-1", 1 * FT], ["tap-2", 36 * FT], ["tap-2", 13 * FT]] as const) {
      expect(slideLimit(demo, tapId, s)).toEqual(refSlideLimit(asReference(demo), tapId, s));
    }
    const heavy = createHeavyModel(HEAVY_TIERS.S);
    expect(slideLimit(heavy, "tap-u12-s15-b1", 9.5 * FT)).toEqual(refSlideLimit(asReference(heavy), "tap-u12-s15-b1", 9.5 * FT));
  }, 120_000);

  it("heavy tiers are valid networks with the documented element counts", () => {
    for (const opts of Object.values(HEAVY_TIERS)) {
      const model = createHeavyModel(opts);
      expect(Object.keys(model.elements)).toHaveLength(opts.units * (1 + 11 * opts.segmentsPerTrunk));
      expect(validateModel(model)).toEqual([]);
    }
  }, 60_000);
});
