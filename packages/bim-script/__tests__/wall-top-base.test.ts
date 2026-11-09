/**
 * @jest-environment node
 *
 * `building.walls` / `building.wall` take a `top` (a level and offset, the
 * structure above, a ceiling, a roof) and a `base` (the slab below, an offset
 * off the level) and send them as the kernel's own fields. Fails on the
 * previous kit: walls took only a fixed height.
 */
import { building, units, type ScriptContext } from "../src";

function recorder() {
  const sent: unknown[] = [];
  const ctx = { id: (p?: string) => `${p ?? "x"}-1`, edit: (c: unknown) => void sent.push(c) } as unknown as ScriptContext;
  return { ctx, sent };
}

const A = { x: units.ft(0), y: units.ft(0) };
const B = { x: units.ft(20), y: units.ft(0) };

describe("kit walls: top and base", () => {
  it("a surface top, a level top with an offset, and a base on the slab below", () => {
    const { ctx, sent } = recorder();
    building.walls(ctx, { level: "L1", points: [A, B], top: "structure above" });
    building.walls(ctx, { level: "L1", points: [A, B], top: { level: "L2", offset: units.in(-6) }, base: "slab below" });
    building.wall(ctx, { level: "L1", from: A, to: B, top: { to: "ceiling", offset: units.in(6) }, base: { offset: units.in(4) } });
    building.wall(ctx, { level: "L1", from: A, to: B, top: "roof" });
    expect(sent).toEqual([
      expect.objectContaining({ type: "create_elements", topSurface: { to: "structure" } }),
      expect.objectContaining({ topLevelId: "L2", topOffsetMm: -152.4, baseSurface: { to: "floor" } }),
      expect.objectContaining({ points: [{ x: 0, y: 0 }, { x: 6096, y: 0 }], topSurface: { to: "ceiling", offsetMm: 152.4 }, baseOffsetMm: 101.6 }),
      expect.objectContaining({ topSurface: { to: "roof" } }),
    ]);
  });

  it("a height beside a top is refused in words", () => {
    const { ctx } = recorder();
    expect(() => building.walls(ctx, { level: "L1", points: [A, B], height: units.ft(10), top: "ceiling" })).toThrow("Give a wall either a height or a top, not both.");
  });
});
