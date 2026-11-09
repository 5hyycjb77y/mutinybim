/**
 * @jest-environment node
 *
 * Round 13 lane P13: the paths Plumbing's calculation sheets bind (water
 * pressure loss, gas sizing) are registered fields on a pipe, typed, so a
 * schedule column, a tag and the sheet show the same number in the same
 * unit and a cell edit says why it can't change it.
 *
 * Fails on round 12's code: round 12 added the paths to the resolver
 * (`WATER_FIELD_PATHS`, `gas.zone_longest` / `carries_cfh` / `heating_value`)
 * but no provider registered them, so `registry.field` was undefined.
 */
import { fieldProviderRegistry } from "@permitzip/bim-kernel";
import { installFirstPartyPacks } from "@permitzip/bim-kernel/packs";
import { PLUMBING_GAS_PACK, WATER_FIELD_PATHS } from "../src";

describe("p13-sheet-fields-typed", () => {
  beforeAll(() => installFirstPartyPacks([PLUMBING_GAS_PACK]));

  it("every water sheet path is a pressure in psi (velocity in ft/s) on a pipe, read from the solve", () => {
    const registry = fieldProviderRegistry();
    for (const p of WATER_FIELD_PATHS) {
      const f = registry.field("mep.pipe", p.path);
      expect([p.path, f?.kind, f?.unit, f?.writer.kind]).toEqual([p.path, p.path === "water.max_velocity_fps" ? "velocity" : "pressure", p.path === "water.max_velocity_fps" ? "ft/s" : "psi", "none"]);
    }
  });

  it("the gas sizing length, carried flow and heating value are pipe fields", () => {
    const registry = fieldProviderRegistry();
    expect(registry.field("mep.pipe", "gas.zone_longest")).toMatchObject({ kind: "length", unit: "ft" });
    expect(registry.field("mep.pipe", "gas.carries_cfh")).toMatchObject({ kind: "flow_gas_volume", unit: "cfh", aggregation: "none" });
    expect(registry.field("mep.pipe", "gas.heating_value")).toMatchObject({ valueType: "text" });
  });
});
