import { activePackSet, defineExtensionPoint } from "@permitzip/bim-kernel/packs";
import { CalcRegistry, type RegisteredCalc } from "./registry";

export * from "./types";
export * from "./units";
export * from "./density";
export * from "./registry";
export * from "./packs/nec/pack";
export * from "./packs/nec/sizes";
export * as necTables from "./packs/nec/tables";
export type { ConduitSize, ConduitType, DemandStep, InsulationType, LightingOccupancy, MotorOcpdDevice, Table9Raceway, TableSource, TempColumns } from "./packs/nec/tables";
export { CONDUIT_TABLE9_RACEWAY, INSULATION_TEMP_C } from "./packs/nec/tables";
export * from "./packs/jurisdictions";
export * from "./packs/design-criteria";
export * from "./packs/nec/receptacle-placement";
export * from "./packs/nec/receptacle-rules";
export * from "./packs/ipc/pack";
export * as ipcTables from "./packs/ipc/tables";
export * from "./packs/ifgc/pack";
export * from "./packs/code-library/types";
export * from "./packs/code-library/gas-table";
export * from "./packs/code-library/proposal";
export * from "./loads/source-load";
export { VFGC_2021_GAS_TABLES, VFGC_2021_TABLE_INDEX } from "./packs/code-library/vfgc-2021-snapshot";
const BUILTIN_CALCS: readonly RegisteredCalc[] = [];

/** Calcs (v1). A pack's ids are `<pack>.<name>` and its `domain` is open; preview calcs are not built-in rows. */
export const CALC_POINT = defineExtensionPoint<RegisteredCalc>({
  id: "calc.calc",
  version: 1,
  label: "Calculations",
  idOf: (calc) => calc.info.id,
  builtins: () => BUILTIN_CALCS,
});

const CALC_DOMAIN_OWNER: Readonly<Record<string, string>> = { electrical: "electrical" };

/** The first-party pack a built-in calc belongs to (by its domain), for listing; null for a pack's own. */
export function calcOwner(calc: RegisteredCalc): string | null {
  return BUILTIN_CALCS.includes(calc) ? (CALC_DOMAIN_OWNER[calc.info.domain] ?? null) : null;
}

/** Preview calcs (v1): a calc still being checked, offered only to a registry asked for previews, never listed by default. */
export const PREVIEW_CALC_POINT = defineExtensionPoint<RegisteredCalc>({
  id: "calc.preview_calc",
  version: 1,
  label: "Preview calculations",
  idOf: (calc) => calc.info.id,
});

/**
 * Every built-in calc; preview calcs only when asked for. The calcs of the
 * pack set in force are offered too (`CALC_POINT`): the first-party add-ons'
 * under every set, then a model's packs.
 */
export function builtinCalcRegistry(options: { readonly preview?: boolean } = {}): CalcRegistry {
  const registry = new CalcRegistry({ packPoint: CALC_POINT });
  for (const calc of [...BUILTIN_CALCS, ...(options.preview ? activePackSet().items(PREVIEW_CALC_POINT) : [])]) registry.register(calc);
  return registry;
}
