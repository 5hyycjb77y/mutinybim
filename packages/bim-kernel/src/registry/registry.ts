import { canonicalJson } from "../canonical";
import {
  CLASS_ID_PATTERN,
  FIELD_PATH_PATTERN,
  RELATIONSHIP_ID_PATTERN,
  RegistryError,
  type ClassFilter,
  type ClassId,
  type FieldDef,
  type FieldProvider,
  type ObjectClass,
  type PathDescription,
  type Registry,
  type RegistryBuilder,
  type RegistryProblem,
  type RegistrySource,
  type RelationshipDef,
  type RelationshipId,
  type RelationshipPair,
  type RelationshipResolver,
  type RelationshipSide,
} from "./types";
import type { UnitCatalog } from "./units";

/**
 * The registry machinery: a builder that collects classes, fields and
 * relationships, checks them as a whole, and freezes them into a `Registry`.
 * Layers (kernel built-ins, trade providers, firm and project libraries)
 * each extend the registry below them; nothing is ever mutated in place, so
 * a compiled index keyed by a registry stays valid for that registry.
 */

interface State {
  readonly classes: Map<ClassId, ObjectClass>;
  /** Per class, its own fields by path. */
  readonly fields: Map<ClassId, Map<string, FieldDef>>;
  readonly relationships: Map<RelationshipId, RelationshipDef>;
  /** Resolvers attached by providers to relationships they did not declare. */
  readonly resolvers: Map<RelationshipId, { readonly provider: string; readonly resolve: RelationshipResolver }>;
}

export interface RegistryOptions {
  /** Checks each quantity field's unit can express its kind. Absent: kinds and units are only required, not cross-checked. */
  readonly units?: UnitCatalog;
}

export function createRegistryBuilder(opts: RegistryOptions = {}): RegistryBuilder {
  return new Builder(emptyState(), opts);
}

function emptyState(): State {
  return { classes: new Map(), fields: new Map(), relationships: new Map(), resolvers: new Map() };
}

function copyState(s: State): State {
  const fields = new Map<ClassId, Map<string, FieldDef>>();
  for (const [cls, byPath] of s.fields) fields.set(cls, new Map(byPath));
  return { classes: new Map(s.classes), fields, relationships: new Map(s.relationships), resolvers: new Map(s.resolvers) };
}

class Builder implements RegistryBuilder {
  private readonly problems: RegistryProblem[] = [];
  constructor(
    private readonly state: State,
    private readonly opts: RegistryOptions,
  ) {}

  addClass(cls: ObjectClass): RegistryBuilder {
    if (!CLASS_ID_PATTERN.test(cls.id)) {
      this.problems.push({ code: "invalid_id", message: `"${cls.id}" is not a class id. Use a namespace and a name, such as mep.water_heater.` });
      return this;
    }
    const existing = this.state.classes.get(cls.id);
    if (existing) {
      this.problems.push({ code: "duplicate_class", message: `Class ${cls.id} is defined twice (${describeSource(existing.source)} and ${describeSource(cls.source)}).` });
      return this;
    }
    this.state.classes.set(cls.id, cls);
    return this;
  }

  replaceClass(cls: ObjectClass): RegistryBuilder {
    if (!this.state.classes.has(cls.id)) {
      this.problems.push({ code: "unknown_class", message: `${describeSource(cls.source)} replaces class ${cls.id}, which does not exist.` });
      return this;
    }
    this.state.classes.set(cls.id, cls);
    return this;
  }

  addField(field: FieldDef): RegistryBuilder {
    const where = `Field ${field.path} (${describeSource(field.source)})`;
    if (!FIELD_PATH_PATTERN.test(field.path)) {
      this.problems.push({ code: "invalid_field", message: `"${field.path}" is not a field path. Use lower_snake_case words joined by dots.` });
      return this;
    }
    if (field.classes.length === 0) {
      this.problems.push({ code: "invalid_field", message: `${where} applies to no class.` });
      return this;
    }
    if (field.valueType === "quantity") {
      if (field.kind === undefined || field.unit === undefined) {
        this.problems.push({ code: "invalid_field", message: `${where} is a quantity, so it needs a kind and a unit.` });
        return this;
      }
      if (this.opts.units && !this.opts.units.unitAllowed(field.kind, field.unit)) {
        this.problems.push({ code: "unit_kind_mismatch", message: `${where} is a ${field.kind.replace(/_/g, " ")}, and "${field.unit}" is not a ${field.kind.replace(/_/g, " ")} unit.` });
        return this;
      }
    } else if (field.kind !== undefined || field.unit !== undefined) {
      this.problems.push({ code: "invalid_field", message: `${where} is ${field.valueType}, so it can't carry a kind or unit.` });
      return this;
    }
    if (field.valueType === "choice" && (field.choices === undefined || field.choices.length === 0)) {
      this.problems.push({ code: "invalid_field", message: `${where} is a choice with no choices.` });
      return this;
    }
    for (const cls of field.classes) {
      let byPath = this.state.fields.get(cls);
      if (!byPath) {
        byPath = new Map();
        this.state.fields.set(cls, byPath);
      }
      const existing = byPath.get(field.path);
      if (existing) {
        this.problems.push({ code: "duplicate_field", message: `Field ${field.path} on ${cls} is defined twice (${describeSource(existing.source)} and ${describeSource(field.source)}).` });
        continue;
      }
      byPath.set(field.path, field);
    }
    return this;
  }

