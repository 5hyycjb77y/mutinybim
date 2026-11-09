import { BASELINE_PARAMETER_SETS } from "@permitzip/bim-library";
import type { ParameterIfc, Registry } from "@permitzip/bim-kernel";
import { $, list, real, str, typed, type StepGraph, type StepRef, type StepValue } from "./step";
import { measureOf, type UnitSet } from "./units";

/**
 * Where each parameter goes in IFC (KERNEL-FOUNDATION §3.2): the registry's
 * own fields with an `ifc` home (built-in, firm, project and pack fields),
 * then the built-in baseline parameter sets. A parameter with no home is
 * written in `MutinyBIM_Parameters`, never under a reserved `Pset_`/`Qto_`
 * name of our own.
 */

export interface ParameterHome {
  /** The parameter key (`elec.voltage`, `load.dfu`, `firm:acme.hood_id`). */
  readonly key: string;
  /** Other keys naming the same parameter (`param.voltage`). */
  readonly aliases?: readonly string[];
  readonly ifc: ParameterIfc;
}

export const UNMAPPED_PARAMETER_SET = "MutinyBIM_Parameters";

export class ParameterHomes {
  private readonly byKey = new Map<string, ParameterIfc>();

  constructor(homes: readonly ParameterHome[]) {
    for (const h of homes) {
      for (const k of [h.key, ...(h.aliases ?? [])]) {
        if (!this.byKey.has(k)) this.byKey.set(k, h.ifc);
      }
    }
  }

  /** The home of the first key that has one. */
  find(keys: readonly string[]): ParameterIfc | null {
    for (const k of keys) {
      const home = this.byKey.get(k);
      if (home) return home;
    }
    return null;
  }
}

/** Every registry field that names an IFC home, under its key, its aliases and the part parameter it is stored as. */
export function registryParameterHomes(registry: Registry): ParameterHome[] {
  const out: ParameterHome[] = [];
  const seen = new Set<string>();
  for (const cls of registry.listClasses({ includeAbstract: true })) {
    for (const f of registry.fieldsFor(cls.id)) {
      if (!f.ifc || seen.has(`${cls.id}|${f.path}`)) continue;
      seen.add(`${cls.id}|${f.path}`);
      const stored = f.writer.kind === "parameter" ? [`param.${f.writer.name}`] : [];
      out.push({ key: f.key ?? f.path, aliases: [f.path, ...(f.aliases ?? []), ...stored], ifc: f.ifc });
    }
  }
  return out;
}

/** The built-in baseline sets' homes (bim-library), under each parameter's key and its stored part parameter. */
export function baselineParameterHomes(): ParameterHome[] {
  return BASELINE_PARAMETER_SETS.flatMap((set) => [
    ...set.parameters.map((p) => ({ key: p.field.key, aliases: p.field.storage.kind === "parameter" ? [`param.${p.field.storage.name}`] : [], ifc: p.ifc })),
    ...set.provided.map((p) => ({ key: p.key, ifc: p.ifc })),
  ]);
}

/** One value on its way to a property or quantity set. */
export type PropertyInput =
  | { readonly kind: "number"; readonly name: string; readonly value: number; readonly unit?: string }
  | { readonly kind: "text"; readonly name: string; readonly value: string }
  | { readonly kind: "bool"; readonly name: string; readonly value: boolean };

/** Values grouped by the set they land in, for one object. */
export class PropertyBag {
  readonly psets = new Map<string, Map<string, PropertyInput>>();
  readonly qtos = new Map<string, Map<string, PropertyInput & { readonly kind: "number" }>>();

