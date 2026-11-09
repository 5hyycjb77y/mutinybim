/**
 * @jest-environment node
 *
 * Round 10 lane V10: a host signs the head of a person's key history and
 * anyone can check it with the published key; a changed byte fails; an old
 * checkpoint still checks after the host rotates its key; a key history
 * fetched later is checked against the published head. Fails on round 9's
 * code: there is no checkpoint module.
 */
import {
  KEY_LOG_GENESIS,
  base64UrlEncode,
  checkpointKeyId,
  historyExtendsCheckpoint,
  keyLogCheckpointBytes,
  keyLogEventHash,
  keyLogFields,
  signKeyLogCheckpoint,
  verifyKeyLogCheckpoint,
  type CheckpointKey,
  type KeyLogEvent,
  type UnsignedKeyLogCheckpoint,
} from "@permitzip/bim-kernel";

const PERSON = "00000000-0000-0000-0000-0000000010a1";

async function hostKey(validFrom: string, validTo: string | null = null): Promise<{ key: CheckpointKey; privateKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { key: { keyId: checkpointKeyId(raw), publicKey: base64UrlEncode(raw), alg: "ed25519", validFrom, validTo }, privateKey: pair.privateKey };
}

function log(count: number): KeyLogEvent[] {
  const out: KeyLogEvent[] = [];
  let prev = KEY_LOG_GENESIS;
  for (let seq = 1; seq <= count; seq++) {
    const payload: KeyLogEvent["payload"] = seq === 1 ? { alg: "webauthn-es256", label: "Laptop", public_key_spki: "MFkw", rp_id: "app.example", enrolled_at: "2026-11-01T10:00:00Z" } : { label: `Laptop ${seq}` };
    const e = { seq, subject: PERSON, eventKind: seq === 1 ? "signing_key_enrolled" : "signing_key_renamed", keyId: "cred-1", payload };
    const eventHash = keyLogEventHash(prev, keyLogFields(e));
    out.push({ ...e, prevHash: prev, eventHash });
    prev = eventHash;
  }
  return out;
}

function unsigned(events: readonly KeyLogEvent[], keyId: string, signedAt: string): UnsignedKeyLogCheckpoint {
  const head = events[events.length - 1];
  if (!head) throw new Error("empty log");
  return { scope: "person", subject: PERSON, seq: head.seq, headHash: head.eventHash, signedAt, keyId };
}