  addRelationship(pair: RelationshipPair, source: RegistrySource): RegistryBuilder {
    const sides: RelationshipSide[] = pair.forward.id === pair.inverse.id ? [pair.forward] : [pair.forward, pair.inverse];
    for (const side of sides) {
      if (!RELATIONSHIP_ID_PATTERN.test(side.id)) {
        this.problems.push({ code: "invalid_id", message: `"${side.id}" is not a relationship id. Use lower_snake_case, such as served_by.` });
        return this;
      }
      const existing = this.state.relationships.get(side.id);
      if (existing) {
        this.problems.push({ code: "duplicate_relationship", message: `Relationship ${side.id} is defined twice (${describeSource(existing.source)} and ${describeSource(source)}).` });
        return this;
      }
    }
    const make = (side: RelationshipSide, inverse: RelationshipId): RelationshipDef => ({
      ...side,
      inverse,
      deps: pair.deps,
      source,
      ...(side.description === undefined && pair.description !== undefined ? { description: pair.description } : {}),
    });
    this.state.relationships.set(pair.forward.id, make(pair.forward, pair.inverse.id));
    if (pair.inverse.id !== pair.forward.id) this.state.relationships.set(pair.inverse.id, make(pair.inverse, pair.forward.id));
    return this;
  }

  addProvider(provider: FieldProvider): RegistryBuilder {
    const source: RegistrySource = `provider:${provider.id}`;
    for (const field of provider.fields ?? []) this.addField({ ...field, source });
    for (const pair of provider.relationships ?? []) this.addRelationship(pair, source);
    for (const [id, resolve] of Object.entries(provider.resolvers ?? {})) {
      const existing = this.state.resolvers.get(id);
      if (existing) {
        this.problems.push({ code: "duplicate_relationship", message: `Relationship ${id} has two resolvers (providers ${existing.provider} and ${provider.id}).` });
        continue;
      }
      this.state.resolvers.set(id, { provider: provider.id, resolve });
    }
    return this;
  }

  build(): Registry {
    const problems = [...this.problems, ...checkState(this.state)];
    if (problems.length > 0) throw new RegistryError(problems);
    return new FrozenRegistry(copyState(this.state), this.opts);
  }
}

function describeSource(source: RegistrySource): string {
  if (source === "builtin") return "built in";
  if (source.startsWith("provider:")) return `provider ${source.slice("provider:".length)}`;
  return source.replace(/^library:/, "library item ");
}

function checkState(s: State): RegistryProblem[] {
  const problems: RegistryProblem[] = [];
  for (const cls of s.classes.values()) {
    if (cls.parent !== undefined && !s.classes.has(cls.parent)) {
      problems.push({ code: "unknown_parent", message: `Class ${cls.id} extends ${cls.parent}, which does not exist.` });
    }
  }
  const reported = new Set<ClassId>();
  for (const start of s.classes.keys()) {
    const seen: ClassId[] = [];
    let at: ClassId | undefined = start;
    while (at !== undefined && s.classes.has(at)) {
      if (seen.includes(at)) {
        const cycle = seen.slice(seen.indexOf(at));
        if (!cycle.some((c) => reported.has(c))) {
          cycle.forEach((c) => reported.add(c));
          problems.push({ code: "inheritance_cycle", message: `Classes ${[...cycle, at].join(" → ")} extend each other in a circle.` });
        }
        break;
      }
      seen.push(at);
      at = s.classes.get(at)?.parent;
    }
  }
  for (const [cls, byPath] of s.fields) {
    if (s.classes.has(cls)) continue;
    const paths = [...byPath.keys()].join(", ");
    problems.push({ code: "unknown_class", message: `Field${byPath.size > 1 ? "s" : ""} ${paths} appl${byPath.size > 1 ? "y" : "ies"} to class ${cls}, which does not exist.` });
  }
  for (const rel of s.relationships.values()) {
    for (const end of [rel.from, rel.to]) {
      if (end === "any") continue;
      for (const cls of end) if (!s.classes.has(cls)) problems.push({ code: "unknown_class", message: `Relationship ${rel.id} names class ${cls}, which does not exist.` });
    }
  }
  for (const [id, { provider, resolve }] of s.resolvers) {
    const rel = s.relationships.get(id);
    if (!rel) problems.push({ code: "unknown_relationship", message: `Provider ${provider} resolves relationship ${id}, which is not declared.` });
    // A registry extended from one that already attached this resolver carries it on the relationship too.
    else if (rel.resolve && rel.resolve !== resolve) problems.push({ code: "duplicate_relationship", message: `Relationship ${id} has two resolvers (${describeSource(rel.source)} and provider ${provider}).` });
  }
  return problems;
}

