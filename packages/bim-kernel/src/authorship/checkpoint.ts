import { canonicalize, sha256HexOf, utf8Bytes } from "./canonical";
import { verifyKeyLog, type KeyLogEvent } from "./key-log";
import { base64UrlDecode, base64UrlEncode } from "./webauthn";

/**
 * Signed checkpoints of a person's key history (round 10 lane V10). A host
 * periodically signs the head of each person's `pzkey/v1` key log (its
 * sequence number and head hash) with its own Ed25519 key and publishes the
 * result, so anyone who later fetches that history can check it still
 * extends what was published: a host can't quietly rewrite who held which
 * key. No blockchain; publishing the host's keys with their validity windows
 * is the trust root. Rotating the host key never invalidates an old
 * checkpoint: each key stays published with the window it signed in.
 *
 * signed bytes = utf8("pzkeyckpt/v1" ‖ canonicalize({ head_hash, key_id, scope, seq, signed_at, subject }))
 *
 * WebCrypto only (Ed25519 is in every current browser and Node 22), no
 * dependency, no host name.
 */

export const KEY_LOG_CHECKPOINT_DOMAIN = "pzkeyckpt/v1";
export const CHECKPOINT_ALG = "ed25519";

/** Scopes this release writes: one person's key log. Readers keep any other and say they can't check it. */
export type KeyLogCheckpointScope = "person" | (string & {});

export interface KeyLogCheckpoint {
  readonly scope: KeyLogCheckpointScope;
  /** The key log's subject (a provider's person id). */
  readonly subject: string;
  /** The head's sequence number: the log had exactly this many entries. */
  readonly seq: number;
  /** `eventHash` of entry `seq`. */
  readonly headHash: string;
  /** ISO 8601 time of signing. */
  readonly signedAt: string;
  /** Which published host key signed it. */
  readonly keyId: string;
  /** Ed25519 signature over `keyLogCheckpointBytes`, base64url (64 bytes). */
  readonly signature: string;
}

export type UnsignedKeyLogCheckpoint = Omit<KeyLogCheckpoint, "signature">;

/** A host's published checkpoint key. `validTo` is set when the host rotated away from it. */
export interface CheckpointKey {
  readonly keyId: string;
  /** Raw 32-byte Ed25519 public key, base64url. */
  readonly publicKey: string;
  readonly alg: string;
  readonly validFrom: string;
  readonly validTo: string | null;
}

const HEX64 = /^[0-9a-f]{64}$/;

export function keyLogCheckpointFields(cp: UnsignedKeyLogCheckpoint): { readonly [key: string]: string | number } {
  return { head_hash: cp.headHash, key_id: cp.keyId, scope: cp.scope, seq: cp.seq, signed_at: cp.signedAt, subject: cp.subject };
}

/** The exact bytes a checkpoint signature covers. Refuses a malformed checkpoint rather than signing it. */
export function keyLogCheckpointBytes(cp: UnsignedKeyLogCheckpoint): Uint8Array {
  if (!Number.isSafeInteger(cp.seq) || cp.seq < 1) throw new Error("a checkpoint's sequence number is a whole number from 1");
  if (!HEX64.test(cp.headHash)) throw new Error("a checkpoint's head hash is 64 lowercase hex characters");
  if (!HEX64.test(cp.keyId)) throw new Error("a checkpoint's key id is 64 lowercase hex characters");
  if (Number.isNaN(Date.parse(cp.signedAt))) throw new Error("a checkpoint's signing time is an ISO 8601 time");
  return utf8Bytes(`${KEY_LOG_CHECKPOINT_DOMAIN}${canonicalize(keyLogCheckpointFields(cp))}`);
}

/** A host key's id: SHA-256 (hex) of its raw 32-byte public key. */
export function checkpointKeyId(publicKeyRaw: Uint8Array): string {
  if (publicKeyRaw.length !== 32) throw new Error("an Ed25519 public key is 32 bytes");
  return sha256HexOf(publicKeyRaw);
}

function buffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

function subtleOf(subtle: SubtleCrypto | undefined): SubtleCrypto {
  const s = subtle ?? globalThis.crypto?.subtle;
  if (!s) throw new Error("This runtime has no WebCrypto, so checkpoints can't be signed or checked here.");
  return s;
}

