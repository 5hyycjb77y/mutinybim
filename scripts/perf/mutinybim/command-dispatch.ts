/**
 * What checking one intent command costs now that a command type may be an
 * add-on's (`COMMAND_POINT`): a kernel command (`move_tag`) and the
 * first-party pack command (`place_service_layout`), each through
 * `commandSchema.safeParse`, the parser every host uses. Each sample is the
 * mean of CALLS parses after a warm-up.
 *
 *   node --import tsx scripts/perf/mutinybim/command-dispatch.ts --samples=21
 *
 * Metrics:
 *   kernel.packs.command_dispatch        move_tag, ns per parse
 *   kernel.packs.command_dispatch.pack   place_service_layout, ns per parse
 *
 * Moved from packages/bim-kernel/src/__tests__/c6k-command-dispatch-perf.test.ts,
 * whose Jest wall clock measured the Unit Tests job's CPU contention: CI read
 * 4.8-5.4 / 30-32 us per parse there (runs 41240040562, 41240123528) while the
 * same code reads 1.4 / 7.0 us under Jest on an M-series laptop. The test keeps
 * the parse-correctness assertions. Prints one `@@perf-result` JSON line.
 */
import { commandSchema } from "../../../packages/bim-kernel/src";

import { emit } from "./lib";

const args = process.argv.slice(2);
const samples = Number(args.find((a) => a.startsWith("--samples="))?.split("=")[1] ?? 21);
const CALLS = 5_000;
const WARMUP = 2_000;

const MOVE_TAG = { type: "move_tag", tagId: "t-1", offset: { x: 10, y: 20 } };
const LAYOUT = {
  type: "place_service_layout",
  label: "Service layout",
  levelId: "lvl-1",
  partTypes: [],
  equipment: [{ partId: "p-1", typeId: "t-1", position: { x: 0, y: 0 }, values: { name: "MDP" } }],
  feeders: [],
};

for (const [name, command] of [["move_tag", MOVE_TAG], ["place_service_layout", LAYOUT]] as const) {
  const parsed = commandSchema.safeParse(command);
  if (!parsed.success) throw new Error(`${name} did not parse: ${parsed.error.message}`);
}

function nsPerCall(command: unknown): number {
  let ok = 0;
  const t0 = performance.now();
  for (let i = 0; i < CALLS; i++) if (commandSchema.safeParse(command).success) ok += 1;
  const ns = ((performance.now() - t0) * 1e6) / CALLS;
  if (ok !== CALLS) throw new Error(`${CALLS - ok} of ${CALLS} parses failed`);
  return ns;
}

for (let i = 0; i < WARMUP; i++) {
  commandSchema.safeParse(MOVE_TAG);
  commandSchema.safeParse(LAYOUT);
}

const kernel: number[] = [];
const pack: number[] = [];
for (let n = 0; n < samples; n++) {
  kernel.push(nsPerCall(MOVE_TAG));
  pack.push(nsPerCall(LAYOUT));
}

emit({
  suite: "batch",
  workload: { callsPerSample: CALLS, samples },
  network: "in-process",
  participants: 1,
  samples: [
    { metric: "kernel.packs.command_dispatch", values: kernel, note: "move_tag through commandSchema.safeParse, ns per parse." },
    { metric: "kernel.packs.command_dispatch.pack", values: pack, note: "place_service_layout (first-party pack command) through commandSchema.safeParse, ns per parse." },
  ],
});
