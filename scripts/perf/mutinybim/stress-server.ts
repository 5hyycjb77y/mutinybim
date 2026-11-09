/**
 * The model server's live-sync path, for the stress harness (stress-authority.ts).
 * Same SyncHub, Sequencer, `ws` server and permessage-deflate settings as
 * services/bim-authority/src/server.ts, one hub per model, one message at a
 * time per connection. What is NOT here: sign-in, the lease, Postgres. The
 * durable write is stood in for by `--commit-delay-ms` on every write to a
 * DurableLog (where the Postgres round trip sits). `--group-commit=off` writes
 * each commit on its own, decided inside the write (the serial path);
 * `--group-commit=on` (default, as the authority runs) decides in memory,
 * shows the edit to everyone else at once and writes batches.
 *
 *   node --expose-gc --import tsx scripts/perf/mutinybim/stress-server.ts --tier=250k --models=1 --commit-delay-ms=20 --group-commit=on
 *
 * Prints `@@stress-ready <port> <json>` when every model is loaded and warm.
 * GET /stats: heap, RSS, GC pauses, event-loop delay, per-model hub counters.
 * POST /reset: clears the GC and event-loop histograms (between ladder steps).
 */
import { createServer } from "node:http";
import { monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";
import { WebSocketServer } from "ws";
import { warmModel, type ModelState } from "@permitzip/bim-kernel";
import { DurableLog, GroupCommitMemoryStore, Sequencer, SyncHub, percentiles, type HubConnection } from "@permitzip/bim-sync";
import { authoredOptions, readBuildingProfile } from "./building-profile";
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import { FULL_BIM_TIERS, createFullBimModel, type FullBimOptions } from "@permitzip/bim-first-party/seed";

// A host like the model server: the kernel carries no trade, so taps, their hosts and the tree's totals come from the first-party add-ons.
installFirstPartyAddOns();

const args = process.argv.slice(2);
const arg = (name: string, fallback: string): string => args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=") ?? fallback;
const tier = arg("tier", "250k");
const modelCount = Number(arg("models", "1"));
const commitDelayMs = Number(arg("commit-delay-ms", "20"));
const port = Number(arg("port", "0"));
const groupCommit = arg("group-commit", "on") !== "off";
const windowMs = Number(arg("window-ms", "0"));
const maxBatch = Number(arg("max-batch", "64"));
/** --profile=<building profile>: the authored model sized like a real building (building-profile.ts) instead of a named tier. */
const profileFile = arg("profile", "");
if (!profileFile && !(tier in FULL_BIM_TIERS)) throw new Error(`--tier must be one of ${Object.keys(FULL_BIM_TIERS).join(", ")}`);
const shape = (modelId: string): FullBimOptions => (profileFile ? authoredOptions(readBuildingProfile(profileFile), modelId) : { ...FULL_BIM_TIERS[tier as keyof typeof FULL_BIM_TIERS], modelId });
if (!(Number.isInteger(modelCount) && modelCount >= 1 && modelCount <= 16)) throw new Error("--models must be 1..16");

/** The kernel's decision inside the commit (planCommit), split by whether the command was sent on the latest head. */
const decideFresh: number[] = [];
const decideRebased: number[] = [];
/** Revisions committed between a command's base and its commit. */
const behind: number[] = [];

const recordDecide = (ms: number, revisionsBehind: number): void => {
  (revisionsBehind === 0 ? decideFresh : decideRebased).push(ms);
  behind.push(revisionsBehind);
};

// ------------------------------------------------------------------ runtime health

const gcPauses: number[] = [];
const gcByKind: Record<string, number> = {};
new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    gcPauses.push(entry.duration);
    const kind = String((entry as PerformanceEntry & { detail?: { kind?: number } }).detail?.kind ?? "unknown");
    gcByKind[kind] = (gcByKind[kind] ?? 0) + 1;
  }
}).observe({ entryTypes: ["gc"] });
const loopDelay = monitorEventLoopDelay({ resolution: 10 });
loopDelay.enable();

// ------------------------------------------------------------------ models

interface Runtime {
  readonly hub: SyncHub;
  readonly sequencer: Sequencer;
  readonly log: DurableLog;
  readonly elements: number;
  readonly warm: ReturnType<typeof warmModel>;
}

const models = new Map<string, Runtime>();
let loadMs = 0;

