/**
 * @jest-environment node
 *
 * Round 5b f-spatial: room outlines proposed from a drawing's linework (F3
 * remainder, "Trace over PDF on 9330 keeps door gaps"). Pure kernel geometry:
 * the host passes the calibrated underlay's lines in model mm.
 *
 * Fails on the old code: there was no detector (`spaces/detect` didn't
 * exist), so nothing could propose a room, let alone keep its doors.
 */
import { detectRoomOutlines, type LineworkSegment } from "../src/spaces/detect";
import { outlineAreaMm2, selfIntersects } from "../src/spaces/space-geometry";
import type { Vec2 } from "../src/types";

const T = 150; // wall thickness, mm (two drawn faces)
const DOOR = 900;

const seg = (ax: number, ay: number, bx: number, by: number): LineworkSegment => ({ a: { x: ax, y: ay }, b: { x: bx, y: by } });

/** A horizontal wall from x0 to x1 at y (centre), both faces drawn, with door gaps [from, to] along it. */
function hWall(x0: number, x1: number, y: number, gaps: ReadonlyArray<readonly [number, number]> = []): LineworkSegment[] {
  const out: LineworkSegment[] = [];
  const cuts = [x0, ...gaps.flatMap(([a, b]) => [a, b]), x1];
  for (let i = 0; i + 1 < cuts.length; i += 2) {
    const a = cuts[i] as number;
    const b = cuts[i + 1] as number;
    out.push(seg(a, y - T / 2, b, y - T / 2), seg(a, y + T / 2, b, y + T / 2));
    if (i > 0) out.push(seg(a, y - T / 2, a, y + T / 2)); // jamb
    if (i + 2 < cuts.length) out.push(seg(b, y - T / 2, b, y + T / 2));
  }
  return out;
}

function vWall(y0: number, y1: number, x: number, gaps: ReadonlyArray<readonly [number, number]> = []): LineworkSegment[] {
  return hWall(y0, y1, x, gaps).map((s) => ({ a: { x: s.a.y, y: s.a.x }, b: { x: s.b.y, y: s.b.x } }));
}

/** 20 x 10 rooms of 4 m (80 x 40 m), a door through every inner east-west wall. */
function twoHundredRoomFloor(): LineworkSegment[] {
  const lines: LineworkSegment[] = [];
  const cols = 20;
  const rows = 10;
  const s = 4_000;
  for (let j = 0; j <= rows; j++) lines.push(...hWall(0, cols * s, j * s, j > 0 && j < rows ? Array.from({ length: cols }, (_, i) => [i * s + 1_000, i * s + 1_000 + DOOR] as const) : []));
  for (let i = 0; i <= cols; i++) lines.push(...vWall(0, rows * s, i * s));
  return lines;
}

/** A door drawn open at the hinge: the leaf into the room and its quarter-circle swing, tessellated as a PDF exports it. */
function swing(cx: number, cy: number, r: number, from: number): LineworkSegment[] {
  const out: LineworkSegment[] = [];
  const n = 12;
  for (let k = 0; k < n; k++) {
    const a0 = from + (k / n) * (Math.PI / 2);
    const a1 = from + ((k + 1) / n) * (Math.PI / 2);
    out.push(seg(cx + r * Math.cos(a0), cy + r * Math.sin(a0), cx + r * Math.cos(a1), cy + r * Math.sin(a1)));
  }
  out.push(seg(cx, cy, cx + r * Math.cos(from), cy + r * Math.sin(from)));
  return out;
}

/** 12 m x 8 m, three 4 m rooms in a row; a door between each pair and an entrance into the first. */
function threeRooms(): LineworkSegment[] {
  return [
    ...hWall(0, 12_000, 0, [[1_500, 1_500 + DOOR]]), // south, with the entrance
    ...hWall(0, 12_000, 8_000),
    ...vWall(0, 8_000, 0),
    ...vWall(0, 8_000, 12_000),
    ...vWall(0, 8_000, 4_000, [[3_000, 3_000 + DOOR]]),
    ...vWall(0, 8_000, 8_000, [[5_000, 5_000 + DOOR]]),
    ...swing(4_000 + T / 2, 3_000, DOOR, 0), // swing into the middle room
  ];
}

function inside(poly: readonly Vec2[], p: Vec2): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i] as Vec2;
    const b = poly[j] as Vec2;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

