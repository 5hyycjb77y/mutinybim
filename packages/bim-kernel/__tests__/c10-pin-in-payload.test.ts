/**
 * @jest-environment node
 *
 * Round 10 lane C10: an approval pins what it was checked against inside its
 * hashed sign-off payload, so the S9 signature (which signs the record's
 * hash) covers it. Changing one byte of the pin breaks the chain; a record
 * from before round 10 carries no pin, still verifies and reads "Checking
 * context not recorded". Fails on round 9: no checking context existed.
 */
import {
  CHECKING_CONTEXT_KEY,
  IdentityProviderRegistry,
  SIGNOFF_GENESIS,
  buildCheckingContext,
  contextStanding,
  createTestIdentityProvider,
  readCheckingContext,
  signoffFields,
  signoffRecordHash,
  signoffSignedBytes,
  verifySignoffChain,
  verifySignoffChainWithSignatures,
  writeCheckingContext,
  writeSignatureEnvelope,
  type SignoffJson,
  type SignoffRecord,
} from "@permitzip/bim-kernel";
import { IBC_2021, IECC_2021, VA, rule } from "./fixtures/c10-rules";

const RAO = "00000000-0000-0000-0000-00000000a001";

const sprinklers = rule({ ruleId: "ibc-903-2", section: "903.2", ruleVersion: "3", jurisdictionId: VA, adoptedAs: "Virginia USBC 2021" });

function record(seq: number, prev: string, payload: { readonly [key: string]: SignoffJson }): SignoffRecord {
  const base = { seq, projectId: "00000000-0000-0000-0000-0000000000b1", baseModelId: "site-9001", recordKind: "merge_approved", subjectId: "00000000-0000-0000-0000-0000000000c1", actorUserId: RAO, payload };
  return { ...base, prevHash: prev, recordHash: signoffRecordHash(prev, signoffFields(base)) };
}

const ctx = buildCheckingContext({ jurisdiction: VA, codesOfRecord: [IBC_2021, IECC_2021], rules: [sprinklers], packs: [{ id: "test.codes", version: "1.0.0" }], determinations: [{ id: "det-occupancy", version: 2 }] });
const author = { kind: "person", provider: "test.identity", subject: RAO };

describe("c10-pin-in-payload", () => {
  it("the context sits inside the hashed payload and the chain verifies", () => {
    const r = record(1, SIGNOFF_GENESIS, { author, discipline: "fire_protection", [CHECKING_CONTEXT_KEY]: writeCheckingContext(ctx) });
    expect(verifySignoffChain([r])).toMatchObject({ ok: true, count: 1 });
    expect(readCheckingContext(r.payload)).toEqual(ctx);
    expect(new TextDecoder().decode(signoffSignedBytes(r))).toContain('"checking_context":{"codesOfRecord"');
  });

  it("the S9 signature over the record covers the context: it verifies, and an edited pin fails the chain", async () => {
    const tester = createTestIdentityProvider([{ subject: RAO, displayName: "J. Rao", keyId: "key-rao", secret: "rao" }]);
    const registry = new IdentityProviderRegistry([tester.provider]);
    const r = record(1, SIGNOFF_GENESIS, { author, [CHECKING_CONTEXT_KEY]: writeCheckingContext(ctx) });
    const signed: SignoffRecord = { ...r, signatureEnvelope: writeSignatureEnvelope(tester.sign(RAO, signoffSignedBytes(r))) };
    const out = await verifySignoffChainWithSignatures([signed], (env, bytes) => registry.verifyEnvelope(env, bytes));
    expect(out.chain.ok).toBe(true);
    expect(out.signatures).toEqual([{ seq: 1, status: "valid", signer: expect.objectContaining({ subject: RAO }) }]);

    const edited = writeCheckingContext({ ...ctx, rules: ctx.rules.map((x) => ({ ...x, ruleVersion: "4" })) });
    const tampered: SignoffRecord = { ...signed, payload: { ...signed.payload, [CHECKING_CONTEXT_KEY]: edited } };
    expect(verifySignoffChain([tampered])).toMatchObject({ ok: false, seq: 1, problem: "Entry 1 was changed after it was recorded." });
  });

  it("pinning is deterministic: the same inputs give the same bytes, whatever order the rules came in", () => {
    const other = rule({ ruleId: "ibc-1004", section: "1004.5" });
    const a = buildCheckingContext({ jurisdiction: VA, codesOfRecord: [IECC_2021, IBC_2021], rules: [sprinklers, other] });
    const b = buildCheckingContext({ jurisdiction: VA, codesOfRecord: [IBC_2021, IECC_2021], rules: [other, sprinklers, other] });
    expect(JSON.stringify(writeCheckingContext(a))).toBe(JSON.stringify(writeCheckingContext(b)));
    expect(a.lineageId).toBe("main");
  });

  it("a record from before round 10 still verifies and reads \"Checking context not recorded\"", () => {
    const old = record(1, SIGNOFF_GENESIS, { author, discipline: "mechanical" });
    expect(verifySignoffChain([old]).ok).toBe(true);
    expect(readCheckingContext(old.payload)).toBeNull();
    expect(contextStanding(readCheckingContext(old.payload), { codesOfRecord: [IBC_2021], rules: [] })).toEqual({ state: "not_recorded", words: "Checking context not recorded" });
  });

  it("its stored form is text and whole numbers only, so the database canonicalizes it the same way", () => {
    const numbers: number[] = [];
    JSON.parse(JSON.stringify(writeCheckingContext(ctx)), (_k, v: unknown) => {
      if (typeof v === "number") numbers.push(v);
      return v;
    });
    expect(numbers.every(Number.isSafeInteger)).toBe(true);
    expect(() => signoffRecordHash(SIGNOFF_GENESIS, signoffFields({ seq: 1, projectId: "p", baseModelId: "m", recordKind: "merge_approved", subjectId: "s", actorUserId: RAO, payload: { [CHECKING_CONTEXT_KEY]: writeCheckingContext(ctx) } }))).not.toThrow();
  });
});
