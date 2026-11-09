import type { SignoffJson, SignoffRecord } from "../responsibility/signoff-chain";
import { DISPOSITION_REASON_MAX, DISPOSITION_REASON_MIN, FINDING_DISPOSITION_KIND, readFindingDisposition, type FindingDisposition } from "./disposition";

/**
 * Dispositions inside signed sign-off payloads (round 11, D2; product owner answer 3:
 * accepting a known problem is part of what the signer signs).
 *
 * Any sign-off payload (an approval, a gate freeze, an issued set) may carry
 * a `dispositions` section: the decisions on findings the signer accepted
 * with it, in canonical order and text only, so the hash and the signature
 * cover them exactly as SQL canonicalises them. A C10 override is its own
 * chain entry (`finding_disposition`); both read back through
 * `dispositionsFromSignoffRecords`.
 *
 * Stored forever: the key, the entry fields (snake_case) and their order
 * rule. Readers are tolerant (an unreadable entry is counted, never
 * guessed); the writer is strict.
 */

/** The payload key. */
export const SIGNED_DISPOSITIONS_KEY = "dispositions";
/** The most dispositions one sign-off carries; a larger set is split across sign-offs. */
export const MAX_SIGNED_DISPOSITIONS = 200;

/** Sign-off record kinds this lane names for the chain (the coordinator adds them to `SIGNOFF_KINDS`). `finding_disposition` is already there (C10). */
export const FINDINGS_SIGNOFF_KINDS = ["finding_disposition"] as const;

function entry(d: FindingDisposition): { readonly [key: string]: SignoffJson } {
  const by: { [key: string]: SignoffJson } = { provider: d.by.provider, subject: d.by.subject, kind: d.by.kind };
  if (d.by.displayName !== undefined) by.displayName = d.by.displayName;
  if (d.by.keyId !== undefined) by.keyId = d.by.keyId;
  const scope: { [key: string]: SignoffJson } = { lineage_id: d.scope.lineageId };
  if (d.scope.untilGate) scope.until_gate = d.scope.untilGate;
  if (d.scope.untilStage) scope.until_stage = d.scope.untilStage;
  return { finding_id: d.findingId, source_version: d.sourceVersion, action: d.action, reason: d.reason, by, at: d.at, scope };
}

export type SignedDispositionsWrite = { readonly ok: true; readonly section: { readonly [SIGNED_DISPOSITIONS_KEY]: readonly SignoffJson[] } } | { readonly ok: false; readonly reason: string };

/**
 * The section to put in a sign-off payload. Only a person's recorded
 * decisions are signed (an agent proposes, a person records); each needs a
 * reason a reviewer can read. Ordered by finding, then copy, then time, so
 * two hosts write the same bytes.
 */
export function signedDispositionsSection(dispositions: readonly FindingDisposition[]): SignedDispositionsWrite {
  if (dispositions.length > MAX_SIGNED_DISPOSITIONS) return { ok: false, reason: `One sign-off carries at most ${MAX_SIGNED_DISPOSITIONS} accepted problems; this one has ${dispositions.length}. Sign them in parts.` };
  for (const d of dispositions) {
    if (d.by.kind !== "person") return { ok: false, reason: `The decision on ${d.findingId} was made by an agent; a person records it before it can be signed.` };
    const reason = d.reason.trim();
    if (reason.length < DISPOSITION_REASON_MIN || reason.length > DISPOSITION_REASON_MAX) return { ok: false, reason: `The decision on ${d.findingId} needs a reason of ${DISPOSITION_REASON_MIN}–${DISPOSITION_REASON_MAX} characters.` };
  }
  const sorted = [...dispositions].sort((a, b) => (a.findingId < b.findingId ? -1 : a.findingId > b.findingId ? 1 : a.scope.lineageId < b.scope.lineageId ? -1 : a.scope.lineageId > b.scope.lineageId ? 1 : a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return { ok: true, section: { [SIGNED_DISPOSITIONS_KEY]: sorted.map(entry) } };
}

export interface SignedDispositionsRead {
  readonly dispositions: readonly FindingDisposition[];
  /** Entries this release couldn't read (kept in the stored payload, never guessed). */
  readonly unreadable: number;
}

/** The dispositions a payload carries. A payload without the section carries none (every sign-off before round 11). */
export function readSignedDispositions(payload: { readonly [key: string]: SignoffJson } | null | undefined): SignedDispositionsRead {
  const raw = payload?.[SIGNED_DISPOSITIONS_KEY];
  if (!Array.isArray(raw)) return { dispositions: [], unreadable: raw === undefined ? 0 : 1 };
  const out: FindingDisposition[] = [];
  let unreadable = 0;
  for (const item of raw) {
    const read = readFindingDisposition(item);
    if (read.ok) out.push(read.value);
    else unreadable += 1;
  }
  return { dispositions: out, unreadable };
}

/**
 * Every disposition a sign-off chain records: its `finding_disposition`
 * entries (C10's signer overrides; the author is the entry's actor when the
 * payload names none) and the `dispositions` sections other entries carry.
 * Unreadable ones are logged and skipped.
 */
export function dispositionsFromSignoffRecords(records: readonly SignoffRecord[]): FindingDisposition[] {
  const out: FindingDisposition[] = [];
  for (const r of records) {
    if (r.recordKind === FINDING_DISPOSITION_KIND) {
      const read = readFindingDisposition(r.payload);
      if (read.ok) out.push(read.value);
      else console.error("[bim-kernel/findings] a finding_disposition sign-off can't be read; skipped", { seq: r.seq, subjectId: r.subjectId, reason: read.reason });
    }
    const section = readSignedDispositions(r.payload);
    if (section.unreadable > 0) console.error("[bim-kernel/findings] a sign-off carries dispositions this release can't read; skipped", { seq: r.seq, unreadable: section.unreadable });
    out.push(...section.dispositions);
  }
  return out;
}
