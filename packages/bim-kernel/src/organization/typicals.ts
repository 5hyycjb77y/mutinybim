import type { BimElement, ModelState, PartInstance, Vec2 } from "../types";
import { organizationOf, type GroupEntry, type TypicalCopy, type TypicalSpec } from "./model";

/**
 * Typicals (G13): a group authored once (unit 001, bay A) and repeated. The
 * copies are not elements: each is a placement of the whole group (an
 * offset and a turn about the base point), so editing the original edits
 * every copy. Loads count once per instance wherever the group is served
 * from outside it (the Electrical add-on's load engine), and plans draw each
 * copy's parts and, if the view asks, its circuiting.
 *
 * Lookup reads the element's own group record by id, so the load engine can
 * name it as a dependency and never scans the organization.
 */

export const MAX_TYPICAL_COPIES = 500;

type Elements = Readonly<Record<string, BimElement>>;

export interface TypicalRef {
  readonly groupId: string;
  readonly spec: TypicalSpec;
}

/** The typical a group record describes, or null. */
export function typicalOfGroup(elements: Elements, groupId: string | undefined): TypicalRef | null {
  if (!groupId) return null;
  const record = elements[groupId];
  if (record?.kind !== "organization" || record.deleted || record.entry.type !== "group") return null;
  const spec = (record.entry as GroupEntry).typical;
  return spec ? { groupId, spec } : null;
}

/** The typical an element belongs to, or null. */
export function typicalOf(elements: Elements, el: BimElement | undefined): TypicalRef | null {
  return el ? typicalOfGroup(elements, el.groupId) : null;
}

/** How many instances the typical stands for: the original and its copies. */
export function typicalCount(spec: TypicalSpec): number {
  return 1 + spec.copies.length;
}

/**
 * How many times a member's load counts at a source: the typical's count when
 * the member is in a typical and the source is not in that same typical (a
 * house panel serving unit 001's panel), else once (unit 001's own panel).
 * `groupId` is the group record the answer read (whether or not it is a
 * typical yet), for a caller's dependency list.
 */
export function typicalMultiplier(elements: Elements, member: BimElement | undefined, source: BimElement | undefined): { readonly count: number; readonly groupId: string | null; readonly spec: TypicalSpec | null } {
  const groupId = member?.groupId ?? null;
  const t = typicalOf(elements, member);
  if (!t || source?.groupId === t.groupId) return { count: 1, groupId, spec: null };
  return { count: typicalCount(t.spec), groupId, spec: t.spec };
}

/** Whether a typical's copies spread over the source's phases: the engineer's choice, else rotate when it is fed through a feeder. */
export function rotatesPhases(spec: TypicalSpec, viaFeeder: boolean): boolean {
  return spec.phaseRotation ? spec.phaseRotation === "rotate" : viaFeeder;
}

/** How many of `n` instances land on each rotation (0, 1, 2… steps) of a source with `modulus` phases: copy k takes rotation k mod modulus. */
export function rotationCounts(n: number, modulus: number): number[] {
  return Array.from({ length: Math.min(n, Math.max(1, modulus)) }, (_, r) => Math.floor((n - 1 - r) / modulus) + 1);
}

/**
 * Where a point of the original lands in a copy: flipped about the base point
 * when the copy is a mirror image (contract 1.10.0; `x` flips left for right,
 * `y` front for back), then turned, then moved. A copy stored before 1.10.0
 * has no `mirror` and lands exactly as it always did.
 */
export function copyPoint(spec: TypicalSpec, copy: TypicalCopy, p: Vec2): Vec2 {
  const a = (copy.rotationDeg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  let dx = p.x - spec.basePoint.x;
  let dy = p.y - spec.basePoint.y;
  if (copy.mirror?.axis === "x") dx = -dx;
  else if (copy.mirror?.axis === "y") dy = -dy;
  return { x: spec.basePoint.x + dx * c - dy * s + copy.offset.x, y: spec.basePoint.y + dx * s + dy * c + copy.offset.y };
}

/** How a direction of the original (an element's turn, degrees) reads in a copy: reflected when mirrored, then turned with the copy. */
export function copyRotationDeg(copy: TypicalCopy, deg: number): number {
  const reflected = copy.mirror?.axis === "x" ? 180 - deg : copy.mirror?.axis === "y" ? -deg : deg;
  const out = (reflected + copy.rotationDeg) % 360;
  return out < 0 ? out + 360 : out;
}

/** Whether a copy is a mirror image of the original (its parts are handed the other way). */
export function isMirroredCopy(copy: TypicalCopy): boolean {
  return copy.mirror !== undefined;
}

/** A name as it reads in a copy: the original's mark replaced by the copy's ("A001-1,3" → "A002-1,3"). Names without the mark read unchanged. */
export function copyText(spec: TypicalSpec, copy: TypicalCopy, text: string): string {
  return spec.mark !== "" && text.includes(spec.mark) ? text.split(spec.mark).join(copy.mark) : text;
}

/**
 * The copies of the typicals among `parts` (what a plan drew), each part
 * moved and turned into place with its mark read for the copy. Plans draw
 * these as they draw the original.
 */
export function typicalCopiesOf(model: Pick<ModelState, "elements" | "connections">, parts: Iterable<PartInstance>): PartInstance[] {
  const specs = new Map<string, TypicalSpec>();
  for (const g of organizationOf(model).groups) if (g.entry.typical && g.entry.typical.copies.length > 0) specs.set(g.id, g.entry.typical);
  if (specs.size === 0) return [];
  const out: PartInstance[] = [];
  for (const part of parts) {
    const spec = part.groupId ? specs.get(part.groupId) : undefined;
    if (!spec) continue;
    for (const copy of spec.copies) {
      out.push({ ...part, position: copyPoint(spec, copy, part.position), rotationDeg: copy.mirror ? copyRotationDeg(copy, part.rotationDeg) : part.rotationDeg + copy.rotationDeg, mark: copyText(spec, copy, part.mark) });
    }
  }
  return out;
}

/** The next mark after `mark` keeping its width and prefix ("001" → "002", "A9" → "A10"); marks with no trailing number get "-2", "-3"… */
function nthMark(mark: string, n: number): string {
  // Quantifiers are bounded (marks are short) so "0"-repetition input cannot
  // backtrack polynomially (polynomial-redos CodeQL finding).
  const m = /^(.{0,64}?)(\d{1,64})$/.exec(mark);
  if (!m) return `${mark}-${n + 1}`;
  const prefix = m[1] ?? "";
  const digits = m[2] ?? "1";
  return `${prefix}${String(Number(digits) + n).padStart(digits.length, "0")}`;
}

/**
 * Copies laid out in rows: `count` instances in all (the original first),
 * `columns` across, `spacing` apart (x across, y down a row is negative y in
 * plan when spacing.y is negative). Marks count on from the original's.
 */
export function arrayCopies(groupId: string, mark: string, count: number, columns: number, spacing: Vec2): TypicalCopy[] {
  const out: TypicalCopy[] = [];
  for (let i = 1; i < count; i++) {
    const col = i % columns;
    const row = Math.floor(i / columns);
    const copyMark = nthMark(mark, i);
    out.push({ id: `${groupId}:${copyMark}`, mark: copyMark, offset: { x: col * spacing.x, y: row * spacing.y }, rotationDeg: 0 });
  }
  return out;
}