  /** Put a value in its home, or `fallbackSet` under `fallbackName`. A later value of the same set and name wins. */
  put(home: ParameterIfc | null, input: PropertyInput, fallbackSet = UNMAPPED_PARAMETER_SET): void {
    if (home && "qto" in home) {
      if (input.kind !== "number") {
        this.pset(fallbackSet).set(input.name, input);
        return;
      }
      this.qto(home.qto).set(home.quantity, { ...input, name: home.quantity });
      return;
    }
    if (home) this.pset(home.pset).set(home.property, { ...input, name: home.property });
    else this.pset(fallbackSet).set(input.name, input);
  }

  set(setName: string, input: PropertyInput): void {
    this.pset(setName).set(input.name, input);
  }

  quantity(setName: string, input: PropertyInput & { readonly kind: "number" }): void {
    this.qto(setName).set(input.name, input);
  }

  get empty(): boolean {
    return this.psets.size === 0 && this.qtos.size === 0;
  }

  private pset(name: string): Map<string, PropertyInput> {
    let m = this.psets.get(name);
    if (!m) this.psets.set(name, (m = new Map()));
    return m;
  }

  private qto(name: string): Map<string, PropertyInput & { readonly kind: "number" }> {
    let m = this.qtos.get(name);
    if (!m) this.qtos.set(name, (m = new Map()));
    return m;
  }
}

const LABEL_MAX = 255;

function nominal(units: UnitSet, input: PropertyInput): StepValue {
  switch (input.kind) {
    case "number": {
      const m = measureOf(input.value, input.unit);
      units.note(m.unitType);
      return typed(m.measure, real(m.value));
    }
    case "bool":
      return typed("IFCBOOLEAN", { bool: input.value });
    case "text":
      return input.value.length <= LABEL_MAX ? typed("IFCLABEL", str(input.value)) : typed("IFCTEXT", str(input.value));
  }
}

const QUANTITY_OF_MEASURE: Readonly<Record<string, { readonly entity: string }>> = {
  IFCLENGTHMEASURE: { entity: "IFCQUANTITYLENGTH" },
  IFCAREAMEASURE: { entity: "IFCQUANTITYAREA" },
  IFCVOLUMEMEASURE: { entity: "IFCQUANTITYVOLUME" },
  IFCMASSMEASURE: { entity: "IFCQUANTITYWEIGHT" },
  IFCCOUNTMEASURE: { entity: "IFCQUANTITYCOUNT" },
  IFCTIMEMEASURE: { entity: "IFCQUANTITYTIME" },
};

function quantityEntity(g: StepGraph, units: UnitSet, q: PropertyInput & { readonly kind: "number" }): StepRef {
  const m = measureOf(q.value, q.unit);
  const known = QUANTITY_OF_MEASURE[m.measure];
  if (known) {
    units.note(m.unitType);
    return g.add(known.entity, [str(q.name), $, $, real(m.value), $]);
  }
  // IfcQuantityNumber (new in 4.3): a code's own units (fixture units) and any other number, in the project unit of its type.
  units.note(m.unitType);
  return g.add("IFCQUANTITYNUMBER", [str(q.name), $, $, real(m.value), $]);
}

export interface WrittenSet {
  readonly name: string;
  readonly ref: StepRef;
}

/** Write a bag's property and quantity sets, sorted by name, each property sorted by name. `guidOf` names each set's GlobalId. */
export function writeSets(g: StepGraph, units: UnitSet, bag: PropertyBag, guidOf: (setName: string) => string): WrittenSet[] {
  const out: WrittenSet[] = [];
  for (const [name, props] of [...bag.psets].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const items = [...props.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map((p) => g.add("IFCPROPERTYSINGLEVALUE", [str(p.name), $, nominal(units, p), $]));
    out.push({ name, ref: g.add("IFCPROPERTYSET", [str(guidOf(name)), $, str(name), $, list(items)]) });
  }
  for (const [name, qs] of [...bag.qtos].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const items = [...qs.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map((q) => quantityEntity(g, units, q));
    out.push({ name, ref: g.add("IFCELEMENTQUANTITY", [str(guidOf(name)), $, str(name), $, $, list(items)]) });
  }
  return out;
}
