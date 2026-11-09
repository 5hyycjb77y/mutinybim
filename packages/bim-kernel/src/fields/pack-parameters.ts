import { defineExtensionPoint } from "../packs/contract";
import { activePackSet } from "../packs/scope";
import type { PackSet } from "../packs/set";
import { CLASS_POINT, firstPartyClasses, packClassSource } from "../registry/index";
import type { ClassId, FieldDef, FieldReader, ParameterIfc, Registry, RegistryBuilder } from "../registry/types";
import type { Kind, UnitCode } from "../registry/units";
import type { BimElement } from "../types";

/**
 * Parameters a pack declares (KERNEL-FOUNDATION §3.2): one set of parameter
 * definitions joins the field registry the Inspector, schedules and agent
 * tools read, the same way the baseline parameter sets do. A pack parameter's
 * value lives in the element's `values` under its key (`ElementCore.values`,
 * written by `set_element_values`), in the parameter's own `unit`.
 */
export interface PackParameter {
  /** `<pack>.<name>` (`struct.section`, `civil.invert_elevation`). */
  readonly key: string;
  readonly label: string;
  /** Classes it applies to (and their subclasses): the pack's own or built-in ones. */
  readonly classes: readonly ClassId[];
  readonly valueType: "quantity" | "text" | "boolean" | "choice";
  /** A bim-units kind; required for quantities. */
  readonly kind?: Kind;
  /** The unit values are typed, shown and stored in; required for quantities, and a unit of `kind`. */
  readonly unit?: UnitCode;
  readonly choices?: readonly string[];
  /** The facet it reads under in the Inspector ("Structural"). */
  readonly group?: string;
  readonly description?: string;
  /** Its IFC 4.3 home (a `Pset_*Common` property, or the pack's own set). */
  readonly ifc?: ParameterIfc;
}

export interface PackParameterSet {
  /** `<pack>.<name>` ("struct.framing"). */
  readonly id: string;
  readonly label: string;
  readonly parameters: readonly PackParameter[];
}

/** Parameter sets (v1). Every parameter key is `<pack>.<name>`, checked by the pack conformance suite. */
export const PARAMETER_SET_POINT = defineExtensionPoint<PackParameterSet>({
  id: "kernel.parameter_set",
  version: 1,
  label: "Parameter sets",
  idOf: (set) => set.id,
  builtins: () => [],
});

function storedValue(el: BimElement, key: string): unknown {
  if (!("values" in el)) return undefined;
  const values: unknown = el.values;
  if (typeof values !== "object" || values === null) return undefined;
  // Any non-null object read by one own key; the reader checks the value's type.
  return (values as Readonly<Record<string, unknown>>)[key];
}

function readerOf(p: PackParameter): FieldReader {
  return (el) => {
    const v = storedValue(el, p.key);
    if (v === undefined || v === null) return null;
    if (p.valueType === "quantity") return typeof v === "number" && Number.isFinite(v) ? v : null;
    if (p.valueType === "boolean") return typeof v === "boolean" ? v : null;
    return typeof v === "boolean" ? (v ? "Yes" : "No") : String(v);
  };
}

/** A pack parameter as a registry field: read from `values[key]`, written with `set_element_values`. */
export function packParameterField(p: PackParameter): Omit<FieldDef, "source"> {
  return {
    path: p.key,
    key: p.key,
    label: p.label,
    classes: p.classes,
    valueType: p.valueType,
    ...(p.kind !== undefined ? { kind: p.kind } : {}),
    ...(p.unit !== undefined ? { unit: p.unit, storedUnit: p.unit } : {}),
    ...(p.choices !== undefined ? { choices: p.choices } : {}),
    ...(p.group !== undefined ? { group: p.group } : {}),
    ...(p.description !== undefined ? { description: p.description } : {}),
    ...(p.ifc !== undefined ? { ifc: p.ifc } : {}),
    binding: "instance",
    writer: { kind: "command", command: "set_element_values", argument: p.key },
    read: readerOf(p),
  };
}

const merged = new WeakMap<PackSet, WeakMap<Registry, Registry>>();

/**
 * Adds a pack set's classes and parameters to `b` in one pass, the way
 * `withPackClasses` and the parameter layer did one after the other: a class
 * `base` already holds from the same pack is kept as it is, a pack class equal
 * to a built-in one is refused (`set.items`), and every parameter joins as a
 * registry field. Returns false when the set adds neither (nothing was added).
 */
export function addPackClassesAndParameters(b: RegistryBuilder, base: Pick<Registry, "getClass"> & Partial<Pick<Registry, "field">>, set: PackSet = activePackSet()): boolean {
  const sets = set.packItems(PARAMETER_SET_POINT);
  const classes = set.packItems(CLASS_POINT);
  if (sets.length === 0 && classes.length === 0) return false;
  if (classes.length > 0) {
    // Refuses a pack class equal to a built-in one before the build reports it in registry words.
    set.items(CLASS_POINT);
    const installed = new Set(firstPartyClasses());
    for (const cls of classes) {
      const source = packClassSource(cls.id);
      if (base.getClass(cls.id)?.source === source || installed.has(cls)) continue;
      b.addClass({ ...cls, source });
    }
  }
  for (const s of sets) {
    const source = `provider:pack:${s.id.slice(0, Math.max(0, s.id.indexOf(".")))}` as const;
    for (const p of s.parameters) {
      // A base that already carries this set (the installed first-party add-ons') keeps it.
      if (p.classes.length > 0 && p.classes.every((c) => base.field?.(c, p.key)?.source === source)) continue;
      b.addField({ ...packParameterField(p), source });
    }
  }
  return true;
}

/**
 * `base` with the pack set's classes and parameters joined (pure, cached per
 * set and base): `base` itself when the set adds neither. One builder pass and
 * one build, whatever the set adds. Throws `RegistryError` naming every
 * problem (a parameter on a class nobody defines, a quantity whose unit isn't
 * one of its kind).
 */
export function withPackParameters(base: Registry, set: PackSet = activePackSet()): Registry {
  if (set.packItems(PARAMETER_SET_POINT).length === 0 && set.packItems(CLASS_POINT).length === 0) return base;
  let byBase = merged.get(set);
  const hit = byBase?.get(base);
  if (hit) return hit;
  const b = base.extend();
  addPackClassesAndParameters(b, base, set);
  const out = b.build();
  if (!byBase) {
    byBase = new WeakMap();
    merged.set(set, byBase);
  }
  byBase.set(base, out);
  return out;
}
