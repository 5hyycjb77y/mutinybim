/**
 * Full-model scan costs at a tier: the proxy reads the guard bans against the
 * indexed reads that replace them, on a committed head and on a prediction
 * (what executeCommand returns before the server confirms it).
 *
 *   node --import tsx scripts/perf/mutinybim/store-scan-bench.ts --tier=250k
 */
import { elementCount, elementValues, elementsOfKind, executeCommand, freezeElements, type ModelState } from "@permitzip/bim-kernel";
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import { FULL_BIM_TIERS, createFullBimModel } from "@permitzip/bim-first-party/seed";

// A host like the model server: the kernel carries no trade, so taps, their hosts and the tree's totals come from the first-party add-ons.
installFirstPartyAddOns();

const tierArg = process.argv.find((a) => a.startsWith("--tier="))?.slice(7) ?? "250k";
if (!(tierArg in FULL_BIM_TIERS)) throw new Error(`--tier must be one of ${Object.keys(FULL_BIM_TIERS).join(", ")}`);
const tier = tierArg as keyof typeof FULL_BIM_TIERS;
const generated = createFullBimModel({ ...FULL_BIM_TIERS[tier], modelId: "scan-bench" });
const head: ModelState = { ...generated, elements: freezeElements(generated.elements) };
const tap = elementsOfKind(head.elements, "tap")[0];
if (!tap) throw new Error("no tap");
const predicted = executeCommand(head, { type: "slide_branch", tapId: tap.id, s: tap.s + 100 }, { history: [], actorId: "bench" });
if (!predicted.ok) throw new Error(predicted.error.message);
const prediction = predicted.model.elements;

function time(label: string, run: () => unknown): void {
  const samples: number[] = [];
  for (let i = 0; i < 7; i++) {
    const t0 = performance.now();
    run();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  console.log(`${label.padEnd(58)} median ${samples[3]?.toFixed(1)} ms  (min ${samples[0]?.toFixed(1)})`);
}

console.log(`[scan-bench] ${tier}: ${elementCount(head.elements)} elements`);
time("head: Object.values(model.elements)", () => Object.values(head.elements));
time("head: elementValues", () => elementValues(head.elements));
time("head: Object.values(...).filter(kind === mep_system)", () => Object.values(head.elements).filter((el) => el.kind === "mep_system"));
time("head: elementsOfKind(mep_system)", () => elementsOfKind(head.elements, "mep_system"));
time("head: Object.keys(...).length", () => Object.keys(head.elements).length);
time("head: elementCount", () => elementCount(head.elements));
time("prediction: Object.values", () => Object.values(prediction));
time("prediction: elementValues", () => elementValues(prediction));
time("prediction: elementsOfKind(terminal)", () => elementsOfKind(prediction, "terminal"));
