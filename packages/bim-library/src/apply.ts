import { paramUnitBinding, RegistryError, type DisciplineDef, type DisplayProfile, type FieldDef, type FieldReader, type FieldWriter, type Registry, type RegistrySource } from "@permitzip/bim-kernel";
import { elementTypeValue } from "@permitzip/bim-kernel/elements";
import { convert } from "@permitzip/bim-units";
import type { ResolvedItem, ResolvedLibrary } from "./layering";
import type { LibraryProblem } from "./provider";
import type { ClassItem, DisciplineItem, DisplayProfileItem, LibraryItem, RelationshipItem, SharedFieldItem } from "./schema";

/**
 * Library items onto a registry: classes (new ones, or replacements a item
 * declares with `replaces`), shared fields and relationships. Calculations,
 * templates and tag types are not registry content; schedules and tags read
 * them from the resolved library (as pins).
 */

export function sourceOf(item: LibraryItem): RegistrySource {
  return `library:${item.body.id}@${item.body.revision}`;
}

export function fieldWriterOf(field: SharedFieldItem): FieldWriter {
  if (!field.editable) return { kind: "none", reason: `${field.label} is set by the library, not typed in.` };
  if (field.storage.kind === "parameter") return { kind: "parameter", scope: field.storage.scope, name: field.storage.name };
  if (field.storage.kind === "values") return { kind: "command", command: "set_element_values", argument: field.key };
  return { kind: "none", reason: `${field.label} is read from the model.` };
}

/**
 * How a field kept as a part parameter reads (KERNEL-FOUNDATION §3.2): the
 * part's own value (when the type declares it per part), else its type's,
 * else the parameter's default, in the field's unit. A part whose type doesn't declare it reads empty. Without a
 * reader a library field named by its key (`param.mca`) opened as an empty
 * column in schedules and agent reads; a bare name still reads the same value
 * through the part type.
 */
export function parameterRead(field: SharedFieldItem): FieldReader | undefined {
  if (field.storage.kind === "values") return valuesRead(field);
  if (field.storage.kind !== "parameter") return undefined;
  const { name } = field.storage;
  return (el, { elements }) => {
    if (el.kind !== "part") return null;
    const type = elements[el.typeId];
    if (type?.kind !== "part_type") return null;
    const d = type.definition;
    // Where the type declares it decides where the value is (a field the library keeps on the type may be declared per part).
    const own = d.instanceParams.find((p) => p.name === name);
    const def = own ?? d.typeParams.find((p) => p.name === name);
    if (!def) return null;
    const v = own ? (el.values[name] ?? d.typeValues[name] ?? def.default) : (d.typeValues[name] ?? def.default);
    if (v === undefined) return null;
    if (field.valueType === "quantity") {
      if (typeof v !== "number") return null;
      const stored = def.kind === "length" ? "mm" : def.kind === "number" ? paramUnitBinding(def.unit)?.unit : undefined;
      return stored && field.unit && stored !== field.unit ? convert(v, stored, field.unit) : v;
    }
    if (field.valueType === "boolean") return typeof v === "boolean" ? v : null;
    return typeof v === "boolean" ? (v ? "Yes" : "No") : String(v);
  };
}

/**
 * How a field kept in an element's `values` reads: the element's own value
 * under the key (then under each alias, for values stored before the key was
 * namespaced), else its element type's (`elementTypeValue`). Numbers are
 * stored in the field's own unit, as `set_element_values` writes them.
 */
function valuesRead(field: SharedFieldItem): FieldReader {
  const keys = [field.key, ...(field.aliases ?? [])];
  return (el, { elements }) => {
    let v: unknown;
    for (const k of keys) {
      v = elementTypeValue(elements, el, k);
      if (v !== undefined) break;
    }
    if (v === undefined || v === null) return null;
    if (field.valueType === "quantity") return typeof v === "number" && Number.isFinite(v) ? v : null;
    if (field.valueType === "boolean") return typeof v === "boolean" ? v : null;
    return typeof v === "boolean" ? (v ? "Yes" : "No") : String(v);
  };
}

/**
 * The other keys a field answers to (FOUNDATION adjustments D2): a field
 * kept as part parameter `<name>` answers to `param.<name>`, the key the part
 * parameter itself has (`parameterOfParamDef`), so a namespaced key
 * (`elec.mca`) and a firm template saved with `param.mca` read the same value.
 */
export function parameterAliases(field: SharedFieldItem): string[] {
  if (field.storage.kind === "values") return (field.aliases ?? []).filter((a) => a !== field.key);
  // A bare key (`k_factor`) is already the name 5a templates used; only a namespaced key needs the `param.` spelling.
  if (field.storage.kind !== "parameter" || !field.key.includes(".")) return [];
  const alias = `param.${field.storage.name}`;
  return alias === field.key ? [] : [alias];
}

export function fieldDefOf(field: SharedFieldItem, source: RegistrySource): FieldDef {
  const read = parameterRead(field);
  const aliases = parameterAliases(field);
  return {
    path: field.key,
    label: field.label,
    classes: field.appliesTo,
    valueType: field.valueType,
    ...(field.kind === undefined ? {} : { kind: field.kind }),
    ...(field.unit === undefined ? {} : { unit: field.unit }),
    ...(field.storage.kind === "values" ? { binding: "instance" as const, ...(field.unit === undefined ? {} : { storedUnit: field.unit }) } : {}),
    ...(field.choices === undefined ? {} : { choices: field.choices }),
    writer: fieldWriterOf(field),
    ...(field.group === undefined ? {} : { group: field.group }),
    ...(field.description === undefined ? {} : { description: field.description }),
    source,
    key: field.key,
    ...(aliases.length > 0 ? { aliases } : {}),
    ...(read ? { read } : {}),
  };
}

