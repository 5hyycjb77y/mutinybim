/**
 * @jest-environment node
 *
 * Round 7 lane C: ceilings as typed surfaces. A `ceiling` is one generic
 * element: an outline (with holes) or a cloud's own outline, a height at a
 * point, flat or sloped, a form, a class and an element type for what it is
 * made of, hosted in a space, on a level. Readers other lanes call:
 * `ceilingHeightAt`, `ceilingsOfSpace`, `ceilingForm`, `ceilingSlope`.
 *
 * Fails on the old code: there were no ceiling commands (`create_ceiling`
 * didn't parse), no readers (`ceilingHeightAt` didn't exist), no
 * `arch.ceiling` class, and element types couldn't be limited to ceilings.
 */
import { asElementId, ceilingForm, ceilingHeightAt, ceilingIndexBuilds, ceilingsAt, ceilingsOfSpace, ceilingSlope, isCeiling, type BimElement, type Ceiling, type ModelState } from "../src";
import { activeClassRegistry } from "../src/registry";
import { commit, FT, officeModel, OFFICE, rect, summaryOf, tryCommit } from "./c7c-fixtures";

const L1 = asElementId("lvl-1");
const MID = { x: 10 * FT, y: 7.5 * FT };

function ceilingOf(m: ModelState, id: string): Ceiling {
  const el = m.elements[id];
  if (!isCeiling(el)) throw new Error(`${id} is not a ceiling`);
  return el;
}

