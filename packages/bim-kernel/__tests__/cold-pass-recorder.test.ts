/**
 * @jest-environment node
 *
 * The cold pass records which add-on contributions each check reads (round 9
 * K9), so recording runs on every first save of a loaded head and on every
 * edit a client predicts. On integration 93945bcd7 it was the whole of the
 * `commit.cold` regression at 1M (385 → 821 ms p50): each check's reads were
 * collected into an array truncated with `length = 0`, which frees its
 * storage, so every check allocated again and the pass ran ~1.6x slower.
 *
 * Pinned here: a recorded check allocates nothing once its reads are known,
 * and a check that reads fewer contributions than the one before it records
 * only its own (the recorder now reuses one buffer across checks).
 */
import { GCProfiler } from "node:v8";
import { elementSlots, type ModelState } from "../src";
import { FULL_BIM_TIERS, createFullBimModel } from "@permitzip/bim-first-party/seed";
import { activePackSet } from "../src/packs";
import { recordPackSetReads, type PackSetReadKind, type PackSetReadRecorder, type RecordedPoint } from "../src/packs/set";
import { elementKindTable } from "../src/registry/element-kind-point";
import { treeNetwork } from "../src/tree-network";
import { exportPointReads, recordPass } from "../src/validate-ledger";

const XS: ModelState = createFullBimModel(FULL_BIM_TIERS.XS);

/** Every read `fn` makes of the pack set in force, as "kind:id". */
function readsOf(fn: () => void): Set<string> {
  const out = new Set<string>();
  const collector: PackSetReadRecorder = {
    note(kind: PackSetReadKind, target: RecordedPoint | string) {
      out.add(`${kind}:${typeof target === "string" ? target : target.id}`);
    },
  };
  recordPackSetReads(collector, fn);
  return out;
}

/** The reads `exportPointReads` holds for each element id, as "kind:id". */
function recordedById(model: ModelState): Map<string, Set<string>> {
  const exported = exportPointReads(model);
  if (!exported) throw new Error("the pass left no usable point index");
  const exceptions = new Map(exported.exceptionIds.map((id, n) => [id, exported.exceptionSigs[n]]));
  const out = new Map<string, Set<string>>();
  const slots = elementSlots(model.elements);
  for (let slot = 0; slot < slots.size; slot++) {
    const el = slots.at(slot);
    if (!el) continue;
    const sig = exceptions.get(el.id) ?? exported.byKind[el.kind];
    if (sig === undefined || sig === 1 || sig === 0xffff) throw new Error(`${el.id} has signature ${String(sig)}`);
    const keys = sig === 0 ? [] : (exported.signatures[sig - 2] ?? []);
    out.set(el.id, new Set(keys.map((k) => {
      const key = exported.keys[k];
      if (!key) throw new Error(`key ${k} is not in the index`);
      return `${key.kind}:${key.id}`;
    })));
  }
  return out;
}

const manyPacks = (): void => {
  for (let k = 0; k < 20; k++) activePackSet().pack(`cold-recorder-probe-${k}`);
};

describe("cold-pass-recorder", () => {
  it("records each check's own reads when it reads fewer than the check before it", () => {
    const kinds = readsOf(() => elementKindTable());
    const tree = readsOf(() => treeNetwork());
    const packs = readsOf(manyPacks);
    // Three read lists of different lengths: kinds alone, kinds + tree, kinds + 20 packs (past the buffer's first size).
    expect(kinds.size).toBeGreaterThan(0);
    expect([...tree].some((r) => !kinds.has(r))).toBe(true);
    expect(packs.size).toBe(20);

    const model: ModelState = { ...XS, elements: { ...XS.elements } };
    const slots = elementSlots(model.elements);
    const expected = new Map<string, Set<string>>();
    const pass = recordPass(model);
    try {
      for (let slot = 0; slot < slots.size; slot++) {
        const el = slots.at(slot);
        if (!el) continue;
        pass.begin();
        elementKindTable();
        if (slot % 5 === 0) manyPacks();
        else if (slot % 2 === 0) treeNetwork();
        pass.element(slot);
        expected.set(el.id, new Set([...kinds, ...(slot % 5 === 0 ? packs : slot % 2 === 0 ? tree : [])]));
      }
    } finally {
      pass.end();
    }

    const recorded = recordedById(model);
    expect(recorded.size).toBe(expected.size);
    for (const [id, reads] of expected) expect([...(recorded.get(id) ?? [])].sort()).toEqual([...reads].sort());
  });

  it("recording a million checks allocates no more than running them unrecorded", () => {
    const model: ModelState = { ...XS, elements: { ...XS.elements } };
    const size = elementSlots(model.elements).size;
    const checks = 1_000_000;
    const scavengesIn = (fn: () => void): number => {
      const profiler = new GCProfiler();
      profiler.start();
      fn();
      return (profiler.stop()?.statistics ?? []).filter((event) => event.gcType === "Scavenge").length;
    };
    const pass = recordPass(model);
    let recorded = 0;
    let unrecorded = 0;
    try {
      // Every table and signature is met once before measuring.
      for (let slot = 0; slot < size; slot++) {
        pass.begin();
        elementKindTable();
        pass.element(slot);
      }
      recorded = scavengesIn(() => {
        for (let i = 0; i < checks; i++) {
          pass.begin();
          elementKindTable();
          pass.element(i % size);
        }
      });
      pass.pause();
      unrecorded = scavengesIn(() => {
        for (let i = 0; i < checks; i++) elementKindTable();
      });
    } finally {
      pass.end();
    }
    // The array-backed recorder allocated a fresh store per check (~80 MB a million checks): 11 more scavenges than
    // unrecorded under Jest (17 vs 6), 9 against 0 compiled by tsx. The reused buffer: 3 under Jest, 0 under tsx.
    expect(recorded).toBeLessThanOrEqual(unrecorded + 5);
  });
});
