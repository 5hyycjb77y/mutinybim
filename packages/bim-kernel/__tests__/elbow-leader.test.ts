/**
 * @jest-environment node
 *
 * U9: tag elbow leaders, pure geometry. A leader leaves the tag level on the
 * side facing its element, takes a short shoulder and bends once; a hand
 * elbow wins; tags placed together keep clear of each other and of each
 * other's leaders; a tag placed by hand never moves.
 */
import { elbowLeaderPath, elbowLeaderSegments, placeTagsClear, segmentsCross, snapPaper, SHOULDER_MM, type PaperBox, type ElbowTagPlacement } from "../src/annotation/elbow-leader";

const box = (x: number, y: number, w = 10, h = 4): PaperBox => ({ min: { x, y }, max: { x: x + w, y: y + h } });
const overlaps = (a: PaperBox, b: PaperBox) => a.min.x < b.max.x && a.max.x > b.min.x && a.min.y < b.max.y && a.max.y > b.min.y;

describe("elbowLeaderPath", () => {
  it("leaves the tag level on the side facing the element, shoulders out, then bends once to it", () => {
    const l = elbowLeaderPath(box(0, 0), { x: 30, y: 20 });
    expect(l?.side).toBe("right");
    expect(l?.points).toEqual([
      { x: 10, y: 2 },
      { x: 10 + SHOULDER_MM, y: 2 },
      { x: 30, y: 20 },
    ]);
    expect(l?.handElbow).toBe(false);
    const left = elbowLeaderPath(box(0, 0), { x: -25, y: -8 });
    expect(left?.side).toBe("left");
    expect(left?.points[0]).toEqual({ x: 0, y: 2 });
    expect(left?.points[1]).toEqual({ x: -SHOULDER_MM, y: 2 });
  });

  it("runs straight when the element is level with the tag or nearer than the shoulder, and draws nothing when it is under the tag", () => {
    expect(elbowLeaderPath(box(0, 0), { x: 40, y: 2.2 })?.points).toHaveLength(2);
    expect(elbowLeaderPath(box(0, 0), { x: 11.5, y: 15 })?.points).toHaveLength(2);
    expect(elbowLeaderPath(box(0, 0), { x: 5, y: 2 })).toBeNull();
    expect(elbowLeaderPath(box(0, 0), { x: 10.8, y: 2 })).toBeNull();
  });

  it("a hand elbow wins over the automatic shoulder, and one placed nearly level snaps level", () => {
    const hand = elbowLeaderPath(box(0, 0), { x: 30, y: 20 }, { x: -6, y: 9 });
    expect(hand?.handElbow).toBe(true);
    expect(hand?.side).toBe("left");
    expect(hand?.points).toEqual([
      { x: 0, y: 2 },
      { x: -6, y: 9 },
      { x: 30, y: 20 },
    ]);
    const nearlyLevel = elbowLeaderPath(box(0, 0), { x: 30, y: 20 }, { x: 18, y: 2.3 });
    expect(nearlyLevel?.points[1]).toEqual({ x: 18, y: 2 });
  });

  it("is crisp: every point sits on a hundredth of a millimetre and the shoulder is exactly level", () => {
    const l = elbowLeaderPath({ min: { x: 0.123456, y: 0.987654 }, max: { x: 10.333333, y: 4.777777 } }, { x: 31.0049, y: 19.99999 });
    for (const p of l?.points ?? []) {
      expect(Math.round(p.x * 100) / 100).toBe(p.x);
      expect(Math.round(p.y * 100) / 100).toBe(p.y);
    }
    expect(l?.points[0]?.y).toBe(l?.points[1]?.y);
    expect(snapPaper({ x: 1.005, y: -2.0049 })).toEqual({ x: 1, y: -2 });
  });

  it("refuses a point that is not a number instead of drawing garbage", () => {
    expect(() => elbowLeaderPath(box(0, 0), { x: Number.NaN, y: 0 })).toThrow(/not a finite paper point/);
  });
});

