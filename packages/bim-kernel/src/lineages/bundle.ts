import type { Changeset } from "../changeset";
import { signoffFields, signoffRecordHash, type SignoffRecord } from "../responsibility/signoff-chain";
import { readLineage } from "./branch";
import type { Lineage } from "./types";

/**
 * Lineage bundles, format v1 (D1, federation): a lineage carried to another
 * server with the same ancestry. Base anchor (the exporting model, the
 * lineage the bundle starts from, the revision and its state digest), the
 * lineage and its chain up to that anchor, the changesets on its line after
 * the anchor revision, and the sign-off records about it. Another server
 * imports it as a lineage whose parent is the anchor.
 *
 * Shape and reader only this round; no writer (federation is round 12+).
 */

export const LINEAGE_BUNDLE_FORMAT = "mutinybim.lineage_bundle";
export const LINEAGE_BUNDLE_VERSION = 1;

export interface LineageBundleBase {
  /** The exporting server's model id. */
  readonly modelId: string;
  readonly lineageId: string;
  readonly revision: number;
  /** `lineageStateDigest` of that lineage at that revision. */
  readonly stateDigest: string;
}

export interface LineageBundle {
  readonly format: typeof LINEAGE_BUNDLE_FORMAT;
  readonly version: typeof LINEAGE_BUNDLE_VERSION;
  readonly base: LineageBundleBase;
  readonly lineage: Lineage;
  /** The lineage's ancestors, nearest first, ending at the base's lineage (empty when the bundle is the base lineage's own line). */
  readonly ancestry: readonly Lineage[];
  /** The lineage's line after `base.revision`, ascending and contiguous. */
  readonly changesets: readonly Changeset[];
  /** Sign-off records about the lineage (reviews, accept backs, merges), each with its own hash. */
  readonly signoffs: readonly SignoffRecord[];
}

export type BundleRead = { readonly ok: true; readonly value: LineageBundle } | { readonly ok: false; readonly problems: readonly string[] };

type Raw = Readonly<Record<string, unknown>>;

function isRecord(v: unknown): v is Raw {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const HEX64 = /^[0-9a-f]{64}$/;

function wholeAtLeast(v: unknown, min: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= min;
}

function readBase(raw: unknown, problems: string[]): LineageBundleBase | null {
  if (!isRecord(raw)) {
    problems.push("the bundle has no base anchor");
    return null;
  }
  const { modelId, lineageId, revision, stateDigest } = raw;
  if (typeof modelId !== "string" || modelId.length === 0 || typeof lineageId !== "string" || lineageId.length === 0) problems.push("the base anchor names its model and copy");
  if (!wholeAtLeast(revision, 0)) problems.push("the base anchor names a whole revision");
  if (typeof stateDigest !== "string" || !HEX64.test(stateDigest)) problems.push("the base anchor's state digest is 64 lower-case hex digits");
  if (typeof modelId !== "string" || typeof lineageId !== "string" || !wholeAtLeast(revision, 0) || typeof stateDigest !== "string") return null;
  return { modelId, lineageId, revision, stateDigest };
}

function readChangesets(raw: unknown, after: number, problems: string[]): Changeset[] {
  if (!Array.isArray(raw)) {
    problems.push("the bundle's changesets must be a list");
    return [];
  }
  raw.forEach((cs, i) => {
    if (!isRecord(cs) || !wholeAtLeast(cs.revision, 1) || !Array.isArray(cs.elements) || !isRecord(cs.command)) {
      problems.push(`changeset ${i + 1} needs a revision, its records and its command`);
      return;
    }
    if (cs.revision !== after + 1 + i) problems.push(`changeset ${i + 1} is revision ${String(cs.revision)}; the line after revision ${after} must run ${after + 1}, ${after + 2}, … with no gap`);
  });
  // Checked above; changesets are kept exactly as stored (the importing server replays them through its own commit path).
  return raw as Changeset[];
}

function readSignoffs(raw: unknown, problems: string[]): SignoffRecord[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    problems.push("the bundle's sign-off records must be a list");
    return [];
  }
  const out: SignoffRecord[] = [];
  raw.forEach((r, i) => {
    if (!isRecord(r) || !wholeAtLeast(r.seq, 1) || typeof r.recordKind !== "string" || typeof r.prevHash !== "string" || typeof r.recordHash !== "string" || !isRecord(r.payload)) {
      problems.push(`sign-off record ${i + 1} needs its sequence, kind, payload and hashes`);
      return;
    }
    // Shape checked; the hash below proves the fields are the ones signed.
    const record = r as unknown as SignoffRecord;
    let hash: string | null = null;
    try {
      hash = signoffRecordHash(record.prevHash, signoffFields(record));
    } catch (err) {
      problems.push(`sign-off record ${record.seq} can't be hashed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (hash !== record.recordHash) problems.push(`sign-off record ${record.seq}'s hash doesn't match its fields; it was changed after it was recorded`);
    out.push(record);
  });
  return out;
}

/**
 * A bundle, checked: format and version, the base anchor, the lineage and
 * its ancestry walk unbroken to the base's lineage, the changesets run on
 * from the base revision, and every sign-off record's hash matches its
 * fields. A newer format version is refused in words, never guessed.
 */
export function readLineageBundle(raw: unknown): BundleRead {
  if (!isRecord(raw)) return { ok: false, problems: ["a copy bundle must be an object"] };
  if (raw.format !== LINEAGE_BUNDLE_FORMAT) return { ok: false, problems: ["this isn't a copy bundle"] };
  if (typeof raw.version !== "number" || raw.version > LINEAGE_BUNDLE_VERSION) return { ok: false, problems: [`this copy bundle is format ${String(raw.version)}, made by a newer release; update to import it`] };
  if (raw.version !== LINEAGE_BUNDLE_VERSION) return { ok: false, problems: [`copy bundle format ${String(raw.version)} isn't one this release reads`] };
  const problems: string[] = [];
  const base = readBase(raw.base, problems);
  const lineage = readLineage(raw.lineage);
  if (!lineage.ok) problems.push(`the copy: ${lineage.reason}`);
  const ancestry: Lineage[] = [];
  if (raw.ancestry !== undefined && !Array.isArray(raw.ancestry)) problems.push("the bundle's ancestry must be a list");
  for (const [i, a] of (Array.isArray(raw.ancestry) ? raw.ancestry : []).entries()) {
    const read = readLineage(a);
    if (read.ok) ancestry.push(read.value);
    else problems.push(`ancestor ${i + 1}: ${read.reason}`);
  }
  if (base && lineage.ok) {
    const byId = new Map(ancestry.map((l) => [l.id, l]));
    let at: Lineage | undefined = lineage.value;
    const seen = new Set<string>();
    while (at && at.id !== base.lineageId) {
      seen.add(at.id);
      const parentId: string | undefined = at.parent?.lineageId;
      at = parentId === undefined || seen.has(parentId) ? undefined : byId.get(parentId);
    }
    if (!at) problems.push(`the copy's ancestry doesn't reach the base copy "${base.lineageId}"`);
  }
  const changesets = readChangesets(raw.changesets, base?.revision ?? 0, problems);
  const signoffs = readSignoffs(raw.signoffs, problems);
  if (problems.length > 0 || !base || !lineage.ok) return { ok: false, problems };
  return { ok: true, value: { format: LINEAGE_BUNDLE_FORMAT, version: LINEAGE_BUNDLE_VERSION, base, lineage: lineage.value, ancestry, changesets, signoffs } };
}
