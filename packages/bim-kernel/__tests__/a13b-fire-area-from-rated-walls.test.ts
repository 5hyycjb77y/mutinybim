/**
 * @jest-environment node
 *
 * A13b: Make fire area from rated walls (proposal only). The closed regions
 * that walls rated at least one hour make on a level become proposed
 * outlined zones; walls rated less (or not at all) don't close one. The
 * rating comes from a rating row (`kernel.rating_kind`) an add-on gives, so
 * the kernel names no rating here. Accepting one is an ordinary outlined
 * `create_zone`.
 *
 * Fails on round 12's code: there is no boundary index or rated-region
 * proposal.
 */
import { withUpgradePolicy, type BimElement } from "../src";
import { contribute, definePack, PACK_CONTRACT_VERSION, PackSet, withPackSet } from "../src/packs";
import { RATING_KIND_POINT, type RatingKindRow } from "../src/registry/rating-kind-point";
import { proposeRatedZones, ratedZoneCommand } from "../src/spaces/detect";
import { executeSpaceDesignCommand } from "../src/spaces/space-commands";
import { L1, modelWith, wall } from "./a13b-fixtures";

const HOURS: RatingKindRow = {
  id: "zzfire.resistance",
  label: "Resistance (test)",
  unit: "hour",
  parameterKeys: ["zzfire.hours"],
  read: (el) => {
    const v = "values" in el && el.values ? (el.values as Readonly<Record<string, unknown>>)["zzfire.hours"] : undefined;
    return typeof v === "number" ? v : null;
  },
};
const SET = PackSet.create([definePack({ id: "zzfire", name: "Ratings (test)", version: "1.0.0", kernel: `^${PACK_CONTRACT_VERSION}` }, [contribute(RATING_KIND_POINT, [HOURS])])]);

const rated = (hours: number) => ({ values: { "zzfire.hours": hours } });

function floor(midHours: number | null): BimElement[] {
  return [
    wall("W-s", { x: 0, y: 0 }, { x: 8000, y: 0 }, rated(1)),
    wall("W-e", { x: 8000, y: 0 }, { x: 8000, y: 4000 }, rated(2)),
    wall("W-n", { x: 8000, y: 4000 }, { x: 0, y: 4000 }, rated(1)),
    wall("W-w", { x: 0, y: 4000 }, { x: 0, y: 0 }, rated(1)),
    wall("W-mid", { x: 4000, y: 0 }, { x: 4000, y: 4000 }, midHours === null ? {} : rated(midHours)),
  ];
}

const opts = { ratingKind: "zzfire.resistance", atLeast: 1 };

describe("a13b fire area from rated walls", () => {
  it("a wall rated under an hour doesn't split the fire area: one proposal across both rooms", () => {
    for (const mid of [null, 0.5]) {
      const m = modelWith(floor(mid));
      const found = withPackSet(SET, () => proposeRatedZones(m.elements, L1, opts));
      expect(found).toHaveLength(1);
      expect(found[0]?.areaM2).toBeCloseTo(7.8 * 3.8, 6);
      expect([...(found[0]?.elementIds ?? [])].sort()).toEqual(["W-e", "W-n", "W-s", "W-w"]);
    }
  });

  it("a two-hour wall between them makes two fire areas", () => {
    const m = modelWith(floor(2));
    const found = withPackSet(SET, () => proposeRatedZones(m.elements, L1, opts));
    expect(found.map((f) => Math.round(f.areaM2 * 100) / 100)).toEqual([14.44, 14.44]);
  });

  it("without the rating row nothing is rated and nothing is proposed", () => {
    const m = modelWith(floor(2));
    expect(proposeRatedZones(m.elements, L1, opts)).toEqual([]);
  });

  it("accepting one writes an outlined fire area zone", () => {
    const m = modelWith(floor(null));
    const [p] = withPackSet(SET, () => proposeRatedZones(m.elements, L1, opts));
    if (!p) throw new Error("no proposal");
    const r = withPackSet(SET, () => withUpgradePolicy(() => true, () => executeSpaceDesignCommand(m, ratedZoneCommand(p, L1, { zoneId: "fa-1", name: "Fire area 1", purpose: "fire_area" }))));
    if (!r.ok) throw new Error(r.error.message);
    const z = r.model.elements["fa-1"];
    expect(z?.kind === "zone" && z.bounds?.kind).toBe("outline");
    expect(z?.kind === "zone" && z.purpose).toBe("fire_area");
  });
});
