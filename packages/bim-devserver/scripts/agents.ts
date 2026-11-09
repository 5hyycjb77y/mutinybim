/**
 * Scripted agents for the feasibility drills. They use the same command
 * contract as people and real agents (not browser automation): read at a
 * revision, "think", then commit a batch, sometimes from a stale base.
 *
 *   npx tsx packages/bim-devserver/scripts/agents.ts            # 2 agents, ws://localhost:3095
 *   BIM_AGENTS=2 BIM_DEV_URL=ws://localhost:3095/sync BIM_AGENT_MINUTES=5 npx tsx packages/bim-devserver/scripts/agents.ts
 */
import WebSocket from "ws";
import { headlineKindValue, type Actor } from "@permitzip/bim-kernel";
import { SyncClient } from "@permitzip/bim-sync";

const url = process.env.BIM_DEV_URL ?? "ws://localhost:3095/sync";
const count = Number(process.env.BIM_AGENTS ?? 2);
const minutes = Number(process.env.BIM_AGENT_MINUTES ?? 5);
const deadline = Date.now() + minutes * 60_000;

interface Stats {
  committed: number;
  rebased: number;
  conflicts: number;
  refused: number;
  latencyMs: number[];
}

function runAgent(index: number, stats: Stats): Promise<void> {
  const actor: Actor = { id: `agent-${index}`, name: `Agent-${index}`, kind: "agent" };
  const sentAt = new Map<string, number>();
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const client = new SyncClient(
      { send: (d) => ws.readyState === WebSocket.OPEN && ws.send(d), close: () => ws.close() },
      actor,
      {
        onOutcome: (req, outcome) => {
          const t0 = sentAt.get(req.idempotencyKey);
          if (t0 !== undefined) stats.latencyMs.push(performance.now() - t0);
          if (outcome.status === "committed") {
            stats.committed += 1;
            if (outcome.rebased) stats.rebased += 1;
          } else if (outcome.error.code === "conflict") stats.conflicts += 1;
          else stats.refused += 1;
        },
      },
    );
    ws.on("open", () => client.opened());
    ws.on("message", (d) => client.receive(d.toString()));
    ws.on("error", (err) => console.error(`[agent-${index}] socket error`, err));
    ws.on("close", () => resolve());

    const loop = async () => {
      while (Date.now() < deadline) {
        const thinkMs = 2_000 + Math.random() * 28_000;
        client.publishPresence({ kind: "working", note: "Balancing diffuser airflow" });
        await new Promise((r) => setTimeout(r, thinkMs));
        const view = client.view();
        if (!view) continue;
        const terminals = Object.values(view.elements).filter((e) => e.kind === "terminal");
        const batch = 1 + Math.floor(Math.random() * 3);
        for (let i = 0; i < batch; i++) {
          const t = terminals[Math.floor(Math.random() * terminals.length)];
          if (!t || t.kind !== "terminal") continue;
          const cfm = Math.max(100, Math.round((headlineKindValue(t)?.value ?? 0) + (Math.random() - 0.5) * 100));
          const res = client.submit({ type: "set_terminal_cfm", terminalId: t.id, cfm });
          if (res.ok) sentAt.set(res.request.idempotencyKey, performance.now());
        }
        client.publishPresence({ kind: "idle" });
      }
      client.dispose();
    };
    ws.once("open", () => {
      loop().catch((err) => {
        console.error(`[agent-${index}] loop failed`, err);
        client.dispose();
      });
    });
  });
}

async function main() {
  const stats: Stats = { committed: 0, rebased: 0, conflicts: 0, refused: 0, latencyMs: [] };
  console.log(`[bim-agents] ${count} scripted agents -> ${url} for ${minutes} min`);
  const report = setInterval(() => {
    const sorted = [...stats.latencyMs].sort((a, b) => a - b);
    const p = (q: number) => (sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0) : null);
    console.log("[bim-agents]", { ...stats, latencyMs: undefined, commitRoundTripMs: { p50: p(0.5), p95: p(0.95) } });
  }, 15_000);
  await Promise.all(Array.from({ length: count }, (_, i) => runAgent(i + 1, stats)));
  clearInterval(report);
  console.log("[bim-agents] done", { committed: stats.committed, rebased: stats.rebased, conflicts: stats.conflicts, refused: stats.refused });
}

main().catch((err) => {
  console.error("[bim-agents] failed", err);
  process.exit(1);
});
