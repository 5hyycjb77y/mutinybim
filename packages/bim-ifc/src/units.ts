import { UNITS, fromSI, isUnitCode, toSI, type IfcUnitRef, type IfcUnitType, type UnitCode } from "@permitzip/bim-units";
import { $, en, int, list, str, type StepGraph, type StepRef, type StepValue } from "./step";

/**
 * Project units from bim-units' IFC unit references. Lengths are written in
 * millimetres (the kernel's own unit, so coordinates cross unchanged); every
 * other unit type in its coherent SI unit. A value written with no explicit
 * unit is in the project unit of its type, so `measureOf` converts a stored
 * number to exactly that unit.
 */

const SI_PREFIXES = new Set(["EXA", "PETA", "TERA", "GIGA", "MEGA", "KILO", "HECTO", "DECA", "DECI", "CENTI", "MILLI", "MICRO", "NANO", "PICO", "FEMTO", "ATTO"]);
const SI_NAMES = new Set([
  "AMPERE", "BECQUEREL", "CANDELA", "COULOMB", "CUBIC_METRE", "DEGREE_CELSIUS", "FARAD", "GRAM", "GRAY", "HENRY", "HERTZ", "JOULE", "KELVIN", "LUMEN", "LUX",
  "METRE", "MOLE", "NEWTON", "OHM", "PASCAL", "RADIAN", "SECOND", "SIEMENS", "SIEVERT", "SQUARE_METRE", "STERADIAN", "TESLA", "VOLT", "WATT", "WEBER",
]);

/** Unit types IfcUnitEnum names (named units); the rest are IfcDerivedUnitEnum. */
const NAMED_UNIT_TYPES = new Set<IfcUnitType>([
  "LENGTHUNIT", "AREAUNIT", "VOLUMEUNIT", "MASSUNIT", "TIMEUNIT", "PLANEANGLEUNIT", "FORCEUNIT", "PRESSUREUNIT", "ENERGYUNIT", "POWERUNIT",
  "ELECTRICCURRENTUNIT", "ELECTRICVOLTAGEUNIT", "ELECTRICRESISTANCEUNIT", "FREQUENCYUNIT", "THERMODYNAMICTEMPERATUREUNIT", "LUMINOUSFLUXUNIT",
  "ILLUMINANCEUNIT", "LUMINOUSINTENSITYUNIT", "COUNTUNIT",
]);

/** The IFC measure type a value of each unit type is written as. */
const MEASURE_OF_UNIT_TYPE: Readonly<Record<IfcUnitType, string>> = {
  LENGTHUNIT: "IFCLENGTHMEASURE",
  AREAUNIT: "IFCAREAMEASURE",
  VOLUMEUNIT: "IFCVOLUMEMEASURE",
  MASSUNIT: "IFCMASSMEASURE",
  TIMEUNIT: "IFCTIMEMEASURE",
  PLANEANGLEUNIT: "IFCPLANEANGLEMEASURE",
  FORCEUNIT: "IFCFORCEMEASURE",
  PRESSUREUNIT: "IFCPRESSUREMEASURE",
  ENERGYUNIT: "IFCENERGYMEASURE",
  POWERUNIT: "IFCPOWERMEASURE",
  ELECTRICCURRENTUNIT: "IFCELECTRICCURRENTMEASURE",
  ELECTRICVOLTAGEUNIT: "IFCELECTRICVOLTAGEMEASURE",
  ELECTRICRESISTANCEUNIT: "IFCELECTRICRESISTANCEMEASURE",
  FREQUENCYUNIT: "IFCFREQUENCYMEASURE",
  THERMODYNAMICTEMPERATUREUNIT: "IFCTHERMODYNAMICTEMPERATUREMEASURE",
  LUMINOUSFLUXUNIT: "IFCLUMINOUSFLUXMEASURE",
  ILLUMINANCEUNIT: "IFCILLUMINANCEMEASURE",
  LUMINOUSINTENSITYUNIT: "IFCLUMINOUSINTENSITYMEASURE",
  COUNTUNIT: "IFCCOUNTMEASURE",
  VOLUMETRICFLOWRATEUNIT: "IFCVOLUMETRICFLOWRATEMEASURE",
  MASSFLOWRATEUNIT: "IFCMASSFLOWRATEMEASURE",
  LINEARVELOCITYUNIT: "IFCLINEARVELOCITYMEASURE",
  MASSDENSITYUNIT: "IFCMASSDENSITYMEASURE",
  TORQUEUNIT: "IFCTORQUEMEASURE",
  LINEARFORCEUNIT: "IFCLINEARFORCEMEASURE",
  PLANARFORCEUNIT: "IFCPLANARFORCEMEASURE",
  TEMPERATUREGRADIENTUNIT: "IFCTEMPERATUREGRADIENTMEASURE",
  USERDEFINED: "IFCREAL",
};

/** A value as written: measure type and number. */
export interface IfcMeasure {
  readonly measure: string;
  readonly value: number;
  /** The unit type it is in, when it has one (the project unit of that type then applies). */
  readonly unitType: IfcUnitType | null;
}

/** The project unit of each unit type: millimetres for length, otherwise the coherent SI unit bim-units lists for it. */
function projectUnitCode(type: IfcUnitType): UnitCode | null {
  if (type === "LENGTHUNIT") return "mm";
  for (const u of Object.values(UNITS)) {
    if (u.ifc?.type === type && u.factor === 1 && u.offset === 0 && !u.ifc.name.includes(" ")) return u.code;
  }
  for (const u of Object.values(UNITS)) {
    if (u.ifc?.type === type && u.factor === 1 && u.offset === 0) return u.code;
  }
  return null;
}

