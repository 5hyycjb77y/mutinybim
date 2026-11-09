/**
 * @jest-environment node
 *
 * Round 7 lane C: `surfacesAt` reads a typed ceiling ahead of the space's
 * stated height. "A statement beats a measurement" stays: a drawn ceiling is
 * a statement, and the more specific one (it is drawn where it is). Old
 * models with only a space's stated height read exactly as before.
 *
 * Fails on the old code: `surfacesAt` read only the space's stated height and
 * linked ceilings, so the ceiling at 8 ft below answered 9 ft from the space.
 */
import { asElementId, surfacesAt, type LinkedSurfaceSource } from "../src";
import { commit, FT, officeModel, OFFICE, rect } from "./c7c-fixtures";

const L1 = asElementId("lvl-1");

describe("c7c surfacesAt prefers a typed ceiling", () => {
  it("a typed ceiling beats the space's stated height, and the difference is said", () => {
    const m = commit(officeModel(), { type: "create_ceiling", ceilings: [{ ceilingId: "c1", levelId: "lvl-1", spaceId: "s101", outline: OFFICE, heightMm: 8 * FT }] });
    const r = surfacesAt(m, { point: { x: 10 * FT, y: 7 * FT }, levelId: L1 });
    if (!r.ok) throw new Error(r.reason);
    expect(r.ceiling).toMatchObject({ role: "ceiling", elevationMm: 8 * FT, aboveFloorMm: Math.round(8 * FT), source: { kind: "ceiling", id: "c1", name: "Ceiling c1", form: "flat", surfaceRole: "ceiling" } });
    expect(r.notes).toContain("Space 101 states its ceiling at 9'-0\", but Ceiling c1 is drawn at 8'-0\" here; the drawn ceiling is used");
  });

  it("a sloped ceiling answers its height at the point", () => {
    const m = commit(officeModel(), { type: "create_ceiling", ceilings: [{ ceilingId: "c1", levelId: "lvl-1", outline: OFFICE, heightMm: 8 * FT, reference: { x: 0, y: 0 }, slope: { directionDeg: 0, pitch: 0.25 } }] });
    const r = surfacesAt(m, { point: { x: 8 * FT, y: 5 * FT }, levelId: L1 });
    if (!r.ok) throw new Error(r.reason);
    expect(r.ceiling?.elevationMm).toBeCloseTo(10 * FT, 6);
    expect(r.ceiling?.source).toMatchObject({ kind: "ceiling", form: "sloped" });
  });

  it("old models: only the space's stated height, read exactly as before", () => {
    const r = surfacesAt(officeModel(), { point: { x: 10 * FT, y: 7 * FT }, levelId: L1 });
    if (!r.ok) throw new Error(r.reason);
    expect(r.ceiling).toMatchObject({ elevationMm: 9 * FT, source: { kind: "space", id: "s101", name: "101 Office" } });
  });

  it("where the typed ceiling stops (a smaller cloud), the space's stated height answers", () => {
    const m = commit(officeModel(), { type: "create_ceiling", ceilings: [{ ceilingId: "cl", levelId: "lvl-1", spaceId: "s101", outline: rect(0, 0, 5 * FT, 5 * FT), form: "cloud", heightMm: 8 * FT }] });
    const under = surfacesAt(m, { point: { x: 2 * FT, y: 2 * FT }, levelId: L1 });
    const beside = surfacesAt(m, { point: { x: 15 * FT, y: 10 * FT }, levelId: L1 });
    if (!under.ok || !beside.ok) throw new Error("surfacesAt refused");
    expect(under.ceiling?.source).toMatchObject({ kind: "ceiling", id: "cl", form: "cloud", surfaceRole: "cloud" });
    expect(beside.ceiling?.source).toMatchObject({ kind: "space", id: "s101" });
  });

  it("a typed ceiling also beats a linked ceiling, and says so", () => {
    const m = commit(officeModel(), { type: "create_ceiling", ceilings: [{ ceilingId: "c1", levelId: "lvl-1", outline: OFFICE, heightMm: 9 * FT }] });
    const linked: LinkedSurfaceSource = { modelId: "arch", label: "Architecture", elements: [{ globalId: "act", name: "ACT ceiling", ifcClass: "IFCCOVERING", kind: "covering", box: [0, 0, 8 * FT, 20 * FT, 15 * FT, 8 * FT + 20] }] };
    const r = surfacesAt(m, { point: { x: 10 * FT, y: 7 * FT }, levelId: L1 }, [linked]);
    if (!r.ok) throw new Error(r.reason);
    expect(r.ceiling?.source.kind).toBe("ceiling");
    expect(r.notes.join(" ")).toMatch(/Ceiling c1 is at 9'-0", but the linked model shows ACT ceiling at 8'-0" above the floor; the drawn ceiling is used/);
  });
});
