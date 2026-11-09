import { recordsOfKinds } from "../store";
import { lineLevelId } from "../joins/rows";
import { ELEMENT_CORE_KINDS, isCoreElement, type CoreElement } from "../elements/feature";
import type { BimElement, ElementId, LinkedCopyStamp, Vec2 } from "../types";
import { linkedElementKey, type LinkedReferenceIndex, type ReferenceItem } from "./index-geometry";

/**
 * Copies of a linked model's elements, kept in step with the link. A copy is
 * an ordinary element of ours (a wall, an opening …) whose provenance says
 * where it came from: the linked model (by its stable link id), the source's
 * IFC GlobalId, the version copied and a fingerprint of the source's shape
 * then (`LinkedCopyStamp`, written by `set_element_linked_copy`).
 *
 * When the link updates, `linkedCopyReview` lists the copies whose source
 * moved, changed or disappeared. Each row is settled by the person: take the
 * link's new shape, or keep theirs (which records the new version as seen).
 * Trade-agnostic: which kinds are made from which linked elements is the
 * caller's (an add-on's) choice.
 */

type Elements = Readonly<Record<string, BimElement>>;

/** Shapes closer than this are the same (model mm): exporters wobble a few tenths. */
const SAME_MM = 2;

function fnv(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

const snap = (n: number): number => Math.round(n / SAME_MM) * SAME_MM;

/** A linked element's shape as a short stable code: its plan outline and height range, to the nearest 2 mm, and its IFC class. */
export function linkedFingerprint(item: ReferenceItem): string {
  const outline = [...item.outline].map((p) => `${snap(p.x)},${snap(p.y)}`).sort().join(";");
  return fnv(`${item.ifcClass}|${outline}|${snap(item.minZ)},${snap(item.maxZ)}`);
}

/** The version a linked model's index was read from (its id when the host sent none). */
export function linkedVersionOf(index: LinkedReferenceIndex, linkId: string): string | null {
  const s = index.sources.find((x) => x.id === linkId);
  return s ? (s.version ?? s.id) : null;
}

/** The stamp a copy of this linked element gets now. */
export function linkedCopyStampOf(index: LinkedReferenceIndex, item: ReferenceItem): LinkedCopyStamp {
  return { linkId: item.ref.sourceId, globalId: item.ref.globalId, version: linkedVersionOf(index, item.ref.sourceId) ?? item.ref.sourceId, fingerprint: linkedFingerprint(item) };
}

/** The stamp on an element, when it is a copy of a linked element. */
export function linkedCopyStamp(el: BimElement | undefined): LinkedCopyStamp | null {
  if (!el || !isCoreElement(el)) return null;
  return el.provenance?.linkedCopy ?? null;
}

/** Every copy of a linked element in the model (read by kind, never a model scan). */
export function linkedCopiesOf(elements: Elements): Array<{ readonly el: CoreElement; readonly stamp: LinkedCopyStamp }> {
  const out: Array<{ el: CoreElement; stamp: LinkedCopyStamp }> = [];
  for (const el of recordsOfKinds(elements, ELEMENT_CORE_KINDS)) {
    if ("deleted" in el && el.deleted) continue;
    const stamp = linkedCopyStamp(el);
    if (stamp && isCoreElement(el)) out.push({ el, stamp });
  }
  return out;
}

/** The copy of a linked element already in the model, if any. */
export function existingLinkedCopy(elements: Elements, linkId: string, globalId: string): CoreElement | null {
  return linkedCopiesOf(elements).find((c) => c.stamp.linkId === linkId && c.stamp.globalId === globalId)?.el ?? null;
}

export type LinkedCopyStatus = "changed" | "gone";

export interface LinkedCopyRow {
  readonly elementId: ElementId;
  readonly kind: string;
  readonly stamp: LinkedCopyStamp;
  readonly status: LinkedCopyStatus;
  /** What happened, in words ("The linked wall moved 500 mm in Sample (architect)"). */
  readonly words: string;
  /** The source as the link has it now (null when it is gone). */
  readonly source: ReferenceItem | null;
  /** Its linked model's label. */
  readonly sourceLabel: string;
}

export interface LinkedCopyReview {
  readonly rows: readonly LinkedCopyRow[];
  /** Copies whose source is unchanged. */
  readonly current: number;
  /** Copies of linked models not loaded here (nothing can be said about them yet). */
  readonly notLoaded: number;
}

function lineEnds(el: CoreElement): readonly [Vec2, Vec2] | null {
  return "start" in el && "end" in el && typeof el.start === "object" && typeof el.end === "object" ? [el.start as Vec2, el.end as Vec2] : null;
}

/** How far a line copy is from its source's centre line now (the larger of its two ends), mm; null when either isn't a line. */
function shiftMm(el: CoreElement, item: ReferenceItem): number | null {
  const ends = lineEnds(el);
  if (!ends || !item.line) return null;
  const { start, end } = item.line.axis;
  const d = (p: Vec2, q: Vec2) => Math.hypot(p.x - q.x, p.y - q.y);
  const [a, b] = ends;
  return Math.min(Math.max(d(a, start), d(b, end)), Math.max(d(a, end), d(b, start)));
}

/** The copies whose linked source moved, changed or left its model, west to east. */
export function linkedCopyReview(elements: Elements, index: LinkedReferenceIndex): LinkedCopyReview {
  const rows: LinkedCopyRow[] = [];
  let current = 0;
  let notLoaded = 0;
  for (const { el, stamp } of linkedCopiesOf(elements)) {
    const source = index.sources.find((s) => s.id === stamp.linkId);
    if (!source) {
      notLoaded += 1;
      continue;
    }
    const item = index.byKey.get(linkedElementKey({ sourceId: stamp.linkId, globalId: stamp.globalId })) ?? null;
    if (!item) {
      rows.push({ elementId: el.id, kind: el.kind, stamp, status: "gone", words: `The linked element this ${el.kind} was copied from is no longer in ${source.label}.`, source: null, sourceLabel: source.label });
      continue;
    }
    if (linkedFingerprint(item) === stamp.fingerprint) {
      current += 1;
      continue;
    }
    const shift = shiftMm(el, item);
    const what = shift !== null && shift > SAME_MM ? `moved ${Math.round(shift)} mm` : "changed";
    rows.push({ elementId: el.id, kind: el.kind, stamp, status: "changed", words: `The linked ${item.rule.noun} this ${el.kind} was copied from ${what} in ${source.label}.`, source: item, sourceLabel: source.label });
  }
  return { rows, current, notLoaded };
}

/** Elements of `kinds` hosted on `hostId` (an opening's `hostId`). */
export function hostedOn(elements: Elements, hostId: string, kinds: readonly string[] = ["opening"]): BimElement[] {
  return recordsOfKinds(elements, kinds).filter((el) => "hostId" in el && el.hostId === hostId && !("deleted" in el && el.deleted));
}

/** Where a linked opening sits along a host line, mm from its start, kept clear of the ends by half its width; null when it doesn't fit. */
export function stationAlong(start: Vec2, end: Vec2, at: Vec2, widthMm: number): number | null {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.hypot(dx, dy);
  if (len < widthMm) return null;
  const along = ((at.x - start.x) * dx + (at.y - start.y) * dy) / len;
  return Math.round(Math.min(len - widthMm / 2, Math.max(widthMm / 2, along)));
}

/** The level a line copy (a wall) stands on, so its update is made on the same level; null when it has none. */
export function linkedCopyLevelId(elements: Elements, el: BimElement): ElementId | null {
  if (el.kind !== "wall") return null;
  const id = lineLevelId(el, elements);
  return id === "" ? null : id;
}
