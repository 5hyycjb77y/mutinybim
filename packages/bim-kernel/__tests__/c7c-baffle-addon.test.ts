/**
 * @jest-environment node
 *
 * Round 7 lane C, zero kernel edits: a test add-on contributes a `baffle`
 * surface role at `SURFACE_ROLE_POINT` (`kernel.surface_role`). With the
 * add-on in force a person or an agent can draw a ceiling in that role, and
 * `ceilingHeightAt` and `surfacesAt` read it by its role and label. Without
 * the add-on the role is refused on write and still read (kept, in its own
 * words) on a model that has one.
 *
 * Fails on the old code: the point had no readers and no writer, so a role
 * from an add-on reached nothing.
 */
import { asElementId, ceilingHeightAt, ceilingRole, surfaceRoles, surfacesAt, SURFACE_ROLE_POINT, type Ceiling } from "../src";
import { contribute, definePack, PackSet, withPackSet } from "../src/packs";
import { commit, FT, officeModel, rect, tryCommit } from "./c7c-fixtures";

const zz = definePack({ id: "zz", name: "Test acoustics", version: "1.0.0", kernel: "^1.0.0" }, [contribute(SURFACE_ROLE_POINT, [{ id: "zz.baffle", label: "Baffle", hostsDevices: false }])]);
const set = PackSet.create([zz]);
const L1 = asElementId("lvl-1");
const BAFFLE = { ceilingId: "b1", levelId: "lvl-1", spaceId: "s101", outline: rect(5 * FT, 5 * FT, 15 * FT, 6 * FT), form: "cloud", heightMm: 10 * FT, role: "zz.baffle" };

describe("c7c a baffle role from an add-on, no kernel edit", () => {
  it("the add-on's role joins the built-in roles while it is in force", () => {
    expect(withPackSet(set, () => surfaceRoles().map((r) => r.id))).toEqual(["ceiling", "soffit", "cloud", "open_to_structure", "zz.baffle"]);
    expect(surfaceRoles().map((r) => r.id)).not.toContain("zz.baffle");
  });

  it("a ceiling drawn in the baffle role is read by ceilingHeightAt and surfacesAt", () => {
    const m = withPackSet(set, () => commit(officeModel(), { type: "create_ceiling", ceilings: [BAFFLE] }));
    const c = m.elements.b1 as Ceiling;
    expect(c.role).toBe("zz.baffle");
    expect(withPackSet(set, () => ceilingRole(c))).toEqual({ id: "zz.baffle", label: "Baffle", hostsDevices: false });
    expect(ceilingHeightAt(m.elements, L1, { x: 10 * FT, y: 5.5 * FT })).toMatchObject({ ceilingId: "b1", role: "zz.baffle", form: "cloud", heightMm: 10 * FT });
    const r = withPackSet(set, () => surfacesAt(m, { point: { x: 10 * FT, y: 5.5 * FT }, levelId: L1 }));
    if (!r.ok) throw new Error(r.reason);
    expect(r.ceiling?.source).toEqual({ kind: "ceiling", id: "b1", name: "Baffle b1", form: "cloud", surfaceRole: "zz.baffle" });
  });

  it("without the add-on the role is refused on write, and still read on a model that has one", () => {
    const refused = tryCommit(officeModel(), { type: "create_ceiling", ceilings: [BAFFLE] });
    expect(refused.ok ? "" : refused.message).toMatch(/"zz.baffle" isn't a surface role this model knows/);
    const m = withPackSet(set, () => commit(officeModel(), { type: "create_ceiling", ceilings: [BAFFLE] }));
    expect(ceilingRole(m.elements.b1 as Ceiling)).toEqual({ id: "zz.baffle", label: "Baffle", hostsDevices: true });
  });
});
