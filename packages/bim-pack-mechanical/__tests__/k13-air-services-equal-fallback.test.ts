/**
 * @jest-environment node
 *
 * Round 13 K13 step 5: Mechanical's service rows (air, heat gain, hydronic,
 * chilled and heating water, condensate, refrigerant) equal the kernel's
 * transitional fallback rows byte for byte. With them taken out of the base,
 * installing Mechanical gives back the same rows and the same system-kind and
 * load-service views, in the frozen order.
 *
 * Fails on round 12's code: Mechanical contributed no `SERVICE_POINT` rows.
 */
import { SERVICE_POINT, builtinServiceRegistry, loadServiceIds, systemKindIds, withPackServices } from "@permitzip/bim-kernel";
import { activePackSet, installFirstPartyPacks } from "@permitzip/bim-kernel/packs";
import { MECHANICAL_CONTRIBUTIONS, MECHANICAL_PACK, MECHANICAL_SERVICE_ROWS } from "../src";
import { ROUND13_SERVICE_ROWS } from "../../bim-kernel/__tests__/fixtures/k14-round13-stand-ins";

/** Round 13's built-in registry, from its frozen rows (the kernel's stand-in list K14 deleted). */
const ROUND13_REGISTRY = builtinServiceRegistry(ROUND13_SERVICE_ROWS);

const OURS = new Set(MECHANICAL_SERVICE_ROWS.map((r) => r.id));

describe("k13-air-services-equal-fallback", () => {
  it("each row equals the fallback's row with the same id", () => {
    for (const row of MECHANICAL_SERVICE_ROWS) expect([row.id, JSON.stringify(row)]).toEqual([row.id, JSON.stringify(ROUND13_SERVICE_ROWS.find((r) => r.id === row.id))]);
    for (const id of ["supply_air", "return_air", "exhaust_air", "outside_air", "heat_gain"]) expect(OURS.has(id)).toBe(true);
    expect(MECHANICAL_CONTRIBUTIONS.find((c) => c.pointId === SERVICE_POINT.id)?.items).toEqual(MECHANICAL_SERVICE_ROWS);
  });

  it("a base without them plus the add-on equals today's registry", () => {
    const base = builtinServiceRegistry(ROUND13_SERVICE_ROWS.filter((r) => !OURS.has(r.id)));
    expect(systemKindIds(base)).not.toContain("supply_air");
    installFirstPartyPacks([MECHANICAL_PACK]);
    const reg = withPackServices(base, activePackSet());
    expect(systemKindIds(reg)).toEqual(systemKindIds(ROUND13_REGISTRY));
    expect(loadServiceIds(reg)).toEqual(loadServiceIds(ROUND13_REGISTRY));
    for (const id of OURS) expect(JSON.stringify(reg.byId.get(id))).toBe(JSON.stringify(ROUND13_REGISTRY.byId.get(id)));
  });
});
