/**
 * @jest-environment node
 *
 * Round 9 lane K9: switching an add-on re-checks only what its contributions
 * reach. The kernel records which add-on contributions each check reads (every
 * read of the pack set while the check runs); on a switch it compares the two
 * sets read by read and re-runs only the checks whose reads differ, plus what
 * changed since the reads were recorded.
 *
 * Fails on round 8b: a switch re-ran the whole model (a cold pass, then a full
 * ledger build on a model the add-on gave issues), and the first edit after
 * opening a model with an issue open ran a cold pass and then a full ledger.
 */
import {
  buildPointReads,
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
import { contribute, defineExtensionPoint, definePack, withModelStatePacks } from "@permitzip/bim-kernel/packs";
import { buildSampleMarketGas } from "../../bim-kernel/__tests__/fixtures/sample-market-gas";
import { CHECK_ADDON_ID, CHECK_ADDON_VERSION, CHECK_MESSAGE_START, CHECK_TEST_PACK } from "./fixtures/check-addon";

const NOW = () => "2026-11-01T00:00:00.000Z";
let seq = 0;

/** A point no check reads, and an add-on contributing one row to it: switching it re-checks nothing. */
const UNREAD_POINT = defineExtensionPoint<{ readonly id: string }>({ id: "k9test.unread", version: 1, label: "Rows no check reads", idOf: (r) => r.id });
const UNREAD_PACK = definePack({ id: "k9unread", name: "Test unread rows", version: "1.0.0", kernel: "^1.5.0" }, [contribute(UNREAD_POINT, [{ id: "k9unread.row" }])]);

let uninstall: () => void = () => undefined;
beforeAll(() => {
  uninstall = installModelSetupHost(() => [CHECK_TEST_PACK, UNREAD_PACK]);
});
afterAll(() => uninstall());

function commit(head: ModelState, command: Command): ModelState {
  seq += 1;
  const d = withUpgradePolicy(
    () => true,
    () => planCommit(head, [], { idempotencyKey: `k9-switch-${seq}`, baseRevision: head.revision, actor: { id: "avery", name: "Avery", kind: "human" }, command }, NOW),
  );
  if (!d.ok) throw new Error(`${command.type}: ${d.error.message}`);
  return d.model;
}

const switchOn = (packId: string, on: boolean): Command => ({ type: "set_model_addon", packId, version: packId === CHECK_ADDON_ID ? CHECK_ADDON_VERSION : "1.0.0", on });
const newLevel = (n: number): Command => ({ type: "create_level", levelId: `lvl-k9-${n}`, name: `K9 ${n}`, elevationMm: 20_000 + n * 3_000 });

const fullOf = (m: ModelState): readonly ValidationIssue[] => withModelStatePacks(m, () => validateModel(m));
const ours = (issues: readonly ValidationIssue[]): readonly ValidationIssue[] => issues.filter((i) => i.message.startsWith(CHECK_MESSAGE_START));
const same = (a: readonly ValidationIssue[], b: readonly ValidationIssue[]): void => expect(JSON.stringify(a)).toBe(JSON.stringify(b));

/** A copy with nothing known about it (no index, no facts): a head opened from storage. */
const opened = (m: ModelState): ModelState => ({ ...m, elements: { ...m.elements } });

/** Sample Market plus forty levels: elements no pipe check reads. */
function sampleMarketModel(modelId: string): ModelState {
  let m: ModelState = { ...buildSampleMarketGas(), modelId };
  for (let n = 100; n < 140; n++) m = commit(m, newLevel(n));
  return opened(m);
}

function withOpenIssue(m: ModelState): ModelState {
  const part = { version: 1, authoredRev: {}, id: "k9-orphan", kind: "part", typeId: "k9-missing-type", levelId: "lvl-1", position: { x: 0, y: 50_000 }, offsetMm: 0, rotationDeg: 0, mark: "X1", values: {} } as unknown as BimElement;
  return opened({ ...m, elements: { ...m.elements, [part.id]: part } });
}

/** Elements the test add-on's check reads: pipe run segments and fittings. */
function pipeChecks(m: ModelState): number {
  return Object.values(m.elements).filter((e) => (e.kind === "run_segment" || e.kind === "run_fitting") && e.domain === "pipe").length;
}

const stats = () => incrementalValidationStats();

/** What a host does once the save is answered and it is idle (round 10): build the point index the cold pass skipped. */
const whenIdle = (m: ModelState): void => {
  expect(buildPointReads(m)).toBe(true);
};

describe("k9-switch-reruns-only-readers", () => {
  it("switching the check add-on on re-runs the pipe checks and the switch record, nothing else", () => {
    const head0 = sampleMarketModel("k9-readers");
    expect(issuesOf(head0)).toHaveLength(0);
    whenIdle(head0);
    const head = commit(head0, switchOn(CHECK_ADDON_ID, true));
    const s1 = stats();
    const after = issuesOf(head);
    const s2 = stats();
    same(after, fullOf(head));
    expect(ours(after).length).toBeGreaterThan(0);
    expect(s2.fullPasses - s1.fullPasses).toBe(0);
    expect(s2.coldPasses - s1.coldPasses).toBe(0);
    const total = Object.keys(head.elements).length + head.connections.length;
    // The add-on's check reads only pipe checks; the switch record changed. Everything else is carried.
    expect(s2.unitsRerun - s1.unitsRerun).toBe(pipeChecks(head) + 1);
    expect(s2.unitsRerun - s1.unitsRerun).toBeLessThan(total / 2);
  });

  it("switching an add-on whose rows no check reads re-runs only the switch record", () => {
    const head0 = sampleMarketModel("k9-unread");
    expect(issuesOf(head0)).toHaveLength(0);
    whenIdle(head0);
    const head = commit(head0, switchOn("k9unread", true));
    const s1 = stats();
    same(issuesOf(head), fullOf(head));
    const s2 = stats();
    expect(s2.unitsRerun - s1.unitsRerun).toBe(1);
    expect(s2.coldPasses - s1.coldPasses + s2.fullPasses - s1.fullPasses).toBe(0);
  });

  it("switching off on a model with another issue open re-runs the readers and gives back the list before", () => {
    const head0 = withOpenIssue(sampleMarketModel("k9-open"));
    const before = issuesOf(head0);
    expect(before.length).toBeGreaterThan(0);
    whenIdle(head0);
    let head = commit(head0, switchOn(CHECK_ADDON_ID, true));
    same(issuesOf(head), fullOf(head));
    head = commit(head, newLevel(1));
    head = commit(head, switchOn(CHECK_ADDON_ID, false));
    const s1 = stats();
    const back = issuesOf(head);
    const s2 = stats();
    same(back, fullOf(head));
    expect(back.map((i) => i.message)).toEqual(before.map((i) => i.message));
    expect(s2.coldPasses - s1.coldPasses + s2.fullPasses - s1.fullPasses).toBe(0);
  });
});

describe("k9-valid-model-index", () => {
  it("a valid model's cold pass records what each check reads; a switch and the edits after it run no whole-model check", () => {
    const head0 = sampleMarketModel("k9-valid");
    const s0 = stats();
    expect(issuesOf(head0)).toHaveLength(0);
    const s1 = stats();
    // One cold pass, no ledger: a valid model keeps only the slim index.
    expect(s1.coldPasses - s0.coldPasses).toBe(1);
    expect(s1.fullPasses - s0.fullPasses).toBe(0);
    whenIdle(head0);
    let head = commit(head0, switchOn(CHECK_ADDON_ID, true));
    for (let n = 1; n <= 4; n++) {
      const r = withUpgradePolicy(() => true, () => executeCommand(head, newLevel(n)));
      if (!r.ok) throw new Error(r.error.message);
      same(r.openIssues ?? [], fullOf(r.model));
      head = commit(head, newLevel(n));
      same(issuesOf(head), fullOf(head));
    }
    expect(ours(issuesOf(head)).length).toBeGreaterThan(0);
    head = commit(head, switchOn(CHECK_ADDON_ID, false));
    head = commit(head, newLevel(9));
    same(issuesOf(head), []);
    const s2 = stats();
    expect(s2.coldPasses - s1.coldPasses).toBe(0);
    expect(s2.fullPasses - s1.fullPasses).toBe(0);
  });
});

describe("k9-one-pass-first-edit", () => {
  it("the first edit after opening a model with an issue open runs one whole-model check, not two", () => {
    const head0 = withOpenIssue(sampleMarketModel("k9-one-pass"));
    const s0 = stats();
    const head = commit(head0, newLevel(1));
    const s1 = stats();
    same(issuesOf(head), fullOf(head));
    expect(s1.coldPasses - s0.coldPasses).toBe(1);
    expect(s1.fullPasses - s0.fullPasses).toBe(0);
    // And the edits after it stay incremental.
    let next = head;
    for (let n = 2; n <= 5; n++) next = commit(next, newLevel(n));
    same(issuesOf(next), fullOf(next));
    const s2 = stats();
    expect(s2.coldPasses - s1.coldPasses + s2.fullPasses - s1.fullPasses).toBe(0);
  });
});
