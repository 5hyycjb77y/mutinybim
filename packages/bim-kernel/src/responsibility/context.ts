/**
 * A `CoverageContext` over a model, from indexes the kernel already keeps
 * (round 8 step 8b, lane M): the element's partition discipline, its class
 * from the class registry (cached per record), its system and service ids,
 * its group, and field filters through the field resolver. Sheet membership
 * is the caller's (a view index); without one, a sheet scope covers nothing,
 * so it can never approve more than the lead meant.
 *
 * Every answer is per element; nothing here scans the model.
 */
import { activeCategoryRegistry } from "../categories/registry";
import { elementClass } from "../categories/element";
import { resolveField } from "../fields/resolver";
import { partitionOf } from "../partition";
import type { ScheduleFilter } from "../schedules/definition";
import type { BimElement, ModelState } from "../types";
import type { CoverageContext } from "./types";

function stringField(el: BimElement, key: string): string | null {
  if (!(key in el)) return null;
  const v: unknown = Reflect.get(el, key);
  return typeof v === "string" && v !== "" ? v : null;
}

function filterHolds(value: string | number | boolean | null, text: string, f: ScheduleFilter): boolean {
  const want = f.value ?? "";
  switch (f.op) {
    case "present":
      return value !== null && text !== "";
    case "absent":
      return value === null || text === "";
    case "equals":
      return text.toLowerCase() === want.toLowerCase();
    case "not_equals":
      return text.toLowerCase() !== want.toLowerCase();
    case "contains":
      return text.toLowerCase().includes(want.toLowerCase());
    case "greater_than":
    case "less_than": {
      const n = typeof value === "number" ? value : Number(text);
      const w = Number(want);
      if (!Number.isFinite(n) || !Number.isFinite(w)) return false;
      return f.op === "greater_than" ? n > w : n < w;
    }
  }
}

export interface ModelCoverageOptions {
  /** Sheet ids an element appears on (the caller's view index). */
  readonly sheetsOf?: (el: BimElement) => readonly string[];
}

export function modelCoverageContext(model: Pick<ModelState, "elements">, options: ModelCoverageOptions = {}): CoverageContext {
  const { elements } = model;
  const registry = activeCategoryRegistry();
  return {
    disciplineOf: (el) => partitionOf(el).discipline,
    classOf: (el) => elementClass(elements, el, registry) ?? undefined,
    isA: (classId, ancestor) => classId === ancestor || registry.lineage(classId).includes(ancestor),
    systemsOf: (el) => {
      const out: string[] = [];
      for (const key of ["systemId", "service"]) {
        const v = stringField(el, key);
        if (v) out.push(v);
      }
      const systemId = stringField(el, "systemId");
      const system = systemId ? elements[systemId] : undefined;
      const kind = system ? stringField(system, "systemKind") : null;
      if (kind) out.push(kind);
      return out;
    },
    groupsOf: (el) => (el.groupId ? [el.groupId] : []),
    sheetsOf: options.sheetsOf ?? (() => []),
    matches: (el, f) => {
      const r = resolveField(elements, el.id, f.path);
      return filterHolds(r.value, r.text, f);
    },
  };
}
