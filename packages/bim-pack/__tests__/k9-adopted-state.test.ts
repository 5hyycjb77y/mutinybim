/**
 * @jest-environment node
 *
 * Round 9 lane K9: a model opened with its kept validation state (written by
 * the process that served it, read back beside its head) adopts what
 * validation knew: no cold pass, and every answer equal to a cold open. A
 * state for another build, add-on set, revision or shape, or whose issues
 * don't re-check, is declined and the cold pass runs as before.
 *
 * Fails on round 8b: there is no kept state; every open runs a cold pass.
 */
import {
  buildPointReads,
  executeCommand,
  incrementalValidationStats,
  installModelSetupHost,
  issuesOf,
  offerValidationState,
  planCommit,
  validateModel,
  validationStateOf,
  validationStateStats,
  withUpgradePolicy,
  type BimElement,
  type Command,
  type ModelState,
  type ValidationIssue,
  type ValidationState,
} from "@permitzip/bim-kernel";
import { withModelStatePacks } from "@permitzip/bim-kernel/packs";
import { buildSampleMarketGas } from "../../bim-kernel/__tests__/fixtures/sample-market-gas";
import { CHECK_ADDON_ID, CHECK_ADDON_VERSION, CHECK_TEST_PACK } from "./fixtures/check-addon";

const NOW = () => "2026-11-01T00:00:00.000Z";
const BUILD = "build-k9";
let seq = 0;

let uninstall: () => void = () => undefined;
beforeAll(() => {
  uninstall = installModelSetupHost(() => [CHECK_TEST_PACK]);
});
afterAll(() => uninstall());

function plan(head: ModelState, command: Command): { ok: true; model: ModelState } | { ok: false; message: string } {
  seq += 1;
  const d = withUpgradePolicy(
    () => true,
    () => planCommit(head, [], { idempotencyKey: `k9-adopt-${seq}`, baseRevision: head.revision, actor: { id: "avery", name: "Avery", kind: "human" }, command }, NOW),
  );
  return d.ok ? { ok: true, model: d.model } : { ok: false, message: d.error.message };
}

function commit(head: ModelState, command: Command): ModelState {
  const r = plan(head, command);
  if (!r.ok) throw new Error(`${command.type}: ${r.message}`);
  return r.model;
}

const fullOf = (m: ModelState): readonly ValidationIssue[] => withModelStatePacks(m, () => validateModel(m));
const text = (issues: readonly ValidationIssue[]): string => JSON.stringify(issues.map((i) => ({ code: i.code, message: i.message, elementIds: [...i.elementIds] })));
const opened = (m: ModelState): ModelState => ({ ...m, elements: { ...m.elements } });

/** What Postgres jsonb hands back: object keys reordered (shortest first), arrays kept. */
function asJsonb(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(asJsonb);
  if (typeof value !== "object" || value === null) return value;
  const keys = Object.keys(value).sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = asJsonb((value as Record<string, unknown>)[k]);
  return out;
}

/** The kept state of `head`, written, stored and read back. */
function kept(head: ModelState): unknown {
  // The model server builds the point index the save skipped before it writes the state (pg-store `writeValidationState`).
  buildPointReads(head);
  const state = validationStateOf(head, BUILD);
  if (!state) throw new Error("no validation state for the head");
  return asJsonb(JSON.parse(JSON.stringify(state)));
}

/** `head` opened by another process: a fresh record, with its kept state offered. */
function reopen(head: ModelState, state: unknown = kept(head), build = BUILD): ModelState {
  const m = opened(head);
  offerValidationState(m, state, build);
  return m;
}

function withOpenIssue(m: ModelState): ModelState {
  const part = { version: 1, authoredRev: {}, id: "k9-adopt-orphan", kind: "part", typeId: "k9-missing-type", levelId: "lvl-1", position: { x: 0, y: 50_000 }, offsetMm: 0, rotationDeg: 0, mark: "X1", values: {} } as unknown as BimElement;
  return { ...m, elements: { ...m.elements, [part.id]: part } };
}

/** Sample Market with an issue open, the check add-on on (its 15 issues too), a few edits in. */
function served(modelId: string): ModelState {
  let head = opened(withOpenIssue({ ...buildSampleMarketGas(), modelId }));
  head = commit(head, { type: "set_model_addon", packId: CHECK_ADDON_ID, version: CHECK_ADDON_VERSION, on: true });
  for (let n = 0; n < 3; n++) head = commit(head, { type: "create_level", levelId: `lvl-k9a-${n}`, name: `K9 ${n}`, elevationMm: 40_000 + n * 3_000 });
  issuesOf(head);
  return head;
}

const wholeChecks = (): number => {
  const s = incrementalValidationStats();
  return s.fullPasses + s.coldPasses;
};

