/**
 * Profiling harness for the four 1M rows that sit over budget: join.cold,
 * commit.cold, memory.server.heap/rss and view.visibility.resolve. Runs the same
 * steps as synthetic.ts (same model, same load, same first join, same first
 * command, same warm-up, same visibility setup) and prints the same figures, plus
 * where the time goes (performance marks around each server step) and a memory
 * breakdown. It is a diagnosis tool, not a gate row: synthetic.ts stays the
 * measurement.
 *
 *   node --expose-gc --import tsx scripts/perf/mutinybim/cold-paths.ts --tier=250k
 *   node --expose-gc --cpu-prof --cpu-prof-dir=/tmp/bim-prof --import tsx scripts/perf/mutinybim/cold-paths.ts --tier=250k
 */
import { execFileSync } from "node:child_process";
import {
  displayResolver,
  elementValues,
  executeCommand,
  isOrganized,
  warmModel,
  type Actor,
  type Command,
  type Interest,
  type ModelState,
} from "@permitzip/bim-kernel";
import { FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";
import { InMemoryCommitStore, Sequencer, SyncClient, SyncHub, type HubConnection } from "@permitzip/bim-sync";
import { gc, memoryMB, round, timeSync } from "./lib";
import { loadModelLikeServer } from "./server-load";

const FT = 304.8;
const args = process.argv.slice(2);
const arg = (name: string, fallback: string): string => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const tier = arg("tier", "250k");
if (!(tier in FULL_BIM_TIERS)) throw new Error(`--tier must be one of ${Object.keys(FULL_BIM_TIERS).join(", ")}`);
const opts = FULL_BIM_TIERS[tier as keyof typeof FULL_BIM_TIERS];
const visibilityRuns = Number(arg("visibility-runs", "21"));

function mem(): Record<string, number> {
  gc();
  const m = process.memoryUsage();
  return { rss: round(m.rss / 1e6, 1), heapUsed: round(m.heapUsed / 1e6, 1), heapTotal: round(m.heapTotal / 1e6, 1), external: round(m.external / 1e6, 1), arrayBuffers: round(m.arrayBuffers / 1e6, 1) };
}

async function main(): Promise<void> {
  // Rows from a generator process, as synthetic.ts loads them: no generator copy in this process.
  const loaded = await loadModelLikeServer(tier as keyof typeof FULL_BIM_TIERS);
  const totalElements = Object.keys(loaded.model.elements).length;
  let head: ModelState | null = loaded.model;
  const afterLoad = mem();
  const store = new InMemoryCommitStore(head);
  head = null;
  const sequencer = await Sequencer.start(store);
  const hub = new SyncHub(sequencer);

  const p = `L${String(opts.floors).padStart(2, "0")}-Z${opts.zonesPerFloor}`;
  const interest: Interest = { areas: [{ level: `L${String(opts.floors).padStart(2, "0")}`, zone: `Z${opts.zonesPerFloor}` }] };
  const actor: Actor = { id: "author", name: "Author", kind: "human" };
  let onMessage: ((data: string) => void) | null = null;
  const conn: HubConnection = {
    id: "cold-1",
    send: (data: string) => {
      client.receive(data);
      onMessage?.(data);
    },
  };
  const client: SyncClient = new SyncClient(
    {
      send: (data) => {
        hub.handle(conn, data).catch((err) => console.error("[cold-paths] hub.handle failed", err));
      },
      close: () => hub.leave(conn),
    },
    actor,
    {},
    600_000,
    { interest },
  );
  const next = (type: string): Promise<number> =>
    new Promise((resolve) => {
      onMessage = (data) => {
        if (data.startsWith(`{"type":"${type}"`)) {
          onMessage = null;
          resolve(performance.now());
        }
      };
    });

  const trace = (what: string): void => {
    if (args.includes("--steps")) console.error(`[cold-paths] ${what} at ${round(performance.now(), 1)} ms`);
  };
  hub.join(conn);
  trace("join start");
  const welcomed = next("welcome");
  const t0 = performance.now();
  client.opened();
  const joinCold = (await welcomed) - t0;
  trace("join end / commit start");

  const command: Command = { type: "slide_branch", tapId: `${p}-air-t1-s2-b1-tap`, s: 3.25 * FT };
  const outcome = next("outcome");
  const t1 = performance.now();
  const submitted = client.submit(command);
  if (!submitted.ok) throw new Error(`[cold-paths] first edit refused locally: ${submitted.error.message}`);
  const commitCold = (await outcome) - t1;
  trace("commit end");

  const warm = warmModel(await store.head());
  const warmMem = memoryMB();
  const warmDetail = mem();
  // macOS: where resident memory beyond the JS heap sits (malloc zones, code, stacks), at the moment memory.server.rss is read.
  const vmmap = args.includes("--vmmap") ? execFileSync("vmmap", ["--summary", String(process.pid)], { encoding: "utf8", maxBuffer: 1 << 24 }) : null;

  let model = await store.head();
  const base = model;
  const organized = Object.keys(base.elements).filter((id) => {
    const el = base.elements[id];
    return el !== undefined && isOrganized(el);
  });
  const step = Math.max(1, Math.floor(organized.length / 2000));
  const picked = organized.filter((_, i) => i % step === 0).slice(0, 2000);
  for (const c of [
    { type: "assign_elements_to_group", ids: picked.slice(0, 1000), groupId: "grp-coordination" },
    { type: "set_element_phases", ids: picked.slice(1000), phaseCreated: "phase-existing", phaseDemolished: "phase-new" },
  ] satisfies Command[]) {
    const r = executeCommand(model, c);
    if (!r.ok) throw new Error(`[cold-paths] ${c.type} refused: ${r.error.message}`);
    model = r.model;
  }
  const ctx = { phaseId: "phase-new", phaseFilterId: "pf-existing-demo", groupDisplay: { "grp-coordination": "hide" as const } };
  const all = elementValues(model.elements);
  const resolve: number[] = [];
  let hidden = 0;
  let dashed = 0;
  for (let i = 0; i < visibilityRuns; i++) {
    resolve.push(
      timeSync(() => {
        const show = displayResolver(model, ctx);
        let h = 0;
        let d = 0;
        for (const el of all) {
          const r = show(el);
          if (!r.visible) h++;
          else if (r.dashed) d++;
        }
        hidden = h;
        dashed = d;
      }).ms,
    );
  }
  resolve.sort((a, b) => a - b);

  const marks = performance
    .getEntriesByType("measure")
    .filter((e) => e.name.startsWith("bim:"))
    .map((e) => ({ name: e.name, ms: round(e.duration, 1) }));
  console.log(
    JSON.stringify(
      {
        tier,
        totalElements,
        joinColdMs: round(joinCold, 1),
        commitColdMs: round(commitCold, 1),
        warm: Object.fromEntries(Object.entries(warm).map(([k, v]) => [k, round(v, 1)])),
        memoryServer: warmMem,
        memoryDetail: { afterLoad, warm: warmDetail },
        visibility: { p50: round(resolve[Math.floor(resolve.length / 2)] ?? 0, 2), min: round(resolve[0] ?? 0, 2), hidden, dashed },
        marks,
      },
      null,
      1,
    ),
  );
  if (vmmap) console.log(vmmap);
  client.dispose();
}

main().catch((err) => {
  console.error("[cold-paths] failed", err);
  process.exit(1);
});
