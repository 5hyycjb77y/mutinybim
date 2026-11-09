import { peerReads } from "../elements/feature";
import type { ReadResult } from "../graph/records";
import { elementsOfKind } from "../store";
import type { BimElement } from "../types";
import { DIVERGENCE_KIND, SUBMITTAL_DIVERGENCE_FEATURE, SUBMITTAL_KIND, SUBMITTAL_RECORDS_FEATURE, type DivergenceBody, type DivergenceElement, type SubmittalBody, type SubmittalElement } from "./types";

/**
 * Submittal and divergence records as this release reads them. Tolerant
 * readers (unknown fields, review states and item fields are kept; the
 * stored record is returned as it was). Round 9's writers (`commands.ts`)
 * write only to peers that advertise the features; an older peer's edits
 * keep every record untouched.
 */

type Raw = Record<string, unknown>;
type Elements = Readonly<Record<string, BimElement>>;

function isRecord(v: unknown): v is Raw {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isText(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function bad<T>(reason: string): ReadResult<T> {
  return { ok: false, reason };
}

function textList(v: unknown): boolean {
  return v === undefined || (Array.isArray(v) && v.every(isText));
}

function refsOk(v: unknown): boolean {
  return v === undefined || (Array.isArray(v) && v.every((r) => isRecord(r) && isText(r.provider) && isText(r.ref)));
}

/** A design-basis reference names at least one element, type or requirement, each as a list of ids. */
function designBasisProblem(v: unknown, what: string): string | null {
  if (!isRecord(v)) return `${what} must say what in the design it is about`;
  if (!textList(v.elementIds) || !textList(v.typeIds) || !textList(v.requirementRefs)) return `${what}'s elements, types and requirements must each be a list of ids`;
  const named = [v.elementIds, v.typeIds, v.requirementRefs].some((l) => Array.isArray(l) && l.length > 0);
  return named ? null : `${what} must name at least one element, type or requirement`;
}

function reviewProblem(v: unknown, what: string): string | null {
  if (!isRecord(v) || !isText(v.state)) return `${what} needs a review state`;
  if (v.reviewer !== undefined && !isText(v.reviewer)) return `${what}'s reviewer must be text`;
  if (v.notes !== undefined && typeof v.notes !== "string") return `${what}'s review notes must be text`;
  return null;
}

/** A stored submittal body, checked; unknown fields and states kept. */
export function readSubmittalBody(raw: unknown): ReadResult<SubmittalBody> {
  if (!isRecord(raw)) return bad("a submittal must be an object");
  if (!isText(raw.title)) return bad("a submittal needs a title");
  if (!isText(raw.revision)) return bad("a submittal needs its revision");
  const basis = designBasisProblem(raw.offeredFor, "a submittal");
  if (basis) return bad(basis);
  const review = reviewProblem(raw.review, "a submittal");
  if (review) return bad(review);
  if (!Array.isArray(raw.items)) return bad("a submittal's items must be a list");
  const seen = new Set<string>();
  for (const item of raw.items) {
    if (!isRecord(item) || !isText(item.id) || !isText(item.label)) return bad("each submittal item needs an id and a label");
    if (seen.has(item.id)) return bad(`two submittal items are both ${item.id}`);
    seen.add(item.id);
    if (item.offeredFor !== undefined) {
      const p = designBasisProblem(item.offeredFor, `submittal item ${item.id}`);
      if (p) return bad(p);
    }
    if (item.review !== undefined) {
      const p = reviewProblem(item.review, `submittal item ${item.id}`);
      if (p) return bad(p);
    }
    if (!refsOk(item.externalRefs)) return bad(`submittal item ${item.id}'s outside references each need a provider and a ref`);
  }
  if (raw.submittedBy !== undefined && !isText(raw.submittedBy)) return bad("who submitted it must be text");
  if (!refsOk(raw.externalRefs)) return bad("a submittal's outside references each need a provider and a ref");
  if ((raw.lineageId === undefined) !== (raw.deltaDigest === undefined)) return bad("a submittal over a copy names both the copy and the delta digest it covers");
  if (raw.lineageId !== undefined && (!isText(raw.lineageId) || !isText(raw.deltaDigest))) return bad("a submittal's copy and delta digest must be text");
  // Checked above; the stored body is returned as it was.
  return { ok: true, value: raw as unknown as SubmittalBody };
}

/** A stored divergence body, checked; unknown fields kept. */
export function readDivergenceBody(raw: unknown): ReadResult<DivergenceBody> {
  if (!isRecord(raw)) return bad("a divergence must be an object");
  const basis = designBasisProblem(raw.designBasis, "a divergence");
  if (basis) return bad(basis);
  const product = raw.approvedProduct;
  if (!isRecord(product) || !isText(product.label)) return bad("a divergence needs the approved product, in words");
  if (!isText(raw.approvedBy) || !isText(raw.at)) return bad("a divergence needs who approved it and when");
  if (typeof raw.notes !== "string") return bad("a divergence needs its notes (they may be empty)");
  const party = raw.responsibleParty;
  if (party !== undefined && (!isRecord(party) || !isText(party.label))) return bad("a divergence's responsible party needs a name");
  if (raw.responsibilityNote !== undefined && typeof raw.responsibilityNote !== "string") return bad("a divergence's responsibility note must be text");
  if (!refsOk(raw.externalRefs)) return bad("a divergence's outside references each need a provider and a ref");
  return { ok: true, value: raw as unknown as DivergenceBody };
}

/** Stored records are immutable: a record checked once stays checked while the model keeps the same object (each revision reuses every record it didn't touch). */
const checked = new WeakMap<object, boolean>();

function checkedOnce(el: object, check: () => boolean): boolean {
  const hit = checked.get(el);
  if (hit !== undefined) return hit;
  const ok = check();
  checked.set(el, ok);
  return ok;
}

export function isSubmittalRecord(el: { readonly kind: string } | undefined): el is SubmittalElement {
  return el !== undefined && el.kind === SUBMITTAL_KIND && checkedOnce(el, () => readSubmittalBody((el as unknown as Raw).submittal).ok);
}

export function isDivergenceRecord(el: { readonly kind: string } | undefined): el is DivergenceElement {
  return el !== undefined && el.kind === DIVERGENCE_KIND && checkedOnce(el, () => readDivergenceBody((el as unknown as Raw).divergence).ok);
}

/** Kind keys for the store's index: plain kind strings until the element union carries them. */
const SUBMITTAL_KIND_KEY = SUBMITTAL_KIND as string as BimElement["kind"];
const DIVERGENCE_KIND_KEY = DIVERGENCE_KIND as string as BimElement["kind"];

/** Every submittal stored in the model, from the store's kind index. */
export function submittalsIn(elements: Elements): SubmittalElement[] {
  const out: SubmittalElement[] = [];
  for (const el of elementsOfKind(elements, SUBMITTAL_KIND_KEY)) {
    const candidate: { readonly kind: string } = el;
    if (isSubmittalRecord(candidate)) out.push(candidate);
  }
  return out;
}

/** Every divergence stored in the model, from the store's kind index. */
export function divergencesIn(elements: Elements): DivergenceElement[] {
  const out: DivergenceElement[] = [];
  for (const el of elementsOfKind(elements, DIVERGENCE_KIND_KEY)) {
    const candidate: { readonly kind: string } = el;
    if (isDivergenceRecord(candidate)) out.push(candidate);
  }
  return out;
}

/** Whether the command being decided may store a submittal: the peers read `submittals:records` (round 9). */
export function submittalsWritable(): boolean {
  return peerReads(SUBMITTAL_RECORDS_FEATURE);
}

/** Whether the command being decided may store a divergence: the peers read `submittals:divergence` (round 9). */
export function divergencesWritable(): boolean {
  return peerReads(SUBMITTAL_DIVERGENCE_FEATURE);
}
