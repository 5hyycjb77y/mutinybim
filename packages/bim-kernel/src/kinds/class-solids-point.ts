import { defineExtensionPoint } from "../packs/contract";
import { activePackSet } from "../packs/scope";
import type { PackSet } from "../packs/set";
import { recognizes } from "../registry/recognition";
import type { KindSolidContext, KindSolidShape } from "../registry/kind-row-faces";
import type { ObjectClass, Registry } from "../registry/types";
import type { BimElement } from "../types";

/**
 * Bodies by class (contract 1.13.0, `kernel.class_solids` v1).
 *
 * A row keyed by a class id gives the records of that class (and its
 * subclasses) a body, whatever their kind: an add-on builds a filler for the
 * kernel's own hosted void, or a louvre for another firm's kind, without
 * owning the kind. 3D views, sections and elevations read it before the kind
 * row's `solid`; a row that answers null leaves the record to the kind row
 * and the drawing's own cases.
 *
 * A body is several parts, each one of the `KindSolidShape` forms with a
 * look: `solid` (shaded as its role) or `glazing` (see-through in 3D, cut
 * like any other part in sections).
 */

/** How one part of a class body looks in 3D. Absent: `solid`. */
export const SOLID_LOOKS = ["solid", "glazing"] as const;
export type SolidLook = (typeof SOLID_LOOKS)[number];

export interface ClassSolidPart {
  readonly shape: KindSolidShape;
  readonly look?: SolidLook;
}

/** A record's body by its class, or null when this one has none (not hosted yet, zero size). */
export type ClassSolidsFace = (el: BimElement, ctx: KindSolidContext) => readonly ClassSolidPart[] | null;

export interface ClassSolidsRow {
  /** The class it builds (a pack's class id, e.g. `zz.louvre`). One row per class. */
  readonly classId: string;
  readonly label: string;
  readonly solids: ClassSolidsFace;
}

export const CLASS_SOLIDS_POINT = defineExtensionPoint<ClassSolidsRow>({
  id: "kernel.class_solids",
  version: 1,
  label: "Bodies by class",
  idOf: (row) => row.classId,
});

/** Problems with class solids rows (pack conformance), in words. */
export function classSolidsRowProblems(rows: readonly ClassSolidsRow[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.classId)) out.push(`class body ${row.classId} is declared twice`);
    seen.add(row.classId);
    if (row.label.trim().length === 0) out.push(`class body ${row.classId} has no label`);
    if (typeof row.solids !== "function") out.push(`class body ${row.classId}: solids must be a function`);
  }
  return out;
}

interface Candidate {
  readonly cls: ObjectClass;
  readonly row: ClassSolidsRow;
}

interface Table {
  readonly rows: ReadonlyMap<string, ClassSolidsRow>;
  /** The registry `byKind` was built under. */
  registry: Registry | null;
  /** Per element kind, the classes that recognise it and have a row (themselves or an ancestor), deepest first. */
  readonly byKind: Map<string, readonly Candidate[]>;
}

const tableOf = (set: PackSet): Table => ({ rows: new Map(set.items(CLASS_SOLIDS_POINT).map((r) => [r.classId, r] as const)), registry: null, byKind: new Map() });

function rowFor(registry: Registry, rows: ReadonlyMap<string, ClassSolidsRow>, classId: string): ClassSolidsRow | null {
  const seen = new Set<string>();
  for (let id: string | undefined = classId; id !== undefined && !seen.has(id); id = registry.getClass(id)?.parent) {
    seen.add(id);
    const row = rows.get(id);
    if (row) return row;
  }
  return null;
}

function depthOf(registry: Registry, cls: ObjectClass): number {
  let d = 0;
  for (let p = cls.parent; p !== undefined && d < 32; p = registry.getClass(p)?.parent) d++;
  return d;
}

function candidates(registry: Registry, table: Table, kind: string): readonly Candidate[] {
  if (table.registry !== registry) {
    table.registry = registry;
    table.byKind.clear();
  }
  const hit = table.byKind.get(kind);
  if (hit) return hit;
  const out: Candidate[] = [];
  for (const cls of registry.listClasses()) {
    const kinds: readonly string[] = cls.recognize?.elementKinds ?? [];
    if (!kinds.includes(kind)) continue;
    const row = rowFor(registry, table.rows, cls.id);
    if (row) out.push({ cls, row });
  }
  out.sort((a, b) => depthOf(registry, b.cls) - depthOf(registry, a.cls));
  table.byKind.set(kind, out);
  return out;
}

/** The face that builds `el`'s body by its class under `registry`: its explicit class's row, else the deepest recognised class's; null when none has a row. */
export function classSolidsFace(el: BimElement, elements: Readonly<Record<string, BimElement>>, registry: Registry): ClassSolidsFace | null {
  const table = activePackSet().memo("kernel.class_solids#table", tableOf);
  if (table.rows.size === 0) return null;
  const explicit = "classId" in el && typeof el.classId === "string" ? rowFor(registry, table.rows, el.classId) : null;
  if (explicit) return explicit.solids;
  const found = candidates(registry, table, el.kind);
  for (const c of found) if (recognizes(c.cls, el, elements)) return c.row.solids;
  return null;
}

/** `el`'s body parts from its class's row, or null when its class has no row (or the row answers none). */
export function classSolidsOf(el: BimElement, ctx: KindSolidContext, registry: Registry): readonly ClassSolidPart[] | null {
  const face = classSolidsFace(el, ctx.elements, registry);
  const parts = face ? face(el, ctx) : null;
  return parts && parts.length > 0 ? parts : null;
}

/** True when any class row is in force (a quick skip for drawings with no add-on bodies). */
export function hasClassSolids(): boolean {
  return activePackSet().memo("kernel.class_solids#table", tableOf).rows.size > 0;
}
