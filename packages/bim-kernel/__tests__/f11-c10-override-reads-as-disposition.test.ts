/**
 * @jest-environment node
 *
 * Round 11 lane F11 (D2): C10's signer override and a requirement's
 * `overridden` state read as dispositions in the one list, with their stored
 * bytes unchanged. A C10 override in the sign-off chain answers the reliance
 * finding of the same id at the same source version; a requirement state
 * `overridden` answers its requirement finding (`override`, by the person
 * who set it, with their reason). C10's own `dispositionAnswers` and the
 * disposition bytes it writes are unchanged.
 *
 * Fails on round 10's code: no ledger, no chain reader, and an override was
 * not a disposition anyone else could read.
 */
import { commandSchema, planCommit, withUpgradePolicy, type Actor, type ModelState } from "../src";
import { dispositionAnswers, readFindingDisposition, relianceFindingId, writeFindingDisposition, type FindingDisposition } from "../src/findings";
import { dispositionsFromSignoffRecords } from "../src/findings/signed";
import { dispositionIndex, dispositionStanding, FindingLedger, type FindingSourceRow } from "../src/findings/api";
import { bindModelPacks, PackSet } from "../src/packs";
import { unbindRequirementsSnapshot } from "../src";
import { bindStudy, floor, ZT_PACK } from "./g7-fixtures";

const RAO = { provider: "test.identity", subject: "user-rao", kind: "person" as const };

beforeAll(() => {
  bindModelPacks("f11-c10-req", PackSet.create([ZT_PACK]));
  bindStudy("f11-c10-req");
});
afterAll(() => unbindRequirementsSnapshot("f11-c10-req"));

describe("f11-c10-override-reads-as-disposition", () => {
  it("C10's chain override answers the reliance finding in the ledger; its bytes and its own reader are unchanged", () => {
    const override: FindingDisposition = { findingId: relianceFindingId("rec-1"), sourceVersion: "codes:abc", action: "override", reason: "Re-checked by hand; IBC 2024 changes nothing here.", by: RAO, at: "2026-11-02T12:00:00.000Z", scope: { lineageId: "main" } };
    const written = writeFindingDisposition(override);
    expect(written).toEqual({ finding_id: "reliance:rec-1", source_version: "codes:abc", action: "override", reason: override.reason, by: RAO, at: override.at, scope: { lineage_id: "main" } });
    expect(readFindingDisposition(written)).toEqual({ ok: true, value: override });
    expect(dispositionAnswers(override, "reliance:rec-1", "codes:abc")).toBe(true);

    // The payload C10's writer stores, as the chain holds it.
    const payload = { finding_id: "reliance:rec-1", source_version: "codes:abc", action: "override", reason: override.reason, by: { provider: RAO.provider, subject: RAO.subject, kind: RAO.kind }, at: override.at, scope: { lineage_id: "main" } };
    expect(payload).toEqual(written);
    const chain = dispositionsFromSignoffRecords([{ seq: 1, projectId: "p", baseModelId: "m", recordKind: "finding_disposition", subjectId: "rec-1", actorUserId: "user-rao", payload, prevHash: "0".repeat(64), recordHash: "0".repeat(64) }]);
    const reliance: FindingSourceRow = { id: "f11c.reliance_feed", label: "Signed approvals", all: (ctx) => [{ id: "reliance:rec-1", source: { kind: "reliance", id: "rec-1", version: "codes:abc" }, severity: "warning", subjects: ["rec-1"], lineageId: ctx.lineageId, revision: ctx.model.revision, words: "May no longer hold — checked against an older rule" }] };
    const ledger = new FindingLedger({ feeds: [reliance], extraDispositions: () => chain });
    ledger.open(floor("f11-c10"));
    const f = ledger.get("reliance:rec-1");
    if (!f) throw new Error("the feed's finding should be listed");
    expect(ledger.standingOf(f)).toMatchObject({ state: "disposed", disposition: { action: "override", reason: override.reason } });
    expect(ledger.entries({ open: true }).some((e) => e.finding.id === f.id)).toBe(false);
  });

  it("a requirement state 'overridden' reads as an override disposition on its requirement finding", () => {
    const actor: Actor = { id: "user-example", name: "K. Example", kind: "human" };
    const m0: ModelState = floor("f11-c10-req");
    const reqId = "zt.code_study:head-count:fp.head_count:S104";
    const d = withUpgradePolicy(() => true, () => planCommit(m0, [], { idempotencyKey: "f11-c10-req-1", baseRevision: m0.revision, actor, command: commandSchema.parse({ type: "set_requirement_state", requirementId: reqId, status: "overridden", value: 2, unit: "ea", reason: "Two heads cover it; the hazard was reviewed with the AHJ.", by: "K. Example" }) }, () => "2026-11-02T10:00:00.000Z"));
    if (!d.ok) throw new Error(d.error.message);
    const index = dispositionIndex(d.model.elements);
    const held = index.byFinding.get(`requirement:${reqId}`)?.[0];
    expect(held?.disposition).toMatchObject({ action: "override", sourceVersion: "unversioned", reason: "Two heads cover it; the hazard was reviewed with the AHJ.", by: { kind: "person", subject: "K. Example" } });
    expect(dispositionStanding({ id: `requirement:${reqId}`, source: { kind: "requirement", id: "zt.code_study:head-count", version: "1" } }, index).state).toBe("disposed");
  });
});
