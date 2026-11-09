/**
 * The sign-off log's hash chain (round 8 step 8b, lane M; the product owner's answers,
 * Nov 1): one append-only, hash-chained list of records per model, holding
 * every acceptance, take / request / grant, removal, merge approval, decline
 * and merge apply (and lane O's classifications and change-order decisions).
 * Not a blockchain: tamper-evident. Anyone with read access, or later an
 * outside verifier with an export, can check it with `verifySignoffChain`.
 *
 * record_hash = sha256(utf8("pzsig/v1" ‖ prev_hash ‖ canonicalize(fields)))
 *
 * `fields` are the record's identity and decision: actor, model, payload
 * (which carries the author), project, kind, sequence and subject.
 * Canonical bytes are the kernel's RFC 8785 form (`authorship/canonical.ts`);
 * the host reproduces them exactly (in its own database), and a
 * shared test vector pins both. Payload numbers are whole numbers only, so
 * every implementation prints them the same way.
 *
 * A signature (round 9) signs `record_hash`: its envelope names
 * `sha256:<record_hash>` as its digest, so the bytes it covers are the
 * record's hash preimage (`signoffPreimage`). The hash chain is unchanged;
 * `verifySignoffChainWithSignatures` checks both.
 */
import { authorWords } from "../authorship/author";
import { canonicalize, sha256HexOf, utf8Bytes } from "../authorship/canonical";
import { readSignatureEnvelope } from "../authorship/envelope";
import type { AuthorRef, SignatureEnvelope, VerifyOutcome } from "../authorship/types";

export const SIGNOFF_DOMAIN = "pzsig/v1";
/** The previous hash of a chain's first record. */
export const SIGNOFF_GENESIS = "0".repeat(64);

/** Kinds the log holds today; readers keep any other kind (a newer host's). */
export const SIGNOFF_KINDS = [
  "responsibility_accepted",
  "responsibility_taken",
  "responsibility_requested",
  "responsibility_granted",
  "responsibility_removed",
  "merge_approved",
  "merge_declined",
  "merge_applied",
  "change_significance_set",
  "change_order_accepted",
  "change_order_refused",
  "change_order_no_cost",
  // Round 10 (C10): an override of "checked against an older rule", by the record's own signer, with a reason.
  "finding_disposition",
  // Round 11: copies (L11) and frozen stages (G11).
  "lineage_reviewed",
  "lineage_accepted_back",
  "gate_frozen",
] as const;

export type SignoffKind = (typeof SIGNOFF_KINDS)[number] | (string & {});

export type SignoffJson = null | boolean | number | string | readonly SignoffJson[] | { readonly [key: string]: SignoffJson };

export interface SignoffRecord {
  readonly seq: number;
  readonly projectId: string;
  readonly baseModelId: string;
  readonly recordKind: SignoffKind;
  readonly subjectId: string;
  readonly actorUserId: string;
  readonly payload: { readonly [key: string]: SignoffJson };
  readonly prevHash: string;
  readonly recordHash: string;
  /** The stored signature envelope, as written (tolerantly read when checked), or absent: "recorded, not signed". */
  readonly signatureEnvelope?: unknown;
}

const HEX64 = /^[0-9a-f]{64}$/;

/** The first payload number that isn't whole, by path ("fields.payload.n"), or null. Paths are built only for a refusal. */
function wholeNumbersOnly(value: SignoffJson, path: () => string): string | null {
  if (typeof value === "number") return Number.isSafeInteger(value) ? null : `${path()} is ${value}; sign-off payload numbers are whole numbers`;
  if (value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const item: SignoffJson = value[i] ?? null;
      if (typeof item === "string" || typeof item === "boolean" || item === null) continue;
      const bad = wholeNumbersOnly(item, () => `${path()}[${i}]`);
      if (bad) return bad;
    }
    return null;
  }
  for (const k in value) {
    const v = (value as { readonly [key: string]: SignoffJson })[k];
    if (v === undefined || typeof v === "string" || typeof v === "boolean" || v === null) continue;
    const bad = wholeNumbersOnly(v, () => `${path()}.${k}`);
    if (bad) return bad;
  }
  return null;
}

/** The hashed fields of a record, in the shape every implementation canonicalizes. */
export function signoffFields(r: Pick<SignoffRecord, "seq" | "projectId" | "baseModelId" | "recordKind" | "subjectId" | "actorUserId" | "payload">): { readonly [key: string]: SignoffJson } {
  return {
    actor_user_id: r.actorUserId,
    base_model_id: r.baseModelId,
    payload: r.payload,
    project_id: r.projectId,
    record_kind: r.recordKind,
    seq: r.seq,
    subject_id: r.subjectId,
  };
}

/** The text a record's hash is taken over. Throws when a payload number isn't whole. */
export function signoffPreimage(prevHash: string, fields: { readonly [key: string]: SignoffJson }): string {
  const bad = wholeNumbersOnly(fields, () => "fields");
  if (bad) throw new Error(bad);
  return `${SIGNOFF_DOMAIN}${prevHash}${canonicalize(fields)}`;
}

/** A record's hash from the previous one. Throws when a payload number isn't whole. */
export function signoffRecordHash(prevHash: string, fields: { readonly [key: string]: SignoffJson }): string {
  return sha256HexOf(signoffPreimage(prevHash, fields));
}

