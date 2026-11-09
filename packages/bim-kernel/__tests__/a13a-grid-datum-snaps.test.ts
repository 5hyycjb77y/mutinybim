/**
 * @jest-environment node
 *
 * Round 13 lane A13a: datums. Placement, routing and drafting tools ask
 * `datumSnapLines(model, levelId)` and get every grid line (through every
 * level) and every reference plane on that level, from the kernel's own
 * `kernel.datum` rows; an add-on's datum row joins them with no kernel edit.
 * Grid labels advance by themselves (A, B, C… skipping I and O; 1, 2, 3…).
 *
 * Fails on round 12's code: there was no datum point, no `datumSnapLines`,
 * no grid-label helper and no `create_element` to draw a grid line with.
 */
import { asElementId, datumRow, datumSnapLines, DATUM_POINT, type BimElement, type ModelState } from "../src";
import { contribute, definePack, PackSet, withPackSet } from "../src/packs";
import { advanceGridLabel, nextGridLabel } from "../src/datums/grid-labels";
import { twoLevels } from "./a13a-fixtures";

const L1 = asElementId("L1");
const L2 = asElementId("L2");

describe("a13a grid datum snaps", () => {
  it("a tool asks datumSnapLines and gets the grid line, on every level, with its label and axis family", () => {
    const m = twoLevels();
    m.ok({ type: "create_element", elementId: "g-1", kind: "grid", levelId: "L1", placement: { kind: "line", start: { x: 0, y: -1000 }, end: { x: 0, y: 9000 } } });
    m.ok({ type: "create_element", elementId: "g-a", kind: "grid", levelId: "L1", placement: { kind: "line", start: { x: -1000, y: 0 }, end: { x: 12_000, y: 0 } } });
    const lines = datumSnapLines(m.head, L1);
    expect(lines).toEqual([
      { datumId: "g-1", label: "1", start: { x: 0, y: -1000 }, end: { x: 0, y: 9000 }, axisFamily: "U" },
      { datumId: "g-a", label: "A", start: { x: -1000, y: 0 }, end: { x: 12_000, y: 0 }, axisFamily: "V" },
    ]);
    expect(datumSnapLines(m.head, L2).map((l) => l.datumId)).toEqual(["g-1", "g-a"]);
    const grid = m.head.elements["g-1"];
    expect(grid && datumRow("grid")?.labelOf(grid, m.head.elements)).toBe("Grid 1");
  });

  it("a level is a horizontal datum: no snap lines, its elevation and name", () => {
    const m = twoLevels();
    const level = m.head.elements["L2"] as BimElement;
    const row = datumRow("level");
    expect(row?.snapLines(level, m.head.elements, L2)).toEqual([]);
    expect(row?.elevationMm?.(level)).toBe(4000);
    expect(row?.labelOf(level, m.head.elements)).toBe("Level 2");
  });

  it("grid labels advance by themselves as lines are drawn, and a label in use is refused in words", () => {
    const m = twoLevels();
    for (let i = 0; i < 3; i++) m.ok({ type: "create_element", elementId: `v${i}`, kind: "grid", levelId: "L1", placement: { kind: "line", start: { x: i * 6000, y: 0 }, end: { x: i * 6000, y: 9000 } } });
    for (let i = 0; i < 9; i++) m.ok({ type: "create_element", elementId: `h${i}`, kind: "grid", levelId: "L1", placement: { kind: "line", start: { x: 0, y: i * 3000 }, end: { x: 12_000, y: i * 3000 } } });
    const labels = (prefix: string) => Object.values(m.head.elements).flatMap((e) => (e.kind === "grid" && e.id.startsWith(prefix) ? [e.label] : []));
    expect(labels("v")).toEqual(["1", "2", "3"]);
    expect(labels("h")).toEqual(["A", "B", "C", "D", "E", "F", "G", "H", "J"]);
    expect(m.refused({ type: "create_element", elementId: "dup", kind: "grid", levelId: "L1", label: "B", placement: { kind: "line", start: { x: 0, y: 1 }, end: { x: 9, y: 1 } } })).toBe(
      "There is already a grid line B; give this one another label, or leave the label out to take the next one",
    );
  });

  it("the pure label helpers skip I and O (or the firm's own list) and roll over past Z", () => {
    expect(advanceGridLabel("H")).toBe("J");
    expect(advanceGridLabel("N")).toBe("P");
    expect(advanceGridLabel("Z")).toBe("AA");
    expect(advanceGridLabel("AH")).toBe("AJ");
    expect(advanceGridLabel("9")).toBe("10");
    expect(advanceGridLabel("C-9")).toBe("C-10");
    expect(advanceGridLabel("I")).toBeNull();
    expect(advanceGridLabel("I", { skipLetters: [] })).toBe("J");
    expect(nextGridLabel([], "letters")).toBe("A");
    expect(nextGridLabel(["A", "C", "2"], "letters")).toBe("D");
    expect(nextGridLabel(["A", "C", "2"], "numbers")).toBe("3");
    expect(nextGridLabel(["A", "B"], "letters", { skipLetters: ["C"] })).toBe("D");
  });

  it("an outside add-on's datum row joins the kernel's with no kernel edit", () => {
    const m = twoLevels();
    m.ok({ type: "create_element", elementId: "g-1", kind: "grid", levelId: "L1", placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 0, y: 9000 } } });
    const pack = definePack({ id: "zz", name: "ZZ", version: "1.0.0", kernel: "^1.11.0" }, [
      contribute(DATUM_POINT, [{ kind: "zz.site_line", label: "Site line", labelOf: () => "S1", snapLines: (el, _e, levelId) => (el.id === "site-1" && levelId === "L1" ? [{ datumId: el.id, label: "S1", start: { x: 0, y: 0 }, end: { x: 10, y: 0 } }] : []) }]),
    ]);
    const site = { id: asElementId("site-1"), version: 1, authoredRev: {}, kind: "zz.site_line" } as unknown as BimElement;
    const withSite: ModelState = { ...m.head, elements: { ...m.head.elements, [site.id]: site } };
    withPackSet(PackSet.create([pack]), () => {
      expect(datumSnapLines(withSite, L1).map((l) => l.label).sort()).toEqual(["1", "S1"]);
    });
  });
});
