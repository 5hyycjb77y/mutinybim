/**
 * @jest-environment node
 *
 * Round 12 lane P12 (move handshake for `services/builtin.ts`): the kernel
 * reads service rows from `SERVICE_POINT`; Plumbing and gas contributes
 * water, sanitary, vent, storm, gas, grease and indirect waste, each equal to
 * round 13's kernel row byte for byte (frozen when K14 deleted the kernel's
 * stand-in list in round 14). With the add-on on, the registry holds its rows
 * in round 13's order; without the other trades' add-ons it holds none of
 * theirs. Installs only Plumbing and gas (@mutinybim-bare-kernel).
 *
 * Fails on round 11's code: the add-on contributed no service rows and the
 * kernel refused a bare-id service row from any add-on. The last case fails
 * on round 13's: the kernel's stand-in list carried every trade's rows.
 */
import {
  BUILTIN_SERVICE_REGISTRY,
  SERVICE_POINT,
  activeServiceRegistry,
  loadServiceIds,
  systemKindIds,
} from "@permitzip/bim-kernel";
import { activePackSet, installFirstPartyPacks } from "@permitzip/bim-kernel/packs";
import { PLUMBING_GAS_CONTRIBUTIONS, PLUMBING_GAS_PACK, PLUMBING_SERVICE_ROWS } from "../src";
import { ROUND13_SERVICE_ROWS, round13ServiceJson } from "../../bim-kernel/__tests__/fixtures/k14-round13-stand-ins";

const PLUMBING_IDS = ["domestic_cold_water", "domestic_hot_water", "domestic_hot_water_return", "sanitary", "vent", "storm", "natural_gas", "cold_water", "hot_water", "gas", "grease_waste", "indirect_waste"];

describe("p12-services-from-addons", () => {
  it("each Plumbing and gas row equals round 13's row byte for byte", () => {
    expect(PLUMBING_SERVICE_ROWS.map((r) => r.id)).toEqual(PLUMBING_IDS);
    for (const row of PLUMBING_SERVICE_ROWS) expect([row.id, JSON.stringify(row)]).toEqual([row.id, round13ServiceJson(row.id)]);
  });

  it("with the add-on on, the registry holds its rows after the kernel's Other, in round 13's order, and its views keep that order", () => {
    installFirstPartyPacks([PLUMBING_GAS_PACK]);
    expect(PLUMBING_GAS_CONTRIBUTIONS.some((c) => c.pointId === SERVICE_POINT.id)).toBe(true);
    const ours = new Set(["other", ...PLUMBING_IDS]);
    const round13 = ROUND13_SERVICE_ROWS.filter((r) => ours.has(r.id));
    const now = activeServiceRegistry();
    expect(now.rows.map((r) => r.id)).toEqual(round13.map((r) => r.id));
    expect(systemKindIds()).toEqual(round13.filter((r) => r.asSystem).map((r) => r.id));
    expect(loadServiceIds()).toEqual(["cold_water", "hot_water", "sanitary", "grease_waste", "gas"]);
    // The point lists every row once: the kernel's Other, then the add-on's own.
    const ids = activePackSet().items(SERVICE_POINT).map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(["other", ...PLUMBING_IDS]);
  });

  it("holds no other trade's rows: the kernel's stand-in list is gone (round 14)", () => {
    installFirstPartyPacks([PLUMBING_GAS_PACK]);
    expect(BUILTIN_SERVICE_REGISTRY.rows.map((r) => r.id)).toEqual(["other"]);
    for (const id of ["supply_air", "power", "fire_protection_wet", "chilled_water_supply"]) expect([id, activeServiceRegistry().byId.has(id)]).toEqual([id, false]);
  });
});