/** Sign a checkpoint with an Ed25519 private key (WebCrypto). The caller publishes the matching key first. */
export async function signKeyLogCheckpoint(cp: UnsignedKeyLogCheckpoint, privateKey: CryptoKey, subtle?: SubtleCrypto): Promise<KeyLogCheckpoint> {
  const bytes = keyLogCheckpointBytes(cp);
  const sig = new Uint8Array(await subtleOf(subtle).sign({ name: "Ed25519" }, privateKey, buffer(bytes)));
  return { ...cp, signature: base64UrlEncode(sig) };
}

export type CheckpointVerdict =
  | { readonly ok: true; readonly words: string; readonly key: CheckpointKey }
  | { readonly ok: false; readonly problem: string };

const day = (iso: string) => iso.slice(0, 10);

/**
 * Check one checkpoint against the host's published keys: the key is
 * published, it was in force when the checkpoint was signed, and the
 * signature covers exactly these fields. Answers in words.
 */
export async function verifyKeyLogCheckpoint(cp: KeyLogCheckpoint, keys: readonly CheckpointKey[], subtle?: SubtleCrypto): Promise<CheckpointVerdict> {
  if (cp.scope !== "person") return { ok: false, problem: `This checkpoint covers "${cp.scope}", which this version can't check.` };
  const key = keys.find((k) => k.keyId === cp.keyId);
  if (!key) return { ok: false, problem: "The key that signed this checkpoint isn't published." };
  if (key.alg !== CHECKPOINT_ALG) return { ok: false, problem: `The key that signed this checkpoint uses ${key.alg}, which this version can't check.` };
  const at = Date.parse(cp.signedAt);
  if (Number.isNaN(at)) return { ok: false, problem: "This checkpoint's signing time can't be read." };
  if (at < Date.parse(key.validFrom) || (key.validTo !== null && at > Date.parse(key.validTo))) {
    return { ok: false, problem: `This checkpoint says it was signed on ${day(cp.signedAt)}, outside the time its key was in use.` };
  }
  const raw = base64UrlDecode(key.publicKey);
  const sig = base64UrlDecode(cp.signature);
  if (!raw || raw.length !== 32) return { ok: false, problem: "The published key can't be read." };
  if (checkpointKeyId(raw) !== key.keyId) return { ok: false, problem: "The published key doesn't match its id." };
  if (!sig || sig.length !== 64) return { ok: false, problem: "The checkpoint's signature can't be read." };
  let bytes: Uint8Array;
  try {
    bytes = keyLogCheckpointBytes(cp);
  } catch (err) {
    return { ok: false, problem: `This checkpoint can't be checked: ${err instanceof Error ? err.message : String(err)}.` };
  }
  const s = subtleOf(subtle);
  const pub = await s.importKey("raw", buffer(raw), { name: "Ed25519" }, false, ["verify"]);
  const good = await s.verify({ name: "Ed25519" }, pub, buffer(sig), buffer(bytes));
  if (!good) return { ok: false, problem: "The checkpoint's signature doesn't check: it was changed after it was signed." };
  return { ok: true, words: `Key history published on ${day(cp.signedAt)} at entry ${cp.seq}; the signature checks.`, key };
}

export type HistoryAgainstCheckpoint = { readonly ok: true; readonly words: string } | { readonly ok: false; readonly problem: string };

/**
 * Whether a key history fetched now still extends a (verified) checkpoint:
 * the log checks, has at least `seq` entries, and entry `seq` is the head
 * that was published.
 */
export function historyExtendsCheckpoint(events: readonly KeyLogEvent[], cp: KeyLogCheckpoint): HistoryAgainstCheckpoint {
  const prefix = events.filter((e) => e.seq <= cp.seq);
  const verdict = verifyKeyLog(prefix);
  if (!verdict.ok) return { ok: false, problem: verdict.problem };
  if (prefix.some((e) => e.subject !== cp.subject)) return { ok: false, problem: "This key history belongs to someone else." };
  if (verdict.count < cp.seq) return { ok: false, problem: `This key history has ${verdict.count} entries, fewer than the ${cp.seq} published on ${day(cp.signedAt)}.` };
  if (verdict.head !== cp.headHash) return { ok: false, problem: `This key history differs from what was published on ${day(cp.signedAt)}: an earlier entry was changed.` };
  return { ok: true, words: `This key history matches what was published on ${day(cp.signedAt)}.` };
}
