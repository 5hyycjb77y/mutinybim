import {
  IdentityProviderRegistry,
  keysFromLog,
  readAuthorRef,
  verifyKeyLog,
  verifySignoffSignature,
  type KeyLogEvent,
  type SignoffJson,
  type SignoffRecord,
} from "@permitzip/bim-kernel"
import type { BimJson } from "../json"
import { createHostIdentityProvider, DEFAULT_HOST_IDENTITY, type HostIdentity, type HostSigningKey } from "../identity/host-provider"
import type { KeyLogEventView, SignoffEntriesResponse, SignoffEntryView } from "./api"
import { SIGNING_WORDS, signedByWords, verifiedByWords } from "./words"

/**
 * Each entry's assurance level, Signed, Verified or Recorded. A signature is
 * re-checked here (in the browser, or anywhere): each signer's key history
 * must hold (kernel `verifyKeyLog`), the key comes from that history, and the
 * kernel's WebAuthn verifier checks the passkey answer against the entry's
 * own hash. Nothing trusts the server's word that it checked. "Verified" is
 * the host app's record of a one-time code: shown as such, never as a signature.
 */

export type EntrySignature =
  | { readonly kind: "recorded"; readonly words: string }
  | { readonly kind: "verified"; readonly words: string; readonly withPassword: boolean }
  | { readonly kind: "signed"; readonly words: string; readonly signerName: string; readonly keyRetiredAt: string | null }
  | { readonly kind: "doesnt_check"; readonly words: string; readonly reason: string }

/** The session's sign-in methods recorded with a verification included a password. */
function verifiedWithPassword(verification: BimJson | null): boolean {
  if (!isJsonObject(verification) || !Array.isArray(verification.session)) return false
  return verification.session.some((m) => isJsonObject(m) && m.method === "password")
}

function isJsonObject(value: BimJson): value is { [key: string]: BimJson | undefined } {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asSignoffJson(value: BimJson): SignoffJson {
  if (Array.isArray(value)) return value.map(asSignoffJson)
  if (isJsonObject(value)) return payloadObject(value)
  return value
}

function payloadObject(value: BimJson): { readonly [key: string]: SignoffJson } {
  const out: { [key: string]: SignoffJson } = {}
  if (!isJsonObject(value)) return out
  for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = asSignoffJson(v)
  return out
}

export function entryRecord(e: SignoffEntryView): SignoffRecord {
  return {
    seq: e.seq,
    projectId: e.projectId,
    baseModelId: e.baseModelId,
    recordKind: e.recordKind,
    subjectId: e.subjectId,
    actorUserId: e.actorUserId,
    payload: payloadObject(e.payload),
    prevHash: e.prevHash,
    recordHash: e.recordHash,
    ...(e.signatureEnvelope !== null ? { signatureEnvelope: e.signatureEnvelope } : {}),
  }
}

function keyLogEvent(v: KeyLogEventView): KeyLogEvent {
  return { seq: v.seq, subject: v.subject, eventKind: v.eventKind, keyId: v.keyId, payload: payloadObject(v.payload), prevHash: v.prevHash, eventHash: v.eventHash, createdAt: v.createdAt }
}

/** The name an entry's author carries ("J. Rao"), or a neutral word. */
export function entryAuthorName(e: SignoffEntryView): string {
  const author = isJsonObject(e.payload) ? e.payload.author : undefined
  const read = readAuthorRef(author)
  return read.ok ? (read.value.displayName ?? "the person who recorded it") : "the person who recorded it"
}

/** Keys from the key histories that hold; a history that doesn't is reported per signer. */
function keyBook(keyLogs: SignoffEntriesResponse["keyLogs"]): { readonly keys: Map<string, HostSigningKey>; readonly broken: Map<string, string> } {
  const keys = new Map<string, HostSigningKey>()
  const broken = new Map<string, string>()
  for (const log of keyLogs) {
    const events = log.events.map(keyLogEvent)
    const verdict = verifyKeyLog(events)
    if (!verdict.ok) {
      broken.set(log.subject, `their key history doesn’t hold (${verdict.problem})`)
      continue
    }
    for (const key of keysFromLog(events).values()) {
      const enrolled = events.find((e) => e.seq === key.enrolledSeq)
      const rpId = enrolled && typeof enrolled.payload.rp_id === "string" ? enrolled.payload.rp_id : null
      if (!rpId) continue
      keys.set(key.keyId, { subject: key.subject, publicKeySpki: key.publicKeySpki, rpId, retiredAt: key.retiredSeq !== null ? (key.retiredAt ?? "") : null })
    }
  }
  return { keys, broken }
}

/** Every entry's signature, by entry id, checked here. `identity`: the host's login system, with the ids its stored signatures carry. */
export async function checkEntrySignatures(res: SignoffEntriesResponse, identity: HostIdentity = DEFAULT_HOST_IDENTITY): Promise<Map<string, EntrySignature>> {
  const { keys, broken } = keyBook(res.keyLogs)
  const registry = new IdentityProviderRegistry([createHostIdentityProvider({ personById: async () => null }, { keyById: async (id) => keys.get(id) ?? null }, identity)])
  const out = new Map<string, EntrySignature>()
  for (const entry of res.entries) {
    if (entry.signatureEnvelope === null) {
      out.set(
        entry.id,
        entry.verifiedAt !== null
          ? { kind: "verified", words: verifiedByWords(entryAuthorName(entry), verifiedWithPassword(entry.verification)), withPassword: verifiedWithPassword(entry.verification) }
          : { kind: "recorded", words: SIGNING_WORDS.recorded },
      )
      continue
    }
    const brokenWhy = broken.get(entry.actorUserId)
    if (brokenWhy) {
      out.set(entry.id, { kind: "doesnt_check", words: SIGNING_WORDS.doesntCheck, reason: `The signer’s key can’t be trusted: ${brokenWhy}.` })
      continue
    }
    const status = await verifySignoffSignature(entryRecord(entry), (env, bytes) => registry.verifyEnvelope(env, bytes))
    if (status.status === "valid") {
      const name = status.signer.displayName ?? entryAuthorName(entry)
      const retiredAt = keys.get(status.signer.keyId ?? "")?.retiredAt ?? null
      out.set(entry.id, { kind: "signed", words: signedByWords(name, retiredAt), signerName: name, keyRetiredAt: retiredAt })
    } else if (status.status === "not_signed") {
      out.set(entry.id, { kind: "recorded", words: SIGNING_WORDS.recorded })
    } else {
      out.set(entry.id, { kind: "doesnt_check", words: SIGNING_WORDS.doesntCheck, reason: status.reason })
    }
  }
  return out
}
