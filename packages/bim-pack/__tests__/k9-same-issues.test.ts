/**
 * @jest-environment node
 *
 * Round 9 lane K9: 200 random add-on switches and edits on the Sample Market gas
 * system (with and without an issue open elsewhere). After every step the
 * command's open issues and the committed head's issues equal full validation
 * under the state's own set, and the command is accepted or refused exactly
 * as it is on the same head opened fresh (nothing known about it).
 */
import { executeCommand, installModelSetupHost, issuesOf, planCommit, validateModel, withUpgradePolicy, type BimElement, type Command, type ModelState, type ValidationIssue } from "@permitzip/bim-kernel";
import { contribute, defineExtensionPoint, definePack, withModelStatePacks } from "@permitzip/bim-kernel/packs";
import { buildSampleMarketGas } from "../../bim-kernel/__tests__/fixtures/sample-market-gas";
import { CHECK_ADDON_ID, CHECK_ADDON_VERSION, CHECK_TEST_PACK } from "./fixtures/check-addon";

const NOW = () => "2026-11-01T00:00:00.000Z";
let seq = 0;

const UNREAD_POINT = defineExtensionPoint<{ readonly id: string }>({ id: "k9same.unread", version: 1, label: "Rows no check reads", idOf: (r) => r.id });
const UNREAD_PACK = definePack({ id: "k9same", name: "Test unread rows", version: "1.0.0", kernel: "^1.5.0" }, [contribute(UNREAD_POINT, [{ id: "k9same.row" }])]);

let uninstall: () => void = () => undefined;
beforeAll(() => {
  uninstall = installModelSetupHost(() => [CHECK_TEST_PACK, UNREAD_PACK]);
});
afterAll(() => uninstall());

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

function plan(head: ModelState, command: Command): { ok: true; model: ModelState } | { ok: false; message: string } {
  seq += 1;
  const d = withUpgradePolicy(
    () => true,
    () => planCommit(head, [], { idempotencyKey: `k9-same-${seq}`, baseRevision: head.revision, actor: { id: "avery", name: "Avery", kind: "human" }, command }, NOW),
  );
  return d.ok ? { ok: true, model: d.model } : { ok: false, message: d.error.message };
}

const fullOf = (m: ModelState): readonly ValidationIssue[] => withModelStatePacks(m, () => validateModel(m));
const text = (issues: readonly ValidationIssue[]): string => JSON.stringify(issues);
const opened = (m: ModelState): ModelState => ({ ...m, elements: { ...m.elements } });

function withOpenIssue(m: ModelState): ModelState {
  const part = { version: 1, authoredRev: {}, id: "k9-same-orphan", kind: "part", typeId: "k9-missing-type", levelId: "lvl-1", position: { x: 0, y: 50_000 }, offsetMm: 0, rotationDeg: 0, mark: "X1", values: {} } as unknown as BimElement;
  return { ...m, elements: { ...m.elements, [part.id]: part } };
}

const NOMINALS = [12.7, 19.05, 25.4, 31.75, 38.1];

function randomCommand(head: ModelState, next: () => number, n: number): Command {
  const roll = next();
  const els = Object.values(head.elements);
  if (roll < 0.2) return { type: "set_model_addon", packId: CHECK_ADDON_ID, version: CHECK_ADDON_VERSION, on: next() < 0.5 };
  if (roll < 0.28) return { type: "set_model_addon", packId: "k9same", version: "1.0.0", on: next() < 0.5 };
  if (roll < 0.6) {
    const pipes = els.filter((e) => e.kind === "run_segment" && e.domain === "pipe");
    const seg = pipes[Math.floor(next() * pipes.length)];
    if (seg && seg.kind === "run_segment" && seg.size.shape === "pipe") {
      return { type: "resize_run", segmentId: seg.id, profile: { ...seg.size, nominalMm: NOMINALS[Math.floor(next() * NOMINALS.length)] ?? 25.4 } };
    }
  }
  if (roll < 0.75) {
    const parts = els.filter((e) => e.kind === "part");
    const part = parts[Math.floor(next() * parts.length)];
    if (part) return { type: "set_parameters", id: part.id, scope: "instance", mark: `K9-${n}` };
  }
  if (roll < 0.85) {
    const mine = els.filter((e) => e.kind === "level" && e.id.startsWith("lvl-k9s-"));
    const level = mine[Math.floor(next() * mine.length)];
    if (level) return { type: "delete_elements", ids: [level.id], policy: "refuse" };
  }
  return { type: "create_level", levelId: `lvl-k9s-${n}`, name: `K9 ${n}`, elevationMm: 30_000 + n * 3_000 };
}

describe("k9-same-issues", () => {
  it("200 random switches and edits: issues and refusals equal full validation and a fresh open", () => {
    let checked = 0;
    let refused = 0;
    let switches = 0;
    for (const [s, start] of [
      [1, { ...buildSampleMarketGas(), modelId: "k9-same-valid" }],
      [2, withOpenIssue({ ...buildSampleMarketGas(), modelId: "k9-same-open" })],
    ] as const) {
      const next = rng(s * 104729);
      let head = opened(start);
      for (let step = 0; step < 100; step++) {
        const command = randomCommand(head, next, s * 1000 + step);
        if (command.type === "set_model_addon") switches += 1;
        const label = `seed ${s} step ${step} ${JSON.stringify(command)}`;
        const preview = withUpgradePolicy(() => true, () => executeCommand(head, command));
        // The same head opened fresh: nothing known about it, every fact established from scratch.
        const fresh = withUpgradePolicy(() => true, () => executeCommand(opened(head), command));
        if (preview.ok !== fresh.ok) throw new Error(`${label}: incremental ${preview.ok ? "accepted" : "refused"}, fresh ${fresh.ok ? "accepted" : "refused"}`);
        if (!preview.ok || !fresh.ok) {
          if (!preview.ok && !fresh.ok) expect(preview.error.message).toBe(fresh.error.message);
          refused += 1;
          continue;
        }
        // A switch is itself checked under the set before it (round 8b K); its issues show from the next read.
        const full = command.type === "set_model_addon" ? withModelStatePacks(head, () => validateModel(preview.model)) : fullOf(preview.model);
        if (text(preview.openIssues ?? []) !== text(full)) throw new Error(`${label}: open ${text(preview.openIssues ?? []).slice(0, 1500)} vs full ${text(full).slice(0, 1500)}`);
        expect(text(fresh.openIssues ?? [])).toBe(text(full));
        const committed = plan(head, command);
        if (!committed.ok) throw new Error(`${label}: preview accepted, commit refused: ${committed.message}`);
        head = committed.model;
        const headFull = fullOf(head);
        if (text(issuesOf(head)) !== text(headFull)) throw new Error(`${label}: head ${text(issuesOf(head)).slice(0, 1500)} vs full ${text(headFull).slice(0, 1500)}`);
        checked += 1;
      }
    }
    process.stderr.write(`[k9 same-issues] ${checked} accepted and compared, ${refused} refused both ways, ${switches} switches\n`);
    expect(checked + refused).toBe(200);
    expect(switches).toBeGreaterThan(30);
    expect(checked).toBeGreaterThan(100);
  });
});
