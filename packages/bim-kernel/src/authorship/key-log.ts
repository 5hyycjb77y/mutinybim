import { canonicalize, sha256HexOf } from "./canonical";

/**
 * A person's signing-key history (round 9 lane S9): one append-only,
 * hash-chained list per person of the keys they enrolled, renamed and
 * retired, across every model. A model's signature names a key id; a
 * verifier reads the signer's key log to learn the key and when (if ever) it
 * was retired. A key is never deleted: retiring it stops new signatures and
 * never makes a past signature invalid. Each entry's time is in its hashed
 * payload (`enrolled_at`, `retired_at`), so the history says when.
 *
 * event_hash = sha256(utf8("pzkey/v1" ‖ prev_hash ‖ canonicalize(fields)))
 *
 * The canonical bytes are the sign-off chain's (RFC 8785, whole numbers
 * only), so the host reproduces them with the same function (for example
 * `app_private.bim_jcs`) and a shared test vector pins both.
 */

export const KEY_LOG_DOMAIN = "pzkey/v1";
export const KEY_LOG_GENESIS = "0".repeat(64);

/** Kinds this release writes; readers keep any other (a newer host's) and skip it. */
export const KEY_LOG_KINDS = ["signing_key_enrolled", "signing_key_renamed", "signing_key_retired"] as const;
export type KeyLogKind = (typeof KEY_LOG_KINDS)[number] | (string & {});

export type KeyLogJson = null | boolean | number | string | readonly KeyLogJson[] | { readonly [key: string]: KeyLogJson };

export interface KeyLogEvent {
  readonly seq: number;
  /** The provider's subject (the host's user id). */
  readonly subject: string;
  readonly eventKind: KeyLogKind;
  /** The key's id (a passkey credential id, base64url). */
  readonly keyId: string;
  /** For `signing_key_enrolled`: `public_key_spki` (base64url), `alg`, `label`, `rp_id`, `enrolled_at`. Renamed: `label`. Retired: `retired_at`. */
  readonly payload: { readonly [key: string]: KeyLogJson };
  readonly prevHash: string;
  readonly eventHash: string;
  readonly createdAt?: string;
}

export function keyLogFields(e: Pick<KeyLogEvent, "seq" | "subject" | "eventKind" | "keyId" | "payload">): { readonly [key: string]: KeyLogJson } {
  return { event_kind: e.eventKind, key_id: e.keyId, payload: e.payload, seq: e.seq, subject: e.subject };
}

function wholeNumbersOnly(value: KeyLogJson): boolean {
  if (typeof value === "number") return Number.isSafeInteger(value);
  if (Array.isArray(value)) return value.every((v) => wholeNumbersOnly(v ?? null));
  if (value !== null && typeof value === "object") return Object.values(value).every((v) => wholeNumbersOnly(v));
  return true;
}

export function keyLogEventHash(prevHash: string, fields: { readonly [key: string]: KeyLogJson }): string {
  if (!wholeNumbersOnly(fields)) throw new Error("key log payload numbers are whole numbers");
  return sha256HexOf(`${KEY_LOG_DOMAIN}${prevHash}${canonicalize(fields)}`);
}

export type KeyLogVerdict = { readonly ok: true; readonly count: number; readonly head: string } | { readonly ok: false; readonly seq: number | null; readonly problem: string };

const HEX64 = /^[0-9a-f]{64}$/;

/** Check one person's key log: one subject, sequence 1, 2, 3…, each pointing at the one before, each hash recomputed. */
export function verifyKeyLog(events: readonly KeyLogEvent[]): KeyLogVerdict {
  let prev = KEY_LOG_GENESIS;
  let subject: string | null = null;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!e) continue;
    if (subject === null) subject = e.subject;
    if (e.subject !== subject) return { ok: false, seq: e.seq, problem: `Entry ${e.seq} belongs to someone else's key history.` };
    if (e.seq !== i + 1) return { ok: false, seq: e.seq, problem: e.seq > i + 1 ? `Key history entry ${i + 1} is missing.` : `Key history entry ${e.seq} is out of order.` };
    if (!HEX64.test(e.prevHash) || !HEX64.test(e.eventHash)) return { ok: false, seq: e.seq, problem: `Key history entry ${e.seq} has a malformed hash.` };
    if (e.prevHash !== prev) return { ok: false, seq: e.seq, problem: `Key history entry ${e.seq} doesn't follow the one before: an entry was changed or removed.` };
    let hash: string;
    try {
      hash = keyLogEventHash(e.prevHash, keyLogFields(e));
    } catch (err) {
      return { ok: false, seq: e.seq, problem: `Key history entry ${e.seq} can't be checked: ${err instanceof Error ? err.message : String(err)}.` };
    }
    if (hash !== e.eventHash) return { ok: false, seq: e.seq, problem: `Key history entry ${e.seq} was changed after it was written.` };
    prev = e.eventHash;
  }
  return { ok: true, count: events.length, head: prev };
}

export interface KeyFromLog {
  readonly keyId: string;
  readonly subject: string;
  readonly publicKeySpki: string;
  readonly alg: string;
  readonly label: string;
  readonly enrolledSeq: number;
  readonly retiredSeq: number | null;
  readonly retiredAt: string | null;
}

/**
 * The keys a (verified) key log describes, by key id. Only an enrolment
 * creates a key; renames and removals of a key the log never enrolled are
 * ignored, as is any kind this release doesn't know.
 */
export function keysFromLog(events: readonly KeyLogEvent[]): ReadonlyMap<string, KeyFromLog> {
  const keys = new Map<string, KeyFromLog>();
  for (const e of events) {
    const prior = keys.get(e.keyId);
    if (e.eventKind === "signing_key_enrolled" && !prior) {
      const { public_key_spki: spki, alg, label } = e.payload;
      if (typeof spki !== "string" || typeof alg !== "string") continue;
      keys.set(e.keyId, { keyId: e.keyId, subject: e.subject, publicKeySpki: spki, alg, label: typeof label === "string" ? label : "Passkey", enrolledSeq: e.seq, retiredSeq: null, retiredAt: null });
    } else if (e.eventKind === "signing_key_renamed" && prior && typeof e.payload.label === "string") {
      keys.set(e.keyId, { ...prior, label: e.payload.label });
    } else if (e.eventKind === "signing_key_retired" && prior && prior.retiredSeq === null) {
      const at = typeof e.payload.retired_at === "string" ? e.payload.retired_at : (e.createdAt ?? null);
      keys.set(e.keyId, { ...prior, retiredSeq: e.seq, retiredAt: at });
    }
  }
  return keys;
}
