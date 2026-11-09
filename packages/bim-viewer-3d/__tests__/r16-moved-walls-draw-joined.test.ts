/**
 * @jest-environment node
 *
 * Round 16 lane r16-walls: after a move, the live 3D model and plan still
 * draw clean corners and tees. The reviewer (7810) moved one wall of a closed room;
 * its neighbours stayed behind, so 3D showed the moved wall's ends poking
 * past open corners and the plan drew four separate boxes.
 *
 * Moving one side of a room now carries its neighbours (kernel
 * `joins/carry.ts`), so the four joined bodies still tile the new room's ring
 * of wall exactly, and a partition teed into the moved wall stops at its face.
 *
 * Fails on round 15's code: after the move the corners are free, the bodies
 * overlap and leave notches (the ring volume is off), and the partition's
 * end no longer reaches the moved wall.
 */
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import { lineJoinPlanGraphics, type ModelState } from "@permitzip/bim-kernel";
import { twoLevels } from "../../bim-kernel/__tests__/a13a-fixtures";
import { MM } from "../src/coords";
import { elementSolids, type Solid } from "../src/native-geometry";

installFirstPartyAddOns();

const H = 3000;
const T = 200;
const P = 100;

/** A closed mesh's volume, mm³ (divergence theorem over its triangles); a box's from its size. */
function volumeMm3(s: Solid): number {
  const p = s.mesh?.positions;
  const idx = s.mesh?.indices;
  if (!p || !idx) return s.size[0] * s.size[1] * s.size[2] * 1e9;
  const at = (i: number): [number, number, number] => [((p[i * 3] ?? 0) + s.center[0]) / MM, ((p[i * 3 + 1] ?? 0) + s.center[1]) / MM, ((p[i * 3 + 2] ?? 0) + s.center[2]) / MM];
  let v = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [at(idx[t] ?? 0), at(idx[t + 1] ?? 0), at(idx[t + 2] ?? 0)];
    v += a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  }
  return Math.abs(v / 6);
}

const volumeOf = (model: ModelState, ids: readonly string[]): number =>
  ids.reduce((sum, id) => {
    const el = model.elements[id];
    return sum + (el ? elementSolids(el, undefined, model).reduce((s, solid) => s + volumeMm3(solid), 0) : 0);
  }, 0);

function roomWithPartition() {
  const m = twoLevels("r16-draw");
  m.ok({ type: "create_elements", idPrefix: "w", kind: "wall", levelId: "L1", points: [{ x: 0, y: 0 }, { x: 6000, y: 0 }, { x: 6000, y: 4000 }, { x: 0, y: 4000 }], closed: true, size: { thicknessMm: T, heightMm: H } });
  m.ok({ type: "create_element", elementId: "p", kind: "wall", levelId: "L1", size: { thicknessMm: P, heightMm: H }, placement: { kind: "line", start: { x: 3000, y: 4000 }, end: { x: 3000, y: 0 } } });
  return m;
}

describe("r16 moved walls still draw joined", () => {
  it("moving the east wall 1 m out: the room's four bodies tile the bigger ring exactly in 3D", () => {
    const m = roomWithPartition();
    m.ok({ type: "move_elements", ids: ["w-2"], delta: { x: 1000, y: 0 } });
    const model = m.head as ModelState;
    const ring = ((7000 + T) * (4000 + T) - (7000 - T) * (4000 - T)) * H;
    expect(volumeOf(model, ["w-1", "w-2", "w-3", "w-4"]) / ring).toBeCloseTo(1, 6);
  });

  it("moving the south wall 600 mm down: the partition teed into it stretches and stops at its inner face", () => {
    const m = roomWithPartition();
    m.ok({ type: "move_elements", ids: ["w-1"], delta: { x: 0, y: -600 } });
    const model = m.head as ModelState;
    // Inside the room the partition runs face to face: (4000 + 600) less a half wall at each end.
    expect(volumeOf(model, ["p"]) / ((4600 - T) * P * H)).toBeCloseTo(1, 6);
    const ring = ((6000 + T) * (4600 + T) - (6000 - T) * (4600 - T)) * H;
    expect(volumeOf(model, ["w-1", "w-2", "w-3", "w-4"]) / ring).toBeCloseTo(1, 6);
  });

  it("the plan draws the moved wall's faces round both corners, with no line across a free end", () => {
    const m = roomWithPartition();
    m.ok({ type: "move_elements", ids: ["w-2"], delta: { x: 1000, y: 0 } });
    const model = m.head as ModelState;
    const el = model.elements["w-2"];
    if (!el) throw new Error("no w-2");
    const graphics = lineJoinPlanGraphics(el, { elements: model.elements, scale: 100, levelId: "L1", detail: "medium", drawing: "view", lookingUp: false, connectedTo: () => null });
    // Its two faces, carried round both corners; a free end would add a line across the wall (and round 15 drew none: null, a plain box).
    expect(graphics).toHaveLength(2);
  });
});
