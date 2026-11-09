/**
 * @jest-environment node
 *
 * Round 13 lane P13 (P12 open item 3): the frozen system-kind order no longer
 * depends on the transitional fallback's row order, and a first-party add-on's
 * bare-id rows join as built-ins when the base doesn't hold them. So the
 * coordinator can delete `services/builtin-fallback.ts` once every trade
 * contributes its rows: with Plumbing and gas's rows taken out of the base,
 * installing the add-on gives back the same rows and the same views, in the
 * round 4 order. An outside add-on still can't claim a bare id.
 * (@mutinybim-bare-kernel: installs only Plumbing and gas.)
 *
 * Fails on round 12's code: there was no `builtinServiceRegistry` (the order
 * was the fallback's row order), and `withPackServices` refused every bare id
 * the base didn't hold ("would redefine a built-in service").
 */
import { SERVICE_POINT, builtinServiceRegistry, loadServiceIds, systemKindIds, withPackServices } from "@permitzip/bim-kernel";
import { PackSet, activePackSet, contribute, definePack, installFirstPartyPacks } from "@permitzip/bim-kernel/packs";
import { PLUMBING_GAS_PACK, PLUMBING_SERVICE_ROWS } from "../src";
import { ROUND13_SERVICE_ROWS } from "../../bim-kernel/__tests__/fixtures/k14-round13-stand-ins";

/** Round 13's built-in registry, from its frozen rows (the kernel's stand-in list K14 deleted). */
const ROUND13_REGISTRY = builtinServiceRegistry(ROUND13_SERVICE_ROWS);

const PLUMBING = new Set(PLUMBING_SERVICE_ROWS.map((r) => r.id));

describe("p13-services-without-fallback", () => {
  it("rows in any order give the frozen views", () => {
    const shuffled = [...ROUND13_SERVICE_ROWS].reverse();
    const reg = builtinServiceRegistry(shuffled);
    expect(systemKindIds(reg)).toEqual(systemKindIds(ROUND13_REGISTRY));
    expect(loadServiceIds(reg)).toEqual(loadServiceIds(ROUND13_REGISTRY));
  });

  it("a base without Plumbing and gas's rows plus the add-on equals today's registry", () => {
    const base = builtinServiceRegistry(ROUND13_SERVICE_ROWS.filter((r) => !PLUMBING.has(r.id)));
    expect(systemKindIds(base)).not.toContain("sanitary");
    installFirstPartyPacks([PLUMBING_GAS_PACK]);
    const reg = withPackServices(base, activePackSet());
    expect(systemKindIds(reg)).toEqual(systemKindIds(ROUND13_REGISTRY));
    expect(loadServiceIds(reg)).toEqual(loadServiceIds(ROUND13_REGISTRY));
    for (const id of PLUMBING) expect(JSON.stringify(reg.byId.get(id))).toBe(JSON.stringify(ROUND13_REGISTRY.byId.get(id)));
  });

  it("an outside add-on can't claim a bare id; its own namespaced row joins after the built-ins", () => {
    const sanitary = PLUMBING_SERVICE_ROWS.find((r) => r.id === "sanitary");
    if (!sanitary) throw new Error("no sanitary row");
    expect(() => definePack({ id: "zzsewer", name: "Test sewer", version: "1.0.0", kernel: "^1.0.0" }, [contribute(SERVICE_POINT, [{ ...sanitary, id: "zz_sewer" }])])).toThrow(/Services id "zz_sewer" must start with "zzsewer\."/);
    const own = definePack({ id: "zzsewer", name: "Test sewer", version: "1.0.0", kernel: "^1.0.0" }, [contribute(SERVICE_POINT, [{ ...sanitary, id: "zzsewer.lateral" }])]);
    const reg = withPackServices(builtinServiceRegistry(ROUND13_SERVICE_ROWS), PackSet.create([own]));
    expect(systemKindIds(reg).slice(-1)).toEqual(["zzsewer.lateral"]);
  });
});
