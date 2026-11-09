/**
 * @jest-environment node
 *
 * Round 11 lane F11 (product owner answer 3): accepting a known problem is part of
 * what the signer signs. A sign-off payload carries a `dispositions` section
 * (text only, canonical order), the chain hash and the S9 signature cover
 * it, an edited acceptance breaks the chain, a payload without the section
 * reads as none, and only a person's recorded decisions can be signed. The
 * ledger names what a signer's approval signs: the decisions in force on
 * findings touching their elements.
 *
 * Fails on round 10's code: no section, no reader, no `dispositionsTouching`.
 */
import { commandSchema, IdentityProviderRegistry, createTestIdentityProvider, planCommit, SIGNOFF_GENESIS, signoffFields, signoffRecordHash, signoffSignedBytes, verifySignoffChain, verifySignoffChainWithSignatures, withUpgradePolicy, writeSignatureEnvelope, type Actor, type ModelState, type SignoffJson, type SignoffRecord } from "../src";
import { MAIN_LINEAGE, type FindingDisposition } from "../src/findings";
import { dispositionsFromSignoffRecords, readSignedDispositions, signedDispositionsSection, SIGNED_DISPOSITIONS_KEY } from "../src/findings/signed";
import { executeRecordFindingDisposition, FindingLedger } from "../src/findings/api";
import { floor } from "./g7-fixtures";

const RAO_ID = "00000000-0000-0000-0000-00000000a001";
const RAO = { provider: "test.identity", subject: RAO_ID, kind: "person" as const, displayName: "J. Rao" };

const accepted = (findingId: string, at = "2026-11-02T15:00:00.000Z"): FindingDisposition => ({ findingId, sourceVersion: "1", action: "accepted_known", reason: "Known clash; the contractor reroutes in the field.", by: RAO, at, scope: { lineageId: MAIN_LINEAGE } });

function record(seq: number, prev: string, payload: { readonly [key: string]: SignoffJson }, recordKind = "merge_approved"): SignoffRecord {
  const base = { seq, projectId: "00000000-0000-0000-0000-0000000000b1", baseModelId: "site-9001", recordKind, subjectId: "00000000-0000-0000-0000-0000000000c1", actorUserId: RAO_ID, payload };
  return { ...base, prevHash: prev, recordHash: signoffRecordHash(prev, signoffFields(base)) };
}

function section(ds: readonly FindingDisposition[]): { readonly [key: string]: readonly SignoffJson[] } {
  const s = signedDispositionsSection(ds);
  if (!s.ok) throw new Error(s.reason);
  return s.section;
}