describe("r5z room outlines from a drawing's linework", () => {
  it("finds the three rooms behind doors, each outline closed across its door gaps", () => {
    const r = detectRoomOutlines(threeRooms());
    if (!r.ok) throw new Error(r.reason);
    expect(r.rooms).toHaveLength(3);
    const centres = [2_000, 6_000, 10_000];
    for (const cx of centres) {
      const room = r.rooms.find((x) => inside(x.outline, { x: cx, y: 4_000 }));
      expect(room).toBeDefined();
      if (!room) continue;
      expect(selfIntersects(room.outline)).toBe(false);
      // 4 m x 8 m to the wall centres; the room is inside the faces (about 3.85 x 7.85), give or take a grid cell and a door bump.
      expect(room.areaM2).toBeGreaterThan(28);
      expect(room.areaM2).toBeLessThan(32.5);
      expect(outlineAreaMm2(room.outline) / 1e6).toBeCloseTo(room.areaM2, 1);
      // No room swallows a neighbour.
      for (const other of centres.filter((c) => c !== cx)) expect(inside(room.outline, { x: other, y: 4_000 })).toBe(false);
    }
  });

  it("keeps the doors: each room says where its openings are and about how wide", () => {
    const r = detectRoomOutlines(threeRooms());
    if (!r.ok) throw new Error(r.reason);
    const at = (cx: number) => r.rooms.find((x) => inside(x.outline, { x: cx, y: 4_000 }));
    expect(at(2_000)?.openings).toHaveLength(2); // the entrance and the door to the middle room
    expect(at(6_000)?.openings).toHaveLength(2);
    expect(at(10_000)?.openings).toHaveLength(1);
    for (const room of r.rooms) {
      for (const o of room.openings) {
        expect(o.widthMm).toBeGreaterThan(DOOR - 300);
        expect(o.widthMm).toBeLessThan(DOOR + 400);
      }
      expect(room.confidence).toBeGreaterThan(0.8);
      expect(room.confidence).toBeLessThan(1);
    }
  });

  it("the door swing in the middle room is not a room of its own", () => {
    const r = detectRoomOutlines(threeRooms());
    if (!r.ok) throw new Error(r.reason);
    expect(r.rooms.every((x) => x.areaM2 > 2)).toBe(true);
  });

  it("is deterministic: the same drawing gives the same proposals and keys", () => {
    const a = detectRoomOutlines(threeRooms());
    const b = detectRoomOutlines(threeRooms());
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("a sheet border around the plan is not proposed as a room", () => {
    const frame = [seg(-5_000, -5_000, 17_000, -5_000), seg(17_000, -5_000, 17_000, 13_000), seg(17_000, 13_000, -5_000, 13_000), seg(-5_000, 13_000, -5_000, -5_000)];
    const r = detectRoomOutlines([...threeRooms(), ...frame]);
    if (!r.ok) throw new Error(r.reason);
    expect(r.rooms).toHaveLength(3);
  });

  it("lines that close nothing give no rooms (the panel says to check the scale)", () => {
    const r = detectRoomOutlines([seg(0, 0, 10_000, 0), seg(0, 3_000, 10_000, 3_000)]);
    expect(r).toMatchObject({ ok: true, rooms: [] });
  });

  it("a scale that is far off is refused in plain words", () => {
    const tiny = detectRoomOutlines([seg(0, 0, 100, 0), seg(100, 0, 100, 100), seg(100, 100, 0, 100), seg(0, 100, 0, 0)]);
    expect(!tiny.ok && tiny.reason).toMatch(/only 0.3 ft across.*Check the scale/);
    const huge = detectRoomOutlines([seg(0, 0, 5e6, 0), seg(5e6, 0, 5e6, 5e6)]);
    expect(!huge.ok && huge.reason).toMatch(/16,404 ft across.*Check the scale/);
    expect(detectRoomOutlines([])).toEqual({ ok: false, reason: expect.stringMatching(/no drawn lines/) });
  });

  // The time budget is `spaces.detect_rooms.200` in the BIM perf gate (plain node, 150 ms p50).
  // Jest's sandbox runs this floor ~18x slower than the browser, so a clock here measures Jest.
  it("a floor of 200 rooms is read in one pass over a capped grid", () => {
    const lines = twoHundredRoomFloor();
    const fine = detectRoomOutlines(lines);
    if (!fine.ok) throw new Error(fine.reason);
    expect(fine.rooms).toHaveLength(200);
    expect(fine.cellMm).toBe(50);
    // A tight cap coarsens the grid instead of growing it, and the rooms still come out.
    const capped = detectRoomOutlines(lines, { maxCells: 300_000 });
    if (!capped.ok) throw new Error(capped.reason);
    expect(capped.rooms).toHaveLength(200);
    expect(capped.cellMm).toBeGreaterThan(100);
  });
});