describe("v10-checkpoint-verifies", () => {
  it("a signed checkpoint checks with the published key", async () => {
    const { key, privateKey } = await hostKey("2026-11-01T00:00:00Z");
    const cp = await signKeyLogCheckpoint(unsigned(log(2), key.keyId, "2026-11-02T12:00:00Z"), privateKey);
    expect(cp.signature).toMatch(/^[A-Za-z0-9_-]{86}$/);
    await expect(verifyKeyLogCheckpoint(cp, [key])).resolves.toMatchObject({ ok: true, words: "Key history published on 2026-11-02 at entry 2; the signature checks." });
  });

  it("a changed head, sequence, subject, time or signature byte fails in words", async () => {
    const { key, privateKey } = await hostKey("2026-11-01T00:00:00Z");
    const cp = await signKeyLogCheckpoint(unsigned(log(2), key.keyId, "2026-11-02T12:00:00Z"), privateKey);
    const broken = "The checkpoint's signature doesn't check: it was changed after it was signed.";
    await expect(verifyKeyLogCheckpoint({ ...cp, headHash: "f".repeat(64) }, [key])).resolves.toEqual({ ok: false, problem: broken });
    await expect(verifyKeyLogCheckpoint({ ...cp, seq: 3 }, [key])).resolves.toEqual({ ok: false, problem: broken });
    await expect(verifyKeyLogCheckpoint({ ...cp, subject: "someone-else" }, [key])).resolves.toEqual({ ok: false, problem: broken });
    await expect(verifyKeyLogCheckpoint({ ...cp, signedAt: "2026-11-02T12:00:01Z" }, [key])).resolves.toEqual({ ok: false, problem: broken });
    const first = cp.signature[0] === "A" ? "B" : "A";
    await expect(verifyKeyLogCheckpoint({ ...cp, signature: `${first}${cp.signature.slice(1)}` }, [key])).resolves.toEqual({ ok: false, problem: broken });
  });

  it("an unpublished key, a key used outside its window and a key whose id doesn't match are refused", async () => {
    const { key, privateKey } = await hostKey("2026-11-01T00:00:00Z");
    const other = await hostKey("2026-11-01T00:00:00Z");
    const cp = await signKeyLogCheckpoint(unsigned(log(1), key.keyId, "2026-11-02T12:00:00Z"), privateKey);
    await expect(verifyKeyLogCheckpoint(cp, [other.key])).resolves.toEqual({ ok: false, problem: "The key that signed this checkpoint isn't published." });
    await expect(verifyKeyLogCheckpoint(cp, [{ ...key, validFrom: "2026-11-03T00:00:00Z" }])).resolves.toMatchObject({ ok: false, problem: expect.stringContaining("outside the time its key was in use") });
    await expect(verifyKeyLogCheckpoint(cp, [{ ...key, publicKey: other.key.publicKey }])).resolves.toEqual({ ok: false, problem: "The published key doesn't match its id." });
  });

  it("after the host rotates, the old checkpoint still checks against the retired key", async () => {
    const old = await hostKey("2026-11-01T00:00:00Z", "2026-11-05T00:00:00Z");
    const next = await hostKey("2026-11-05T00:00:00Z");
    const before = await signKeyLogCheckpoint(unsigned(log(1), old.key.keyId, "2026-11-02T12:00:00Z"), old.privateKey);
    const after = await signKeyLogCheckpoint(unsigned(log(2), next.key.keyId, "2026-11-06T12:00:00Z"), next.privateKey);
    const published = [old.key, next.key];
    await expect(verifyKeyLogCheckpoint(before, published)).resolves.toMatchObject({ ok: true });
    await expect(verifyKeyLogCheckpoint(after, published)).resolves.toMatchObject({ ok: true });
    // The retired key signing after it was retired is refused.
    const late = await signKeyLogCheckpoint(unsigned(log(2), old.key.keyId, "2026-11-06T12:00:00Z"), old.privateKey);
    await expect(verifyKeyLogCheckpoint(late, published)).resolves.toMatchObject({ ok: false, problem: expect.stringContaining("outside the time its key was in use") });
  });

  it("a key history fetched later extends the published head, or says how it differs", async () => {
    const { key, privateKey } = await hostKey("2026-11-01T00:00:00Z");
    const events = log(3);
    const cp = await signKeyLogCheckpoint(unsigned(events.slice(0, 2), key.keyId, "2026-11-02T12:00:00Z"), privateKey);
    expect(historyExtendsCheckpoint(events, cp)).toEqual({ ok: true, words: "This key history matches what was published on 2026-11-02." });
    expect(historyExtendsCheckpoint(events.slice(0, 1), cp)).toEqual({ ok: false, problem: "This key history has 1 entries, fewer than the 2 published on 2026-11-02." });
    // Rewrite entry 2 consistently (re-chained): the history checks on its own but not against the checkpoint.
    const rewritten = log(1);
    const e2 = { seq: 2, subject: PERSON, eventKind: "signing_key_renamed", keyId: "cred-1", payload: { label: "Someone else's laptop" } };
    const prev = rewritten[0]?.eventHash ?? KEY_LOG_GENESIS;
    rewritten.push({ ...e2, prevHash: prev, eventHash: keyLogEventHash(prev, keyLogFields(e2)) });
    expect(historyExtendsCheckpoint(rewritten, cp)).toEqual({ ok: false, problem: "This key history differs from what was published on 2026-11-02: an earlier entry was changed." });
  });

  it("the signed bytes are canonical and refuse malformed fields", () => {
    const keyId = "a".repeat(64);
    const bytes = keyLogCheckpointBytes({ scope: "person", subject: PERSON, seq: 1, headHash: "b".repeat(64), signedAt: "2026-11-02T12:00:00Z", keyId });
    expect(new TextDecoder().decode(bytes)).toBe(`pzkeyckpt/v1{"head_hash":"${"b".repeat(64)}","key_id":"${keyId}","scope":"person","seq":1,"signed_at":"2026-11-02T12:00:00Z","subject":"${PERSON}"}`);
    expect(() => keyLogCheckpointBytes({ scope: "person", subject: PERSON, seq: 0, headHash: "b".repeat(64), signedAt: "2026-11-02T12:00:00Z", keyId })).toThrow("whole number from 1");
    expect(() => keyLogCheckpointBytes({ scope: "person", subject: PERSON, seq: 1, headHash: "B".repeat(64), signedAt: "2026-11-02T12:00:00Z", keyId })).toThrow("64 lowercase hex");
  });
});
