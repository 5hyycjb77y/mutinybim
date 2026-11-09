/**
 * Where the model server's memory goes, step by step, on the synthetic full-BIM
 * model: the same load, first join, first commit and warm-up as synthetic.ts,
 * with the heap read (after a full collection) between each step. A diagnosis
 * tool for memory.server.heap / memory.server.rss, not a gate row.
 *
 *   node --expose-gc --import tsx scripts/perf/mutinybim/memory-probe.ts --tier=250k [--in-process]
 *   node --expose-gc --import tsx scripts/perf/mutinybim/memory-probe.ts --tier=1M --copies=2 [--copy-kind=branch|separate] [--enforce]
 *
 * By default the model arrives as rows from a generator process (server-load.ts),
 * as the server reads storage; --in-process generates it here, as synthetic.ts
 * did before round 8, to show what the harness's copy costs.
 *
 * --copies=N keeps N copies open in the one server process, each with its own
 * store, sequencer, hub and person editing it (round 13 owed: "two copies
 * open"). `branch` (default) opens each further copy from the first one's head,
 * sharing what it hasn't changed, as a contractor copy does; `separate` reads
 * each copy's rows from the generator again, as two unrelated models would.
 * --enforce holds the final RSS to `memory.server.rss.two_copies.1M` when the
 * run is 1M with two copies (exit 1 over it).
 *
 * Prints one JSON object: heap and rss after each step, and the growth each step
 * caused.
 */
import {
  warmModel,
  type Actor,
  type Command,
  type Interest,
  type ModelState,
} from "@permitzip/bim-kernel";
import { FULL_BIM_TIERS, createFullBimModel } from "@permitzip/bim-first-party/seed";
import { InMemoryCommitStore, Sequencer, SyncClient, SyncHub, type HubConnection } from "@permitzip/bim-sync";
import { loadBudgets, memoryMB, round } from "./lib";
import { loadModelLikeServer } from "./server-load";

const FT = 304.8;
const TWO_COPIES_METRIC = "memory.server.rss.two_copies.1M";
const args = process.argv.slice(2);
const arg = (name: string, fallback: string): string => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const tier = arg("tier", "250k");
if (!(tier in FULL_BIM_TIERS)) throw new Error(`--tier must be one of ${Object.keys(FULL_BIM_TIERS).join(", ")}`);
const opts = FULL_BIM_TIERS[tier as keyof typeof FULL_BIM_TIERS];
const copies = Number(arg("copies", "1"));
if (!Number.isInteger(copies) || copies < 1 || copies > 4) throw new Error(`--copies must be 1 to 4; got ${arg("copies", "")}`);
const copyKind = arg("copy-kind", "branch");
if (copyKind !== "branch" && copyKind !== "separate") throw new Error(`--copy-kind must be branch or separate; got ${copyKind}`);
if (copies > 1 && args.includes("--in-process")) throw new Error("--copies reads rows from the generator process; drop --in-process");
if (typeof (globalThis as { gc?: () => void }).gc !== "function") throw new Error("[memory-probe] run with node --expose-gc");

interface Step {
  readonly step: string;
  readonly heap: number;
  readonly rss: number;
  readonly heapGrowth: number;
}

interface OpenCopy {
  readonly store: InMemoryCommitStore;
  readonly client: SyncClient;
}

