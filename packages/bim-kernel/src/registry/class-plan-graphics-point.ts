import { defineExtensionPoint } from "../packs/contract";
import { activePackSet } from "../packs/scope";
import type { PackSet } from "../packs/set";
import type { BimElement } from "../types";
import type { KindPlanGraphicsFace, PlanGraphic, PlanGraphicsContext } from "./kind-row-faces";
import { recognizes } from "./recognition";
import type { ObjectClass, Registry } from "./types";

/**
 * Plan graphics by class (contract 1.11.0, `kernel.class_plan_graphics` v1).
 *
 * A row keyed by a class id draws the records of that class (and its
 * subclasses), whatever their kind: an add-on draws a door's swing for the
 * kernel's own `opening` kind without owning the kind. Plans read it before
 * the kind row's `planGraphics`; a row that answers null leaves the record
 * to the kind row and the plan's own cases.
 */

export interface ClassPlanGraphicsRow {
  /** The class it draws (a door class, a pack's `zz.louver`). One row per class. */
  readonly classId: string;
  readonly label: string;
  readonly planGraphics: KindPlanGraphicsFace;
}

export const CLASS_PLAN_GRAPHICS_POINT = defineExtensionPoint<ClassPlanGraphicsRow>({
  id: "kernel.class_plan_graphics",
  version: 1,
  label: "Plan graphics by class",
  idOf: (row) => row.classId,
});

/** Problems with class plan graphics rows (pack conformance), in words. */
export function classPlanGraphicsRowProblems(rows: readonly ClassPlanGraphicsRow[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.classId)) out.push(`class plan graphics ${row.classId} is declared twice`);
    seen.add(row.classId);
    if (row.label.trim().length === 0) out.push(`class plan graphics ${row.classId} has no label`);
    if (typeof row.planGraphics !== "function") out.push(`class plan graphics ${row.classId}: planGraphics must be a function`);
  }
  return out;
}

interface Table {
  readonly rows: ReadonlyMap<string, ClassPlanGraphicsRow>;
  /** The registry `byKind` was built under. */
  registry: Registry | null;
  /** Per element kind, the classes that recognise it and have a row (themselves or an ancestor), deepest first. */
  readonly byKind: Map<string, readonly { readonly cls: ObjectClass; readonly row: ClassPlanGraphicsRow }[]>;
}

const tableOf = (set: PackSet): Table => ({ rows: new Map(set.items(CLASS_PLAN_GRAPHICS_POINT).map((r) => [r.classId, r] as const)), registry: null, byKind: new Map() });

function rowFor(registry: Registry, rows: ReadonlyMap<string, ClassPlanGraphicsRow>, classId: string): ClassPlanGraphicsRow | null {
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

function candidates(registry: Registry, table: Table, kind: string): readonly { readonly cls: ObjectClass; readonly row: ClassPlanGraphicsRow }[] {
  if (table.registry !== registry) {
    table.registry = registry;
    table.byKind.clear();
  }
  const hit = table.byKind.get(kind);
  if (hit) return hit;
  const out: { cls: ObjectClass; row: ClassPlanGraphicsRow }[] = [];
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

/** The face that draws `el` by its class under `registry` (the set in force's classes): its explicit class's row, else the deepest recognised class's; null when none has a row. */
export function classPlanGraphicsFace(el: BimElement, elements: Readonly<Record<string, BimElement>>, registry: Registry): KindPlanGraphicsFace | null {
  const table = activePackSet().memo("kernel.class_plan_graphics#table", tableOf);
  if (table.rows.size === 0) return null;
  const explicit = "classId" in el && typeof el.classId === "string" ? rowFor(registry, table.rows, el.classId) : null;
  if (explicit) return explicit.planGraphics;
  for (const c of candidates(registry, table, el.kind)) if (recognizes(c.cls, el, elements)) return c.row.planGraphics;
  return null;
}

/** Plan graphics for `el` from its class's row, or null. */
export function classPlanGraphicsOf(el: BimElement, ctx: PlanGraphicsContext, registry: Registry): readonly PlanGraphic[] | null {
  const face = classPlanGraphicsFace(el, ctx.elements, registry);
  return face ? face(el, ctx) : null;
}
