/**
 * `@permitzip/bim-first-party`: the MutinyBIM add-ons PermitZIP ships
 * (Electrical, Plumbing and gas, Mechanical, Fire protection), installed in every host (the
 * browser, the model server, the MCP routes, the agent worker, tests)
 * whatever the per-deployment add-on list says. One import, one call:
 * `installFirstPartyAddOns()`. Every model then opens with these packs under
 * whatever it pins.
 *
 * Round 6: each add-on is its trade's own package; the kernel carries none.
 */
import { installFirstPartyPacks, type Pack } from "@permitzip/bim-kernel/packs";
import { ELECTRICAL_PACK as ELECTRICAL_ADDON } from "@permitzip/bim-pack-electrical/host";
import { MECHANICAL_PACK as MECHANICAL_ADDON } from "@permitzip/bim-pack-mechanical/host";
import { PLUMBING_GAS_PACK as PLUMBING_GAS_ADDON } from "@permitzip/bim-pack-plumbing/host";
import { ARCHITECTURE_PACK as ARCHITECTURE_ADDON } from "@permitzip/bim-pack-architecture";
import { STRUCTURAL_PACK as STRUCTURAL_ADDON } from "@permitzip/bim-pack-structural";
import { FIRE_PROTECTION_PACK as FIRE_PROTECTION_ADDON } from "./fire-protection";

export { ELECTRICAL_ADDON, MECHANICAL_ADDON, PLUMBING_GAS_ADDON, FIRE_PROTECTION_ADDON, ARCHITECTURE_ADDON, STRUCTURAL_ADDON };
export { FIRE_PROTECTION_DISCIPLINES } from "./fire-protection";

/** In first-party order: Settings › MutinyBIM library › Add-ons lists them so, and their rows join every point in this order. */
export const FIRST_PARTY_ADDONS: readonly Pack[] = [ELECTRICAL_ADDON, PLUMBING_GAS_ADDON, MECHANICAL_ADDON, FIRE_PROTECTION_ADDON, ARCHITECTURE_ADDON, STRUCTURAL_ADDON];

/** Install the first-party add-ons in this process. Idempotent; refuses loudly a different pack for an id already installed. */
export function installFirstPartyAddOns(): void {
  installFirstPartyPacks(FIRST_PARTY_ADDONS);
}
