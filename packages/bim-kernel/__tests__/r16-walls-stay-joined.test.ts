/**
 * @jest-environment node
 *
 * Round 16 lane r16-walls (gap audit D, ranked 5): walls stay joined when
 * moved. The product owner drew closed loops on 7810 (shared corners, `closed: true`),
 * then moved single walls. Each moved wall left its neighbours behind, so
 * the corners opened 6 to 12 inches and stopped joining. The moved wall also
 * kept two disagreeing copies of its line: `start` / `end` moved, the stored
 * `placement` stayed where it was drawn.
 *
 * Now a move carries what is joined to it (kernel `joins/carry.ts`, for any
 * line-placed kind whose join row has `withLine`): a corner goes where the
 * moved end went, a wall teed into a moved wall stays on its face, and a
 * moved wall teed into a still one stays on that face. Every line is written
 * once (`placement/line-face.ts`), so the placement always equals the line.
 *
 * Fails on round 15's code: after the move the neighbours' ends are where
 * they were (corners `free`, 152 / 305 mm gaps), and the moved wall's
 * placement still holds the old line.
 */
import { asElementId, type BimElement, type ModelState, type Vec2 } from "../src";
import { endCleanupsOf, LINE_JOIN_POINT, type EndCleanup } from "../src/joins/point";
import { contribute, definePack } from "../src/packs";
import { bindModelPacks, PackSet, unbindModelPacks } from "../src/packs";
import { faceOf } from "../src/placement/line-face";
import { element, Log, twoLevels } from "./a13a-fixtures";
import { modelWith, wall } from "./a13b-fixtures";

/** One of the 7810 rooms, 20 ft × 12 ft on centrelines, drawn as one closed loop. */
const FT = 304.8;
const ROOM: Vec2[] = [
  { x: -3048, y: -7620 },
  { x: -3048 + 20 * FT, y: -7620 },
  { x: -3048 + 20 * FT, y: -7620 + 12 * FT },
  { x: -3048, y: -7620 + 12 * FT },
];
/** What he moved one wall by (rev 101): 12" left, 6" up. */
const AVERY_MOVE = { x: -FT, y: FT / 2 };

function loop(): Log {
  const m = twoLevels("r16-walls");
  m.ok({ type: "create_elements", idPrefix: "w", kind: "wall", levelId: "L1", points: ROOM, closed: true, size: { thicknessMm: 152.4 } });
  return m;
}

function cleanups(m: ModelState, id: string): readonly EndCleanup[] {
  const r = endCleanupsOf(m, asElementId(id));
  if (!Array.isArray(r)) throw new Error(`no cleanups for ${id}`);
  return r;
}

type Line = { start: Vec2; end: Vec2; placement?: { kind: string; start?: Vec2; end?: Vec2; lateral?: "left" | "center" | "right" } };
function line(m: ModelState, id: string): Line {
  const el = element(m, id);
  if (el.kind !== "wall") throw new Error(`${id} is not a wall`);
  return el as unknown as Line;
}

/** The stored placement describes the same line as the flat fields (justification applied). */
function expectOneLine(m: ModelState, id: string): void {
  const el = element(m, id);
  if (el.kind !== "wall") throw new Error(`${id} is not a wall`);
  const p = el.placement;
  if (p?.kind !== "line") return;
  const face = faceOf(el.start, el.end, p.lateral, el.thickness);
  expect(Math.hypot(p.start.x - face.start.x, p.start.y - face.start.y)).toBeLessThan(0.01);
  expect(Math.hypot(p.end.x - face.end.x, p.end.y - face.end.y)).toBeLessThan(0.01);
}

const near = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