describe("k9-adopted-state", () => {
  it("a model opened with its kept state runs no cold pass and answers as a cold open", () => {
    const head = served("k9-adopt");
    const m = reopen(head);
    const c0 = wholeChecks();
    const a0 = validationStateStats().adopted;
    const issues = issuesOf(m);
    expect(wholeChecks() - c0).toBe(0);
    expect(validationStateStats().adopted - a0).toBe(1);
    expect(text(issues)).toBe(text(fullOf(m)));
    expect(issues.length).toBeGreaterThan(15);
    // And the first edit on it: no whole-model check either.
    const next = commit(m, { type: "create_level", levelId: "lvl-k9a-first", name: "First", elevationMm: 90_000 });
    expect(wholeChecks() - c0).toBe(0);
    expect(text(issuesOf(next))).toBe(text(fullOf(next)));
  });

  it("a valid model's kept state is adopted too", () => {
    let head = opened({ ...buildSampleMarketGas(), modelId: "k9-adopt-valid" });
    head = commit(head, { type: "create_level", levelId: "lvl-k9v", name: "V", elevationMm: 40_000 });
    expect(issuesOf(head)).toHaveLength(0);
    const m = reopen(head);
    const c0 = wholeChecks();
    expect(issuesOf(m)).toHaveLength(0);
    expect(wholeChecks() - c0).toBe(0);
    // A switch on the adopted model re-runs only what the add-on's rows reach.
    const on = commit(m, { type: "set_model_addon", packId: CHECK_ADDON_ID, version: CHECK_ADDON_VERSION, on: true });
    expect(text(issuesOf(on))).toBe(text(fullOf(on)));
    expect(wholeChecks() - c0).toBe(0);
  });

  it("another build, add-on set, revision or shape, or issues that don't re-check: declined, and the cold pass answers", () => {
    const head = served("k9-adopt-mismatch");
    const good = kept(head) as ValidationState;
    const cases: Array<{ readonly why: string; readonly state: unknown; readonly build?: string; readonly otherHost?: boolean }> = [
      { why: "build", state: good, build: "build-other" },
      { why: "shape", state: { ...good, version: good.version + 1 } },
      { why: "shape", state: { ...good, reads: { ...good.reads, keys: "nope" } } },
      { why: "revision", state: { ...good, revision: good.revision - 1 } },
      { why: "add-on set", state: { ...good, setKey: `${good.setKey}|other` } },
      { why: "counts", state: { ...good, elementCount: good.elementCount + 1 } },
      { why: "issues", state: { ...good, issues: good.issues.slice(1) } },
      { why: "reads", state: { ...good, reads: { ...good.reads, connectionSig: 9_999 } } },
      // A host without the test add-on opens it: the model resolves to another set than the one the state was written under.
      { why: "add-on set", state: good, otherHost: true },
    ];
    for (const c of cases) {
      const m = reopen(head, c.state, c.build ?? BUILD);
      const restore = c.otherHost ? installModelSetupHost(() => []) : null;
      try {
        const c0 = wholeChecks();
        const d0 = validationStateStats().declined;
        const issues = issuesOf(m);
        expect({ why: c.why, declined: validationStateStats().declined - d0, last: validationStateStats().lastDeclined }).toEqual({ why: c.why, declined: 1, last: c.why });
        expect(wholeChecks() - c0).toBe(1);
        expect(text(issues)).toBe(text(fullOf(m)));
      } finally {
        restore?.();
      }
    }
  });

  it("k9-adopted-same-issues: 200 random edits and switches from adopted opens equal a cold open, issue for issue and refusal for refusal", () => {
    const NOMINALS = [12.7, 19.05, 25.4, 31.75, 38.1];
    let s = 4242;
    const next = (): number => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x1_0000_0000;
    };
    let head = reopen(served("k9-adopt-random"));
    let accepted = 0;
    let refused = 0;
    let reopened = 0;
    for (let step = 0; step < 200; step++) {
      // Every so often the model is closed and opened by another process with its kept state.
      if (step % 15 === 14) {
        head = reopen(head);
        reopened += 1;
      }
      const els = Object.values(head.elements);
      const roll = next();
      let command: Command = { type: "create_level", levelId: `lvl-k9r-${step}`, name: `R ${step}`, elevationMm: 60_000 + step * 3_000 };
      if (roll < 0.2) command = { type: "set_model_addon", packId: CHECK_ADDON_ID, version: CHECK_ADDON_VERSION, on: next() < 0.5 };
      else if (roll < 0.6) {
        const pipes = els.filter((e) => e.kind === "run_segment" && e.domain === "pipe");
        const seg = pipes[Math.floor(next() * pipes.length)];
        if (seg && seg.kind === "run_segment" && seg.size.shape === "pipe") command = { type: "resize_run", segmentId: seg.id, profile: { ...seg.size, nominalMm: NOMINALS[Math.floor(next() * NOMINALS.length)] ?? 25.4 } };
      } else if (roll < 0.75) {
        const parts = els.filter((e) => e.kind === "part");
        const part = parts[Math.floor(next() * parts.length)];
        if (part) command = { type: "set_parameters", id: part.id, scope: "instance", mark: `R-${step}` };
      }
      const label = `step ${step} ${JSON.stringify(command)}`;
      const preview = withUpgradePolicy(() => true, () => executeCommand(head, command));
      const cold = withUpgradePolicy(() => true, () => executeCommand(opened(head), command));
      if (preview.ok !== cold.ok) throw new Error(`${label}: adopted ${preview.ok ? "accepted" : "refused"}, cold ${cold.ok ? "accepted" : "refused"}`);
      if (!preview.ok || !cold.ok) {
        if (!preview.ok && !cold.ok) expect(preview.error.message).toBe(cold.error.message);
        refused += 1;
        continue;
      }
      expect(text(preview.openIssues ?? [])).toBe(text(cold.openIssues ?? []));
      head = commit(head, command);
      if (text(issuesOf(head)) !== text(fullOf(head))) throw new Error(`${label}: head ${text(issuesOf(head)).slice(0, 800)} vs full ${text(fullOf(head)).slice(0, 800)}`);
      accepted += 1;
    }
    process.stderr.write(`[k9 adopted-same-issues] ${accepted} accepted, ${refused} refused both ways, ${reopened} reopened with a kept state\n`);
    expect(accepted + refused).toBe(200);
    expect(accepted).toBeGreaterThan(100);
    expect(reopened).toBe(13);
  });
});
