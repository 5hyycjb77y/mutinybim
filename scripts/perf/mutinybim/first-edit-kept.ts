/**
 * `validate.first_edit_after_load.open_issues` with the kept validation state
 * (round 9 K9, round 10 S10): the first ordinary edit on a head a fresh process
 * loaded with an issue open, (a) with the state the previous process kept and
 * (b) without it (the cold pass). The model is loaded the way the model server
 * loads it (plain rows from a child process), and each reopened copy is rebuilt
 * from JSON so nothing the first process cached is reachable. Prints both first
 * edits, whole-model checks, the state's size and where the kept-state edit's
 * time goes (a CPU profile of exactly that call, by self time).
 *
 *   node --expose-gc --max-old-space-size=12288 --import tsx scripts/perf/mutinybim/first-edit-kept.ts --tier=1M
 */
import { Session } from "node:inspector";
import {
  elementsFromRows,
  incrementalValidationStats,
  issuesOf,
  offerValidationState,
  planCommit,
  validateModel,
  validationStateOf,
  validationStateStats,
  warmModel,
  withUpgradePolicy,
  type WarmTimings,
  type BimElement,
  type Command,
  type Connection,
  type ModelState,
} from "@permitzip/bim-kernel";
import { FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";
import { withModelStatePacks } from "@permitzip/bim-kernel/packs";
import { gc, round } from "./lib";
import { loadModelLikeServer } from "./server-load";

const args = process.argv.slice(2);
const arg = (name: string, fallback: string): string => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const tier = arg("tier", "250k");
if (!(tier in FULL_BIM_TIERS)) throw new Error(`--tier must be one of ${Object.keys(FULL_BIM_TIERS).join(", ")}`);
const runs = Number(arg("runs", "3"));
const CODE_KEY = "s10-first-edit-kept";
const NOW = () => "2026-11-02T00:00:00.000Z";

let seq = 0;
function commit(head: ModelState, command: Command): { model: ModelState; ms: number } {
  seq += 1;
  const request = { idempotencyKey: `s10-${seq}`, baseRevision: head.revision, actor: { id: "avery", name: "Avery", kind: "human" as const }, command };
  const t0 = performance.now();
  const d = withUpgradePolicy(() => true, () => planCommit(head, [], request, NOW));
  const ms = performance.now() - t0;
  if (!d.ok) throw new Error(`${command.type}: ${d.error.message}`);
  return { model: d.model, ms };
}

const wholeChecks = (): number => {
  const s = incrementalValidationStats();
  return s.fullPasses + s.coldPasses;
};

/** A part whose type the model doesn't have: an issue open away from what the edits touch. */
function withOpenIssue(model: ModelState): ModelState {
  const level = Object.values(model.elements).find((e) => e.kind === "level");
  const part = { version: 1, authoredRev: {}, id: "s10-orphan", kind: "part", typeId: "s10-missing-type", levelId: level?.id ?? "lvl-1", position: { x: 0, y: 50_000 }, offsetMm: 0, rotationDeg: 0, mark: "X1", values: {} } as unknown as BimElement;
  return { ...model, elements: { ...model.elements, [part.id]: part } };
}

/** The same head as a new process reads it: fresh records, nothing cached on them. */
function reopen(head: ModelState): ModelState {
  const rows = JSON.parse(JSON.stringify(Object.values(head.elements))) as BimElement[];
  const connections = JSON.parse(JSON.stringify(head.connections)) as Connection[];
  return { ...head, elements: elementsFromRows(rows), connections };
}

interface ProfileNode {
  readonly id: number;
  readonly callFrame: { readonly functionName: string; readonly url: string; readonly lineNumber: number };
  readonly hitCount?: number;
}
interface CpuProfile {
  readonly nodes: readonly ProfileNode[];
  readonly samples?: readonly number[];
  readonly timeDeltas?: readonly number[];
}

function profiled<T>(fn: () => T): { value: T; profile: CpuProfile } {
  const session = new Session();
  session.connect();
  let profile: CpuProfile | null = null;
  let value: T | undefined;
  session.post("Profiler.enable", () => undefined);
  session.post("Profiler.setSamplingInterval", { interval: 200 }, () => undefined);
  session.post("Profiler.start", () => undefined);
  value = fn();
  session.post("Profiler.stop", (err, result) => {
    if (err) throw err;
    profile = (result as { profile: CpuProfile }).profile;
  });
  session.disconnect();
  if (!profile) throw new Error("[first-edit-kept] the profiler returned nothing");
  return { value: value as T, profile };
}

function topSelf(profile: CpuProfile, n: number): string[] {
  const byNode = new Map<number, ProfileNode>(profile.nodes.map((node) => [node.id, node]));
  const selfUs = new Map<string, number>();
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  for (let i = 0; i < samples.length; i++) {
    const node = byNode.get(samples[i] ?? -1);
    if (!node) continue;
    const { functionName, url, lineNumber } = node.callFrame;
    if (url.startsWith("node:inspector")) continue; // the profiler's own stop
    const key = `${functionName || "(anonymous)"} ${url.split("/").slice(-2).join("/")}:${lineNumber + 1}`;
    selfUs.set(key, (selfUs.get(key) ?? 0) + (deltas[i] ?? 0));
  }
  return [...selfUs].sort((a, b) => b[1] - a[1]).slice(0, n).map(([key, us]) => `${(us / 1000).toFixed(1).padStart(7)} ms  ${key}`);
}

async function main(): Promise<void> {
  const source: ModelState = (await loadModelLikeServer(tier as keyof typeof FULL_BIM_TIERS)).model;
  const idsOf = (kind: string) => Object.values(source.elements).filter((e) => e.kind === kind).map((e) => e.id);
  const walls = idsOf("wall");
  const tags = idsOf("tag");
  const terminals = idsOf("terminal");
  const equipment = idsOf("equipment");
  const taps = idsOf("tap");
  let i = 0;
  // k9-perf's mix: a wall, a tag, an air terminal's flow, a unit, a branch slide.
  const KINDS = ["move_wall", "move_tag", "set_terminal_cfm", "move_equipment", "slide_branch"] as const;
  let only: (typeof KINDS)[number] | null = "move_wall";
  let current: ModelState | null = null;
  const ordinary = (): Command => {
    i += 1;
    const kind = only ?? KINDS[i % 5] ?? "move_wall";
    switch (kind) {
      case "move_tag":
        return { type: "move_tag", tagId: tags[(i * 104729) % tags.length] ?? "", offset: { x: 40, y: 40 } };
      case "set_terminal_cfm":
        return { type: "set_terminal_cfm", terminalId: terminals[(i * 31) % terminals.length] ?? "", cfm: 200 + i };
      case "move_equipment":
        return { type: "move_equipment", equipmentId: equipment[(i * 13) % equipment.length] ?? "", delta: { x: 5, y: 0 } };
      case "slide_branch": {
        const tapId = taps[(i * 101) % taps.length] ?? "";
        const tap = current?.elements[tapId];
        return { type: "slide_branch", tapId, s: (tap?.kind === "tap" ? tap.s : 0) + (i % 2 === 0 ? 25 : -25) };
      }
      default:
        return { type: "move_wall", wallId: walls[(i * 7919) % walls.length] ?? "", delta: { x: 10, y: 0 } };
    }
  };

  // The previous process: opens the head with an issue, edits, keeps the state.
  let head = commit(withOpenIssue(source), ordinary()).model;
  for (let k = 0; k < 5; k++) head = commit(head, ordinary()).model;
  const tw0 = performance.now();
  const state = validationStateOf(head, CODE_KEY);
  if (!state) throw new Error("[first-edit-kept] no validation state for the head");
  const body = JSON.stringify(state);
  const writeMs = performance.now() - tw0;

  const keptMs: number[] = [];
  const coldMs: number[] = [];
  let keptChecks = 0;
  let coldChecks = 0;
  let adopted = 0;
  let profileLines: string[] = [];
  let rss = 0;
  for (let r = 0; r < runs; r++) {
    // Without the state: the cold pass.
    {
      const fresh = reopen(head);
      gc();
      const c0 = wholeChecks();
      const { ms } = commit(fresh, ordinary());
      coldMs.push(ms);
      coldChecks += wholeChecks() - c0;
    }
    gc();
    // With it.
    {
      const fresh = reopen(head);
      offerValidationState(fresh, JSON.parse(body), CODE_KEY);
      gc();
      const c0 = wholeChecks();
      const a0 = validationStateStats().adopted;
      const run = r === runs - 1 ? profiled(() => commit(fresh, ordinary())) : { value: commit(fresh, ordinary()), profile: null };
      keptMs.push(run.value.ms);
      keptChecks += wholeChecks() - c0;
      adopted += validationStateStats().adopted - a0;
      if (run.profile) profileLines = topSelf(run.profile, 25);
      rss = Math.max(rss, process.memoryUsage().rss);
      if (r === runs - 1) {
        const after = run.value.model;
        const same = JSON.stringify(issuesOf(after)) === JSON.stringify(withModelStatePacks(after, () => validateModel(after)));
        if (!same) throw new Error("[first-edit-kept] the kept-state head's open issues differ from full validation");
      }
    }
    gc();
  }
  // The model server's open (BIM_AUTHORITY_PREWARM, on by default): warmModel indexes and checks the head before the first edit is served.
  const warmed = (offer: boolean): { warm: WarmTimings; firstMs: number; checks: number } => {
    const fresh = reopen(head);
    if (offer) offerValidationState(fresh, JSON.parse(body), CODE_KEY);
    gc();
    const c0 = wholeChecks();
    const warm = withModelStatePacks(fresh, () => warmModel(fresh));
    const { ms } = commit(fresh, ordinary());
    return { warm, firstMs: ms, checks: wholeChecks() - c0 };
  };
  const warmCold = warmed(false);
  gc();
  const warmKept = warmed(true);
  gc();
  const warmRow = (w: { warm: WarmTimings; firstMs: number; checks: number }) => ({
    openMs: round(w.warm.indexMs + w.warm.partitionsMs + w.warm.derivedMs + w.warm.validateMs, 0),
    indexMs: round(w.warm.indexMs, 0),
    partitionsMs: round(w.warm.partitionsMs, 0),
    derivedMs: round(w.warm.derivedMs, 0),
    validateMs: round(w.warm.validateMs, 0),
    firstEditMs: round(w.firstMs, 0),
    wholeModelChecks: w.checks,
  });
  const byKind: Record<string, number> = {};
  for (const kind of KINDS) {
    only = kind;
    const fresh = reopen(head);
    current = fresh;
    offerValidationState(fresh, JSON.parse(body), CODE_KEY);
    gc();
    byKind[kind] = round(commit(fresh, ordinary()).ms, 0);
    current = null;
    gc();
  }
  only = "move_wall";
  const summary = {
    tier,
    elements: Object.keys(head.elements).length,
    state: { writeMs: round(writeMs, 1), bytes: body.length, issues: state.issues.length, exceptions: state.reads.exceptionIds.length, signatures: state.reads.signatures.length },
    firstEditKept: { ms: keptMs.map((v) => round(v, 0)), wholeModelChecks: keptChecks, adopted, byKind },
    firstEditCold: { ms: coldMs.map((v) => round(v, 0)), wholeModelChecks: coldChecks },
    prewarmedOpen: { kept: warmRow(warmKept), cold: warmRow(warmCold) },
    harnessRssMB: Math.round(rss / 1e6), // several reopened copies alive: not memory.server.rss
  };
  console.log(`[s10 first-edit-kept] ${JSON.stringify(summary)}`);
  console.log("[s10 first-edit-kept] kept-state first edit, by self time (last run):");
  for (const line of profileLines) console.log(line);

}

main().catch((err: unknown) => {
  console.error("[first-edit-kept] failed", err);
  process.exit(1);
});