describe("f11-in-signed-payload", () => {
  it("the acceptance sits inside the hashed, signed payload; editing it breaks the chain", async () => {
    const r = record(1, SIGNOFF_GENESIS, { author: { kind: "person", provider: "test.identity", subject: RAO_ID }, discipline: "fire_protection", ...section([accepted("question:Q-2"), accepted("lint_rule:clash-hard:a|b")]) });
    expect(verifySignoffChain([r])).toMatchObject({ ok: true, count: 1 });
    expect(new TextDecoder().decode(signoffSignedBytes(r))).toContain('"dispositions":[{"action":"accepted_known"');
    expect(readSignedDispositions(r.payload).dispositions.map((d) => d.findingId)).toEqual(["lint_rule:clash-hard:a|b", "question:Q-2"]);

    const tester = createTestIdentityProvider([{ subject: RAO_ID, displayName: "J. Rao", keyId: "key-rao", secret: "rao" }]);
    const registry = new IdentityProviderRegistry([tester.provider]);
    const signed: SignoffRecord = { ...r, signatureEnvelope: writeSignatureEnvelope(tester.sign(RAO_ID, signoffSignedBytes(r))) };
    const out = await verifySignoffChainWithSignatures([signed], (env, bytes) => registry.verifyEnvelope(env, bytes));
    expect(out.signatures).toEqual([{ seq: 1, status: "valid", signer: expect.objectContaining({ subject: RAO_ID }) }]);

    const edited = section([{ ...accepted("question:Q-2"), reason: "Edited after signing, to say something else." }, accepted("lint_rule:clash-hard:a|b")]);
    const tampered: SignoffRecord = { ...signed, payload: { ...signed.payload, ...edited } };
    expect(verifySignoffChain([tampered])).toMatchObject({ ok: false, seq: 1, problem: "Entry 1 was changed after it was recorded." });
  });

  it("two hosts write the same bytes whatever order they list the decisions in", () => {
    const a = section([accepted("question:Q-2"), accepted("lint_rule:x", "2026-11-02T16:00:00.000Z"), accepted("lint_rule:x")]);
    const b = section([accepted("lint_rule:x"), accepted("question:Q-2"), accepted("lint_rule:x", "2026-11-02T16:00:00.000Z")]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("an agent's decision or one with no reason can't be signed; old payloads carry none", () => {
    expect(signedDispositionsSection([{ ...accepted("q"), by: { provider: "test.identity", subject: "agent:x", kind: "agent", onBehalfOf: RAO } }])).toMatchObject({ ok: false, reason: expect.stringContaining("made by an agent") });
    expect(signedDispositionsSection([{ ...accepted("q"), reason: "short" }]).ok).toBe(false);
    expect(readSignedDispositions({ author: "x" })).toEqual({ dispositions: [], unreadable: 0 });
    expect(readSignedDispositions({ [SIGNED_DISPOSITIONS_KEY]: [{ finding_id: "q" }] })).toEqual({ dispositions: [], unreadable: 1 });
  });

  it("the chain's dispositions: C10 overrides and the sections other entries carry", () => {
    const c10 = record(1, SIGNOFF_GENESIS, { finding_id: "reliance:rec-1", source_version: "codes:abc", action: "override", reason: "Re-checked by hand; IBC 2024 changes nothing here.", author: { kind: "person", provider: "test.identity", subject: RAO_ID }, at: "2026-11-02T12:00:00.000Z", scope: { lineage_id: "main" } }, "finding_disposition");
    const approval = record(2, c10.recordHash, { ...section([accepted("question:Q-2")]) });
    expect(dispositionsFromSignoffRecords([c10, approval]).map((d) => [d.findingId, d.action])).toEqual([
      ["reliance:rec-1", "override"],
      ["question:Q-2", "accepted_known"],
    ]);
  });

  it("the ledger names what a signer's approval of some elements signs: the decisions in force on findings touching them", () => {
    const actor: Actor = { id: RAO_ID, name: "J. Rao", kind: "human" };
    let m: ModelState = floor("f11-signed");
    const d = withUpgradePolicy(() => true, () => planCommit(m, [], { idempotencyKey: "f11-signed-1", baseRevision: m.revision, actor, command: commandSchema.parse({ type: "add_question", questions: [{ questionId: "Q-2", text: "Beam over 102?", askOf: "Structural", anchor: { elementIds: ["S102"] }, blocksIssue: true }] }) }, () => "2026-11-02T10:00:00.000Z"));
    if (!d.ok) throw new Error(d.error.message);
    m = d.model;
    const r = withUpgradePolicy(() => true, () => executeRecordFindingDisposition(m, { type: "record_finding_disposition", findingId: "question:Q-2", sourceVersion: "1", action: "accepted_known", reason: "Issued with the question open; answered on site." }, { actor, at: "2026-11-02T15:00:00.000Z" }));
    if (!r.ok) throw new Error(r.error.message);
    const ledger = new FindingLedger();
    ledger.open(r.model);
    expect(ledger.dispositionsTouching(["S102"]).map((x) => x.findingId)).toEqual(["question:Q-2"]);
    expect(ledger.dispositionsTouching(["S104"])).toEqual([]);
  });
});
