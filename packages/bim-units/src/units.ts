import { dim, DIMENSIONLESS } from "./dimension";
import type { Dimension, IfcUnitRef, IfcUnitType, UnitCode, UnitDefinition } from "./types";

/**
 * Every built-in unit with its factor to coherent SI. Factors are exact
 * definitions where one exists (international foot, avoirdupois pound, US
 * gallon, IT Btu); inch of water is the conventional 4 °C value UCUM uses
 * (249.0889 Pa) and inch of mercury the conventional 3386.389 Pa.
 */

const FT = 0.3048;
const IN = 0.0254;
const LB = 0.45359237;
const LBF = 4.4482216152605;
const PSI = LBF / (IN * IN);
const GAL = 3.785411784e-3;
const FT2 = FT * FT;
const FT3 = FT * FT * FT;
const BTU = 1055.05585262;
const IN_WC = 249.0889;
const BAR = 1e5;

const LENGTH = dim({ L: 1 });
const AREA = dim({ L: 2 });
const VOLUME = dim({ L: 3 });
const SECOND_MOMENT = dim({ L: 4 });
const MASS = dim({ M: 1 });
const TIME = dim({ T: 1 });
const ANGLE = dim({ A: 1 });
const FORCE = dim({ M: 1, L: 1, T: -2 });
const TORQUE = dim({ M: 1, L: 2, T: -2 });
const PRESSURE = dim({ M: 1, L: -1, T: -2 });
const LINE_LOAD = dim({ M: 1, T: -2 });
const DENSITY = dim({ M: 1, L: -3 });
const VELOCITY = dim({ L: 1, T: -1 });
const FLOW = dim({ L: 3, T: -1 });
const MASS_FLOW = dim({ M: 1, T: -1 });
const POWER = dim({ M: 1, L: 2, T: -3 });
const CURRENT = dim({ I: 1 });
const VOLTAGE = dim({ M: 1, L: 2, T: -3, I: -1 });
const RESISTANCE = dim({ M: 1, L: 2, T: -3, I: -2 });
const RESISTANCE_PER_LENGTH = dim({ M: 1, L: 1, T: -3, I: -2 });
const FREQUENCY = dim({ T: -1 });
const TEMPERATURE = dim({ Th: 1 });
const LUMINOUS = dim({ J: 1 });
const ILLUMINANCE = dim({ J: 1, L: -2 });
const K_FACTOR = dim({ L: 3.5, M: -0.5 });
const PRESSURE_GRADIENT = dim({ M: 1, L: -2, T: -2 });
const COUNT = dim({ C: 1 });
const AREA_PER_COUNT = dim({ L: 2, C: -1 });
const CURRENCY = dim({ $: 1 });
const POWER_PER_AREA = dim({ M: 1, T: -3 });
const FLOW_PER_COUNT = dim({ L: 3, T: -1, C: -1 });

interface Options {
  readonly aliases?: readonly string[];
  readonly ucum?: string;
  readonly ifc?: readonly [IfcUnitType, string];
  readonly offset?: number;
}

function unit(code: UnitCode, label: string, dimension: Dimension, factor: number, symbol: string, options: Options = {}): UnitDefinition {
  const ifc: IfcUnitRef | undefined = options.ifc ? { type: options.ifc[0], name: options.ifc[1] } : undefined;
  return Object.freeze({
    code,
    label,
    dimension,
    factor,
    offset: options.offset ?? 0,
    symbol,
    aliases: Object.freeze([...(options.aliases ?? [])]),
    ...(options.ucum !== undefined ? { ucum: options.ucum } : {}),
    ...(ifc ? { ifc } : {}),
  });
}

