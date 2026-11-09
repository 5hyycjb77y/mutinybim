/**
 * @jest-environment node
 *
 * Round 9 lane S9: the sign-off chain checks signatures too. Each record
 * reads "not signed", "valid" (by whom) or why its signature doesn't check:
 * a forged envelope, one copied from another record, one claiming someone
 * other than the person who recorded it. A chain that was edited has its
 * signatures left unchecked. Fails on round 8b's code: records carry no
 * signature and `verifySignoffChainWithSignatures` doesn't exist.
 */
import {
  IdentityProviderRegistry,
  base64UrlDecode,
  createTestIdentityProvider,
  createWebAuthnIdentityProvider,
  signoffFields,
  signoffRecordHash,
  signoffSignedBytes,
  verifySignoffChain,
  verifySignoffChainWithSignatures,
  webAuthnEnvelope,
  writeSignatureEnvelope,
  SIGNOFF_GENESIS,
  type SignoffRecord,
} from "@permitzip/bim-kernel";
import { VECTOR, VECTOR_RECORD } from "./s9-webauthn-vector";

const J_RAO = "00000000-0000-0000-0000-00000000a001";
const LEE = "00000000-0000-0000-0000-00000000a002";

function chain(n: number): SignoffRecord[] {
  const out: SignoffRecord[] = [];
  let prev = SIGNOFF_GENESIS;
  for (let seq = 1; seq <= n; seq++) {
    const actor = seq % 2 === 1 ? J_RAO : LEE;
    const base = {
      seq,
      projectId: "00000000-0000-0000-0000-0000000000b1",
      baseModelId: "site-9001",
      recordKind: "merge_approved",
      subjectId: "00000000-0000-0000-0000-0000000000c1",
      actorUserId: actor,
      payload: { author: { kind: "person", provider: "test.identity", subject: actor }, discipline: "mechanical" },
    };
    const recordHash = signoffRecordHash(prev, signoffFields(base));
    out.push({ ...base, prevHash: prev, recordHash });
    prev = recordHash;
  }
  return out;
}

const tester = createTestIdentityProvider([
  { subject: J_RAO, displayName: "J. Rao", keyId: "key-rao", secret: "rao" },
  { subject: LEE, displayName: "P. Lee", keyId: "key-lee", secret: "lee" },
]);
const registry = new IdentityProviderRegistry([tester.provider]);
const check = (env: Parameters<IdentityProviderRegistry["verifyEnvelope"]>[0], bytes: Uint8Array) => registry.verifyEnvelope(env, bytes);

function signed(records: SignoffRecord[], seq: number, by = records[seq - 1]?.actorUserId ?? J_RAO): SignoffRecord[] {
  return records.map((r) => (r.seq === seq ? { ...r, signatureEnvelope: writeSignatureEnvelope(tester.sign(by, signoffSignedBytes(r))) } : r));
}

