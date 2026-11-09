/**
 * The authority's live-sync path for the schedules drill (schedules-load.ts):
 * the real PostgresCommitStore with its lease, the group-commit Sequencer,
 * SyncHub with the kernel's schedule evaluator, and the `ws` server with the
 * same permessage-deflate settings as src/server.ts. What is NOT here:
 * sign-in and the host's permission check (every socket is an editor), which
 * the drill does not measure.
 *
 * Throwaway database on this machine only:
 *   BIM_SCHEDULES_DRILL_DB_URL=postgresql://postgres:<pw>@127.0.0.1:<port>/postgres \
 *   node --import tsx services/bim-authority/drills/schedules-server.ts --model=<id> --port=<port> --schedules=on
 *
 * Prints `@@ready <port>` once the model is loaded and warm. GET /stats: hub
 * and schedule counters, event-loop delay, heap.
 */
import { createServer } from "node:http";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { WebSocketServer } from "ws";
import { warmModel } from "@permitzip/bim-kernel";
import { Sequencer, SyncHub, kernelScheduleEvaluator, percentiles, type HubConnection } from "@permitzip/bim-sync";
import { PostgresCommitStore, connect } from "../src/pg-store";

const args = process.argv.slice(2);
const arg = (name: string, fallback: string): string => args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=") ?? fallback;
const url = process.env.BIM_SCHEDULES_DRILL_DB_URL;
if (!url) throw new Error("Set BIM_SCHEDULES_DRILL_DB_URL to a throwaway database on this machine");
const host = new URL(url).hostname;
if (host !== "127.0.0.1" && host !== "localhost") throw new Error("This drill writes; it refuses any database that is not on this machine");
const modelId = arg("model", "schedules-drill");
const port = Number(arg("port", "8191"));
const schedulesOn = arg("schedules", "on") !== "off";

const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();

const sql = connect(url, 8);
const store = new PostgresCommitStore(sql, { modelId, owner: `schedules-drill-${process.pid}`, ownerMachine: null, leaseTtlMs: 10_000 });
const sequencer = await Sequencer.start(store);
const head = await store.head();
warmModel(head);
const hub = new SyncHub(sequencer, schedulesOn ? { schedules: kernelScheduleEvaluator() } : {});
const renew = setInterval(() => {
  store.renewLease().catch((err: unknown) => console.error("[schedules-server] lease renewal failed", err));
}, 3_000);

const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: { threshold: 1024, zlibDeflateOptions: { level: 1 }, serverNoContextTakeover: true, clientNoContextTakeover: true },
});
let nextId = 0;
wss.on("connection", (socket) => {
  nextId += 1;
  const conn: HubConnection = { id: `c${nextId}`, send: (data) => socket.send(data) };
  hub.join(conn);
  let queue: Promise<void> = Promise.resolve();
  socket.on("message", (data) => {
    const raw = data.toString();
    queue = queue.then(() => hub.handle(conn, raw)).catch((err: unknown) => console.error("[schedules-server] message failed", err));
  });
  socket.on("close", () => hub.leave(conn));
});

const server = createServer((req, res) => {
  if (req.url === "/stats") {
    const { commitMs, joins: _joins, schedules, ...counts } = hub.metrics;
    const body = {
      ...counts,
      serverCommitMs: percentiles(commitMs),
      schedules: schedules ? { ...schedules, buildMs: percentiles(schedules.buildMs), applyMs: percentiles(schedules.applyMs) } : null,
      loopDelayMs: { p50: loop.percentile(50) / 1e6, p99: loop.percentile(99) / 1e6, max: loop.max / 1e6 },
      heapMb: Math.round(process.memoryUsage().heapUsed / 1e6),
      group: { batches: sequencer.groupStats.batches, commits: sequencer.groupStats.commits, writeMs: percentiles(sequencer.groupStats.flushMs) },
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
    return;
  }
  if (req.url === "/reset" && req.method === "POST") {
    hub.metrics.commitMs.length = 0;
    hub.metrics.schedules?.applyMs.splice(0);
    hub.metrics.schedules?.buildMs.splice(0);
    loop.reset();
    res.writeHead(204);
    res.end();
    return;
  }
  res.writeHead(404);
  res.end();
});
server.on("upgrade", (req, socket, headBuf) => wss.handleUpgrade(req, socket, headBuf, (ws) => wss.emit("connection", ws, req)));
server.listen(port, "127.0.0.1", () => console.log(`@@ready ${port} elements=${Object.keys(head.elements).length} revision=${head.revision} schedules=${schedulesOn ? "on" : "off"}`));

function stop(): void {
  clearInterval(renew);
  store
    .releaseLease()
    .catch((err: unknown) => console.error("[schedules-server] lease release failed", err))
    .finally(() => process.exit(0));
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
