/**
 * @jest-environment node
 *
 * Round 7 lane Q, the quantity half of lane G's `dependsOn`: merging three
 * offices by deleting W-12, W-13 and W-14 (each with its door) reports what
 * that does to quantities through `quantityDeltasBetween`, reading only the
 * deleted ids and the hosts they name. A door removed on its own re-measures
 * its wall's net face area even though the wall isn't listed.
 *
 * Fails on the old code: there was no `qto/delta.ts` and no measure rules.
 */
import { quantityDeltasBetween, type BimElement } from "../src";
import { FT, threeOffices } from "./q7-fixtures";

const without = (elements: Readonly<Record<string, BimElement>>, ids: readonly string[]): Record<string, BimElement> => {
  const out: Record<string, BimElement> = { ...elements };
  for (const id of ids) delete out[id];
  return out;
};

describe("q7 quantity deltas for dependsOn", () => {
  it("deleting three walls and their doors reports wall length and door deltas", () => {
    const before = threeOffices().elements;
    const ids = ["W-12", "W-13", "W-14", "D-12", "D-13", "D-14"];
    const after = without(before, ids);
    const deltas = quantityDeltasBetween(before, after, ids);
    const labels = deltas.map((d) => d.label);
    expect(labels).toContain("-45 ft of 1-hour wall");
    expect(labels).toContain("-3 doors");
    const wall = deltas.find((d) => d.measure === "qto.length");
    expect(wall).toMatchObject({ group: "type:t-1hr", unit: "m" });
    expect(wall?.delta).toBeCloseTo((-45 * FT) / 1000, 6);
    // Only the primary measure of each class, unless asked for all.
    expect(deltas.some((d) => d.measure === "qto.area_net")).toBe(false);
    expect(quantityDeltasBetween(before, after, ids, { all: true }).some((d) => d.measure === "qto.area_net")).toBe(true);
  });

  it("a door removed alone re-measures its wall's net face area", () => {
    const before = threeOffices().elements;
    const after = without(before, ["D-13"]);
    const all = quantityDeltasBetween(before, after, ["D-13"], { all: true });
    const net = all.find((d) => d.measure === "qto.area_net");
    expect(net?.delta).toBeCloseTo((3 * FT * 7 * FT) / 1e6, 6);
    expect(net?.label).toBe("+21 ft² of 1-hour wall");
    expect(all.find((d) => d.measure === "qto.count")?.label).toBe("-1 door");
  });

  it("an unchanged model reports nothing", () => {
    const before = threeOffices().elements;
    expect(quantityDeltasBetween(before, before, ["W-12"])).toEqual([]);
  });
});
