import type { Kind, UnitCode } from "@permitzip/bim-units";
import { finite, resolveField, textOrNull, typeParam, type FieldReader, type ProviderField } from "@permitzip/bim-kernel";

/**
 * Vendor data on mechanical equipment and air devices (round 15, the product owner's
 * answer 3): manufacturer and model, capacity, operating weight, curb size,
 * service clearance and the sequence of operation, as fields with typed
 * units so the equipment schedule prints them and Properties edits them.
 * Each reads the part's parameter by its library names (instance value, else
 * its type's) and writes the first name on the type: one vendor model, one
 * value. Reading them off cut-sheet pictures is round 16.
 *
 * Spread into the mechanical provider (no registration of its own).
 */

const EQUIPMENT = ["mep.mechanical_equipment"];
const DEVICES_AND_EQUIPMENT = ["mep.mechanical_equipment", "mep.air_terminal"];
const GROUP = "Vendor data";
const DEPS = { elementKinds: ["part", "part_type"] } as const;

function firstNumber(names: readonly string[]): FieldReader {
  return (el, ctx) => {
    for (const n of names) {
      const v = finite(resolveField(ctx.elements, el.id, `param.${n}`).value);
      if (v !== null) return v;
    }
    return null;
  };
}

function firstText(names: readonly string[]): FieldReader {
  return (el, ctx) => {
    for (const n of names) {
      const r = resolveField(ctx.elements, el.id, `param.${n}`);
      const v = typeof r.value === "string" ? r.value : r.text;
      const t = textOrNull(v);
      if (t !== null) return t;
    }
    return null;
  };
}

const quantity = (path: string, label: string, kind: Kind, unit: UnitCode, names: readonly [string, ...string[]], classes: readonly string[] = EQUIPMENT): ProviderField => ({
  path,
  label,
  classes,
  valueType: "quantity",
  kind,
  unit,
  writer: typeParam(names[0]),
  deps: DEPS,
  group: GROUP,
  read: firstNumber(names),
});

const text = (path: string, label: string, names: readonly [string, ...string[]], classes: readonly string[] = EQUIPMENT): ProviderField => ({
  path,
  label,
  classes,
  valueType: "text",
  writer: typeParam(names[0]),
  deps: DEPS,
  group: GROUP,
  read: firstText(names),
});

/** The library parameter names each vendor field reads, first one written. Stored names: never rename one. */
export const VENDOR_PARAM_NAMES = {
  manufacturer: ["manufacturer"],
  model: ["model", "model_number"],
  cooling: ["cooling_tons", "tons"],
  heating: ["heating_mbh", "heat_output_mbh"],
  weight: ["operating_weight", "weight"],
  curb: ["curb_size"],
  clearance: ["service_clearance"],
  sequence: ["sequence_of_operation"],
} as const satisfies Readonly<Record<string, readonly [string, ...string[]]>>;

const N = VENDOR_PARAM_NAMES;

export const VENDOR_FIELDS: readonly ProviderField[] = [
  text("vendor.manufacturer", "Manufacturer", N.manufacturer, DEVICES_AND_EQUIPMENT),
  text("vendor.model", "Model", N.model, DEVICES_AND_EQUIPMENT),
  quantity("own.cooling_capacity", "Cooling capacity", "thermal_power", "ton_r", N.cooling),
  quantity("own.heating_capacity", "Heating capacity", "thermal_power", "MBH", N.heating),
  quantity("own.weight", "Operating weight", "mass", "lb", N.weight),
  text("vendor.curb_size", "Curb size", N.curb),
  // Lengths on a part are stored in millimetres, as every length parameter is.
  quantity("vendor.service_clearance", "Service clearance", "length", "mm", N.clearance),
  text("vendor.sequence_of_operation", "Sequence of operation", N.sequence),
];
