/**
 * @jest-environment node
 *
 * Round 7 lane C: "Make a ceiling from this height". An old model's space
 * with a stated ceiling height becomes one flat ceiling over its outline at
 * that height, hosted in it, in one undoable edit. The space keeps its
 * height; the ceiling now answers for it.
 *
 * Fails on the old code: `make_ceiling_from_space_height` wasn't a command.
 */
import { asElementId, ceilingHeightAt, ceilingIdForSpace, ceilingsOfSpace, isCeiling, makeCeilingFromHeightRefusal, type Space } from "../src";
import { commit, FT, officeModel, OFFICE, summaryOf, tryCommit } from "./c7c-fixtures";

describe("c7c make a ceiling from a space's stated height", () => {
  it("one flat ceiling over the space's outline at its height, hosted in it", () => {
    const m = commit(officeModel(), { type: "make_ceiling_from_space_height", spaceId: "s101" });
    const c = m.elements[ceilingIdForSpace("s101")];
    if (!isCeiling(c)) throw new Error("no ceiling made");
    expect(c).toMatchObject({ id: "ceiling:s101", levelId: "lvl-1", spaceId: "s101", form: "flat", heightMm: 9 * FT, classId: "arch.ceiling" });
    expect(c.outline).toEqual(OFFICE);
    expect(ceilingsOfSpace(m.elements, asElementId("s101")).map((x) => x.id)).toEqual(["ceiling:s101"]);
    expect(ceilingHeightAt(m.elements, asElementId("lvl-1"), { x: 5 * FT, y: 5 * FT })?.ceilingId).toBe("ceiling:s101");
    const space = m.elements.s101;
    expect(space?.kind === "space" ? space.ceilingHeightMm : null).toBe(9 * FT);
    expect(summaryOf(officeModel(), { type: "make_ceiling_from_space_height", spaceId: "s101" })).toEqual([
      "Drew ceiling ceiling:s101 in 101 Office (flat, 9'-0\", 300 sq ft)",
      "Made from 101 Office's stated ceiling height; the space keeps its height, and the ceiling now answers for it",
    ]);
  });

  it("twice, or by two people at once, is refused rather than doubled", () => {
    const m = commit(officeModel(), { type: "make_ceiling_from_space_height", spaceId: "s101" });
    const r = tryCommit(m, { type: "make_ceiling_from_space_height", spaceId: "s101" });
    expect(r.ok ? "" : r.message).toBe("ceiling:s101 already exists; choose a new id for the ceiling");
  });

  it("a space with no stated height says why, the same words the Spaces list shows on the disabled action", () => {
    const m = commit(officeModel(), { type: "create_space", spaces: [{ spaceId: "s102", number: "102", name: "Storage", levelId: "lvl-1", outline: OFFICE.map((p) => ({ x: p.x + 30 * FT, y: p.y })) }] });
    const space = m.elements.s102 as Space;
    const why = makeCeilingFromHeightRefusal(m.elements, space);
    expect(why).toBe("102 Storage has no ceiling height stated. Type one in its row first, or draw the ceiling on a ceiling plan");
    const r = tryCommit(m, { type: "make_ceiling_from_space_height", spaceId: "s102" });
    expect(r.ok ? "" : r.message).toBe(why);
    const typed = commit(m, { type: "create_space", spaces: [{ spaceId: "s103", number: "103", name: "Future", ceilingHeightMm: 9 * FT }] });
    expect(makeCeilingFromHeightRefusal(typed.elements, typed.elements.s103 as Space)).toBe("103 Future isn't on a level yet. Draw it on a plan first");
  });
});