/** FNV-1a, 52 bits: a short deterministic fingerprint (a cache key, not a security hash). */
function fingerprintOf(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x050c5d1f;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x01000193 ^ 0x5bd1e995) >>> 0;
  }
  return `reg-${h1.toString(16).padStart(8, "0")}${(h2 & 0xfffff).toString(16).padStart(5, "0")}`;
}

class FrozenRegistry implements Registry {
  private fingerprintMemo: string | undefined;
  private readonly children = new Map<ClassId, ClassId[]>();
  private readonly ancestorCache = new Map<ClassId, readonly ClassId[]>();
  private readonly descendantCache = new Map<ClassId, readonly ClassId[]>();
  private readonly fieldCache = new Map<ClassId, readonly FieldDef[]>();
  private readonly relationshipsByClass = new Map<ClassId, readonly RelationshipDef[]>();
  private readonly relationshipsList: readonly RelationshipDef[];

  constructor(
    private readonly state: State,
    private readonly opts: RegistryOptions,
  ) {
    for (const [id, attached] of state.resolvers) {
      const rel = state.relationships.get(id);
      if (rel) state.relationships.set(id, { ...rel, resolve: attached.resolve });
    }
    for (const cls of state.classes.values()) {
      if (cls.parent === undefined) continue;
      const list = this.children.get(cls.parent);
      if (list) list.push(cls.id);
      else this.children.set(cls.parent, [cls.id]);
    }
    this.relationshipsList = [...state.relationships.values()];
  }

  /** Hashed on first read: building a registry (every library layer extends one) never pays for hashing it. */
  get fingerprint(): string {
    this.fingerprintMemo ??= fingerprintOf(
      canonicalJson({
        classes: [...this.state.classes.values()],
        fields: [...this.state.fields].map(([cls, byPath]) => [cls, [...byPath.values()].map(({ read, ...decl }) => ({ ...decl, read: read !== undefined }))]),
        relationships: this.relationshipsList.map(({ resolve, ...decl }) => ({ ...decl, resolve: resolve !== undefined })),
      }),
    );
    return this.fingerprintMemo;
  }

  listClasses(filter: ClassFilter = {}): readonly ObjectClass[] {
    const out: ObjectClass[] = [];
    for (const cls of this.state.classes.values()) {
      if (cls.abstract && !filter.includeAbstract) continue;
      if (filter.discipline !== undefined && cls.discipline !== filter.discipline) continue;
      out.push(cls);
    }
    return out;
  }

  getClass(id: ClassId): ObjectClass | undefined {
    return this.state.classes.get(id);
  }

  ancestors(id: ClassId): readonly ClassId[] {
    const cached = this.ancestorCache.get(id);
    if (cached) return cached;
    const out: ClassId[] = [];
    let at: ClassId | undefined = id;
    while (at !== undefined && this.state.classes.has(at)) {
      out.push(at);
      at = this.state.classes.get(at)?.parent;
    }
    this.ancestorCache.set(id, out);
    return out;
  }

  descendants(id: ClassId): readonly ClassId[] {
    const cached = this.descendantCache.get(id);
    if (cached) return cached;
    const out: ClassId[] = [];
    if (this.state.classes.has(id)) {
      const stack = [id];
      while (stack.length > 0) {
        const at = stack.pop();
        if (at === undefined) break;
        out.push(at);
        for (const child of this.children.get(at) ?? []) stack.push(child);
      }
    }
    this.descendantCache.set(id, out);
    return out;
  }

  isA(id: ClassId, ancestor: ClassId): boolean {
    return this.ancestors(id).includes(ancestor);
  }

  fieldsFor(id: ClassId): readonly FieldDef[] {
    const cached = this.fieldCache.get(id);
    if (cached) return cached;
    const byPath = new Map<string, FieldDef>();
    for (const cls of this.ancestors(id)) {
      for (const [path, field] of this.state.fields.get(cls) ?? []) if (!byPath.has(path)) byPath.set(path, field);
    }
    const out = [...byPath.values()];
    this.fieldCache.set(id, out);
    return out;
  }

