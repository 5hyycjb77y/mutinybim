/**
 * @jest-environment node
 *
 * Round 9 lane S9: a person's signing-key history is hash-chained like the
 * sign-off log, with the same canonical bytes, so the host's table
 * (`bim_signing_key_events`, hashed in SQL) and this check agree byte for
 * byte (the vector below is asserted by `supabase/tests/bim_signing_keys.test.sql`
 * too). A retired key stays known, with the time from its hashed entry. Fails on round 8b's code:
 * there is no key log.
 */
import { KEY_LOG_GENESIS, keyLogEventHash, keyLogFields, keysFromLog, verifyKeyLog, type KeyLogEvent } from "@permitzip/bim-kernel";

const PERSON = "00000000-0000-0000-0000-0000000005a1";

function log(): KeyLogEvent[] {
  const raw: Omit<KeyLogEvent, "prevHash" | "eventHash">[] = [
    { seq: 1, subject: PERSON, eventKind: "signing_key_enrolled", keyId: "cred-1", payload: { alg: "webauthn-es256", label: "MacBook Touch ID", public_key_spki: "MFkw", rp_id: "app.polygnotos.com" } }, // oss-clean: legacy-host-id (pinned hash vector)
    { seq: 2, subject: PERSON, eventKind: "signing_key_renamed", keyId: "cred-1", payload: { label: "Work laptop" } },
    { seq: 3, subject: PERSON, eventKind: "signing_key_retired", keyId: "cred-1", payload: { retired_at: "2026-11-02T09:00:00Z" }, createdAt: "2026-11-02T09:00:05Z" },
  ];
  const out: KeyLogEvent[] = [];
  let prev = KEY_LOG_GENESIS;
  for (const e of raw) {
    const eventHash = keyLogEventHash(prev, keyLogFields(e));
    out.push({ ...e, prevHash: prev, eventHash });
    prev = eventHash;
  }
  return out;
}

describe("s9-key-log", () => {
  it("the shared vector: the first event's hash is pinned (SQL reproduces it)", () => {
    const [first] = log();
    expect(first?.eventHash).toBe(SHARED_VECTOR_HASH);
  });

  it("verifies, and a changed, removed or reordered entry is named", () => {
    const events = log();
    expect(verifyKeyLog(events)).toMatchObject({ ok: true, count: 3 });
    expect(verifyKeyLog(events.map((e) => (e.seq === 2 ? { ...e, payload: { label: "Someone's laptop" } } : e)))).toEqual({ ok: false, seq: 2, problem: "Key history entry 2 was changed after it was written." });
    expect(verifyKeyLog([events[0], events[2]].filter((e): e is KeyLogEvent => e !== undefined))).toMatchObject({ ok: false, seq: 3 });
    expect(verifyKeyLog(events.map((e) => (e.seq === 3 ? { ...e, subject: "someone-else" } : e)))).toMatchObject({ ok: false, problem: "Entry 3 belongs to someone else's key history." });
  });

  it("a retired key is never dropped: still known, with its last name and the hashed retire time", () => {
    expect(keysFromLog(log()).get("cred-1")).toEqual({
      keyId: "cred-1",
      subject: PERSON,
      publicKeySpki: "MFkw",
      alg: "webauthn-es256",
      label: "Work laptop",
      enrolledSeq: 1,
      retiredSeq: 3,
      retiredAt: "2026-11-02T09:00:00Z",
    });
  });

  it("a removal of a key never enrolled, and an unknown kind, are ignored", () => {
    const stray: KeyLogEvent = { seq: 4, subject: PERSON, eventKind: "signing_key_retired", keyId: "cred-x", payload: {}, prevHash: KEY_LOG_GENESIS, eventHash: KEY_LOG_GENESIS };
    const future: KeyLogEvent = { ...stray, eventKind: "signing_key_moved_to_wallet", keyId: "cred-1" };
    const keys = keysFromLog([...log(), stray, future]);
    expect(keys.has("cred-x")).toBe(false);
    expect(keys.get("cred-1")?.retiredSeq).toBe(3);
  });
});

const SHARED_VECTOR_HASH = "9735f111d269035fac2c09409fb134e508d266c1f58c12b58327a97a64ce00a7";