/** The bytes a record's signature covers (their SHA-256 is `record_hash`). */
export function signoffSignedBytes(r: SignoffRecord): Uint8Array {
  return utf8Bytes(signoffPreimage(r.prevHash, signoffFields(r)));
}

export type SignoffVerdict = { readonly ok: true; readonly count: number; readonly head: string } | { readonly ok: false; readonly seq: number | null; readonly problem: string };

/**
 * Check a model's chain, in the order given: sequence 1, 2, 3… with no gap
 * or repeat, each record pointing at the one before (the first at the
 * genesis value), and each hash recomputed from its fields. Catches an
 * edited payload, a removed record and a reordered sequence, and says which
 * record and what, in words.
 */
export function verifySignoffChain(records: readonly SignoffRecord[]): SignoffVerdict {
  let prev = SIGNOFF_GENESIS;
  let model: string | null = null;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (!r) continue;
    const expected = i + 1;
    if (model === null) model = r.baseModelId;
    if (r.baseModelId !== model) return { ok: false, seq: r.seq, problem: `Entry ${r.seq} belongs to model ${r.baseModelId}, not ${model}.` };
    if (r.seq !== expected) return { ok: false, seq: r.seq, problem: r.seq > expected ? `Entry ${expected} is missing (the next one is ${r.seq}).` : `Entry ${r.seq} is out of order (expected entry ${expected}).` };
    if (!HEX64.test(r.prevHash) || !HEX64.test(r.recordHash)) return { ok: false, seq: r.seq, problem: `Entry ${r.seq} has a malformed hash.` };
    if (r.prevHash !== prev) return { ok: false, seq: r.seq, problem: `Entry ${r.seq} doesn't follow entry ${r.seq - 1}: an entry before it was changed or removed.` };
    let hash: string;
    try {
      hash = signoffRecordHash(r.prevHash, signoffFields(r));
    } catch (err) {
      return { ok: false, seq: r.seq, problem: `Entry ${r.seq} can't be checked: ${err instanceof Error ? err.message : String(err)}.` };
    }
    if (hash !== r.recordHash) return { ok: false, seq: r.seq, problem: `Entry ${r.seq} was changed after it was recorded.` };
    prev = r.recordHash;
  }
  return { ok: true, count: records.length, head: prev };
}

/** What a reader sees beside one record: signed by whom, recorded only, or a signature that doesn't check. */
export type SignoffSignatureStatus =
  | { readonly seq: number; readonly status: "not_signed" }
  | { readonly seq: number; readonly status: "valid"; readonly signer: AuthorRef; readonly note?: string }
  | { readonly seq: number; readonly status: "invalid" | "unverifiable"; readonly reason: string };

/** Checks one envelope over bytes: an `IdentityProviderRegistry`'s `verifyEnvelope`, bound. */
export type SignatureChecker = (env: SignatureEnvelope, payload: Uint8Array) => Promise<VerifyOutcome>;

/**
 * One record's signature: the envelope must name this record's hash and its
 * actor as signer, and the checker (the signer's identity provider, which
 * reads the signer's key history) must say yes.
 */
export async function verifySignoffSignature(r: SignoffRecord, check: SignatureChecker): Promise<SignoffSignatureStatus> {
  if (r.signatureEnvelope === undefined || r.signatureEnvelope === null) return { seq: r.seq, status: "not_signed" };
  const read = readSignatureEnvelope(r.signatureEnvelope);
  if (!read.ok) return { seq: r.seq, status: "invalid", reason: read.reason };
  const env = read.value;
  if (env.payloadDigest !== `sha256:${r.recordHash}`) return { seq: r.seq, status: "invalid", reason: `This signature is for a different entry, not entry ${r.seq}.` };
  if (env.signer.subject !== r.actorUserId) return { seq: r.seq, status: "invalid", reason: `This signature is ${authorWords(env.signer)}'s, but the entry was recorded by someone else. People sign only their own entries.` };
  let bytes: Uint8Array;
  try {
    bytes = signoffSignedBytes(r);
  } catch (err) {
    return { seq: r.seq, status: "invalid", reason: `Entry ${r.seq} can't be checked: ${err instanceof Error ? err.message : String(err)}.` };
  }
  const outcome = await check(env, bytes);
  if (outcome.status === "valid") return { seq: r.seq, status: "valid", signer: outcome.signer, ...(outcome.note ? { note: outcome.note } : {}) };
  return { seq: r.seq, status: outcome.status, reason: outcome.reason };
}

/**
 * The chain (`verifySignoffChain`) and then every signature on it. A chain
 * that doesn't hold is reported first and signatures aren't checked: a
 * signature on a changed record proves nothing.
 */
export async function verifySignoffChainWithSignatures(
  records: readonly SignoffRecord[],
  check: SignatureChecker,
): Promise<{ readonly chain: SignoffVerdict; readonly signatures: readonly SignoffSignatureStatus[] }> {
  const chain = verifySignoffChain(records);
  if (!chain.ok) return { chain, signatures: [] };
  const signatures: SignoffSignatureStatus[] = [];
  for (const r of records) signatures.push(await verifySignoffSignature(r, check));
  return { chain, signatures };
}
