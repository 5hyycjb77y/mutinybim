import { anchorOf, asElementId, ELEMENT_KINDS, isPlaced, placementOf, type PartInstance, type Space } from "../src";

const part = (over: Partial<PartInstance> = {}): PartInstance => ({
  id: asElementId("p1"),
  kind: "part",
  version: 1,
  authoredRev: {},
  typeId: asElementId("t1"),
  levelId: asElementId("L1"),
  position: { x: 1000, y: 2000 },
  offsetMm: 0,
  rotationDeg: 90,
  mark: "P1",
  values: {},
  ...over,
});

describe("next-batch contracts", () => {
  it("reads every existing part as placed", () => {
    expect(isPlaced(part())).toBe(true);
    expect(placementOf(part())).toEqual({ state: "placed", levelId: "L1", position: { x: 1000, y: 2000 }, offsetMm: 0, rotationDeg: 90 });
  });

  it("never exposes a planned part's placeholder position", () => {
    const planned = part({ planned: { levelHint: asElementId("L1"), note: "panel P1, location TBD" } });
    expect(isPlaced(planned)).toBe(false);
    const placement = placementOf(planned);
    expect(placement).toEqual({ state: "planned", levelHint: "L1", note: "panel P1, location TBD" });
    expect("position" in placement).toBe(false);
  });

  it("registers spaces, zones and drawing underlays as element kinds", () => {
    expect(ELEMENT_KINDS).toEqual(expect.arrayContaining(["space", "zone", "drawing_underlay", "load_point"]));
  });

  it("anchors an outlined space at its centroid and a typed one nowhere", () => {
    const base: Omit<Space, "bounds" | "origin"> = { id: asElementId("s1"), kind: "space", version: 1, authoredRev: {}, number: "101", name: "Dining" };
    const outlined: Space = {
      ...base,
      origin: { kind: "traced", underlayId: asElementId("u1") },
      bounds: { kind: "outline", outline: [{ x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 2000 }, { x: 0, y: 2000 }] },
    };
    expect(anchorOf(outlined)).toEqual({ x: 2000, y: 1000 });
    expect(anchorOf({ ...base, origin: { kind: "typed" }, bounds: { kind: "none" } })).toBeNull();
  });
});
