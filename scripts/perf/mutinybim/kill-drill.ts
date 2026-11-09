/**
 * Group commit kill-mid-batch drill at scale: 25 and 50 editors, the
 * authority killed repeatedly while edits it already showed to other people
 * are not yet durable. Fails (exit 1) on any divergence, any edit applied
 * other than exactly once, or any client left unsettled.
 * In-process (real SyncClient / SyncHub / Sequencer / group-commit store, a
 * DurableLog as the database); the Postgres store's own drill is
 * services/bim-authority/drills/group-commit-store.ts.
 *
 *   node --import tsx scripts/perf/mutinybim/kill-drill.ts --editors=25,50 --kills=5 --write-delay-ms=20
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runKillDrill, type KillDrillReport } from "../../../packages/bim-sync/__tests__/support/kill-drill";
import { REPO_ROOT } from "./lib";

const args = process.argv.slice(2);
const arg = (name: string, fallback: string): string => args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=") ?? fallback;
const ladder = arg("editors", "25,50").split(",").map(Number);
const kills = Number(arg("kills", "5"));
const writeDelayMs = Number(arg("write-delay-ms", "20"));
const rate = Number(arg("rate", "2"));
const phaseMs = Number(arg("phase-ms", "3000"));
const backlog = Number(arg("backlog", "0"));
const settleMs = Number(arg("settle-ms", "30000"));
const outDir = arg("out", path.join(REPO_ROOT, ".perf-results/mutinybim", `kill-drill-${new Date().toISOString().replace(/[:.]/g, "-")}`));

async function main(): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  const reports: KillDrillReport[] = [];
  for (const editors of ladder) {
    const report = await runKillDrill({ editors, kills, rate, phaseMs, writeDelayMs, seed: editors, backlog, settleMs, ...(args.includes("--progress") ? { onProgress: (state) => console.log(`[kill-drill] settling ${JSON.stringify(state)}`) } : {}) });
    reports.push(report);
    console.log(
      `[kill-drill] ${editors} editors, ${kills} kills: ${report.committed}/${report.submitted} committed, ${report.rejected} refused; ` +
        `kills with undurable edits shown ${report.killsWithUndurableShown}, most lost revisions seen ${report.maxShownButLost}; ` +
        `divergent clients ${report.divergentClients}, exactly-once violations ${report.exactlyOnceViolations}, duplicate keys ${report.duplicateKeysInLog}, unsettled ${report.unsettledClients}; ` +
        `${report.durableWrites} writes for ${report.finalRevision} revisions; settled in ${report.settleMs ?? "never"} ms, serial fallbacks ${report.fallbacks}${report.stuck.length ? `; stuck: ${report.stuck.join(" | ")}` : ""}`,
    );
  }
  writeFileSync(path.join(outDir, "results.json"), JSON.stringify({ recordedAt: new Date().toISOString(), kills, writeDelayMs, rate, phaseMs, reports }, null, 2));
  const bad = reports.filter((r) => r.divergentClients > 0 || r.exactlyOnceViolations > 0 || r.duplicateKeysInLog > 0 || r.unsettledClients > 0 || r.killsWithUndurableShown === 0);
  if (bad.length > 0) {
    console.error(`[kill-drill] FAIL: ${JSON.stringify(bad)}`);
    process.exitCode = 1;
  } else console.log(`[kill-drill] PASS; results: ${path.relative(REPO_ROOT, path.join(outDir, "results.json"))}`);
}

main().catch((err) => {
  console.error("[kill-drill] failed", err);
  process.exit(1);
});