describe("s9-chain-verifies-signatures", () => {
  it("a signature signs the record hash: its digest is sha256:<record_hash>", () => {
    const [r] = chain(1);
    if (!r) throw new Error("no record");
    expect(tester.sign(J_RAO, signoffSignedBytes(r)).payloadDigest).toBe(`sha256:${r.recordHash}`);
  });

  it("reads recorded-only, signed-by and the chain together", async () => {
    const records = signed(chain(3), 2);
    expect(verifySignoffChain(records)).toMatchObject({ ok: true, count: 3 });
    const out = await verifySignoffChainWithSignatures(records, check);
    expect(out.chain.ok).toBe(true);
    expect(out.signatures).toEqual([
      { seq: 1, status: "not_signed" },
      { seq: 2, status: "valid", signer: expect.objectContaining({ subject: LEE, displayName: "P. Lee" }) },
      { seq: 3, status: "not_signed" },
    ]);
  });

  it("a forged signature value doesn't check", async () => {
    const records = signed(chain(2), 1).map((r) => (r.seq === 1 && typeof r.signatureEnvelope === "object" && r.signatureEnvelope !== null ? { ...r, signatureEnvelope: { ...r.signatureEnvelope, signature: "0".repeat(64) } } : r));
    const out = await verifySignoffChainWithSignatures(records, check);
    expect(out.signatures[0]).toMatchObject({ seq: 1, status: "invalid" });
  });

  it("a signature copied from another entry doesn't check", async () => {
    const records = signed(chain(3), 1);
    const moved = records.map((r) => (r.seq === 3 ? { ...r, signatureEnvelope: records[0]?.signatureEnvelope } : r));
    const out = await verifySignoffChainWithSignatures(moved, check);
    expect(out.signatures[2]).toEqual({ seq: 3, status: "invalid", reason: "This signature is for a different entry, not entry 3." });
  });

  it("someone else's signature on your entry doesn't check, even with a valid key", async () => {
    const out = await verifySignoffChainWithSignatures(signed(chain(1), 1, LEE), check);
    expect(out.signatures[0]).toMatchObject({ status: "invalid", reason: expect.stringContaining("People sign only their own entries") });
  });

  it("an edited chain is reported and its signatures aren't checked", async () => {
    const records = signed(chain(2), 1).map((r) => (r.seq === 1 ? { ...r, payload: { ...r.payload, discipline: "structure" } } : r));
    const out = await verifySignoffChainWithSignatures(records, check);
    expect(out.chain).toEqual({ ok: false, seq: 1, problem: "Entry 1 was changed after it was recorded." });
    expect(out.signatures).toEqual([]);
  });

  it("a real passkey signature (the fixed WebAuthn vector) checks on its record", async () => {
    const spki = base64UrlDecode(VECTOR.spki);
    const authenticatorData = base64UrlDecode(VECTOR.authenticatorData);
    const clientDataJSON = base64UrlDecode(VECTOR.clientDataJSON);
    const signature = base64UrlDecode(VECTOR.signature);
    if (!spki || !authenticatorData || !clientDataJSON || !signature) throw new Error("bad vector");
    const record: SignoffRecord = { ...VECTOR_RECORD };
    expect(verifySignoffChain([record])).toMatchObject({ ok: true });
    // The vector was signed under the host's earlier provider id; the host now writes "host" and keeps reading the old id.
    // oss-clean: legacy-host-id
    const env = webAuthnEnvelope({ provider: "polygnotos", signer: { provider: "polygnotos", subject: VECTOR.signer, kind: "person" }, payloadDigest: `sha256:${record.recordHash}`, assertion: { credentialId: VECTOR.credentialId, authenticatorData, clientDataJSON, signature } });
    const passkeys = new IdentityProviderRegistry([
      {
        ...createWebAuthnIdentityProvider({
          id: "host",
          label: "Host login",
          version: "0.2.0",
          relyingParty: { rpId: VECTOR.rpId, origins: [VECTOR.origin] },
          resolveAuthor: async () => null,
          resolveKey: async () => ({ subject: VECTOR.signer, publicKeySpki: spki, retiredAt: null }),
        }),
        // oss-clean: legacy-host-id
        legacyIds: ["polygnotos"],
      },
    ]);
    const out = await verifySignoffChainWithSignatures([{ ...record, signatureEnvelope: writeSignatureEnvelope(env) }], (e, b) => passkeys.verifyEnvelope(e, b));
    expect(out.signatures).toEqual([{ seq: 1, status: "valid", signer: expect.objectContaining({ subject: VECTOR.signer, keyId: VECTOR.credentialId }) }]);
  });

  (process.env.S9_PERF === "1" ? it : it.skip)("10,000 entries verify inside the budget (signoff.chain.verify.10k, 400 ms p95)", async () => {
    const records = chain(10_000);
    const times: number[] = [];
    for (let run = 0; run < 7; run++) {
      const t0 = performance.now();
      const out = await verifySignoffChainWithSignatures(records, check);
      times.push(performance.now() - t0);
      expect(out.chain).toMatchObject({ ok: true, count: 10_000 });
    }
    times.sort((a, b) => a - b);
    const p50 = times[3] ?? Infinity;
    const p95 = times[6] ?? Infinity;
    process.stderr.write(`[s9-perf] signoff.chain.verify.10k p50 ${p50.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms\n`);
    expect(p50).toBeLessThan(200);
    expect(p95).toBeLessThan(400);
  });
});
