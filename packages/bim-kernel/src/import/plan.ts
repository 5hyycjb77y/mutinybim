import { activeClassRegistry } from "../registry";
import type { Registry } from "../registry/types";
import { activePackSet, withModelStatePacks } from "../packs/scope";
import { elementsOfKind } from "../store";
import type { BimElement, ElementId, Level, ModelState, ParamValue } from "../types";
import { IFC_IMPORT_RULE_POINT, type ImportRuleContext, type ImportRuleDef } from "./rule-point";
import { reverseClassMap } from "./reverse-map";
import { importElementId } from "./rules";
import type { IfcImportPlan, IfcImportReport, ImportClassLine, ImportGroup, ImportProduct, ImportSource } from "./types";

/**
 * Plan an import (round 9 I9): every product of a linked model asks the
 * reverse class map for its class and that class's rule; what converts
 * becomes new records carrying `provenance`, what doesn't stays on the
 * linked model with its reason. Pure: reads `model` (Main's head, for levels
 * and ids) and the pack set bound to it, writes nothing. The model server
 * lands the plan on a new branch (`import_elements`).
 */

export interface PlanImportOptions {
  /** Main's head: its levels are matched to the file's storeys, and no new id may collide with one of its elements. */
  readonly model: ModelState;
  /** The linked model (reference) the storeys belong to, for new levels' `source`. */
  readonly referenceId: string;
  /** Short key for element ids (`imp.<key>.<GlobalId>`); the source version's id prefix. */
  readonly sourceKey: string;
  /** Override the classes (tests); default: the model's set's registry. */
  readonly registry?: Registry;
  /** Override the rules (tests); default: the model's set's `kernel.ifc_import_rule` rows. */
  readonly rules?: readonly ImportRuleDef[];
}

const LEVEL_MATCH_MM = 50;

