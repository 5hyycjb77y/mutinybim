/**
 * @jest-environment node
 *
 * Round 8b lane K: what a model knows about its own validity is tied to the
 * add-on set it was checked under. Switching a test add-on with one pipe check
 * on (`set_model_addon`) makes the next edit report that check's issues; off,
 * they are gone; every answer equals full validation under the state's own set.
 *
 * Fails on round 8: the switch's result was checked under the set before the
 * switch and remembered as "known valid", so the next edit took the
 * incremental path and never ran the add-on's check (`k8-switch-rechecks`),
 * and on a model with other issues open the add-on's issues had no earlier
 * report and refused an unrelated edit. A host rebinding a state to another
 * set read the facts established under the first one.
 */
import {
  executeCommand,
  incrementalValidationStats,
  installModelSetupHost,
  issuesOf,
  planCommit,
  validateModel,
  withUpgradePolicy,
  type BimElement,
  type Command,
  type ModelState,
  type ValidationIssue,
} from "@permitzip/bim-kernel";
import { bindModelPacks, PackSet, unbindModelPacks, withModelStatePacks } from "@permitzip/bim-kernel/packs";
import { buildSampleMarketGas } from "../../bim-kernel/__tests__/fixtures/sample-market-gas";
import { CHECK_ADDON_ID, CHECK_ADDON_VERSION, CHECK_MESSAGE_START, CHECK_TEST_PACK } from "./fixtures/check-addon";

const NOW = () => "2026-11-01T00:00:00.000Z";
let seq = 0;

let uninstall: () => void = () => undefined;
beforeAll(() => {
  uninstall = installModelSetupHost(() => [CHECK_TEST_PACK]);
});
afterAll(() => uninstall());

function commit(head: ModelState, command: Command): ModelState {
  seq += 1;
  const d = withUpgradePolicy(
    () => true,
    () => planCommit(head, [], { idempotencyKey: `k8-switch-${seq}`, baseRevision: head.revision, actor: { id: "avery", name: "Avery", kind: "human" }, command }, NOW),
  );
  if (!d.ok) throw new Error(`${command.type}: ${d.error.message}`);
  return d.model;
}

const switchCheck = (on: boolean): Command => ({ type: "set_model_addon", packId: CHECK_ADDON_ID, version: CHECK_ADDON_VERSION, on });
const newLevel = (n: number): Command => ({ type: "create_level", levelId: `lvl-k8-${n}`, name: `K8 ${n}`, elevationMm: 20_000 + n * 3_000 });

/** Full validation of a state under the set that state resolves to. */
const fullOf = (m: ModelState): readonly ValidationIssue[] => withModelStatePacks(m, () => validateModel(m));
const ours = (issues: readonly ValidationIssue[]): readonly ValidationIssue[] => issues.filter((i) => i.message.startsWith(CHECK_MESSAGE_START));

function edit(head: ModelState, command: Command): { readonly next: ModelState; readonly open: readonly ValidationIssue[] } {
  const r = withUpgradePolicy(() => true, () => executeCommand(head, command));
  if (!r.ok) throw new Error(`${command.type}: ${r.error.message}`);
  expect(JSON.stringify(r.openIssues ?? [])).toBe(JSON.stringify(fullOf(r.model)));
  const next = commit(head, command);
  expect(JSON.stringify(issuesOf(next))).toBe(JSON.stringify(fullOf(next)));
  return { next, open: r.openIssues ?? [] };
}

function sampleMarketModel(modelId: string): ModelState {
  return { ...buildSampleMarketGas(), modelId };
}

/** Sample Market plus one part whose type the model doesn't have: an issue open elsewhere. */
function sampleMarketWithOpenIssue(modelId: string): ModelState {
  const m = sampleMarketModel(modelId);
  const part: BimElement = { version: 1, authoredRev: {}, id: "k8-orphan", kind: "part", typeId: "k8-missing-type", levelId: "lvl-1", position: { x: 0, y: 50_000 }, offsetMm: 0, rotationDeg: 0, mark: "X1", values: {} } as unknown as BimElement;
  return { ...m, elements: { ...m.elements, [part.id]: part } };
}

