/**
 * @jest-environment node
 *
 * Round 11 lane F11 (D2): a disposition is a record in the model, not a host
 * row. It is written by a person (an agent is refused: it proposes), stored
 * as a `finding_disposition` record with a kernel kind row, survives the
 * stored bytes (JSON) and a copy of the model: the copy inherits Main's
 * decisions as of the fork, its own stay on it, and Main's later decisions
 * don't reach it. An older peer is refused in its words.
 *
 * Fails on round 10's code: no record kind, no writer, no standing per copy.
 */
import { commandSchema, kernelKindRow, planCommit, withUpgradePolicy, type Actor, type BimElement, type ModelState } from "../src";
import { FINDING_DISPOSITION_KIND } from "../src/findings";
import { dispositionIndex, dispositionRecordId, dispositionStanding, executeRecordFindingDisposition, FindingLedger, type DispositionIndex, type HeldDisposition, type RecordFindingDispositionCommand } from "../src/findings/api";
import { floor } from "./g7-fixtures";

const RAO: Actor = { id: "user-rao", name: "J. Rao", kind: "human" };
const AGENT: Actor = { id: "agent:user-rao:t1", name: "Agent", kind: "agent" };

let key = 0;
function commit(m: ModelState, command: unknown): ModelState {
  key += 1;
  const d = withUpgradePolicy(() => true, () => planCommit(m, [], { idempotencyKey: `f11-travel-${key}`, baseRevision: m.revision, actor: RAO, command: commandSchema.parse(command) }, () => "2026-11-02T10:00:00.000Z"));
  if (!d.ok) throw new Error(d.error.message);
  return d.model;
}

function held(): ModelState {
  return commit(floor("f11-travel"), { type: "add_question", questions: [{ questionId: "Q-beam", text: "Is there a beam over the corridor?", askOf: "Structural", anchor: { elementIds: ["S100"] }, blocksIssue: true }] });
}

const accept = (over: Partial<RecordFindingDispositionCommand> = {}): RecordFindingDispositionCommand => ({ type: "record_finding_disposition", findingId: "question:Q-beam", sourceVersion: "1", action: "accepted_known", reason: "Issuing for permit; the beam question is answered on site.", ...over });

function decide(m: ModelState, c: RecordFindingDispositionCommand, actor: Actor = RAO, at = "2026-11-02T15:00:00.000Z"): ModelState {
  const r = withUpgradePolicy(() => true, () => executeRecordFindingDisposition(m, c, { actor, at }));
  if (!r.ok) throw new Error(r.error.message);
  return { ...r.model, revision: (m.revision + 1) as ModelState["revision"] };
}

describe("f11-disposition-travels", () => {
  it("the kind is one kernel row: a record, new for older peers until findings:ledger", () => {
    expect(kernelKindRow(FINDING_DISPOSITION_KIND)).toMatchObject({ kind: "finding_disposition", nature: "record", upgrade: { newForOlderPeers: true, feature: "findings:ledger" } });
  });

  it("a person's decision is a record in the model; the ledger reads it; it survives the stored bytes", () => {
    const m = decide(held(), accept());
    const rec = m.elements[dispositionRecordId("question:Q-beam", "1")];
    expect(rec).toMatchObject({ kind: "finding_disposition", disposition: { finding_id: "question:Q-beam", action: "accepted_known", by: { provider: "unsigned", subject: "user-rao", kind: "person" }, scope: { lineage_id: "main" } } });
    const ledger = new FindingLedger();
    ledger.open(m);
    const f = ledger.get("question:Q-beam");
    if (!f) throw new Error("the hold should be a finding");
    expect(ledger.standingOf(f)).toMatchObject({ state: "disposed", inherited: false, disposition: { action: "accepted_known", reason: expect.stringContaining("Issuing for permit") } });

    const stored: Record<string, BimElement> = JSON.parse(JSON.stringify(m.elements));
    const reopened = new FindingLedger();
    reopened.open({ ...m, elements: stored });
    expect(reopened.standingOf(f).state).toBe("disposed");
  });

  it("an agent proposes, a person records: the agent's command writes nothing", () => {
    const r = withUpgradePolicy(() => true, () => executeRecordFindingDisposition(held(), accept(), { actor: AGENT }));
    expect(r).toMatchObject({ ok: false, error: { message: "An agent can propose this decision; a person records it. Nothing changed" } });
  });

  it("an older peer is refused in the older-server words", () => {
    const r = withUpgradePolicy(() => false, () => executeRecordFindingDisposition(held(), accept(), { actor: RAO }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/^Decision on a problem can't be saved yet: the model server this model is open on is an older version/);
  });

  it("a copy inherits Main's decisions as of the fork; its own stay on it; Main's later ones don't reach it", () => {
    const m = decide(held(), accept());
    const shop = { lineageId: "shop-1", ancestors: [{ lineageId: "main", forkRevision: m.revision }] };
    const finding = { id: "question:Q-beam", source: { kind: "question", id: "Q-beam", version: "1" } };
    // The copy's own retraction re-opens it there and only there.
    const onShop = decide(m, accept({ action: "retracted", reason: "Not on the shop copy: the beam moved.", lineageId: "shop-1" }), RAO, "2026-11-02T16:00:00.000Z");
    expect(dispositionStanding(finding, dispositionIndex(m.elements), shop)).toMatchObject({ state: "disposed", inherited: true });
    expect(dispositionStanding(finding, dispositionIndex(onShop.elements), shop)).toEqual({ state: "open" });
    expect(dispositionStanding(finding, dispositionIndex(onShop.elements))).toMatchObject({ state: "disposed", inherited: false });

    // A decision Main records after the fork, read together with the copy's (a merged index), doesn't reach the copy.
    const late: HeldDisposition = { disposition: { findingId: "question:Q-other", sourceVersion: "1", action: "waived", reason: "Waived on Main after the fork.", by: { provider: "unsigned", subject: "user-rao", kind: "person" }, at: "2026-11-03T09:00:00.000Z", scope: { lineageId: "main" } }, recordId: "fd-late", recordedRevision: m.revision + 5 };
    const index: DispositionIndex = { byFinding: new Map([["question:Q-other", [late]]]), count: 1, unreadable: 0 };
    expect(dispositionStanding({ id: "question:Q-other", source: finding.source }, index, shop)).toEqual({ state: "open" });
    expect(dispositionStanding({ id: "question:Q-other", source: finding.source }, index)).toMatchObject({ state: "disposed" });
    // Accepted back: the copy's decision counts on Main.
    expect(dispositionStanding(finding, dispositionIndex(onShop.elements), { lineageId: "main", acceptedFrom: ["shop-1"] })).toEqual({ state: "open" });
  });

  it("a deferral needs a stage or an issued set, and lapses when the stage is reached", () => {
    expect(() => decide(held(), accept({ action: "deferred_to_stage" }))).toThrow("Say which stage or issued set this waits for");
    const m = decide(held(), accept({ action: "deferred_to_stage", untilStage: "construction_documents" }));
    const finding = { id: "question:Q-beam", source: { kind: "question", id: "Q-beam", version: "1" } };
    expect(dispositionStanding(finding, dispositionIndex(m.elements)).state).toBe("disposed");
    expect(dispositionStanding(finding, dispositionIndex(m.elements), undefined, { stageReached: (s) => s === "construction_documents" })).toMatchObject({ state: "lapsed", words: "Deferred until construction_documents; that stage is here" });
  });
});