describe("r16 walls stay joined when moved", () => {
  it("the 7810 move: the moved wall carries both neighbours, every corner stays joined (no 6–12 inch gaps)", () => {
    const m = loop();
    const south = line(m.head, "w-1");
    const cs = m.ok({ type: "move_elements", ids: ["w-1"], delta: AVERY_MOVE });
    // Its two neighbours rode along in the same edit.
    expect(cs.elements.map((e) => e.id).sort()).toEqual(["w-1", "w-2", "w-4"]);
    const moved = line(m.head, "w-1");
    expect(near(line(m.head, "w-4").end, moved.start)).toBeLessThan(0.01);
    expect(near(line(m.head, "w-2").start, moved.end)).toBeLessThan(0.01);
    expect(near(moved.start, { x: south.start.x + AVERY_MOVE.x, y: south.start.y + AVERY_MOVE.y })).toBeLessThan(0.01);
    // The far ends did not move.
    expect(line(m.head, "w-4").start).toEqual(line(loop().head, "w-4").start);
    for (const id of ["w-1", "w-2", "w-3", "w-4"]) for (const c of cleanups(m.head, id)) expect(c.style).not.toBe("free");
  });

  it("one wall, one line: after a move the stored placement equals the moved line (the second copy no longer stays behind)", () => {
    const m = loop();
    m.ok({ type: "move_elements", ids: ["w-1"], delta: AVERY_MOVE });
    for (const id of ["w-1", "w-2", "w-3", "w-4"]) expectOneLine(m.head, id);
    m.ok({ type: "move_wall", wallId: "w-3", delta: { x: 0, y: 600 } });
    for (const id of ["w-1", "w-2", "w-3", "w-4"]) expectOneLine(m.head, id);
  });

  it("a record an older edit left disagreeing comes out agreeing after its next move", () => {
    const m = loop();
    const w = element(m.head, "w-1");
    if (w.kind !== "wall" || w.placement?.kind !== "line") throw new Error("w-1 has no line placement");
    // What 7810's 1f68bb22-1 holds: the line moved, the placement left where it was drawn.
    const drifted: BimElement = { ...w, start: { x: w.start.x - 305, y: w.start.y + 152 }, end: { x: w.end.x - 305, y: w.end.y + 152 } };
    const head: ModelState = { ...m.head, elements: { ...m.head.elements, [w.id]: drifted } };
    const log = new Log(head);
    log.ok({ type: "move_elements", ids: ["w-1"], delta: { x: 0, y: -100 } });
    expectOneLine(log.head, "w-1");
  });

  it("moving the wall another one tees into keeps the tee: the other stretches along its own line", () => {
    const m = loop();
    // A partition from the north wall down to the south wall's face, 3 m along.
    m.ok({ type: "create_element", elementId: "p", kind: "wall", levelId: "L1", size: { thicknessMm: 114 }, placement: { kind: "line", start: { x: -48, y: ROOM[2]?.y ?? 0 }, end: { x: -48, y: -7620 } } });
    expect(cleanups(m.head, "p")[1]?.style).toBe("tee");
    m.ok({ type: "move_elements", ids: ["w-1"], delta: { x: 0, y: -600 } });
    const p = line(m.head, "p");
    expect(near(p.end, { x: -48, y: -8220 })).toBeLessThan(0.01);
    expect(cleanups(m.head, "p")[1]?.style).toBe("tee");
  });

  it("moving a wall that tees into another keeps it on that face: it stretches instead of leaving a gap", () => {
    const m = loop();
    m.ok({ type: "create_element", elementId: "p", kind: "wall", levelId: "L1", size: { thicknessMm: 114 }, placement: { kind: "line", start: { x: -48, y: ROOM[2]?.y ?? 0 }, end: { x: -48, y: -7620 } } });
    // Slide the partition 1 m east and 300 mm south: its south end stays on the south wall, its north end on the north wall.
    m.ok({ type: "move_elements", ids: ["p"], delta: { x: 1000, y: -300 } });
    const p = line(m.head, "p");
    expect(near(p.end, { x: 952, y: -7620 })).toBeLessThan(0.01);
    expect(near(p.start, { x: 952, y: ROOM[2]?.y ?? 0 })).toBeLessThan(0.01);
    expect(cleanups(m.head, "p").map((c) => c.style)).toEqual(["tee", "tee"]);
  });

  it("walls moved together move rigidly; undo restores every wall exactly", () => {
    const m = loop();
    const lines = (): string => JSON.stringify(["w-1", "w-2", "w-3", "w-4"].map((id) => { const l = line(m.head, id); return [l.start, l.end, l.placement]; }));
    const before = lines();
    const cs = m.ok({ type: "move_elements", ids: ["w-1", "w-2", "w-3", "w-4"], delta: { x: 500, y: 500 } });
    expect(cs.elements.map((e) => e.id).sort()).toEqual(["w-1", "w-2", "w-3", "w-4"]);
    for (const id of ["w-1", "w-2", "w-3", "w-4"]) for (const c of cleanups(m.head, id)) expect(c.style).not.toBe("free");
    const one = m.ok({ type: "move_elements", ids: ["w-1"], delta: AVERY_MOVE });
    m.ok({ type: "undo", revision: one.revision });
    m.ok({ type: "undo", revision: cs.revision });
    expect(lines()).toBe(before);
  });

  it("a move that would shrink a neighbour to nothing is refused, naming it", () => {
    const m = loop();
    const msg = m.refused({ type: "move_elements", ids: ["w-2"], delta: { x: -20 * FT + 50, y: 0 } });
    expect(msg).toMatch(/w-(1|3)/);
  });

  it("Disallow join keeps that end where it is", () => {
    const m = loop();
    m.ok({ type: "set_element_values", elementIds: ["w-4"], values: { "join.disallow_end": true } });
    const was = line(m.head, "w-4").end;
    m.ok({ type: "move_elements", ids: ["w-1"], delta: { x: 0, y: -300 } });
    expect(line(m.head, "w-4").end).toEqual(was);
  });
});

