import { defineExtensionPoint } from "../packs/contract";
import { activePackSet } from "../packs/scope";
import { GLOBAL_PARTITION } from "../partition";
import { REGISTRY_ID_PATTERN } from "../ids";
import { asElementId, type ElementTypeElement, type ParamValue } from "../types";

/**
 * Starter element types (`kernel.starter_element_type` v1): the types an
 * add-on ships so a new model is never "No type". A drawing command that
 * names a starter's id while the model has no type by that id adds the type
 * in the same edit (one Undo takes both away), as a placed part adds its
 * starter connection type. What a type is made of, in words and values, is
 * the add-on's; the kernel only carries the row and adopts it.
 */
export interface StarterElementTypeRow {
  /** The type's element id once adopted (a pack id, e.g. `zz.type.partition`). */
  readonly id: string;
  readonly name: string;
  /** What it is, in plain words, shown beside its name. */
  readonly description: string;
  /** The kinds it types (`create_element_type` forKinds). */
  readonly forKinds: readonly string[];
  /** For a hosted kind with variants (an opening's door or window): the variant it types. Absent: any. */
  readonly variant?: string;
  readonly classId?: string;
  readonly values?: Readonly<Record<string, ParamValue>>;
  /** What an element of this type is drawn at when the drawing names no size, mm (`create_element`'s size). */
  readonly size?: { readonly thicknessMm?: number; readonly widthMm?: number; readonly heightMm?: number };
  /** The type a tool starts with for its kind (and variant). At most one per kind and variant across the set in force. */
  readonly toolDefault?: boolean;
}

export const STARTER_ELEMENT_TYPE_POINT = defineExtensionPoint<StarterElementTypeRow>({
  id: "kernel.starter_element_type",
  version: 1,
  label: "Starter element types",
  idOf: (row) => row.id,
});

/** Problems with starter element type rows (pack conformance), in words. */
export function starterElementTypeRowProblems(rows: readonly StarterElementTypeRow[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const defaults = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) out.push(`starter type ${row.id} is declared twice`);
    seen.add(row.id);
    if (!REGISTRY_ID_PATTERN.test(row.id)) out.push(`starter type ${row.id}: its id must be a pack id (zz.type.partition)`);
    if (row.name.trim().length === 0) out.push(`starter type ${row.id} has no name`);
    if (row.description.trim().length === 0) out.push(`starter type ${row.id} doesn't say what it is`);
    if (row.forKinds.length === 0) out.push(`starter type ${row.id} types no kind`);
    for (const [k, v] of Object.entries(row.size ?? {})) if (!(typeof v === "number" && v > 0)) out.push(`starter type ${row.id}: size ${k} must be above zero`);
    if (row.toolDefault) {
      for (const kind of row.forKinds) {
        const key = `${kind}/${row.variant ?? ""}`;
        if (defaults.has(key)) out.push(`starter type ${row.id}: another starter is already the default for ${kind}${row.variant ? ` (${row.variant})` : ""}`);
        defaults.add(key);
      }
    }
  }
  return out;
}

/** Every starter element type of the set in force, in set order. */
export function starterElementTypes(): readonly StarterElementTypeRow[] {
  return activePackSet().items(STARTER_ELEMENT_TYPE_POINT);
}

/** The starter element type with this id in the set in force, or null. */
export function starterElementType(id: string): StarterElementTypeRow | null {
  const set = activePackSet();
  const byId = set.memo("kernel.starter_element_type#by_id", (s) => new Map(s.items(STARTER_ELEMENT_TYPE_POINT).map((r) => [r.id, r] as const)));
  return byId.get(id) ?? null;
}

/** The starter a tool starts with for `kind` (and `variant`), or null when no add-on in force ships one. */
export function defaultStarterType(kind: string, variant?: string): StarterElementTypeRow | null {
  return starterElementTypes().find((r) => r.toolDefault === true && r.forKinds.includes(kind) && (r.variant === undefined || r.variant === variant)) ?? null;
}

/** The type record a starter becomes in a model. */
export function starterTypeRecord(row: StarterElementTypeRow): ElementTypeElement {
  return {
    id: asElementId(row.id),
    version: 0,
    authoredRev: {},
    partition: GLOBAL_PARTITION,
    kind: "element_type",
    name: row.name,
    forKinds: [...row.forKinds],
    ...(row.values && Object.keys(row.values).length > 0 ? { values: { ...row.values } } : {}),
    ...(row.classId !== undefined ? { classId: row.classId } : {}),
  };
}
