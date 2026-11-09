/**
 * The one read shape every "something is wrong or unresolved" producer
 * emits (round 11, D2): lint (clash, clearance, systems, documents), code
 * and requirement checks, open questions that hold an issue, records whose
 * reliance may no longer hold, divergences, merge waits, and any add-on's
 * own check (`FINDING_SOURCE_POINT`). Producers stay as they are; thin
 * adapters (`sources/**`) map their reads onto this.
 *
 * The id recipe is stored forever (dispositions name it): `<source kind>:<local id>`,
 * where the local id is the source's own stable id when it has one (lint's
 * finding id, a requirement id, a question or record id) and otherwise the
 * source id plus the sorted subjects (`localFindingId`).
 */

/** Where a finding came from. Open: an add-on's source kind is its row id (`<pack>.<name>`). */
export type FindingSourceKind = "lint_rule" | "code_rule" | "requirement" | "question" | "reliance" | "divergence" | "merge" | (string & {});

export const KNOWN_FINDING_SOURCE_KINDS = ["lint_rule", "code_rule", "requirement", "question", "reliance", "divergence", "merge"] as const satisfies readonly FindingSourceKind[];

/** How much it matters. `blocking` holds an issue or a landing; open: a source's own level is kept. */
export type FindingSeverity = "blocking" | "warning" | "info" | (string & {});

export const KNOWN_FINDING_SEVERITIES = ["blocking", "warning", "info"] as const satisfies readonly FindingSeverity[];

export interface FindingSource {
  readonly kind: FindingSourceKind;
  /** The check within the source: a lint rule id, a requirement's rule, a question id, a branch. */
  readonly id: string;
  /** The check's version. A disposition recorded against another version reads "accepted against an earlier version of this check". */
  readonly version: string;
}

export interface FindingRef {
  /** Stable: `<source kind>:<local id>` (see `findingRefId`). */
  readonly id: string;
  readonly source: FindingSource;
  readonly severity: FindingSeverity;
  /** Model ids it is about, sorted (elements, records, `linked:<GlobalId>` for a linked model's element). */
  readonly subjects: readonly string[];
  /** The copy of the model it was found on (`"main"` until lineages land). */
  readonly lineageId: string;
  /** The model revision it was read at. */
  readonly revision: number;
  /** Plain words, at most `FINDING_WORDS_MAX` characters. */
  readonly words: string;
  readonly fix?: { readonly commandHint?: string };
}

/** Longest local id kept as written; longer ones are shortened deterministically. */
export const FINDING_LOCAL_ID_MAX = 200;
export const FINDING_WORDS_MAX = 240;
/** The most subjects one finding lists; beyond this the first are kept (the id still names them all). */
export const FINDING_SUBJECTS_MAX = 500;

function fnv(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

/** A local id from the source's check id and its subjects (sorted, so the order a producer lists them in never matters). */
export function localFindingId(sourceId: string, subjects: readonly string[]): string {
  const id = `${sourceId}:${[...new Set(subjects)].sort().join("|")}`;
  if (id.length <= FINDING_LOCAL_ID_MAX) return id;
  return `${id.slice(0, FINDING_LOCAL_ID_MAX - 10)}#${fnv(id)}`;
}

/** The finding id: `<source kind>:<local id>`. */
export function findingRefId(kind: FindingSourceKind, localId: string): string {
  return `${kind}:${localId}`;
}

/** The source kind of a finding id (the part before the first colon). */
export function findingSourceKindOf(findingId: string): string {
  const at = findingId.indexOf(":");
  return at < 0 ? findingId : findingId.slice(0, at);
}

/** Sorted, unique, capped subjects. */
export function findingSubjects(ids: Iterable<string>): string[] {
  const list = Array.isArray(ids) ? (ids as readonly string[]) : [...ids];
  // Most producers already list them sorted and unique (lint does): keep that without a set and a sort.
  let ordered = true;
  for (let i = 0; i < list.length && ordered; i++) ordered = (list[i] as string).length > 0 && (i === 0 || (list[i - 1] as string) < (list[i] as string));
  if (ordered) return list.length > FINDING_SUBJECTS_MAX ? list.slice(0, FINDING_SUBJECTS_MAX) : [...list];
  const out = [...new Set(list)].filter((s) => s.length > 0).sort();
  return out.length > FINDING_SUBJECTS_MAX ? out.slice(0, FINDING_SUBJECTS_MAX) : out;
}

/** Words cut to `FINDING_WORDS_MAX` characters. */
export function findingWords(text: string): string {
  const t = text.trim();
  return t.length <= FINDING_WORDS_MAX ? t : `${t.slice(0, FINDING_WORDS_MAX - 1)}…`;
}

/** Whether a stored severity holds an issue or a landing. */
export function isBlockingSeverity(severity: FindingSeverity): boolean {
  return severity === "blocking";
}
