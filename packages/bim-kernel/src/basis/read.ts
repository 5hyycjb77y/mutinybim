import { isDeterminationRecord, isRuleRecordElement } from "../graph/records";
import type { PackSet } from "../packs/set";
import { activePackSet } from "../packs/scope";
import { loadStageOf } from "../requirements/anchor";
import type { BimElement } from "../types";
import { BASIS_NOT_RECORDED, KNOWN_BASIS_SOURCE_KINDS, basisTable, readStoredBasis, type BasisLadder, type ValueBasis } from "./types";

/**
 * Reading the one confidence scale off any record (round 11 D4). Nothing here
 * writes: an old record keeps its stored ladder field and reads mapped onto
 * the scale; a record with nothing reads "not recorded" (product owner question 7,
 * pending: the default). `infer` (off by default) may guess for records that
 * carry no basis at all (an existing-conditions record, an imported one); a
 * guess is always marked `inferred: true` and is never stored, so turning
 * inference on later needs no stored change.
 *
 * Fields read (tolerantly, whether or not a release's types name them yet):
 * `provenance.basis` and `valueBasis[key]` (the stored scale), then the old
 * ladders on the record itself: a load's stage (derived from where it is
 * anchored), a determination's confidence, a rule's verification. A price
 * list's basis and a product's layer are not on a model record; read them
 * with `ladderBasis`.
 */

export type BasisReading =
  | {
      readonly known: true;
      readonly basis: ValueBasis;
      /** Where the answer came from: the stored scale, an old ladder read-mapped, or a guess. */
      readonly from: "stored" | BasisLadder | "inferred";
      /** Present only on a guess. */
      readonly inferred?: true;
    }
  | { readonly known: false; readonly words: string };

export interface ReadBasisOptions {
  /** Guess for records with nothing recorded (question 7). Default false: "not recorded". */
  readonly infer?: boolean;
  readonly set?: PackSet;
}

const NOT_RECORDED: BasisReading = Object.freeze({ known: false, words: BASIS_NOT_RECORDED });

type Raw = Readonly<Record<string, unknown>>;

function field(el: object, name: string): unknown {
  return (el as Raw)[name];
}

/** The stored `provenance.basis`, when the record has a readable one. */
function storedRecordBasis(el: BimElement): ValueBasis | null {
  const p = field(el, "provenance");
  if (typeof p !== "object" || p === null) return null;
  const raw = (p as Raw).basis;
  return raw === undefined ? null : readStoredBasis(raw);
}

/** An old ladder's value read onto the scale; "not recorded" when no rung maps it. */
export function ladderBasis(ladder: BasisLadder, value: string, extra: Omit<ValueBasis, "maturity" | "confidence"> & { readonly confidence?: string } = {}, set: PackSet = activePackSet()): BasisReading {
  const hit = basisTable(set).ladder(ladder, value);
  if (!hit) return NOT_RECORDED;
  const confidence = hit.map.confidence ?? extra.confidence;
  const source = hit.map.sourceKind !== undefined ? { kind: hit.map.sourceKind, ...(extra.source?.ref !== undefined ? { ref: extra.source.ref } : {}) } : extra.source;
  const basis: ValueBasis = { maturity: hit.row.id, ...(source ? { source } : {}), ...(confidence !== undefined ? { confidence } : {}), ...(extra.at !== undefined ? { at: extra.at } : {}) };
  return { known: true, basis, from: ladder };
}

function ownLadder(el: BimElement, set: PackSet): BasisReading | null {
  if (el.kind === "load_point") return ladderBasis("load_stage", loadStageOf(el), {}, set);
  if (isDeterminationRecord(el)) {
    const d = el.determination;
    return ladderBasis("determination_confidence", String(d.confidence), { source: { kind: "person", ref: d.decidedBy }, ...(d.decidedAt !== undefined ? { at: d.decidedAt } : {}) }, set);
  }
  if (isRuleRecordElement(el)) {
    const v = el.rule.verification;
    return ladderBasis("rule_verification", String(v.status), { ...(v.by !== undefined ? { source: { kind: "person", ref: v.by } } : {}), ...(v.at !== undefined ? { at: v.at } : {}) }, set);
  }
  return null;
}

/** A guess for a record with nothing recorded, marked inferred. Null when there is nothing to guess from. */
function inferred(el: BimElement): BasisReading | null {
  const locked = field(el, "locked");
  if (typeof locked === "object" && locked !== null && (locked as Raw).state === "existing") {
    return { known: true, basis: { maturity: "assumed", source: { kind: "old_drawings" } }, from: "inferred", inferred: true };
  }
  const p = field(el, "provenance");
  if (typeof p === "object" && p !== null) {
    const s = (p as Raw).source;
    if (typeof s === "string" && s.length > 0) {
      const kind = KNOWN_BASIS_SOURCE_KINDS.includes(s) ? s : "import";
      return { known: true, basis: { maturity: "assumed", source: { kind, ref: s } }, from: "inferred", inferred: true };
    }
    if (typeof (p as Raw).ifcGlobalId === "string") return { known: true, basis: { maturity: "assumed", source: { kind: "import" } }, from: "inferred", inferred: true };
  }
  return null;
}

/** The record's basis: stored, else its own old ladder read-mapped, else (only with `infer`) a guess, else "not recorded". */
export function readBasis(el: BimElement, options: ReadBasisOptions = {}): BasisReading {
  const stored = storedRecordBasis(el);
  if (stored) return { known: true, basis: stored, from: "stored" };
  const set = options.set ?? activePackSet();
  const ladder = ownLadder(el, set);
  if (ladder?.known) return ladder;
  if (options.infer === true) return inferred(el) ?? NOT_RECORDED;
  return NOT_RECORDED;
}

/** One value's basis: `valueBasis[key]` when stored, else the record's. */
export function readValueBasis(el: BimElement, key: string, options: ReadBasisOptions = {}): BasisReading {
  const per = field(el, "valueBasis");
  if (typeof per === "object" && per !== null && !Array.isArray(per)) {
    const raw = (per as Raw)[key];
    const stored = raw === undefined ? null : readStoredBasis(raw);
    if (stored) return { known: true, basis: stored, from: "stored" };
  }
  return readBasis(el, options);
}

/** The rung id a column groups a reading under: the maturity, or "not recorded". */
export function basisGroupOf(reading: BasisReading): string {
  return reading.known ? reading.basis.maturity : BASIS_NOT_RECORDED;
}