const PROJECT_UNITS = new Map<IfcUnitType, UnitCode | null>();
function cachedProjectUnit(type: IfcUnitType): UnitCode | null {
  if (!PROJECT_UNITS.has(type)) PROJECT_UNITS.set(type, projectUnitCode(type));
  return PROJECT_UNITS.get(type) ?? null;
}

/**
 * A stored number in `storedUnit` as the measure IFC writes. A unit with no
 * IFC reference (fixture units, other counts of a code's own) is written as
 * a plain real with no unit.
 */
export function measureOf(value: number, storedUnit: string | undefined): IfcMeasure {
  if (storedUnit === undefined || !isUnitCode(storedUnit)) return { measure: "IFCREAL", value, unitType: null };
  const ref = UNITS[storedUnit].ifc;
  if (!ref || ref.type === "USERDEFINED") return { measure: "IFCREAL", value, unitType: null };
  const target = cachedProjectUnit(ref.type);
  if (!target) return { measure: "IFCREAL", value, unitType: null };
  return { measure: MEASURE_OF_UNIT_TYPE[ref.type], value: fromSI(toSI(value, storedUnit), target), unitType: ref.type };
}

/** Collects the unit types values were written in, then writes the project's IfcUnitAssignment. */
export class UnitSet {
  private readonly used = new Set<IfcUnitType>(["LENGTHUNIT", "AREAUNIT", "VOLUMEUNIT", "PLANEANGLEUNIT"]);

  note(type: IfcUnitType | null): void {
    if (type) this.used.add(type);
  }

  /** Written last so it covers every value; the project points at it. Order is fixed (unit type name). */
  write(g: StepGraph): StepRef {
    const units: StepValue[] = [];
    for (const type of [...this.used].sort()) {
      const code = cachedProjectUnit(type);
      const ref = code ? UNITS[code].ifc : undefined;
      const unit = ref ? writeUnit(g, ref) : null;
      if (unit) units.push(unit);
    }
    return g.add("IFCUNITASSIGNMENT", [list(units)]);
  }
}

function siUnit(g: StepGraph, type: string, word: string): { readonly ref: StepRef } {
  const space = word.indexOf(" ");
  const prefix = space < 0 ? null : word.slice(0, space);
  const name = space < 0 ? word : word.slice(space + 1);
  return { ref: g.add("IFCSIUNIT", [{ derived: true }, en(type), prefix ? en(prefix) : $, en(name)]) };
}

const SI_UNIT_TYPE: Readonly<Record<string, string>> = {
  METRE: "LENGTHUNIT",
  SQUARE_METRE: "AREAUNIT",
  CUBIC_METRE: "VOLUMEUNIT",
  GRAM: "MASSUNIT",
  SECOND: "TIMEUNIT",
  NEWTON: "FORCEUNIT",
  KELVIN: "THERMODYNAMICTEMPERATUREUNIT",
  WATT: "POWERUNIT",
  JOULE: "ENERGYUNIT",
};

/** "CUBIC_METRE PER SECOND" → its SI factors with exponents; null when a word is not an SI unit. */
function derivedFactors(name: string): Array<{ readonly word: string; readonly base: string; readonly exponent: number }> | null {
  const words = name.split(" ");
  const out: Array<{ word: string; base: string; exponent: number }> = [];
  let sign = 1;
  for (let i = 0; i < words.length; i++) {
    const w = words[i] ?? "";
    if (w === "PER") {
      sign = -1;
      continue;
    }
    // KILOGRAM is the SI name GRAM with the prefix KILO.
    const word = w === "KILOGRAM" ? "KILO GRAM" : SI_PREFIXES.has(w) && SI_NAMES.has(words[i + 1] ?? "") ? `${w} ${words[++i] ?? ""}` : w;
    const base = word.split(" ").pop() ?? word;
    if (!SI_UNIT_TYPE[base]) return null;
    out.push({ word, base, exponent: sign });
  }
  return out.length > 0 ? out : null;
}

/**
 * One project unit: an IfcSIUnit for an SI name with its prefix, an
 * IfcDerivedUnit for "X PER Y" and "X Y" names. Null for a unit type IFC
 * writes without a unit (counts).
 */
function writeUnit(g: StepGraph, ref: IfcUnitRef): StepRef | null {
  const words = ref.name.split(" ");
  const first = words[0] ?? "";
  if (NAMED_UNIT_TYPES.has(ref.type) && (SI_NAMES.has(ref.name) || (words.length === 2 && SI_PREFIXES.has(first) && SI_NAMES.has(words[1] ?? "")))) {
    return siUnit(g, ref.type, ref.name).ref;
  }
  if (NAMED_UNIT_TYPES.has(ref.type)) return null;
  const factors = derivedFactors(ref.name);
  if (!factors) {
    console.error("[bim-ifc] bim-units IFC unit name is not SI; values of this type are written without a unit", { type: ref.type, name: ref.name });
    return null;
  }
  const elements: StepValue[] = factors.map((f) => g.add("IFCDERIVEDUNITELEMENT", [siUnit(g, SI_UNIT_TYPE[f.base] ?? "USERDEFINED", f.word).ref, int(f.exponent)]));
  return g.add("IFCDERIVEDUNIT", [list(elements), en(ref.type), $, str(ref.name)]);
}