const LIST: readonly UnitDefinition[] = [
  unit("1", "Unitless", DIMENSIONLESS, 1, "", { ucum: "1", aliases: ["none", "ratio"] }),
  unit("%", "Percent", DIMENSIONLESS, 0.01, "%", { ucum: "%", aliases: ["pct", "percent"] }),
  unit("in/ft", "Inches per foot", DIMENSIONLESS, 1 / 12, "in/ft", { aliases: ["in per ft", "\"/ft", "in_per_ft"] }),
  unit("ea", "Each", COUNT, 1, "ea", { ucum: "{each}", ifc: ["COUNTUNIT", "EACH"], aliases: ["EA", "each", "count", "no."] }),
  unit("ls", "Lump sum", COUNT, 1, "LS", { aliases: ["LS", "lump sum"] }),
  unit("occ", "Occupants", COUNT, 1, "occ", { aliases: ["occupants", "persons", "people"] }),

  unit("m", "Metres", LENGTH, 1, "m", { ucum: "m", ifc: ["LENGTHUNIT", "METRE"], aliases: ["meter", "meters", "metre", "metres"] }),
  unit("mm", "Millimetres", LENGTH, 1e-3, "mm", { ucum: "mm", ifc: ["LENGTHUNIT", "MILLI METRE"], aliases: ["millimeter", "millimeters", "millimetre", "millimetres"] }),
  unit("cm", "Centimetres", LENGTH, 1e-2, "cm", { ucum: "cm", ifc: ["LENGTHUNIT", "CENTI METRE"] }),
  unit("km", "Kilometres", LENGTH, 1e3, "km", { ucum: "km", ifc: ["LENGTHUNIT", "KILO METRE"] }),
  unit("in", "Inches", LENGTH, IN, "in", { ucum: "[in_i]", ifc: ["LENGTHUNIT", "INCH"], aliases: ["\"", "inch", "inches", "in."] }),
  unit("ft", "Feet", LENGTH, FT, "ft", { ucum: "[ft_i]", ifc: ["LENGTHUNIT", "FOOT"], aliases: ["'", "foot", "feet", "ft."] }),
  unit("yd", "Yards", LENGTH, 0.9144, "yd", { ucum: "[yd_i]", ifc: ["LENGTHUNIT", "YARD"], aliases: ["yard", "yards"] }),
  unit("mi", "Miles", LENGTH, 1609.344, "mi", { ucum: "[mi_i]", ifc: ["LENGTHUNIT", "MILE"], aliases: ["mile", "miles"] }),

  unit("m2", "Square metres", AREA, 1, "m²", { ucum: "m2", ifc: ["AREAUNIT", "SQUARE_METRE"], aliases: ["m^2", "m²", "sq m", "sqm"] }),
  unit("mm2", "Square millimetres", AREA, 1e-6, "mm²", { ucum: "mm2", ifc: ["AREAUNIT", "MILLI SQUARE_METRE"], aliases: ["mm^2", "mm²"] }),
  unit("cm2", "Square centimetres", AREA, 1e-4, "cm²", { ucum: "cm2", aliases: ["cm^2", "cm²"] }),
  unit("ha", "Hectares", AREA, 1e4, "ha", { ucum: "har", aliases: ["hectare", "hectares"] }),
  unit("in2", "Square inches", AREA, IN * IN, "in²", { ucum: "[sin_i]", ifc: ["AREAUNIT", "SQUARE INCH"], aliases: ["in^2", "in²", "sq in"] }),
  unit("ft2", "Square feet", AREA, FT2, "ft²", { ucum: "[sft_i]", ifc: ["AREAUNIT", "SQUARE FOOT"], aliases: ["ft^2", "ft²", "sf", "SF", "sq ft", "sqft"] }),
  unit("yd2", "Square yards", AREA, 0.9144 * 0.9144, "yd²", { ucum: "[syd_i]", aliases: ["yd^2", "yd²", "sy", "SY", "sq yd"] }),
  unit("acre", "Acres", AREA, 4046.8564224, "ac", { ifc: ["AREAUNIT", "ACRE"], aliases: ["ac", "acres"] }),
  unit("cmil", "Circular mils", AREA, (Math.PI / 4) * (IN / 1000) ** 2, "cmil", { ucum: "[cml_i]", aliases: ["circular mils"] }),

  unit("m3", "Cubic metres", VOLUME, 1, "m³", { ucum: "m3", ifc: ["VOLUMEUNIT", "CUBIC_METRE"], aliases: ["m^3", "m³", "cu m"] }),
  unit("L", "Litres", VOLUME, 1e-3, "L", { ucum: "L", ifc: ["VOLUMEUNIT", "LITRE"], aliases: ["l", "liter", "liters", "litre", "litres"] }),
  unit("in3", "Cubic inches", VOLUME, IN * IN * IN, "in³", { ucum: "[cin_i]", aliases: ["in^3", "in³", "cu in"] }),
  unit("ft3", "Cubic feet", VOLUME, FT3, "ft³", { ucum: "[cft_i]", ifc: ["VOLUMEUNIT", "CUBIC FOOT"], aliases: ["ft^3", "ft³", "cf", "CF", "cu ft"] }),
  unit("yd3", "Cubic yards", VOLUME, 0.9144 ** 3, "CY", { ucum: "[cyd_i]", ifc: ["VOLUMEUNIT", "CUBIC YARD"], aliases: ["yd^3", "yd³", "cy", "CY", "cu yd"] }),
  unit("gal", "US gallons", VOLUME, GAL, "gal", { ucum: "[gal_us]", ifc: ["VOLUMEUNIT", "US GALLON"], aliases: ["gallon", "gallons", "gals"] }),
  unit("mm3", "Cubic millimetres", VOLUME, 1e-9, "mm³", { ucum: "mm3", aliases: ["mm^3", "mm³"] }),
  unit("cm3", "Cubic centimetres", VOLUME, 1e-6, "cm³", { ucum: "cm3", aliases: ["cm^3", "cm³", "cc"] }),
  unit("mm4", "Millimetres to the fourth", SECOND_MOMENT, 1e-12, "mm⁴", { ucum: "mm4", aliases: ["mm^4", "mm⁴"] }),
  unit("cm4", "Centimetres to the fourth", SECOND_MOMENT, 1e-8, "cm⁴", { ucum: "cm4", aliases: ["cm^4", "cm⁴"] }),
  unit("in4", "Inches to the fourth", SECOND_MOMENT, IN ** 4, "in⁴", { ucum: "[in_i]4", aliases: ["in^4", "in⁴"] }),

  unit("kg", "Kilograms", MASS, 1, "kg", { ucum: "kg", ifc: ["MASSUNIT", "KILO GRAM"] }),
  unit("g", "Grams", MASS, 1e-3, "g", { ucum: "g", ifc: ["MASSUNIT", "GRAM"] }),
  unit("t", "Tonnes", MASS, 1e3, "t", { ucum: "t", ifc: ["MASSUNIT", "TONNE"], aliases: ["tonne", "tonnes"] }),
  unit("lb", "Pounds", MASS, LB, "lb", { ucum: "[lb_av]", ifc: ["MASSUNIT", "POUND"], aliases: ["lbs", "pound", "pounds", "#"] }),

  unit("s", "Seconds", TIME, 1, "s", { ucum: "s", ifc: ["TIMEUNIT", "SECOND"], aliases: ["sec", "second", "seconds"] }),
  unit("min", "Minutes", TIME, 60, "min", { ucum: "min", ifc: ["TIMEUNIT", "MINUTE"], aliases: ["minute", "minutes"] }),
  unit("h", "Hours", TIME, 3600, "hr", { ucum: "h", ifc: ["TIMEUNIT", "HOUR"], aliases: ["hr", "hrs", "hour", "hours"] }),
  unit("d", "Days", TIME, 86400, "d", { ucum: "d", ifc: ["TIMEUNIT", "DAY"], aliases: ["day", "days"] }),
  unit("wk", "Weeks", TIME, 604800, "wk", { ucum: "wk", aliases: ["week", "weeks"] }),

  unit("rad", "Radians", ANGLE, 1, "rad", { ucum: "rad", ifc: ["PLANEANGLEUNIT", "RADIAN"], aliases: ["radian", "radians"] }),
  unit("deg", "Degrees", ANGLE, Math.PI / 180, "°", { ucum: "deg", ifc: ["PLANEANGLEUNIT", "DEGREE"], aliases: ["°", "degree", "degrees"] }),

  unit("N", "Newtons", FORCE, 1, "N", { ucum: "N", ifc: ["FORCEUNIT", "NEWTON"], aliases: ["newton", "newtons"] }),
  unit("kN", "Kilonewtons", FORCE, 1e3, "kN", { ucum: "kN", ifc: ["FORCEUNIT", "KILO NEWTON"] }),
  unit("lbf", "Pounds force", FORCE, LBF, "lbf", { ucum: "[lbf_av]", ifc: ["FORCEUNIT", "POUND-FORCE"], aliases: ["lb-f", "pound force"] }),
  unit("kip", "Kips", FORCE, 1000 * LBF, "kip", { ifc: ["FORCEUNIT", "KIP"], aliases: ["kips", "k"] }),
  unit("N.m", "Newton metres", TORQUE, 1, "N·m", { ucum: "N.m", ifc: ["TORQUEUNIT", "NEWTON METRE"], aliases: ["N·m", "Nm", "N-m"] }),
  unit("kN.m", "Kilonewton metres", TORQUE, 1e3, "kN·m", { ucum: "kN.m", aliases: ["kN·m", "kNm", "kN-m"] }),
  unit("lbf.in", "Pound-force inches", TORQUE, LBF * IN, "lb-in", { ucum: "[lbf_av].[in_i]", aliases: ["lb-in", "in-lb", "lbf-in"] }),
  unit("lbf.ft", "Pound-force feet", TORQUE, LBF * FT, "lb-ft", { ucum: "[lbf_av].[ft_i]", aliases: ["lb-ft", "ft-lb", "lbf-ft"] }),
  unit("kip.in", "Kip inches", TORQUE, 1000 * LBF * IN, "kip-in", { aliases: ["kip-in", "k-in", "in-kip"] }),
  unit("kip.ft", "Kip feet", TORQUE, 1000 * LBF * FT, "kip-ft", { aliases: ["kip-ft", "k-ft", "ft-kip"] }),

  unit("Pa", "Pascals", PRESSURE, 1, "Pa", { ucum: "Pa", ifc: ["PRESSUREUNIT", "PASCAL"], aliases: ["pascal", "pascals"] }),
  unit("kPa", "Kilopascals", PRESSURE, 1e3, "kPa", { ucum: "kPa", ifc: ["PRESSUREUNIT", "KILO PASCAL"], aliases: ["kN/m2", "kN/m²"] }),
  unit("MPa", "Megapascals", PRESSURE, 1e6, "MPa", { ucum: "MPa", ifc: ["PRESSUREUNIT", "MEGA PASCAL"], aliases: ["N/mm2", "N/mm²"] }),
  unit("bar", "Bar", PRESSURE, BAR, "bar", { ucum: "bar", ifc: ["PRESSUREUNIT", "BAR"] }),
  unit("psi", "Pounds per square inch", PRESSURE, PSI, "psi", { ucum: "[psi]", ifc: ["PRESSUREUNIT", "PSI"], aliases: ["PSI", "psig", "lb/in2"] }),
  unit("ksi", "Kips per square inch", PRESSURE, 1000 * PSI, "ksi", { aliases: ["KSI"] }),
  unit("psf", "Pounds per square foot", PRESSURE, LBF / FT2, "psf", { aliases: ["PSF", "lb/ft2", "lb/sf"] }),
  unit("ksf", "Kips per square foot", PRESSURE, (1000 * LBF) / FT2, "ksf", { aliases: ["KSF"] }),
  unit("in_wc", "Inches of water column", PRESSURE, IN_WC, "in. w.c.", { ucum: "[in_i'H2O]", aliases: ["in w.c.", "in. w.c.", "in wc", "in. wc", "inwc", "\"wc", "\" w.c.", "inH2O", "in_wc_gas"] }),
  unit("ft_wc", "Feet of water column", PRESSURE, 12 * IN_WC, "ft w.c.", { aliases: ["ft w.c.", "ft wc", "ft hd", "ft head", "ftH2O"] }),
  unit("inHg", "Inches of mercury", PRESSURE, 3386.389, "in. Hg", { ucum: "[in_i'Hg]", aliases: ["in Hg", "in. Hg", "\"Hg"] }),
  unit("N/m", "Newtons per metre", LINE_LOAD, 1, "N/m", { ucum: "N/m", ifc: ["LINEARFORCEUNIT", "NEWTON PER METRE"] }),
  unit("kN/m", "Kilonewtons per metre", LINE_LOAD, 1e3, "kN/m", { ucum: "kN/m" }),
  unit("plf", "Pounds per linear foot", LINE_LOAD, LBF / FT, "plf", { aliases: ["PLF", "lb/ft", "lb/lf"] }),
  unit("klf", "Kips per linear foot", LINE_LOAD, (1000 * LBF) / FT, "klf", { aliases: ["KLF", "kip/ft"] }),
  unit("kg/m3", "Kilograms per cubic metre", DENSITY, 1, "kg/m³", { ucum: "kg/m3", ifc: ["MASSDENSITYUNIT", "KILOGRAM PER CUBIC METRE"], aliases: ["kg/m^3", "kg/m³"] }),
  unit("lb/ft3", "Pounds per cubic foot", DENSITY, LB / FT3, "pcf", { aliases: ["pcf", "PCF", "lb/ft^3", "lb/cf"] }),

  unit("m/s", "Metres per second", VELOCITY, 1, "m/s", { ucum: "m/s", ifc: ["LINEARVELOCITYUNIT", "METRE PER SECOND"] }),
  unit("km/h", "Kilometres per hour", VELOCITY, 1 / 3.6, "km/h", { ucum: "km/h", aliases: ["kph"] }),
  unit("ft/s", "Feet per second", VELOCITY, FT, "fps", { ucum: "[ft_i]/s", aliases: ["fps", "FPS", "ft/sec"] }),
  unit("ft/min", "Feet per minute", VELOCITY, FT / 60, "fpm", { ucum: "[ft_i]/min", aliases: ["fpm", "FPM"] }),
  unit("mph", "Miles per hour", VELOCITY, 1609.344 / 3600, "mph", { ucum: "[mi_i]/h", aliases: ["MPH", "mi/h"] }),

  unit("m3/s", "Cubic metres per second", FLOW, 1, "m³/s", { ucum: "m3/s", ifc: ["VOLUMETRICFLOWRATEUNIT", "CUBIC_METRE PER SECOND"], aliases: ["m^3/s", "m³/s"] }),
  unit("m3/h", "Cubic metres per hour", FLOW, 1 / 3600, "m³/h", { ucum: "m3/h", aliases: ["m^3/h", "m³/h", "cmh"] }),
  unit("L/s", "Litres per second", FLOW, 1e-3, "L/s", { ucum: "L/s", aliases: ["l/s", "lps"] }),
  unit("L/min", "Litres per minute", FLOW, 1e-3 / 60, "L/min", { ucum: "L/min", aliases: ["l/min", "lpm"] }),
  unit("cfm", "Cubic feet per minute", FLOW, FT3 / 60, "CFM", { ucum: "[cft_i]/min", ifc: ["VOLUMETRICFLOWRATEUNIT", "CUBIC FOOT PER MINUTE"], aliases: ["CFM", "ft3/min", "ft³/min"] }),
  unit("cfs", "Cubic feet per second", FLOW, FT3, "cfs", { ucum: "[cft_i]/s", aliases: ["CFS", "ft3/s", "ft³/s"] }),
  unit("gpm", "US gallons per minute", FLOW, GAL / 60, "gpm", { ucum: "[gal_us]/min", ifc: ["VOLUMETRICFLOWRATEUNIT", "US GALLON PER MINUTE"], aliases: ["GPM", "gal/min"] }),
  unit("gph", "US gallons per hour", FLOW, GAL / 3600, "gal/h", { ucum: "[gal_us]/h", aliases: ["GPH", "gal/h", "gal/hr"] }),
  unit("gpd", "US gallons per day", FLOW, GAL / 86400, "gpd", { ucum: "[gal_us]/d", aliases: ["GPD", "gal/d", "gal/day"] }),
  unit("mgd", "Million US gallons per day", FLOW, (1e6 * GAL) / 86400, "MGD", { aliases: ["MGD"] }),
  unit("cfh", "Cubic feet per hour", FLOW, FT3 / 3600, "CFH", { ucum: "[cft_i]/h", aliases: ["CFH", "ft3/h", "ft³/h"] }),
  unit("kg/s", "Kilograms per second", MASS_FLOW, 1, "kg/s", { ucum: "kg/s", ifc: ["MASSFLOWRATEUNIT", "KILOGRAM PER SECOND"] }),
  unit("kg/h", "Kilograms per hour", MASS_FLOW, 1 / 3600, "kg/h", { ucum: "kg/h" }),
  unit("lb/h", "Pounds per hour", MASS_FLOW, LB / 3600, "lb/h", { ucum: "[lb_av]/h", aliases: ["lb/hr", "pph", "PPH"] }),

  unit("W", "Watts", POWER, 1, "W", { ucum: "W", ifc: ["POWERUNIT", "WATT"], aliases: ["w", "watt", "watts"] }),
  unit("kW", "Kilowatts", POWER, 1e3, "kW", { ucum: "kW", ifc: ["POWERUNIT", "KILO WATT"], aliases: ["kw", "KW"] }),
  unit("MW", "Megawatts", POWER, 1e6, "MW", { ucum: "MW", ifc: ["POWERUNIT", "MEGA WATT"] }),
  unit("hp", "Horsepower", POWER, 745.69987158227, "hp", { ucum: "[HP]", ifc: ["POWERUNIT", "HORSEPOWER"], aliases: ["HP", "horsepower"] }),
  unit("VA", "Volt-amperes", POWER, 1, "VA", { ucum: "V.A", aliases: ["va", "V·A"] }),
  unit("kVA", "Kilovolt-amperes", POWER, 1e3, "kVA", { ucum: "kV.A", aliases: ["kva", "KVA"] }),
  unit("MVA", "Megavolt-amperes", POWER, 1e6, "MVA", { ucum: "MV.A" }),
  unit("var", "Volt-amperes reactive", POWER, 1, "var", { aliases: ["VAR", "VAr"] }),
  unit("kvar", "Kilovolt-amperes reactive", POWER, 1e3, "kvar", { aliases: ["kVAR", "KVAR", "kVAr"] }),
  unit("Btu/h", "Btu per hour", POWER, BTU / 3600, "Btu/h", { ucum: "[Btu_IT]/h", ifc: ["POWERUNIT", "BTU PER HOUR"], aliases: ["btuh", "Btuh", "BTUH", "BTU/H", "Btu/hr", "BTU/hr", "btu/h"] }),
  unit("MBH", "Thousand Btu per hour", POWER, (1000 * BTU) / 3600, "MBH", { aliases: ["mbh", "kBtu/h", "kBtuh", "MBtuh"] }),
  unit("ton_r", "Tons of refrigeration", POWER, (12000 * BTU) / 3600, "tons", { aliases: ["tons", "ton", "TR", "RT"] }),
  unit("therm/h", "Therms per hour", POWER, (1e5 * BTU) / 3600, "therm/h", { aliases: ["thm/h", "therms/h"] }),
  unit("J", "Joules", TORQUE, 1, "J", { ucum: "J", ifc: ["ENERGYUNIT", "JOULE"], aliases: ["joule", "joules"] }),
  unit("kJ", "Kilojoules", TORQUE, 1e3, "kJ", { ucum: "kJ", ifc: ["ENERGYUNIT", "KILO JOULE"] }),
  unit("kWh", "Kilowatt-hours", TORQUE, 3.6e6, "kWh", { ucum: "kW.h", aliases: ["kwh", "KWH"] }),
  unit("Btu", "Btu", TORQUE, BTU, "Btu", { ucum: "[Btu_IT]", ifc: ["ENERGYUNIT", "BTU"], aliases: ["BTU", "btu"] }),
  unit("MBtu", "Thousand Btu", TORQUE, 1000 * BTU, "MBtu", { aliases: ["kBtu", "MBTU"] }),
  unit("therm", "Therms", TORQUE, 1e5 * BTU, "therm", { aliases: ["therms", "thm"] }),

  unit("A", "Amperes", CURRENT, 1, "A", { ucum: "A", ifc: ["ELECTRICCURRENTUNIT", "AMPERE"], aliases: ["amp", "amps", "ampere", "amperes"] }),
  unit("mA", "Milliamperes", CURRENT, 1e-3, "mA", { ucum: "mA", ifc: ["ELECTRICCURRENTUNIT", "MILLI AMPERE"] }),
  unit("kA", "Kiloamperes", CURRENT, 1e3, "kA", { ucum: "kA", ifc: ["ELECTRICCURRENTUNIT", "KILO AMPERE"], aliases: ["KA"] }),
  unit("V", "Volts", VOLTAGE, 1, "V", { ucum: "V", ifc: ["ELECTRICVOLTAGEUNIT", "VOLT"], aliases: ["v", "volt", "volts"] }),
  unit("kV", "Kilovolts", VOLTAGE, 1e3, "kV", { ucum: "kV", ifc: ["ELECTRICVOLTAGEUNIT", "KILO VOLT"], aliases: ["kv", "KV"] }),
  unit("ohm", "Ohms", RESISTANCE, 1, "Ω", { ucum: "Ohm", ifc: ["ELECTRICRESISTANCEUNIT", "OHM"], aliases: ["Ω", "ohms", "Ohm"] }),
  unit("ohm/kft", "Ohms per 1,000 ft", RESISTANCE_PER_LENGTH, 1 / (1000 * FT), "Ω/kft", { aliases: ["Ω/kft", "ohm_per_kft", "ohms/kft", "ohm/1000ft"] }),
  unit("ohm/km", "Ohms per kilometre", RESISTANCE_PER_LENGTH, 1e-3, "Ω/km", { ucum: "Ohm/km", aliases: ["Ω/km", "ohms/km"] }),
  unit("Hz", "Hertz", FREQUENCY, 1, "Hz", { ucum: "Hz", ifc: ["FREQUENCYUNIT", "HERTZ"], aliases: ["hz", "hertz"] }),

  unit("K", "Kelvin", TEMPERATURE, 1, "K", { ucum: "K", ifc: ["THERMODYNAMICTEMPERATUREUNIT", "KELVIN"], aliases: ["kelvin"] }),
  unit("degC", "Degrees Celsius", TEMPERATURE, 1, "°C", { offset: 273.15, ucum: "Cel", ifc: ["THERMODYNAMICTEMPERATUREUNIT", "DEGREE_CELSIUS"], aliases: ["°C", "C", "celsius"] }),
  unit("degF", "Degrees Fahrenheit", TEMPERATURE, 5 / 9, "°F", { offset: 273.15 - (32 * 5) / 9, ucum: "[degF]", ifc: ["THERMODYNAMICTEMPERATUREUNIT", "DEGREE FAHRENHEIT"], aliases: ["°F", "F", "fahrenheit"] }),
  unit("delta_degC", "Celsius degrees (difference)", TEMPERATURE, 1, "°C", { aliases: ["Δ°C", "delta °C"] }),
  unit("delta_degF", "Fahrenheit degrees (difference)", TEMPERATURE, 5 / 9, "°F", { aliases: ["Δ°F", "delta °F"] }),

  unit("lm", "Lumens", LUMINOUS, 1, "lm", { ucum: "lm", ifc: ["LUMINOUSFLUXUNIT", "LUMEN"], aliases: ["lumen", "lumens"] }),
  unit("lx", "Lux", ILLUMINANCE, 1, "lx", { ucum: "lx", ifc: ["ILLUMINANCEUNIT", "LUX"], aliases: ["lux"] }),
  unit("fc", "Foot-candles", ILLUMINANCE, 1 / FT2, "fc", { aliases: ["FC", "footcandles", "foot-candles"] }),
  unit("cd", "Candelas", LUMINOUS, 1, "cd", { ucum: "cd", ifc: ["LUMINOUSINTENSITYUNIT", "CANDELA"], aliases: ["candela", "candelas"] }),

  unit("gpm/ft2", "gpm per square foot", VELOCITY, GAL / 60 / FT2, "gpm/ft²", { aliases: ["gpm/sf", "gpm/ft^2", "gpm/ft²"] }),
  unit("mm/min", "Millimetres per minute", VELOCITY, 1e-3 / 60, "mm/min", { ucum: "mm/min", aliases: ["L/min/m2", "L/min·m²"] }),
  unit("gpm/psi^0.5", "gpm per root psi", K_FACTOR, GAL / 60 / Math.sqrt(PSI), "gpm/psi½", { aliases: ["gpm/psi½", "gpm/psi^1/2"] }),
  unit("L/min/bar^0.5", "L/min per root bar", K_FACTOR, 1e-3 / 60 / Math.sqrt(BAR), "L/min/bar½", { aliases: ["L/min/bar½", "lpm/bar^0.5"] }),

  unit("WSFU", "Water supply fixture units", DIMENSIONLESS, 1, "WSFU", { ucum: "{WSFU}", aliases: ["wsfu", "WFU", "SFU"] }),
  unit("DFU", "Drainage fixture units", DIMENSIONLESS, 1, "DFU", { ucum: "{DFU}", aliases: ["dfu"] }),
  unit("in/h", "Inches per hour", VELOCITY, IN / 3600, "in/h", { ucum: "[in_i]/h", aliases: ["in/hr", "iph"] }),
  unit("mm/h", "Millimetres per hour", VELOCITY, 1e-3 / 3600, "mm/h", { ucum: "mm/h", aliases: ["mm/hr"] }),

  unit("Pa/m", "Pascals per metre", PRESSURE_GRADIENT, 1, "Pa/m", { ucum: "Pa/m" }),
  unit("in_wc/100ft", "Inches of water per 100 ft", PRESSURE_GRADIENT, IN_WC / (100 * FT), "in. w.c./100 ft", { aliases: ["in w.c./100 ft", "in. w.c./100 ft", "in wc/100ft", "in_wc_per_100ft"] }),
  unit("ft_wc/100ft", "Feet of head per 100 ft", PRESSURE_GRADIENT, (12 * IN_WC) / (100 * FT), "ft/100 ft", { aliases: ["ft/100ft", "ft/100 ft", "ft hd/100 ft"] }),
  unit("psi/100ft", "psi per 100 ft", PRESSURE_GRADIENT, PSI / (100 * FT), "psi/100 ft", { aliases: ["psi/100 ft", "psi_per_100ft"] }),

  unit("ft2/occ", "Square feet per occupant", AREA_PER_COUNT, FT2, "ft²/occ", { aliases: ["sf/occ", "SF/occ", "sf/person", "ft2/person"] }),
  unit("m2/occ", "Square metres per occupant", AREA_PER_COUNT, 1, "m²/occ", { aliases: ["m2/person"] }),

  unit("USD", "US dollars", CURRENCY, 1, "$", { aliases: ["$", "usd", "dollars"] }),

  unit("W/m2", "Watts per square metre", POWER_PER_AREA, 1, "W/m²", { ucum: "W/m2", aliases: ["W/m²"] }),
  unit("W/ft2", "Watts per square foot", POWER_PER_AREA, 1 / FT2, "W/ft²", { aliases: ["W/sf", "W/SF", "W/ft²", "watts/sf"] }),
  unit("VA/m2", "Volt-amperes per square metre", POWER_PER_AREA, 1, "VA/m²", { aliases: ["VA/m²"] }),
  unit("VA/ft2", "Volt-amperes per square foot", POWER_PER_AREA, 1 / FT2, "VA/ft²", { aliases: ["VA/sf", "VA/SF", "VA/ft²", "va/sf"] }),
  unit("L/s/m2", "Litres per second per square metre", VELOCITY, 1e-3, "L/s·m²", { aliases: ["L/s·m²", "l/s/m2"] }),
  unit("cfm/ft2", "cfm per square foot", VELOCITY, FT3 / 60 / FT2, "cfm/ft²", { aliases: ["cfm/sf", "CFM/SF", "cfm/ft²"] }),
  unit("L/s/occ", "Litres per second per person", FLOW_PER_COUNT, 1e-3, "L/s/person", { aliases: ["L/s/person", "l/s/person"] }),
  unit("cfm/occ", "cfm per person", FLOW_PER_COUNT, FT3 / 60, "cfm/person", { aliases: ["cfm/person", "CFM/person", "cfm/p"] }),
];

export const UNITS: Readonly<Record<UnitCode, UnitDefinition>> = Object.freeze(Object.fromEntries(LIST.map((u) => [u.code, u])) as Record<UnitCode, UnitDefinition>);