  field(classId: ClassId, path: string): FieldDef | undefined {
    for (const cls of this.ancestors(classId)) {
      const field = this.state.fields.get(cls)?.get(path);
      if (field) return field;
    }
    return undefined;
  }

  relationship(id: RelationshipId): RelationshipDef | undefined {
    return this.state.relationships.get(id);
  }

  listRelationships(): readonly RelationshipDef[] {
    return this.relationshipsList;
  }

  relationshipsFor(id: ClassId): readonly RelationshipDef[] {
    const cached = this.relationshipsByClass.get(id);
    if (cached) return cached;
    const lineage = this.ancestors(id);
    const out = this.relationshipsList.filter((rel) => rel.from === "any" || rel.from.some((c) => lineage.includes(c)));
    this.relationshipsByClass.set(id, out);
    return out;
  }

  describePath(classId: ClassId, path: string): PathDescription {
    if (!this.state.classes.has(classId)) return { ok: false, message: `There is no class ${classId}.` };
    const segments = path.split(".");
    const steps: RelationshipDef[] = [];
    let at: readonly ClassId[] | "any" = [classId];
    let i = 0;
    for (;;) {
      const rest = segments.slice(i).join(".");
      const field = this.fieldOn(at, rest);
      if (field.kind === "found") return { ok: true, steps, field: field.field, many: steps.some((s) => s.cardinality === "many") };
      if (field.kind === "conflict") return { ok: false, message: field.message };
      const head = segments[i];
      const rel = head === undefined ? undefined : this.state.relationships.get(head);
      const from = at;
      const starts = rel?.from;
      if (rel === undefined || starts === undefined || i >= segments.length - 1 || !(starts === "any" || from === "any" || from.some((c) => this.reaches(c, starts)))) {
        const through = steps.length === 0 ? "" : ` (through ${steps.map((s) => s.id).join(" → ")}, ${at === "any" ? "the elements reached" : at.join(" or ")} ${at === "any" || at.length > 1 ? "have" : "has"} no "${rest}")`;
        return { ok: false, message: `${classId} has no field "${path}"${through}.` };
      }
      steps.push(rel);
      at = rel.to;
      i++;
    }
  }

  extend(): RegistryBuilder {
    return new Builder(copyState(this.state), this.opts);
  }

  /** True when the class is one of `targets` or a subclass of one. */
  private reaches(cls: ClassId, targets: readonly ClassId[]): boolean {
    const lineage = this.ancestors(cls);
    return targets.some((t) => lineage.includes(t));
  }

  private fieldOn(classes: readonly ClassId[] | "any", path: string): { kind: "found"; field: FieldDef } | { kind: "missing" } | { kind: "conflict"; message: string } {
    const candidates = classes === "any" ? [...this.state.classes.keys()] : classes;
    let found: { cls: ClassId; field: FieldDef } | undefined;
    for (const cls of candidates) {
      const field = this.field(cls, path);
      if (!field) continue;
      if (!found) {
        found = { cls, field };
        continue;
      }
      if (found.field.valueType !== field.valueType || found.field.kind !== field.kind || found.field.unit !== field.unit) {
        return { kind: "conflict", message: `"${path}" means different things on ${found.cls} and ${cls}, so it can't be read through this relationship.` };
      }
    }
    return found ? { kind: "found", field: found.field } : { kind: "missing" };
  }
}

/** A class a pack contributes: an `ObjectClass` without `source` (the registry stamps `provider:pack:<namespace>`). */
export type PackClass = Omit<ObjectClass, "source">;

/** The registry source a pack's classes carry. */
export function packClassSource(classId: ClassId): RegistrySource {
  return `provider:pack:${classId.slice(0, Math.max(0, classId.indexOf(".")))}`;
}

const extendedByPackClasses = new WeakMap<Registry, WeakMap<readonly PackClass[], Registry>>();

/**
 * `base` with pack classes added (pure; the same base and list give the
 * same registry object). A class `base` already holds from the same pack is
 * kept as it is, so a host registry that already merged the set's classes
 * passes through. Throws `RegistryError` naming every problem (a class equal
 * to one of `base`'s, an unknown parent).
 */
export function withPackClasses(base: Registry, classes: readonly PackClass[]): Registry {
  if (classes.length === 0) return base;
  let byList = extendedByPackClasses.get(base);
  const hit = byList?.get(classes);
  if (hit) return hit;
  const b = base.extend();
  for (const cls of classes) {
    const source = packClassSource(cls.id);
    if (base.getClass(cls.id)?.source === source) continue;
    b.addClass({ ...cls, source });
  }
  const out = b.build();
  if (!byList) {
    byList = new WeakMap();
    extendedByPackClasses.set(base, byList);
  }
  byList.set(classes, out);
  return out;
}