describe("c7c ceiling kind", () => {
  it("creates a flat ceiling hosted in a space, reads it back, and the readers answer from it", () => {
    const m = commit(officeModel(), { type: "create_ceiling", ceilings: [{ ceilingId: "c1", levelId: "lvl-1", spaceId: "s101", outline: OFFICE, heightMm: 8 * FT }] });
    const c = ceilingOf(m, "c1");
    expect(c).toMatchObject({ kind: "ceiling", levelId: "lvl-1", spaceId: "s101", form: "flat", heightMm: 8 * FT, classId: "arch.ceiling", partition: { level: "Level 1", discipline: "architecture" } });
    expect(c.slope).toBeUndefined();
    expect(ceilingHeightAt(m.elements, L1, MID)).toEqual({ heightMm: 8 * FT, ceilingId: "c1", form: "flat", role: "ceiling", slope: null });
    expect(ceilingHeightAt(m.elements, L1, { x: 30 * FT, y: 5 * FT })).toBeNull();
    expect(ceilingHeightAt(m.elements, asElementId("lvl-2"), MID)).toBeNull();
    expect(ceilingsOfSpace(m.elements, asElementId("s101")).map((x) => x.id)).toEqual(["c1"]);
    expect(summaryOf(officeModel(), { type: "create_ceiling", ceilings: [{ ceilingId: "c1", levelId: "lvl-1", spaceId: "s101", outline: OFFICE, heightMm: 8 * FT }] })[0]).toBe("Drew ceiling c1 in 101 Office (flat, 8'-0\", 300 sq ft)");
  });

  it("a sloped ceiling: its height at a point rises from the reference by the pitch toward its direction", () => {
    const m = commit(officeModel(), {
      type: "create_ceiling",
      ceilings: [{ ceilingId: "c2", levelId: "lvl-1", spaceId: "s101", outline: OFFICE, heightMm: 8 * FT, reference: { x: 0, y: 0 }, slope: { directionDeg: 0, pitch: 0.25 } }],
    });
    const c = ceilingOf(m, "c2");
    expect(ceilingForm(c)).toBe("sloped");
    expect(ceilingSlope(c)).toEqual({ directionDeg: 0, pitch: 0.25 });
    expect(ceilingHeightAt(m.elements, L1, { x: 4 * FT, y: 2 * FT })?.heightMm).toBeCloseTo(9 * FT, 6);
    expect(ceilingHeightAt(m.elements, L1, { x: 0.001, y: 10 * FT })?.heightMm).toBeCloseTo(8 * FT, 2);
    expect(ceilingHeightAt(m.elements, L1, { x: 4 * FT, y: 2 * FT })?.slope).toEqual({ directionDeg: 0, pitch: 0.25 });
  });

  it("a cloud under the room's ceiling is what is seen from below; a hole leaves nothing overhead", () => {
    let m = commit(officeModel(), { type: "create_ceiling", ceilings: [{ ceilingId: "c1", levelId: "lvl-1", spaceId: "s101", outline: OFFICE, heightMm: 10 * FT, holes: [rect(1 * FT, 1 * FT, 3 * FT, 3 * FT)] }] });
    m = commit(m, { type: "create_ceiling", ceilings: [{ ceilingId: "cloud-1", levelId: "lvl-1", spaceId: "s101", outline: rect(8 * FT, 5 * FT, 12 * FT, 10 * FT), form: "cloud", heightMm: 9 * FT }] });
    expect(ceilingHeightAt(m.elements, L1, MID)).toMatchObject({ ceilingId: "cloud-1", form: "cloud", role: "cloud", heightMm: 9 * FT });
    expect(ceilingsAt(m.elements, L1, MID).map((x) => x.ceilingId)).toEqual(["cloud-1", "c1"]);
    expect(ceilingHeightAt(m.elements, L1, { x: 2 * FT, y: 2 * FT })).toBeNull();
    expect(ceilingsOfSpace(m.elements, asElementId("s101")).map((x) => x.id).sort()).toEqual(["c1", "cloud-1"]);
  });

  it("refuses in words: a sloped ceiling with no slope, a flat one with a slope, a hole outside, a role no add-on defines, a space on another level", () => {
    const m = officeModel();
    const base = { ceilingId: "cx", levelId: "lvl-1", outline: OFFICE, heightMm: 9 * FT };
    const refusal = (extra: Record<string, unknown>) => {
      const r = tryCommit(m, { type: "create_ceiling", ceilings: [{ ...base, ...extra }] });
      return r.ok ? "" : r.message;
    };
    expect(refusal({ form: "sloped" })).toBe("A sloped ceiling needs its slope: which way it rises and how steeply. Give a slope, or make it flat");
    expect(refusal({ form: "flat", slope: { directionDeg: 90, pitch: 0.1 } })).toBe("A flat ceiling has no slope. Choose sloped, or leave the slope out");
    expect(refusal({ holes: [rect(30 * FT, 0, 32 * FT, 2 * FT)] })).toMatch(/A hole must sit inside the ceiling's outline/);
    expect(refusal({ role: "zz.baffle" })).toBe('"zz.baffle" isn\'t a surface role this model knows. Choose one of: Ceiling, Soffit, Cloud, Open to structure');
    const two = commit(m, { type: "create_space", spaces: [{ spaceId: "s201", number: "201", name: "Office", levelId: "lvl-2", outline: OFFICE }] });
    const r = tryCommit(two, { type: "create_ceiling", ceilings: [{ ...base, spaceId: "s201" }] });
    expect(r.ok ? "" : r.message).toBe("Space 201 is on another level; host the ceiling in a space on its own level, or leave the space out");
  });

  it("what it is made of is an element type limited to ceilings; a wall type is refused", () => {
    let m = commit(officeModel(), { type: "create_element_type", typeId: "act-2x2", name: "Acoustic tile 2x2", classId: "arch.ceiling", forKinds: ["ceiling"], values: { "zz.nrc": 0.7 } });
    m = commit(m, { type: "create_element_type", typeId: "wall-a", name: "Wall type A", forKinds: ["wall"] });
    m = commit(m, { type: "create_ceiling", ceilings: [{ ceilingId: "c1", levelId: "lvl-1", outline: OFFICE, heightMm: 9 * FT, typeId: "act-2x2" }] });
    expect(ceilingOf(m, "c1").typeId).toBe("act-2x2");
    const r = tryCommit(m, { type: "edit_ceiling", ceilingId: "c1", typeId: "wall-a" });
    expect(r.ok ? "" : r.message).toBe("Wall type A is a type for walls, not ceilings");
    expect(activeClassRegistry().getClass("arch.ceiling")).toMatchObject({ label: "Ceilings", ifc: { entity: "IfcCovering", predefinedType: "CEILING" } });
  });

  it("edits and deletes; nothing-to-change is said", () => {
    let m = commit(officeModel(), { type: "create_ceiling", ceilings: [{ ceilingId: "c1", levelId: "lvl-1", outline: OFFICE, heightMm: 9 * FT }] });
    m = commit(m, { type: "edit_ceiling", ceilingId: "c1", slope: { directionDeg: 90, pitch: 0.1 } });
    expect(ceilingOf(m, "c1")).toMatchObject({ form: "sloped", slope: { directionDeg: 90, pitch: 0.1 } });
    m = commit(m, { type: "edit_ceiling", ceilingId: "c1", slope: null });
    expect(ceilingOf(m, "c1").form).toBe("flat");
    const same = tryCommit(m, { type: "edit_ceiling", ceilingId: "c1", heightMm: 9 * FT });
    expect(same.ok ? "" : same.message).toBe("Nothing to change: Ceiling c1 already reads that way");
    m = commit(m, { type: "delete_ceilings", ceilingIds: ["c1"] });
    expect(m.elements.c1).toBeUndefined();
    expect(ceilingHeightAt(m.elements, L1, MID)).toBeNull();
  });

  it("upgrade on edit: a ceiling stored before ceilings were classed gains arch.ceiling on its next edit, and only then", () => {
    const m0 = officeModel();
    const bare = { id: asElementId("old-1"), kind: "ceiling", version: 1, authoredRev: {}, partition: { level: "Level 1", zone: "Z1", discipline: "architecture" }, levelId: L1, outline: OFFICE, form: "flat", heightMm: 9 * FT } as unknown as BimElement;
    const untouched = { ...bare, id: asElementId("old-2") } as BimElement;
    const m = { ...m0, elements: { ...m0.elements, [bare.id]: bare, [untouched.id]: untouched } };
    const after = commit(m, { type: "edit_ceiling", ceilingId: "old-1", heightMm: 8.5 * FT });
    expect(after.elements["old-1"]).toMatchObject({ classId: "arch.ceiling", classSource: "recognised", schemaVersion: 2, heightMm: 8.5 * FT });
    expect(after.elements["old-2"]).toBe(untouched);
  });

  it("the index is carried to the next revision: an unrelated edit never rebuilds it", () => {
    const m = commit(officeModel("c7c-carry"), { type: "create_ceiling", ceilings: [{ ceilingId: "c1", levelId: "lvl-1", outline: OFFICE, heightMm: 9 * FT }] });
    ceilingHeightAt(m.elements, L1, MID);
    const built = ceilingIndexBuilds();
    const next = commit(m, { type: "create_level", levelId: "lvl-3", name: "Level 3", elevationMm: 26 * FT });
    expect(ceilingHeightAt(next.elements, L1, MID)?.ceilingId).toBe("c1");
    const moved = commit(next, { type: "edit_ceiling", ceilingId: "c1", outline: rect(30 * FT, 0, 40 * FT, 10 * FT) });
    expect(ceilingHeightAt(moved.elements, L1, MID)).toBeNull();
    expect(ceilingHeightAt(moved.elements, L1, { x: 35 * FT, y: 5 * FT })?.ceilingId).toBe("c1");
    expect(ceilingIndexBuilds()).toBe(built);
  });

  it("says when a ceiling is higher than the structure above it, with the next step", () => {
    const lines = summaryOf(officeModel(), { type: "create_ceiling", ceilings: [{ ceilingId: "c1", levelId: "lvl-1", outline: OFFICE, heightMm: 14 * FT }] });
    expect(lines).toContain("Ceiling c1 reaches 14'-0\" above its floor, 1'-0\" higher than the floor of Level 2 at 13'-0\". Lower the ceiling, or check that level or slab");
    const fine = summaryOf(officeModel(), { type: "create_ceiling", ceilings: [{ ceilingId: "c1", levelId: "lvl-1", outline: OFFICE, heightMm: 9 * FT }] });
    expect(fine.join(" ")).not.toMatch(/higher than/);
  });
});