function addClass(b: ReturnType<Registry["extend"]>, base: Registry, item: ClassItem, source: RegistrySource): void {
  const cls = {
    id: item.key,
    label: item.label,
    discipline: item.discipline,
    ...(item.parent === undefined ? {} : { parent: item.parent }),
    ...(item.abstract === undefined ? {} : { abstract: item.abstract }),
    ...(item.ifc === undefined ? {} : { ifc: item.ifc }),
    ...(item.recognize === undefined ? {} : { recognize: item.recognize }),
    ...(item.description === undefined ? {} : { description: item.description }),
    ...(item.drawsUnder === undefined ? {} : { drawsUnder: item.drawsUnder }),
    ...(item.symbolId === undefined ? {} : { symbolId: item.symbolId }),
    source,
  };
  if (item.replaces && base.getClass(item.key)) b.replaceClass(cls);
  else b.addClass(cls);
}

function addRelationship(b: ReturnType<Registry["extend"]>, item: RelationshipItem, source: RegistrySource): void {
  b.addRelationship(
    {
      forward: { id: item.key, label: item.label, cardinality: item.cardinality, from: item.from, to: item.to, traversal: item.traversal },
      inverse: { id: item.inverseKey, label: item.inverseLabel, cardinality: item.inverseCardinality, from: item.to, to: item.from, traversal: item.traversal },
      deps: { connections: true },
      ...(item.description === undefined ? {} : { description: item.description }),
    },
    source,
  );
}

/** A registry problem tied back to the library item its message names (`library item <id>@<rev>`). */
function problemOf(message: string, items: readonly LibraryItem[]): LibraryProblem {
  const named = /library item (\S+)@\d+/.exec(message)?.[1];
  const item = named === undefined ? undefined : items.find((i) => i.body.id === named);
  return item ? { itemId: item.body.id, itemKey: item.body.key, itemType: item.type, message } : { message };
}

/** A display profile item as the units library's `DisplayProfile` (its `key` is the profile id). */
export function displayProfileOf(item: DisplayProfileItem): DisplayProfile {
  return {
    id: item.key,
    name: item.name,
    ...(item.description === undefined ? {} : { description: item.description }),
    kinds: item.kinds,
    label: item.label,
    thousands: item.thousands,
    decimal: item.decimal,
  };
}

export type RegistryResult = { readonly ok: true; readonly registry: Registry } | { readonly ok: false; readonly problems: readonly LibraryProblem[] };

/** A registry extending `base` with every class, field and relationship of `items` (deprecated ones included: existing pins still read them). */
export function extendRegistry(base: Registry, items: readonly (LibraryItem | ResolvedItem)[]): RegistryResult {
  const list = items.map((i) => ("layer" in i ? i.item : i));
  const b = base.extend();
  for (const item of list) if (item.type === "class") addClass(b, base, item.body, sourceOf(item));
  for (const item of list) if (item.type === "relationship") addRelationship(b, item.body, sourceOf(item));
  const defs = list.flatMap((item) => (item.type === "field" ? [fieldDefOf(item.body, sourceOf(item))] : []));
  for (const def of defs) b.addField(def);
  let registry: Registry;
  try {
    registry = b.build();
  } catch (err) {
    if (err instanceof RegistryError) return { ok: false, problems: err.problems.map((p) => problemOf(p.message, list)) };
    throw err;
  }
  // A field's aliases are fields too (same reader and writer, key unchanged), so a column or agent read named by
  // either spelling resolves. Added once the fields themselves are valid, so a problem is reported once, under the
  // key; an alias another item uses as its own key is left to that item.
  const keys = new Set(defs.map((d) => d.path));
  const aliases = defs.flatMap((def) => (def.aliases ?? []).filter((a) => !keys.has(a)).map((path) => ({ ...def, path })));
  if (aliases.length === 0) return { ok: true, registry };
  const withAliases = registry.extend();
  const seen = new Set<string>();
  for (const a of aliases) {
    if (seen.has(a.path)) continue;
    seen.add(a.path);
    withAliases.addField(a);
  }
  try {
    return { ok: true, registry: withAliases.build() };
  } catch (err) {
    if (err instanceof RegistryError) return { ok: false, problems: err.problems.map((p) => problemOf(p.message, list)) };
    throw err;
  }
}

/** The registry a model reads under a resolved library. */
export function registryForLibrary(base: Registry, resolved: ResolvedLibrary): RegistryResult {
  return extendRegistry(base, resolved.items);
}

/**
 * A firm's discipline items as registry rows (`kernel.discipline`), for the
 * model's pack set (`PackSetOptions.firm`). Deprecated items are left out.
 */
export function firmDisciplineRows(items: readonly DisciplineItem[]): DisciplineDef[] {
  return items
    .filter((item) => item.deprecated !== true)
    .map((item) => ({
      id: item.key,
      label: item.label,
      ...(item.parent ? { parent: item.parent } : {}),
      ...(item.group ? { group: item.group } : {}),
      display: { colour: item.colour, ...(item.icon ? { icon: item.icon } : {}) },
      ...(item.defaultResponsibleRole ? { defaultResponsibleRole: item.defaultResponsibleRole } : {}),
    }));
}
