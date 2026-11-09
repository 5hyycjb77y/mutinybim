import { OUTDOOR_AIR_READER_POINT, PRESSURE_TARGET_POINT, SERVICE_POINT } from "@permitzip/bim-kernel";
import { contribute, definePack, ELECTRICAL_MANIFEST, installFirstPartyPacks, MECHANICAL_MANIFEST, type Pack } from "@permitzip/bim-kernel/packs";
import { ELECTRICAL_SERVICE_ROWS } from "@permitzip/bim-pack-electrical";
import { PLUMBING_GAS_ADDON } from "@permitzip/bim-first-party";
import { MECHANICAL_CONTRIBUTIONS } from "../src";

/**
 * Mechanical's rows without its outdoor-air engine and pressure targets: what
 * a bare kernel read before round 6 (the three transitional packs carried the
 * fields, tables, commands and adapters; the engine and targets came from the
 * host). Suites that bring their own engine or targets per case install the
 * first-party add-ons with this in Mechanical's place, so every case reads as
 * it did. Electrical stays out: `param.<name>` paths are the kernel's. Its
 * service rows (power, lighting, data, fire alarm) are in, as the kernel's
 * stand-in list carried them until round 14, so a unit's Power connector reads.
 */
export const MECHANICAL_ROWS_ONLY: Pack = definePack(
  MECHANICAL_MANIFEST,
  MECHANICAL_CONTRIBUTIONS.filter((c) => c.pointId !== OUTDOOR_AIR_READER_POINT.id && c.pointId !== PRESSURE_TARGET_POINT.id),
);

/** Electrical's service rows alone (no fields, tables or engine). */
export const ELECTRICAL_SERVICES_ONLY: Pack = definePack(ELECTRICAL_MANIFEST, [contribute(SERVICE_POINT, ELECTRICAL_SERVICE_ROWS)]);

export function installMechanicalRowsOnly(): void {
  installFirstPartyPacks([PLUMBING_GAS_ADDON, MECHANICAL_ROWS_ONLY, ELECTRICAL_SERVICES_ONLY]);
}
