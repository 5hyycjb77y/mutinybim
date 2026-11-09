import { convert, unitAllowed } from "@permitzip/bim-units";
import { builtinRegistry, builtinRegistryBuilder } from "../../registry/builtin";
import { addPackClassesAndParameters } from "../pack-parameters";
import type { RegistryOptions } from "../../registry/registry";
import type { FieldProvider, Registry, RegistryBuilder } from "../../registry/types";
import type { UnitCatalog } from "../../registry/units";
import { defineExtensionPoint } from "../../packs/contract";
import { activePackSet } from "../../packs/scope";
import type { PackSet } from "../../packs/set";
import { LOADS_FIELD_PROVIDER } from "./loads";
import { PLACEMENT_FIELD_PROVIDER } from "./placement";
import { SERVES_PROVIDER } from "./serves";
import { baseFieldProvider, SPATIAL_FIELD_PROVIDER } from "./spatial";
import { withQtoFieldProvider } from "../../qto/fields";

export * from "./support";
export { LOADS_FIELD_PROVIDER, estimateVsDevicesText } from "./loads";
export { PLACEMENT_FIELD_PROVIDER, PLACEMENT_PLACED, PLACEMENT_PLANNED } from "./placement";
export { SERVES_PROVIDER, SERVES_RULE_POINT, servesOf, sourceOf, type ServesRuleDef } from "./serves";
export { SPATIAL_FIELD_PROVIDER, baseFieldProvider, levelOf, roomOf, roomText, withBaseFields } from "./spatial";
export { PARAMETER_SET_POINT, packParameterField, withPackParameters, type PackParameter, type PackParameterSet } from "../pack-parameters";

/**
 * The kernel's field providers on the kernel's classes: the registry every
 * schedule, tag, diagram and agent tool reads through before a firm library
 * layers on. Trade code lives only in these providers (SCHEDULES-PLAN §4).
 *
 * Layering a library: `withBaseFields(registryForLibrary(fieldProviderRegistry(), resolved))`,
 * so the library's new classes get mark, type, level, room and count too.
 */

/** The unit questions the registry asks, answered by `@permitzip/bim-units`. */
export const BIM_UNIT_CATALOG: UnitCatalog = { unitAllowed, convert };

/**
 * One field provider on the pack contract. `rank` orders providers (lower
 * first; ties keep set order): a provider's fields list in that order, and a
 * pack's provider defaults after every built-in and first-party one.
 */
export interface FieldProviderRow {
  readonly id: string;
  readonly provider: FieldProvider;
  readonly rank?: number;
}

/** Rank of a pack provider that names none: after the built-in and first-party ones. */
export const FIELD_PROVIDER_DEFAULT_RANK = 1000;

const BUILTIN_PROVIDERS: readonly FieldProviderRow[] = [
  { id: "spatial", provider: SPATIAL_FIELD_PROVIDER, rank: 0 },
  { id: "serves", provider: SERVES_PROVIDER, rank: 50 },
  { id: "placement", provider: PLACEMENT_FIELD_PROVIDER, rank: 60 },
  { id: "loads", provider: LOADS_FIELD_PROVIDER, rank: 70 },
];

/** Field providers (v1). Built-in rows are the shared ones; each trade's are its pack's. */
export const FIELD_PROVIDER_POINT = defineExtensionPoint<FieldProviderRow>({ id: "kernel.field_provider", version: 1, label: "Field providers", idOf: (r) => r.id, builtins: () => withQtoFieldProvider(BUILTIN_PROVIDERS) });

/** The providers of the set in force, in rank order. */
export function fieldProviders(set: PackSet = activePackSet()): readonly FieldProvider[] {
  return set.memo("kernel.field_provider#ordered", () =>
    set
      .items(FIELD_PROVIDER_POINT)
      .map((row, i) => ({ row, i }))
      .sort((a, b) => (a.row.rank ?? FIELD_PROVIDER_DEFAULT_RANK) - (b.row.rank ?? FIELD_PROVIDER_DEFAULT_RANK) || a.i - b.i)
      .map(({ row }) => row.provider),
  );
}

/** The kernel's classes and relationships with every provider of the set in force and the base fields, for a layer to extend. */
export function fieldProviderRegistryBuilder(opts: RegistryOptions = { units: BIM_UNIT_CATALOG }): RegistryBuilder {
  const b = builtinRegistryBuilder(opts);
  for (const p of fieldProviders()) b.addProvider(p);
  b.addProvider(baseFieldProvider(builtinRegistryBuilder(opts).build()));
  return b;
}

/**
 * The kernel registry with every field provider of the set in force, unit-checked, plus that
 * set's classes and parameters (what `withPackParameters` joins). Built once per set, in one
 * builder pass: an outside add-on's classes and parameters cost one build, not three.
 */
export function fieldProviderRegistry(): Registry {
  const set = activePackSet();
  return set.memo("kernel.field_provider#registry", () => {
    const b = fieldProviderRegistryBuilder();
    addPackClassesAndParameters(b, builtinRegistry(), set);
    return b.build();
  });
}
