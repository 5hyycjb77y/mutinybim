/**
 * @jest-environment node
 *
 * A wall run to the underside of a pitched roof is drawn in 3D with a sloped
 * top that meets the roof's underside, and the roof itself is drawn pitched.
 * Fails on the previous code: a wall was always a flat box `height` tall and
 * a roof's slope was stored but drawn flat.
 */
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import { twoLevels } from "../../bim-kernel/__tests__/a13a-fixtures";
import { MM } from "../src/coords";
import { elementSolids, type Solid } from "../src/native-geometry";

installFirstPartyAddOns();

const FOOTPRINT = [
  { x: 0, y: 0 },
  { x: 10_000, y: 0 },
  { x: 10_000, y: 8000 },
  { x: 0, y: 8000 },
];

/** World mm heights of a mesh solid's vertices. */
function heights(s: Solid): number[] {
  const p = s.mesh?.positions;
  if (!p) return [s.center[1] / MM - s.size[1] / MM / 2, s.center[1] / MM + s.size[1] / MM / 2];
  const out: number[] = [];
  for (let i = 1; i < p.length; i += 3) out.push(Math.round(((p[i] ?? 0) + s.center[1]) / MM));
  return out;
}

describe("walls bound to a pitched roof in 3D", () => {
  it("the wall's top slopes with the roof's underside; the roof is drawn pitched", () => {
    const m = twoLevels("viewer-surface-bind");
    m.ok({ type: "create_element", elementId: "r", kind: "architecture.roof", levelId: "L2", placement: { kind: "area", outline: FOOTPRINT }, values: { "architecture.slope_rise": 0.25, "architecture.slope_direction_deg": 90 } });
    m.ok({ type: "create_element", elementId: "g", kind: "wall", levelId: "L1", placement: { kind: "line", start: { x: 1000, y: 1000 }, end: { x: 1000, y: 7000 } }, topSurface: { to: "roof" } });
    const wall = m.head.elements.g;
    const roof = m.head.elements.r;
    if (!wall || !roof) throw new Error("not drawn");
    const [body] = elementSolids(wall, undefined, m.head);
    if (!body) throw new Error("the wall has no body");
    const zs = heights(body);
    // The base stays on Level 1; the top runs from 4250 at its south end to 5750 at its north end (a 3 in 12 roof).
    expect(Math.min(...zs)).toBe(0);
    expect(Math.max(...zs)).toBe(5750);
    expect(zs).toContain(4250);
    const roofZs = elementSolids(roof, undefined, m.head).flatMap(heights);
    // Its underside runs from 4000 on the low edge to 6000 eight metres up the slope.
    expect(Math.min(...roofZs)).toBe(4000);
    expect(Math.max(...roofZs)).toBe(6000 + 250);
  });
});
