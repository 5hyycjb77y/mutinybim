import type { Kind, UnitCode } from "@permitzip/bim-units";
import { EXHAUST_CFM_PARAMS, finite, locked, MAKEUP_AIR_CFM_PARAMS, OUTDOOR_AIR_CFM_PARAMS, resolvedNumber, resolveField, typeParam, type FieldProvider, type FieldReader, type ProviderField } from "@permitzip/bim-kernel";
import { PRESSURIZATION_FIELDS } from "./pressurization";
import { VENDOR_FIELDS } from "./vendor";

/**
 * `own.*`: what an item itself draws (SCHEDULES-PLAN §5d), summed on its own
 * system and never on the systems it serves. Gas input (`own.mbh`) is the gas
 * provider's; electrical load reads the circuit engine through the resolver;
 * nameplate values read the part's parameters by their library names.
 */

const EQUIPMENT = ["mep.equipment"];

/** The first of `names` the part has a number for (instance value, else its type's). */
function firstParam(names: readonly string[]): FieldReader {
  return (el, ctx) => {
    for (const n of names) {
      const v = finite(resolveField(ctx.elements, el.id, `param.${n}`).value);
      if (v !== null) return v;
    }
    return null;
  };
}

const nameplate = (path: string, label: string, kind: Kind, unit: UnitCode, names: readonly string[]): ProviderField => ({
  path,
  label,
  classes: EQUIPMENT,
  valueType: "quantity",
  kind,
  unit,
  writer: typeParam(names[0] as string),
  deps: { elementKinds: ["part", "part_type"] },
  group: "Own load",
  read: firstParam(names),
});

export const MECHANICAL_FIELD_PROVIDER: FieldProvider = {
  id: "mep.mechanical",
  fields: [
    {
      path: "own.va",
      label: "Electrical load",
      classes: EQUIPMENT,
      valueType: "quantity",
      kind: "power_apparent",
      unit: "VA",
      writer: locked("Read from its electrical connectors and connection type."),
      deps: { elementKinds: ["part", "part_type", "service_link", "service_catalog"] },
      group: "Own load",
      read: resolvedNumber("load"),
    },
    nameplate("own.hp", "Motor", "power_mechanical", "hp", ["motor_hp", "hp"]),
    nameplate("own.mca", "Minimum circuit ampacity", "current", "A", ["mca"]),
    nameplate("own.mocp", "Maximum overcurrent protection", "current", "A", ["mocp"]),
    nameplate("own.cfm", "Supply airflow", "flow_air", "cfm", ["supply_cfm", "airflow", "supply_airflow"]),
    nameplate("own.gpm", "Design flow", "flow_liquid", "gpm", ["gpm", "flow_gpm"]),
    // What the part moves into or out of the building (balance/pressurization.ts reads the same names).
    nameplate("own.exhaust_cfm", "Exhaust airflow", "flow_air", "cfm", EXHAUST_CFM_PARAMS),
    nameplate("own.makeup_air_cfm", "Makeup airflow", "flow_air", "cfm", MAKEUP_AIR_CFM_PARAMS),
    nameplate("own.outdoor_cfm", "Outdoor airflow", "flow_air", "cfm", OUTDOOR_AIR_CFM_PARAMS),
    ...PRESSURIZATION_FIELDS,
    ...VENDOR_FIELDS,
  ],
};