async function loadModels(): Promise<void> {
  const loadStarted = performance.now();
  for (let i = 0; i < modelCount; i++) {
    const modelId = `stress-${i}`;
    const generated = createFullBimModel(shape(modelId));
    // A loaded copy with plain records, as the authority holds after reading Postgres.
    const head: ModelState = { ...generated, elements: Object.fromEntries(Object.entries(generated.elements)) };
    const log = new DurableLog(head, commitDelayMs);
    const store = new GroupCommitMemoryStore(log, recordDecide);
    const sequencer = await Sequencer.start(store, { enabled: groupCommit, windowMs, maxBatch });
    const warm = warmModel(await store.head());
    models.set(modelId, { hub: new SyncHub(sequencer), sequencer, log, elements: Object.keys(head.elements).length, warm });
  }
  loadMs = performance.now() - loadStarted;
}

// ------------------------------------------------------------------ sockets

const wss = new WebSocketServer({
  noServer: true,
  // Mirrors services/bim-authority/src/server.ts.
  perMessageDeflate: { threshold: 1024, zlibDeflateOptions: { level: 1 }, serverNoContextTakeover: true, clientNoContextTakeover: true },
});
let connSeq = 0;
let connections = 0;

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "POST" && url.pathname === "/reset") {
    gcPauses.length = 0;
    for (const k of Object.keys(gcByKind)) delete gcByKind[k];
    loopDelay.reset();
    decideFresh.length = 0;
    decideRebased.length = 0;
    behind.length = 0;
    for (const rt of models.values()) {
      rt.hub.metrics.commitMs.length = 0;
      rt.sequencer.groupStats.batchSizes.length = 0;
      rt.sequencer.groupStats.flushMs.length = 0;
      rt.log.writes = 0;
    }
    res.writeHead(204).end();
    return;
  }
  if (req.method === "GET" && url.pathname === "/stats") {
    const mem = process.memoryUsage();
    const sorted = [...gcPauses].sort((a, b) => a - b);
    const perModel: Record<string, unknown> = {};
    for (const [id, rt] of models) {
      const { commitMs, joins: _joins, ...counts } = rt.hub.metrics;
      const g = rt.sequencer.groupStats;
      perModel[id] = {
        ...counts,
        connections: rt.hub.connectionCount(),
        serverCommitMs: percentiles(commitMs),
        elements: rt.elements,
        durableWrites: rt.log.writes,
        groupCommit: rt.sequencer.groupCommit() ? { batches: g.batches, maxPending: g.maxPending, batchSize: percentiles(g.batchSizes), writeMs: percentiles(g.flushMs) } : null,
      };
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        heapUsedMB: mem.heapUsed / 1e6,
        heapTotalMB: mem.heapTotal / 1e6,
        rssMB: mem.rss / 1e6,
        externalMB: mem.external / 1e6,
        gc: { count: sorted.length, totalMs: sorted.reduce((a, b) => a + b, 0), p99Ms: sorted[Math.max(0, Math.ceil(sorted.length * 0.99) - 1)] ?? 0, maxMs: sorted[sorted.length - 1] ?? 0, byKind: gcByKind },
        eventLoopDelayMs: { p50: loopDelay.percentile(50) / 1e6, p99: loopDelay.percentile(99) / 1e6, max: loopDelay.max / 1e6 },
        decideMs: { fresh: percentiles(decideFresh), rebased: percentiles(decideRebased), revisionsBehind: percentiles(behind) },
        connections,
        models: perModel,
      }),
    );
    return;
  }
  res.writeHead(404).end();
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const runtime = url.pathname === "/sync" ? models.get(url.searchParams.get("model") ?? "") : undefined;
  if (!runtime) {
    socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    connSeq += 1;
    connections += 1;
    const conn: HubConnection = { id: `stress-conn-${connSeq}`, send: (data: string) => ws.send(data) };
    runtime.hub.join(conn);
    let queue: Promise<void> = Promise.resolve();
    ws.on("message", (data) => {
      const raw = data.toString();
      queue = queue.then(() => runtime.hub.handle(conn, raw)).catch((err) => console.error("[stress-server] message failed", { id: conn.id, err }));
    });
    ws.on("close", () => {
      connections -= 1;
      runtime.hub.leave(conn);
    });
    ws.on("error", (err) => console.error("[stress-server] socket error", { id: conn.id, err }));
  });
});

loadModels()
  .then(() => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const bound = typeof address === "object" && address ? address.port : port;
      const info = { tier: profileFile ? `profile:${profileFile}` : tier, models: [...models.keys()], elementsPerModel: [...models.values()].map((m) => m.elements), commitDelayMs, groupCommit, windowMs, maxBatch, loadMs: Math.round(loadMs), node: process.version, execArgv: process.execArgv };
      console.log(`@@stress-ready ${bound} ${JSON.stringify(info)}`);
    });
  })
  .catch((err) => {
    console.error("[stress-server] could not load models", err);
    process.exit(1);
  });

process.on("SIGTERM", () => {
  wss.close();
  server.close(() => process.exit(0));
});