describe("k8-switch-rechecks", () => {
  it("switch the check add-on on: the next edit reports its issues; off: it no longer does", () => {
    let head = sampleMarketModel("k8-valid");
    expect(ours(fullOf(head))).toHaveLength(0);
    expect(issuesOf(head)).toHaveLength(0);

    head = commit(head, switchCheck(true));
    const revealed = ours(fullOf(head));
    expect(revealed.length).toBeGreaterThan(0);
    expect(JSON.stringify(issuesOf(head))).toBe(JSON.stringify(fullOf(head)));

    const on = edit(head, newLevel(1));
    expect(ours(on.open).map((i) => i.message)).toEqual(revealed.map((i) => i.message));
    head = edit(on.next, newLevel(2)).next;

    head = commit(head, switchCheck(false));
    expect(ours(fullOf(head))).toHaveLength(0);
    const off = edit(head, newLevel(3));
    expect(ours(off.open)).toHaveLength(0);
    expect(off.open).toHaveLength(0);
  });

  it("with another issue open elsewhere: the add-on's issues are open after the switch and don't refuse an unrelated edit", () => {
    let head = sampleMarketWithOpenIssue("k8-open");
    const before = issuesOf(head);
    expect(before.length).toBeGreaterThan(0);
    expect(ours(before)).toHaveLength(0);

    head = commit(head, switchCheck(true));
    const on = edit(head, newLevel(1));
    expect(ours(on.open).length).toBeGreaterThan(0);
    expect(on.open.length).toBe(before.length + ours(on.open).length);

    head = commit(on.next, switchCheck(false));
    const off = edit(head, newLevel(2));
    expect(ours(off.open)).toHaveLength(0);
    expect(off.open.map((i) => i.message)).toEqual(before.map((i) => i.message));
  });

  it("an edit chained on an uncommitted switch (a preview) re-checks too, and the head's facts are left alone", () => {
    const head = sampleMarketModel("k8-preview");
    expect(issuesOf(head)).toHaveLength(0);
    const preview = withUpgradePolicy(() => true, () => executeCommand(head, switchCheck(true)));
    if (!preview.ok) throw new Error(preview.error.message);
    const chained = withUpgradePolicy(() => true, () => executeCommand(preview.model, newLevel(9)));
    if (!chained.ok) throw new Error(chained.error.message);
    expect(ours(chained.openIssues ?? []).length).toBeGreaterThan(0);
    expect(JSON.stringify(chained.openIssues ?? [])).toBe(JSON.stringify(fullOf(chained.model)));
    // The head never had the add-on: its next edit is checked without it.
    const r = edit(head, newLevel(1));
    expect(ours(r.open)).toHaveLength(0);
  });

  it("facts are keyed by the set: a host binding the same state to another set re-establishes them once", () => {
    const head = sampleMarketModel("k8-bound");
    expect(issuesOf(head)).toHaveLength(0);
    bindModelPacks("k8-bound", PackSet.create([CHECK_TEST_PACK]));
    try {
      expect(ours(issuesOf(head)).length).toBeGreaterThan(0);
      expect(JSON.stringify(issuesOf(head))).toBe(JSON.stringify(fullOf(head)));
      expect(issuesOf(head)).toBe(issuesOf(head));
    } finally {
      unbindModelPacks("k8-bound");
    }
    expect(issuesOf(head)).toHaveLength(0);
  });

  it("the switch itself is refused or allowed exactly as before; its issues show from the next edit", () => {
    const head = sampleMarketModel("k8-switch-result");
    const r = withUpgradePolicy(() => true, () => executeCommand(head, switchCheck(true)));
    if (!r.ok) throw new Error(r.error.message);
    // Checked under the set it was made in (the add-on wasn't on yet).
    expect(r.openIssues ?? []).toHaveLength(0);
    const next = commit(head, switchCheck(true));
    expect(ours(issuesOf(next)).length).toBeGreaterThan(0);
  });
});

describe("k8-same-set-stays-incremental", () => {
  it("no switch: edits after the add-on is on keep the incremental path", () => {
    let head = commit(sampleMarketWithOpenIssue("k8-incremental"), switchCheck(true));
    head = edit(head, newLevel(0)).next;
    const s0 = incrementalValidationStats();
    for (let n = 1; n <= 6; n++) head = edit(head, newLevel(n)).next;
    const s1 = incrementalValidationStats();
    // Six edits, each validated twice by the checks above (the command, then the commit): updates, no full pass.
    expect(s1.fullPasses - s0.fullPasses).toBe(0);
    expect(s1.updates - s0.updates).toBeGreaterThanOrEqual(6);
  });
});