/** "2 walls", "1 air terminal", "1 floor or slab": the label's nouns counted (registry labels are mostly plural, some singular). */
function plural(n: number, label: string): string {
  const one = (w: string) => (w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
  const many = (w: string) => (w.endsWith("s") ? w : `${w}s`);
  const nouns = label.toLowerCase().split(" and ");
  if (nouns.length > 1) return `${n} ${n === 1 ? nouns.map((p) => p.split(" ").map((w, i, a) => (i === a.length - 1 ? one(w) : w)).join(" ")).join(" or ") : nouns.join(" and ")}`;
  const words = (nouns[0] ?? "").split(" ");
  return `${n} ${words.map((w, i) => (i === words.length - 1 ? (n === 1 ? one(w) : many(w)) : w)).join(" ")}`;
}

/** "IfcCurtainWall" → "Curtain walls". */
function entityWords(entity: string): string {
  const words = entity.replace(/^Ifc/i, "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  const text = words.charAt(0).toUpperCase() + words.slice(1);
  return text.endsWith("s") ? text : `${text}s`;
}

function list(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export function planIfcImport(source: ImportSource, opts: PlanImportOptions): IfcImportPlan {
  return withModelStatePacks(opts.model, () => planInScope(source, opts));
}

function planInScope(source: ImportSource, opts: PlanImportOptions): IfcImportPlan {
  const registry = opts.registry ?? activeClassRegistry();
  const rules = opts.rules ?? activePackSet().items(IFC_IMPORT_RULE_POINT);
  const map = reverseClassMap(registry, rules);
  const records: BimElement[] = [];
  const byId = new Map<string, BimElement>();
  const converted = new Map<string, ElementId>();
  const notes = new Set<string>();
  const shared = new Map<string, BimElement | string>();
  const exists = (id: ElementId) => byId.has(id) || opts.model.elements[id] !== undefined;
  const push = (r: BimElement) => {
    if (exists(r.id)) throw new Error(`[bim-kernel/import] the planned id ${r.id} is already used; the import key must be unique per source`);
    records.push(r);
    byId.set(r.id, r);
  };

  // Levels: the file's storeys matched to Main's levels (by the storey they came from, then name, then height), new ones made.
  const levels = elementsOfKind(opts.model.elements, "level");
  const storeyLevel = new Map<string, Level>();
  const levelsAdded: string[] = [];
  const taken = new Set(levels.map((l) => l.name.toLowerCase()));
  for (const storey of [...source.storeys].sort((a, b) => a.elevationMm - b.elevationMm)) {
    const match =
      levels.find((l) => l.source?.storeyId === storey.sourceId) ??
      levels.find((l) => l.name.trim().toLowerCase() === storey.name.trim().toLowerCase()) ??
      levels.find((l) => Math.abs(l.elevationMm - storey.elevationMm) <= LEVEL_MATCH_MM);
    if (match) {
      storeyLevel.set(storey.sourceId, match);
      continue;
    }
    let name = storey.name.trim() || `Level at ${Math.round(storey.elevationMm)} mm`;
    if (taken.has(name.toLowerCase())) name = `${name} (${source.label})`.slice(0, 120);
    taken.add(name.toLowerCase());
    const level: Level = {
      id: importElementId(opts.sourceKey, storey.sourceId),
      kind: "level",
      version: 0,
      authoredRev: {},
      name,
      elevationMm: Math.round(storey.elevationMm),
      source: { referenceId: opts.referenceId, storeyId: storey.sourceId, storeyName: storey.name },
    };
    push(level);
    storeyLevel.set(storey.sourceId, level);
    levels.push(level);
    levelsAdded.push(name);
  }
  const byElevation = [...levels].sort((a, b) => a.elevationMm - b.elevationMm);
  const levelFor = (p: ImportProduct): Level | null => {
    const direct = p.storeyId ? storeyLevel.get(p.storeyId) : undefined;
    if (direct) return direct;
    const z = p.geometry.bounds?.min.z;
    if (z === undefined) return null;
    let best: Level | null = null;
    for (const l of byElevation) if (l.elevationMm <= z + LEVEL_MATCH_MM) best = l;
    return best ?? byElevation[0] ?? null;
  };

  const groups = new Map<string, ImportGroup>(source.groups.map((g) => [g.sourceId, g]));
  const lines = new Map<string, { classId: string | null; label: string; converted: number; linked: Map<string, number> }>();
  const line = (key: string, classId: string | null, label: string) => {
    let l = lines.get(key);
    if (!l) {
      l = { classId, label, converted: 0, linked: new Map() };
      lines.set(key, l);
    }
    return l;
  };
  const stay = (key: string, classId: string | null, label: string, reason: string, count = 1) => {
    const l = line(key, classId, label);
    l.linked.set(reason, (l.linked.get(reason) ?? 0) + count);
  };

  const chosen: Array<{ product: ImportProduct; choice: Extract<ReturnType<typeof map.choose>, { ok: true }>["choice"] }> = [];
  for (const product of source.products) {
    const answer = map.choose(product);
    if (answer.ok) chosen.push({ product, choice: answer.choice });
    else stay(answer.cls?.id ?? product.entity, answer.cls?.id ?? null, answer.cls?.label ?? entityWords(product.entity), answer.reason);
  }
  chosen.sort((a, b) => (a.choice.rule.order ?? 10) - (b.choice.rule.order ?? 10));

  for (const { product, choice } of chosen) {
    const { cls } = choice;
    const ctx: ImportRuleContext = {
      cls,
      fields: choice.fields,
      options: choice.options,
      idFor: (sourceId, suffix) => importElementId(opts.sourceKey, sourceId, suffix),
      level: levelFor,
      partition: (level) => ({ level: level.name, zone: "Z1", discipline: cls.discipline }),
      converted: (sourceId) => {
        const id = converted.get(sourceId);
        return id ? (byId.get(id) ?? null) : null;
      },
      group: (sourceId) => groups.get(sourceId) ?? null,
      shared: <T extends BimElement>(key: string, make: () => T | string): T | string => {
        const have = shared.get(key);
        if (have !== undefined) return have as T | string;
        const made = make();
        if (typeof made !== "string") push(made);
        shared.set(key, made);
        return made;
      },
      values: (p) => mappedValues(registry, cls.id, p),
      provenance: (p) => ({ ifcGlobalId: p.sourceId, source: source.id }),
      note: (text) => {
        if (notes.size < 200) notes.add(text);
      },
    };
    let result;
    try {
      result = choice.rule.convert(product, ctx);
    } catch (err) {
      console.error("[bim-kernel/import] an import rule threw; the product stays linked", { rule: choice.rule.id, entity: product.entity, sourceId: product.sourceId, err });
      result = { ok: false as const, reason: `the ${choice.rule.label.toLowerCase()} rule failed on it` };
    }
    if (!result.ok) {
      stay(cls.id, cls.id, cls.label, result.reason);
      continue;
    }
    for (const r of result.records) push(r);
    const own = result.records[result.records.length - 1];
    if (own) converted.set(product.sourceId, own.id);
    line(cls.id, cls.id, cls.label).converted += 1;
  }
  for (const u of source.unreadable) stay(u.entity, null, entityWords(u.entity), u.reason, u.count);

  const classes: ImportClassLine[] = [...lines.values()]
    .map((l) => ({ classId: l.classId, label: l.label, converted: l.converted, linked: [...l.linked].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count) }))
    .sort((a, b) => b.converted - a.converted || a.label.localeCompare(b.label));
  const convertedCount = classes.reduce((s, c) => s + c.converted, 0);
  const linkedCount = classes.reduce((s, c) => s + c.linked.reduce((t, r) => t + r.count, 0), 0);
  const did = classes.filter((c) => c.converted > 0).map((c) => plural(c.converted, c.label));
  const left = classes.map((c) => ({ c, n: c.linked.reduce((t, r) => t + r.count, 0) })).filter((x) => x.n > 0).map((x) => plural(x.n, x.c.label));
  const summary = [did.length > 0 ? `Converted ${list(did)}.` : "Nothing in this linked model could be converted.", left.length > 0 ? `Left ${list(left)} as the linked model.` : "Everything else came in too."].join(" ");
  const report: IfcImportReport = {
    source: { id: source.id, label: source.label, disciplines: source.disciplines },
    converted: convertedCount,
    stayLinked: linkedCount,
    levelsAdded,
    classes,
    notes: [...notes],
    summary,
  };
  return { records, converted, report };
}

/** Values the registry maps from property sets onto the class's text, yes/no and choice fields (numbers wait for unit checks). */
function mappedValues(registry: Registry, classId: string, p: ImportProduct): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  for (const f of registry.fieldsFor(classId)) {
    if (!f.key || !f.ifc || !("pset" in f.ifc) || f.binding !== "instance") continue;
    const v = p.properties[f.ifc.pset]?.[f.ifc.property];
    if (v === undefined) continue;
    if (f.valueType === "text" && typeof v === "string") out[f.key] = v.slice(0, 400);
    else if (f.valueType === "boolean" && typeof v === "boolean") out[f.key] = v;
    else if (f.valueType === "choice" && typeof v === "string" && (!f.choices || f.choices.includes(v))) out[f.key] = v;
  }
  return out;
}