/**
 * @jest-environment node
 *
 * A door or window takes its sill height on the command that places it (the
 * opening's `opening.sill_mm` value) and when it is changed later; the wall's
 * cut follows it. A sill that would push the head above the top of the wall,
 * or below its base, is refused in words before anything is written.
 *
 * Fails on the old code: any sill was accepted, so a 7 ft sill under a 4 ft
 * window in a 9 ft wall cut a hole through the top of the wall.
 */
import { OPENING_SILL_KEY, hostVoidsOf } from "../src";
import { twoLevels } from "./a13a-fixtures";

const FT = 304.8;

function wallAndWindow(sillMm?: number) {
  const m = twoLevels("s4d-sill");
  m.ok({ type: "create_element", elementId: "w1", kind: "wall", levelId: "L1", placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 6000, y: 0 } }, size: { thicknessMm: 200, heightMm: 9 * FT } });
  return { m, place: () => ({ type: "create_hosted" as const, elementId: "win1", kind: "opening", openingType: "window", hostId: "w1", s: 3000, side: 1 as const, mark: "W1", size: { widthMm: 900, heightMm: 4 * FT }, ...(sillMm !== undefined ? { values: { [OPENING_SILL_KEY]: sillMm } } : {}) }) };
}

describe("s4d: window sill height", () => {
  it("a window placed with a 3'-0\" sill cuts the wall from 3'-0\" to 7'-0\"", () => {
    const { m, place } = wallAndWindow(3 * FT);
    m.ok(place());
    const cut = hostVoidsOf(m.head.elements, "w1").find((v) => v.elementId === "win1");
    const ys = cut?.profile.map((p) => p.y) ?? [];
    expect(Math.min(...ys)).toBeCloseTo(3 * FT, 3);
    expect(Math.max(...ys)).toBeCloseTo(7 * FT, 3);
  });

  it("a sill that puts the head above the top of the wall is refused in words", () => {
    const { m, place } = wallAndWindow(6 * FT);
    expect(m.refused(place())).toMatch(/puts its head at 3048 mm, above the top of wall w1 \(2743 mm\)\. Lower the sill or make the window shorter/);
  });

  it("changing a placed window's sill is checked the same way, and a good change moves the cut", () => {
    const { m, place } = wallAndWindow();
    m.ok(place());
    expect(m.refused({ type: "set_element_values", elementIds: ["win1"], values: { [OPENING_SILL_KEY]: 7 * FT } })).toMatch(/window W1 is 1219 mm tall.*above the top of/);
    expect(m.refused({ type: "set_element_values", elementIds: ["win1"], values: { [OPENING_SILL_KEY]: -10 } })).toMatch(/can't be below the bottom/);
    m.ok({ type: "set_element_values", elementIds: ["win1"], values: { [OPENING_SILL_KEY]: 2 * FT } });
    const ys = hostVoidsOf(m.head.elements, "w1").find((v) => v.elementId === "win1")?.profile.map((p) => p.y) ?? [];
    expect(Math.min(...ys)).toBeCloseTo(2 * FT, 3);
  });
});