describe("r16 joined ends follow for an add-on's line kind (kernel-general, not wall-specific)", () => {
  const ID = "r16-walls-addon";
  type Fence = { id: string; kind: "zz.fence"; start: Vec2; end: Vec2 };
  /** The add-on's own record, read the way an add-on reads one (the kernel types don't name its kind). */
  const fenceOf = (el: BimElement): Fence | null => {
    const r: unknown = el;
    return typeof r === "object" && r !== null && "kind" in r && r.kind === "zz.fence" && "start" in r && "end" in r ? (r as Fence) : null;
  };
  const fencePack = (withLine: boolean) =>
    definePack({ id: "zz", name: "Fence", version: "1.0.0", kernel: "^1.13.0" }, [
      contribute(LINE_JOIN_POINT, [
        {
          kind: "zz.fence",
          label: "Fence",
          styles: ["butt"],
          joinsWith: ["wall"],
          line: (el) => {
            const f = fenceOf(el);
            return f ? { start: f.start, end: f.end, widthMm: 50, levelId: asElementId("L1") } : null;
          },
          priority: () => 1,
          ...(withLine
            ? {
                withLine: (el: BimElement, l: { start: Vec2; end: Vec2 }) => {
                  const f = fenceOf(el);
                  return f ? ({ ...f, start: l.start, end: l.end } as unknown as BimElement) : el;
                },
              }
            : {}),
        },
      ]),
    ]);
  const fence = { id: asElementId("f"), kind: "zz.fence", version: 1, authoredRev: {}, start: { x: 6000, y: 0 }, end: { x: 9000, y: 0 } } as unknown as BimElement;

  afterEach(() => unbindModelPacks(ID));

  it("a fence whose row has withLine follows the wall it meets", () => {
    bindModelPacks(ID, PackSet.create([fencePack(true)]));
    const m = new Log(modelWith([wall("W", { x: 0, y: 0 }, { x: 6000, y: 0 }), fence], ID));
    const cs = m.ok({ type: "move_wall", wallId: "W", delta: { x: 0, y: 400 } });
    expect(cs.elements.map((e) => e.id).sort()).toEqual(["W", "f"]);
    const f = m.head.elements.f as unknown as Fence;
    expect(f.start).toEqual({ x: 6000, y: 400 });
  });

  it("without withLine its end stays put (the row has not said how to write its line)", () => {
    bindModelPacks(ID, PackSet.create([fencePack(false)]));
    const m = new Log(modelWith([wall("W", { x: 0, y: 0 }, { x: 6000, y: 0 }), fence], ID));
    const cs = m.ok({ type: "move_wall", wallId: "W", delta: { x: 0, y: 400 } });
    expect(cs.elements.map((e) => e.id)).toEqual(["W"]);
  });
});
