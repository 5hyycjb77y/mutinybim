import type { ObjectClass, ObjectClassIfc, Registry } from "../registry/types";
import type { ImportRuleDef } from "./rule-point";
import type { ImportProduct } from "./types";

/**
 * The reverse class map (KERNEL-FOUNDATION §7): from a product's IFC entity,
 * predefined type and object type to the class that takes it, read from the
 * registry's `ifc` homes. A pack or library class with a home is in the map
 * the moment its pack is in the set; nothing here names an entity.
 *
 * Best first: a predefined type (or USERDEFINED object type) that matches
 * exactly, then a pack or library class over a built-in one, then the
 * deeper class. A class whose home names a different predefined type than
 * the product's is not a candidate. Only classes with a usable rule are
 * chosen; the rest are reported with the reason.
 */

export interface ImportChoice {
  readonly cls: ObjectClass;
  readonly rule: ImportRuleDef;
  readonly fields: Readonly<Record<string, string | number | boolean>>;
  readonly options: Readonly<Record<string, string | number | boolean>>;
}

export type ImportChoiceResult = { readonly ok: true; readonly choice: ImportChoice } | { readonly ok: false; readonly cls: ObjectClass | null; readonly reason: string };

export interface ReverseClassMap {
  /** Classes whose IFC home the product matches, best first (with or without a rule). */
  candidates(product: Pick<ImportProduct, "entity" | "predefinedType" | "objectType">): readonly ObjectClass[];
  choose(product: Pick<ImportProduct, "entity" | "predefinedType" | "objectType">): ImportChoiceResult;
}

const UNSET = new Set(["NOTDEFINED", ""]);

function hintOf(registry: Registry, cls: ObjectClass): ObjectClassIfc | null {
  for (const id of registry.ancestors(cls.id)) {
    const hint = registry.getClass(id)?.ifc;
    if (hint) return hint;
  }
  return null;
}

function nearest<T>(registry: Registry, cls: ObjectClass, read: (c: ObjectClass) => T | undefined): T | undefined {
  for (const id of registry.ancestors(cls.id)) {
    const c = registry.getClass(id);
    const v = c ? read(c) : undefined;
    if (v !== undefined) return v;
  }
  return undefined;
}

/** Fields the class's recognition fixes with `equals` on a field of the record itself (not through a relationship). */
export function recognitionFields(registry: Registry, cls: ObjectClass): Readonly<Record<string, string | number | boolean>> {
  const where = nearest(registry, cls, (c) => c.recognize?.where) ?? [];
  const out: Record<string, string | number | boolean> = {};
  for (const cond of where) {
    if (cond.op !== "equals" || cond.path.includes(".")) continue;
    const v = cond.value;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[cond.path] = v;
  }
  return out;
}

/** The rule a class's instances come in through: its own (or an ancestor's) `ifc.import.rule`, else the rule for the kind it recognises. */
export function importRuleFor(registry: Registry, cls: ObjectClass, rules: readonly ImportRuleDef[]): ImportRuleDef | null {
  const named = nearest(registry, cls, (c) => c.ifc?.import?.rule);
  if (named !== undefined) return rules.find((r) => r.id === named) ?? null;
  const recognize = nearest(registry, cls, (c) => c.recognize);
  const kinds = [...(recognize?.partCategories?.length ? ["part"] : []), ...(recognize?.elementKinds ?? [])];
  for (const kind of kinds) {
    const rule = rules.find((r) => r.forKinds?.includes(kind));
    if (rule) return rule;
  }
  return null;
}

interface Indexed {
  readonly cls: ObjectClass;
  readonly hint: ObjectClassIfc;
  readonly rank: readonly [number, number];
}

export function reverseClassMap(registry: Registry, rules: readonly ImportRuleDef[]): ReverseClassMap {
  const byEntity = new Map<string, Indexed[]>();
  for (const cls of registry.listClasses({ includeAbstract: false })) {
    const hint = hintOf(registry, cls);
    if (!hint) continue;
    const key = hint.entity.toUpperCase();
    const list = byEntity.get(key) ?? [];
    list.push({ cls, hint, rank: [cls.source === "builtin" ? 0 : 1, registry.ancestors(cls.id).length] });
    byEntity.set(key, list);
  }
  const ruleOf = new Map<string, ImportRuleDef | null>();
  const ruleFor = (cls: ObjectClass) => {
    if (!ruleOf.has(cls.id)) ruleOf.set(cls.id, importRuleFor(registry, cls, rules));
    return ruleOf.get(cls.id) ?? null;
  };

  const candidates = (product: Pick<ImportProduct, "entity" | "predefinedType" | "objectType">): ObjectClass[] => {
    const list = byEntity.get(product.entity.toUpperCase()) ?? [];
    const pt = product.predefinedType && !UNSET.has(product.predefinedType.toUpperCase()) ? product.predefinedType.toUpperCase() : null;
    const ot = product.objectType?.trim().toLowerCase() || null;
    const scored: Array<{ cls: ObjectClass; score: readonly [number, number, number] }> = [];
    for (const { cls, hint, rank } of list) {
      const hpt = hint.predefinedType?.toUpperCase() ?? null;
      let exact = 0;
      if (hpt === "USERDEFINED") {
        if (pt !== "USERDEFINED" || (hint.objectType && hint.objectType.toLowerCase() !== ot)) continue;
        exact = 2;
      } else if (hpt !== null) {
        if (pt !== null && pt !== hpt) continue;
        exact = pt === hpt ? 2 : 0;
      } else exact = 1;
      scored.push({ cls, score: [exact, rank[0], rank[1]] });
    }
    scored.sort((a, b) => b.score[0] - a.score[0] || b.score[1] - a.score[1] || b.score[2] - a.score[2] || (a.cls.id < b.cls.id ? -1 : a.cls.id > b.cls.id ? 1 : 0));
    return scored.map((s) => s.cls);
  };

  return {
    candidates,
    choose(product) {
      const found = candidates(product);
      for (const cls of found) {
        const rule = ruleFor(cls);
        if (rule) return { ok: true, choice: { cls, rule, fields: recognitionFields(registry, cls), options: nearest(registry, cls, (c) => c.ifc?.import?.options) ?? {} } };
      }
      const first = found[0] ?? null;
      if (!first) return { ok: false, cls: null, reason: "no class in this model takes it" };
      return { ok: false, cls: first, reason: `${first.label} can't be edited here yet` };
    },
  };
}