async function main(): Promise<void> {
  const steps: Step[] = [];
  let last = memoryMB();
  const mark = (step: string): void => {
    const now = memoryMB();
    steps.push({ step, heap: now.heap, rss: now.rss, heapGrowth: round(now.heap - last.heap, 1) });
    last = now;
  };
  mark("process start");

  let head: ModelState | null;
  let totalElements: number;
  if (args.includes("--in-process")) {
    // The old harness shape: the generator's copy lives in this process too.
    let generated: ModelState | null = createFullBimModel(opts);
    totalElements = Object.keys(generated.elements).length;
    mark("harness generated the model");
    head = structuredClone({ ...generated, elements: Object.fromEntries(Object.entries(generated.elements)) });
    mark("server copy loaded (plain records)");
    generated = null;
    mark("harness copy released");
  } else {
    const loaded = await loadModelLikeServer(tier as keyof typeof FULL_BIM_TIERS);
    head = loaded.model;
    totalElements = Object.keys(head.elements).length;
    mark("server rows read from the generator process");
  }

  const open: OpenCopy[] = [];
  open.push(await serveCopy(head, "", mark));
  head = null;

  for (let n = 2; n <= copies; n++) {
    let next: ModelState;
    if (copyKind === "branch") {
      const base = await open[0]?.store.head();
      if (!base) throw new Error("[memory-probe] the first copy has no head to open a copy from");
      next = { ...base, modelId: `${base.modelId}-copy-${n}` };
      mark(`copy ${n} opened from copy 1's head (shares what it hasn't changed)`);
    } else {
      next = (await loadModelLikeServer(tier as keyof typeof FULL_BIM_TIERS)).model;
      next = { ...next, modelId: `${next.modelId}-copy-${n}` };
      mark(`copy ${n} rows read from the generator process`);
    }
    open.push(await serveCopy(next, ` (copy ${n})`, mark));
  }

  const finalRss = steps[steps.length - 1]?.rss ?? 0;
  let verdict: { metric: string; budgetMB: number; rssMB: number; pass: boolean } | null = null;
  if (copies === 2 && tier === "1M") {
    const budget = loadBudgets().metrics[TWO_COPIES_METRIC];
    if (!budget) throw new Error(`[memory-probe] docs/perf/mutinybim-budgets.json has no ${TWO_COPIES_METRIC} row`);
    verdict = { metric: TWO_COPIES_METRIC, budgetMB: budget.p50, rssMB: finalRss, pass: finalRss <= budget.p50 };
  }

  console.log(JSON.stringify({ tier, totalElements, copies, ...(copies > 1 ? { copyKind } : {}), steps, ...(verdict ? { verdict } : {}) }, null, 1));
  for (const copy of open) copy.client.dispose();
  if (args.includes("--enforce")) {
    if (!verdict) {
      console.error(`[memory-probe] --enforce needs --tier=1M --copies=2 (the only row with a budget: ${TWO_COPIES_METRIC})`);
      process.exit(1);
    }
    if (!verdict.pass) {
      console.error(`[memory-probe] FAIL: ${TWO_COPIES_METRIC} RSS ${verdict.rssMB} MB is over its ${verdict.budgetMB} MB budget`);
      process.exit(1);
    }
  }
  process.exit(0);
}

/** One open copy on the server: its store, sequencer and hub, one person joined to a zone, a first commit, warm-up, five more commits. */
async function serveCopy(model: ModelState, suffix: string, mark: (step: string) => void): Promise<OpenCopy> {
  const store = new InMemoryCommitStore(model);
  const sequencer = await Sequencer.start(store);
  const hub = new SyncHub(sequencer);
  mark(`sequencer + hub started${suffix}`);

  const p = `L${String(opts.floors).padStart(2, "0")}-Z${opts.zonesPerFloor}`;
  const interest: Interest = { areas: [{ level: `L${String(opts.floors).padStart(2, "0")}`, zone: `Z${opts.zonesPerFloor}` }] };
  const actor: Actor = { id: "author", name: "Author", kind: "human" };
  let onMessage: ((data: string) => void) | null = null;
  const conn: HubConnection = {
    id: `probe-${model.modelId}`,
    send: (data: string) => {
      client.receive(data);
      onMessage?.(data);
    },
  };
  const client: SyncClient = new SyncClient(
    {
      send: (data) => {
        hub.handle(conn, data).catch((err) => console.error("[memory-probe] hub.handle failed", err));
      },
      close: () => hub.leave(conn),
    },
    actor,
    {},
    600_000,
    { interest },
  );
  const next = (type: string): Promise<void> =>
    new Promise((resolve) => {
      onMessage = (data) => {
        if (data.startsWith(`{"type":"${type}"`)) {
          onMessage = null;
          resolve();
        }
      };
    });

  hub.join(conn);
  const welcomed = next("welcome");
  client.opened();
  await welcomed;
  mark(`first join (one zone)${suffix}`);

  const command: Command = { type: "slide_branch", tapId: `${p}-air-t1-s2-b1-tap`, s: 3.25 * FT };
  const outcome = next("outcome");
  const submitted = client.submit(command);
  if (!submitted.ok) throw new Error(`[memory-probe] first edit refused locally${suffix}: ${submitted.error.message}`);
  await outcome;
  mark(`first commit${suffix}`);

  warmModel(await store.head());
  mark(`warmModel(head)${suffix}`);

  for (let i = 0; i < 5; i++) {
    const o = next("outcome");
    const r = client.submit({ type: "slide_branch", tapId: `${p}-air-t1-s2-b1-tap`, s: (i % 2 === 0 ? 3.5 : 3.25) * FT });
    if (!r.ok) throw new Error(`[memory-probe] edit ${i} refused locally${suffix}: ${r.error.message}`);
    await o;
  }
  mark(`five more commits${suffix}`);
  return { store, client };
}

main().catch((err) => {
  console.error("[memory-probe] failed", err);
  process.exit(1);
});
