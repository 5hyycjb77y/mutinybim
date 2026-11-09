import { withConnectionFieldDefaults } from "../catalog/connection-field-point";
import { catalogKey } from "../catalog/model";
import type { ConnectionTypeEntry } from "../catalog/types";
import { defineExtensionPoint } from "../packs/contract";
import { activePackSet } from "../packs/scope";

/**
 * Starter connection types (v1): a trade's typical devices and appliances
 * ("WC-FT", "G-GRILL"), added to a project's catalog the first time a load
 * point or a placed part names one. Keyed by designator ("WC-FT" is a catalog
 * key, not a registry id), so the point has no `idOf`: the first row with a
 * designator wins.
 */
export const STARTER_CONNECTION_TYPE_POINT = defineExtensionPoint<ConnectionTypeEntry>({
  id: "kernel.starter_connection_type",
  version: 1,
  label: "Starter connection types",
});

/** Every starter connection type of the set in force, in set order. */
export function starterConnectionTypes(): readonly ConnectionTypeEntry[] {
  return activePackSet().memo("kernel.starter_connection_type#with_fields", (set) => set.items(STARTER_CONNECTION_TYPE_POINT).map((e) => withConnectionFieldDefaults(e)));
}

/** The starter connection type with this designator in the set in force, or null. */
export function starterConnectionType(designator: string): ConnectionTypeEntry | null {
  const set = activePackSet();
  const byKey = set.memo("kernel.starter_connection_type#by_key", () => {
    const out = new Map<string, ConnectionTypeEntry>();
    for (const e of starterConnectionTypes()) if (!out.has(catalogKey(e.designator))) out.set(catalogKey(e.designator), e);
    return out;
  });
  return byKey.get(catalogKey(designator)) ?? null;
}
