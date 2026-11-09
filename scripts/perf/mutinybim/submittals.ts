/**
 * submittal.* — round 9 lane Q9: the design → submittal → field chain for one
 * element, and the submittals offered for one type, on the synthetic
 * 14-storey tower with 500 submittals (one per anchored element, every tenth
 * offered for a type) and 100 approved substitutions.
 *
 *   node --import tsx scripts/perf/mutinybim/submittals.ts [--samples=7]
 *
 *   submittal.chain_of.one_element   productChainOf one element, first read on a new revision (ms)
 *   submittal.depends_on.one_type    submittalsDependingOn one type, first read on a new revision (ms)
 *
 * The 250k and 1M rows run the same reads on synthetic-250k (Testing).
 */
import { commandSchema, elementValues, executeCommand, productChainOf, submittalsDependingOn, withUpgradePolicy, type ElementId, type ModelState } from "@permitzip/bim-kernel";
import { createFullBimModel } from "@permitzip/bim-first-party/seed";

import { emit } from "./lib";

const args = process.argv.slice(2);
const samples = Number(args.find((a) => a.startsWith("--samples="))?.split("=")[1] ?? 7);
const SUBMITTALS = 500;
const ACTOR = { id: "perf-reviewer", name: "Reviewer", kind: "human" as const };

function pct(xs: readonly number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return Math.round((s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0) * 100) / 100;
}

function time(fn: () => void): number {
  const t = performance.now();
  fn();
  return performance.now() - t;
}

function run(m: ModelState, command: unknown): ModelState {
  const r = withUpgradePolicy(() => true, () => executeCommand(m, commandSchema.parse(command), { actorId: ACTOR.id, actor: ACTOR, at: "2026-11-03T12:00:00.000Z" }));
  if (!r.ok) throw new Error(r.error.message);
  return r.model;
}

function build(): { model: ModelState; element: ElementId; type: ElementId } {
  let model = createFullBimModel({ floors: 14, zonesPerFloor: 2, rooms: { cols: 8, rows: 9 }, modelId: "synthetic-tower-14-submittals" });
  const parts = elementValues(model.elements).filter((e) => e.kind === "terminal");
  // The synthetic tower has no shared types; ten equipment ids stand in (the chain index keys any id the same way).
  const types = elementValues(model.elements).filter((e) => e.kind === "equipment").slice(0, 10);
  const step = Math.max(1, Math.floor(parts.length / SUBMITTALS));
  for (let k = 0; k < SUBMITTALS; k++) {
    const el = parts[(k * step) % parts.length];
    const type = types[k % Math.max(1, types.length)];
    if (!el) continue;
    const offeredFor = k % 10 === 0 && type ? { typeIds: [type.id] } : { elementIds: [el.id] };
    model = run(model, { type: "add_submittal", submittalId: `perf-sub-${k}`, title: `Product data ${k}`, offeredFor, items: [{ id: "1", label: "Product data" }, { id: "2", label: "Wiring", offeredFor: { elementIds: [el.id] } }] });
    if (k % 5 === 0) model = run(model, { type: "record_divergence", divergenceId: `perf-div-${k}`, designBasis: { elementIds: [el.id] }, approvedProduct: { label: "Maker B", submittalId: `perf-sub-${k}`, itemId: "1" }, notes: "" });
  }
  const element = parts[0]?.id;
  const type = types[0]?.id;
  if (!element || !type) throw new Error("the synthetic tower has no parts or types to offer submittals for");
  return { model, element, type };
}

const chain: number[] = [];
const depends: number[] = [];
let counts = { elements: 0, submittals: SUBMITTALS, chainSubmittals: 0, typeSubmittals: 0 };
for (let i = 0; i < samples; i++) {
  const { model, element, type } = build();
  // The model as a session holds it: read once (the store's kind index is built lazily on a first read).
  submittalsDependingOn(model.elements, type);
  // A new revision (one review, the common edit here): the first read builds the snapshot's index.
  const a = run(model, { type: "review_submittal", submittalId: "perf-sub-1", itemId: "1", state: "approved_as_noted", notes: `Sample ${i}` });
  let n = 0;
  chain.push(time(() => void (n = productChainOf(a.elements, element).submittals.length)));
  const b = run(a, { type: "review_submittal", submittalId: "perf-sub-2", state: "approved" });
  let t = 0;
  depends.push(time(() => void (t = submittalsDependingOn(b.elements, type).length)));
  counts = { elements: Object.keys(b.elements).length, submittals: SUBMITTALS, chainSubmittals: n, typeSubmittals: t };
}

const row = (xs: readonly number[]) => ({ p50: pct(xs, 50), p95: pct(xs, 95), n: xs.length });
process.stderr.write(`${JSON.stringify({ suite: "submittals", metrics: { "submittal.chain_of.one_element": row(chain), "submittal.depends_on.one_type": row(depends) }, counts }, null, 2)}\n`);
emit({
  suite: "batch",
  workload: { submittals: "500 on the synthetic tower, every tenth for a type, 100 approved substitutions", samples },
  network: "in-process (no network, no Postgres)",
  participants: 1,
  info: counts,
  samples: [
    { metric: "submittal.chain_of.one_element", values: chain, counts: { totalElements: counts.elements, affectedElements: counts.chainSubmittals }, note: "Design → submittal → field for one element, first read on a new revision." },
    { metric: "submittal.depends_on.one_type", values: depends, counts: { totalElements: counts.elements, affectedElements: counts.typeSubmittals }, note: "Submittals offered for one type, first read on a new revision." },
  ],
});