describe("placeTagsClear", () => {
  const grid = (spacing: number) => Array.from({ length: 16 }, (_, i) => ({ id: `t${String(i).padStart(2, "0")}`, target: { x: (i % 4) * spacing, y: Math.floor(i / 4) * spacing }, size: { w: 8, h: 3.4 } }));
  const cluster = grid(6);

  function assertClear(placed: readonly ElbowTagPlacement[]): void {
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i] as ElbowTagPlacement;
        const b = placed[j] as ElbowTagPlacement;
        expect({ pair: [a.id, b.id], overlap: overlaps(a.box, b.box) }).toEqual({ pair: [a.id, b.id], overlap: false });
        for (const [p, q] of a.leader ? elbowLeaderSegments(a.leader) : []) for (const [r, s] of b.leader ? elbowLeaderSegments(b.leader) : []) expect({ pair: [a.id, b.id], cross: segmentsCross(p, q, r, s) }).toEqual({ pair: [a.id, b.id], cross: false });
      }
    }
  }

  it("sixteen 8 mm tags on elements 6 mm apart all land clear of each other and of each other's leaders", () => {
    const placed = placeTagsClear(cluster, []);
    expect(placed.every((p) => p.clear)).toBe(true);
    assertClear(placed);
    for (const p of placed) expect(p.leader).not.toBeNull();
  });

  it("a crowd too dense to tag cleanly (2 mm apart) says which tags need a hand, and still never stacks one tag on another", () => {
    const placed = placeTagsClear(grid(2), []);
    const unclear = placed.filter((p) => !p.clear).map((p) => p.id);
    expect(unclear.length).toBeGreaterThan(0);
    expect(unclear.length).toBeLessThan(8);
    for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) expect(overlaps(placed[i]!.box, placed[j]!.box)).toBe(false);
  });

  it("is deterministic: the same tags in any order land in the same places", () => {
    const a = placeTagsClear(cluster, []);
    const b = placeTagsClear([...cluster].reverse(), []);
    const byId = new Map(b.map((p) => [p.id, p.head]));
    for (const p of a) expect(byId.get(p.id)).toEqual(p.head);
  });

  it("a tag placed by hand never moves, keeps its hand elbow, and the others keep clear of it", () => {
    const hand = { id: "hand", target: { x: 0, y: 0 }, size: { w: 8, h: 3.4 }, hand: { head: { x: 9, y: -6 }, elbow: { x: 3, y: -1 } } };
    const placed = placeTagsClear([...cluster, hand], []);
    const h = placed.find((p) => p.id === "hand");
    expect(h?.source).toBe("hand");
    expect(h?.head).toEqual({ x: 9, y: -6 });
    expect(h?.leader?.handElbow).toBe(true);
    expect(h?.leader?.points[1]).toEqual({ x: 3, y: -1 });
    assertClear(placed);
  });

  it("keeps clear of notes and dimensions already on the drawing, but may point into the tagged element's own outline", () => {
    const note = box(2, -14, 20, 10);
    const own = box(-1, -1, 2, 2);
    const [p] = placeTagsClear([{ id: "a", target: { x: 0, y: 0 }, size: { w: 8, h: 3.4 } }], [note, own]);
    expect(p?.clear).toBe(true);
    expect(overlaps(p!.box, note)).toBe(false);
  });

  it("says which tag found no clear spot instead of stacking it silently", () => {
    const wall = box(-200, -200, 400, 400);
    const [p] = placeTagsClear([{ id: "boxed-in", target: { x: 300, y: 300 }, size: { w: 8, h: 3.4 } }], [wall], { rings: 1, stepMm: 1 });
    expect(p?.clear).toBe(true);
    const [q] = placeTagsClear([{ id: "boxed-in", target: { x: 0, y: 0 }, size: { w: 8, h: 3.4 } }], [wall, box(-1, -1, 2, 2)], { rings: 2 });
    expect(q?.clear).toBe(false);
  });

  it("refuses a tag listed twice and nonsense options", () => {
    expect(() => placeTagsClear([cluster[0]!, cluster[0]!], [])).toThrow(/listed twice/);
    expect(() => placeTagsClear(cluster, [], { rings: 0 })).toThrow(/whole number of rings/);
  });
});
