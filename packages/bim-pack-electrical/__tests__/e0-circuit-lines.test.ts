/**
 * @jest-environment node
 *
 * E0 B7: square circuit lines. In Electrical Demo 2 (29:41–30:41) the square
 * style joined receptacles nearest-neighbour and always turned the same
 * corner, so a line ran all the way across the room and came back over the
 * runs before it ("looks like a bus"), and the home-run tag printed over the
 * panel's "P1". Square lines now grow a tree from the home run, pick the
 * corner per line against what is already drawn, step a parallel run beside
 * another instead of on top of it, and keep the home-run tag clear of text.
 */
import { type ModelState, type PartInstance, type Primitive, type Vec2, type ViewElement } from "@permitzip/bim-kernel";
import { deriveCircuitGraphics, drawCircuitGraphics, type CircuitGraphic, type CircuitGraphicsProps } from "../src/annotation/circuit-graphics";
import { Building } from "../../bim-kernel/__tests__/fixtures/electrical-building";

const SCALE = 48;
/** Runs closer than this side by side (paper mm) read as one line on the print. */
const STACKED_MM = 0.5;

function plan(b: Building, circuitGraphics: CircuitGraphicsProps): void {
  b.ok({ type: "create_view", viewId: "v-e1", name: "Level 1 Power", viewType: "floor_plan", crop: { min: { x: -12000, y: -8000 }, max: { x: 12000, y: 12000 } }, props: { level: "Level 1", scale: SCALE, discipline: "electrical", circuitGraphics } });
}

function view(m: ModelState): ViewElement {
  const v = m.elements["v-e1"];
  if (v?.kind !== "view") throw new Error("missing view");
  return v;
}

function shownParts(m: ModelState): Map<string, PartInstance> {
  const out = new Map<string, PartInstance>();
  for (const el of Object.values(m.elements)) if (el.kind === "part") out.set(el.id, el);
  return out;
}

type Seg = { readonly key: string; readonly a: Vec2; readonly b: Vec2 };

function segments(gs: readonly CircuitGraphic[]): Seg[] {
  const out: Seg[] = [];
  gs.forEach((g) => {
    const lines = [...g.paths, ...(g.homeRun ? [[g.homeRun.from, g.homeRun.tip]] : [])];
    lines.forEach((line, li) => {
      for (let i = 0; i + 1 < line.length; i++) out.push({ key: `${g.key}#${li}`, a: line[i]!, b: line[i + 1]! });
    });
  });
  return out;
}

/** Horizontal and vertical pieces that lie on top of each other for more than a hair (model mm). */
function stacked(gs: readonly CircuitGraphic[]): string[] {
  const tol = STACKED_MM * SCALE;
  const segs = segments(gs);
  const out: string[] = [];
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const p = segs[i]!;
      const q = segs[j]!;
      for (const axis of ["x", "y"] as const) {
        const across = axis === "x" ? "y" : "x";
        const pRuns = Math.abs(p.a[across] - p.b[across]) < 1e-6;
        const qRuns = Math.abs(q.a[across] - q.b[across]) < 1e-6;
        if (!pRuns || !qRuns || Math.abs(p.a[across] - q.a[across]) > tol) continue;
        const lo = Math.max(Math.min(p.a[axis], p.b[axis]), Math.min(q.a[axis], q.b[axis]));
        const hi = Math.min(Math.max(p.a[axis], p.b[axis]), Math.max(q.a[axis], q.b[axis]));
        if (hi - lo > tol) out.push(`${p.key} and ${q.key} share ${Math.round(hi - lo)} mm along ${across}=${Math.round(p.a[across])}`);
      }
    }
  }
  return out;
}

/**
 * An L-shaped room (a 10 m leg along the bottom, a 4 m leg up the left side),
 * panel P1 outside the bottom-left corner, five receptacles round the walls:
 * two up the left wall, three along the bottom. One circuit, P1-1.
 */
function lRoom(): Building {
  const b = new Building();
  b.place("p1", "panel208", { panel_name: "P1" }, "P1", { x: -4000, y: 0 });
  b.place("r1", "receptacle", { voltage: 120, load_va: 180 }, "R1", { x: 2000, y: 300 });
  b.place("r2", "receptacle", { voltage: 120, load_va: 180 }, "R2", { x: 300, y: 2500 });
  b.place("r3", "receptacle", { voltage: 120, load_va: 180 }, "R3", { x: 5000, y: 300 });
  b.place("r4", "receptacle", { voltage: 120, load_va: 180 }, "R4", { x: 300, y: 6000 });
  b.place("r5", "receptacle", { voltage: 120, load_va: 180 }, "R5", { x: 8000, y: 300 });
  b.ok({ type: "create_service_link", linkId: "c1", sourceId: "p1", positions: [1], members: ["r1", "r2", "r3", "r4", "r5"].map((elementId) => ({ elementId })) });
  return b;
}

describe("square circuit lines never stack or retrace", () => {
  it("five receptacles in an L-shaped room: no two runs on top of each other", () => {
    const b = lRoom();
    plan(b, { style: "orthogonal" });
    const gs = deriveCircuitGraphics(b.head, view(b.head), shownParts(b.head), SCALE);
    const g = gs.find((x) => x.key === "c1");
    expect(g?.joins).toHaveLength(4);
    // Every receptacle is on the drawing.
    expect(new Set(g?.joins.flat())).toEqual(new Set(["r1", "r2", "r3", "r4", "r5"]));
    expect(stacked(gs)).toEqual([]);
  });

  it("the bottom wall reads as a clean run: R1 to R3 to R5, nothing back across it", () => {
    const b = lRoom();
    plan(b, { style: "orthogonal" });
    const g = deriveCircuitGraphics(b.head, view(b.head), shownParts(b.head), SCALE).find((x) => x.key === "c1")!;
    const sorted = g.joins.map(([x, y]) => [x, y].sort().join("-")).sort();
    expect(sorted).toEqual(["r1-r2", "r1-r3", "r2-r4", "r3-r5"]);
  });

  it("a second circuit whose usual corner would ride the first's run turns the other corner", () => {
    const b = new Building();
    b.place("p1", "panel208", { panel_name: "P1" }, "P1", { x: -6000, y: 0 });
    b.place("a", "receptacle", { voltage: 120, load_va: 180 }, "A", { x: 0, y: 0 });
    b.place("b", "receptacle", { voltage: 120, load_va: 180 }, "B", { x: 4000, y: 3000 });
    b.place("c", "receptacle", { voltage: 120, load_va: 180 }, "C", { x: 1500, y: -2000 });
    b.place("d", "receptacle", { voltage: 120, load_va: 180 }, "D", { x: 4000, y: 1500 });
    b.ok({ type: "create_service_link", linkId: "c1", sourceId: "p1", positions: [1], members: [{ elementId: "a" }, { elementId: "b" }] });
    b.ok({ type: "create_service_link", linkId: "c2", sourceId: "p1", positions: [3], members: [{ elementId: "c" }, { elementId: "d" }] });
    plan(b, { style: "orthogonal", homeRuns: false });
    const gs = deriveCircuitGraphics(b.head, view(b.head), shownParts(b.head), SCALE);
    expect(stacked(gs)).toEqual([]);
    // C to D goes up first, then across: the across-first corner would run up x = 4000 on top of c1.
    const cd = gs.find((x) => x.key === "c2")!.paths[0]!;
    expect(cd.some((p) => Math.abs(p.x - 1500) < 1e-6 && Math.abs(p.y - 1500) < 1e-6)).toBe(true);
  });

  it("three in a row still draw as one straight run each, with the corner the old style used when nothing is in the way", () => {
    const b = new Building();
    b.place("l1", "panel208", { panel_name: "L1" }, "L1", { x: -8000, y: 0 });
    b.place("r1", "receptacle", { voltage: 120, load_va: 180 }, "r1", { x: 0, y: 0 });
    b.place("r2", "receptacle", { voltage: 120, load_va: 180 }, "r2", { x: 3000, y: 0 });
    b.place("r3", "receptacle", { voltage: 120, load_va: 180 }, "r3", { x: 6000, y: 2000 });
    b.ok({ type: "create_service_link", linkId: "c1", sourceId: "l1", positions: [1], members: [{ elementId: "r3" }, { elementId: "r1" }, { elementId: "r2" }] });
    plan(b, { style: "orthogonal" });
    const g = deriveCircuitGraphics(b.head, view(b.head), shownParts(b.head), SCALE).find((x) => x.key === "c1")!;
    expect(g.paths[0]).toEqual([
      { x: 300, y: 0 },
      { x: 2700, y: 0 },
    ]);
    // Across first, then up into r3 from below (the old default).
    expect(g.paths[1]).toEqual([
      { x: 3300, y: 0 },
      { x: 6000, y: 0 },
      { x: 6000, y: 1850 },
    ]);
  });
});

describe("the home-run tag keeps clear of the panel's own text", () => {
  type Text = Extract<Primitive, { kind: "text" }>;
  const box = (t: Text) => {
    const w = t.text.length * t.size * 0.6;
    const x0 = t.anchor === "start" ? t.at.x : t.anchor === "end" ? t.at.x - w : t.at.x - w / 2;
    return { x0, x1: x0 + w, y0: t.at.y - t.size, y1: t.at.y + t.size * 0.25 };
  };
  const meet = (p: Text, q: Text) => {
    const a = box(p);
    const c = box(q);
    return a.x0 < c.x1 && c.x0 < a.x1 && a.y0 < c.y1 && c.y0 < a.y1;
  };

  function draw(seed: readonly Primitive[]): Text[] {
    const b = new Building();
    b.place("p1", "panel208", { panel_name: "P1" }, "P1", { x: -2000, y: 0 });
    b.place("r1", "receptacle", { voltage: 120, load_va: 180 }, "R1", { x: 0, y: 0 });
    b.place("r2", "receptacle", { voltage: 120, load_va: 180 }, "R2", { x: 3000, y: 0 });
    b.ok({ type: "create_service_link", linkId: "c1", sourceId: "p1", positions: [1], members: [{ elementId: "r1" }, { elementId: "r2" }] });
    plan(b, { style: "orthogonal" });
    const prims: Primitive[] = [...seed];
    const toPaper = (p: Vec2): Vec2 => ({ x: 200 + p.x / SCALE, y: 150 - p.y / SCALE });
    drawCircuitGraphics({ toPaper, scale: SCALE, window: { min: { x: 0, y: 0 }, max: { x: 400, y: 300 } }, prims }, b.head, view(b.head), shownParts(b.head));
    return prims.filter((p): p is Text => p.kind === "text");
  }

  it("with nothing there, the tag sits past the arrow tip as it always has", () => {
    const tag = draw([]).find((t) => t.text === "P1-1")!;
    expect(tag.anchor).toBe("end");
    // r1's left edge is 300 mm left of it; the arrow is 8 mm of paper; the tag starts 1.8 mm past the tip.
    expect(tag.at.x).toBeCloseTo(200 - 300 / SCALE - 8 - 1.2 - 0.6, 6);
  });

  it("with the panel's P1 printed where the tag would go, the tag moves beside the arrow", () => {
    const usual = draw([]).find((t) => t.text === "P1-1")!;
    const panelMark: Text = { kind: "text", at: { x: usual.at.x - 2, y: usual.at.y }, text: "P1", size: 2.5, anchor: "middle" };
    const texts = draw([panelMark]);
    const tag = texts.find((t) => t.text === "P1-1")!;
    expect(meet(tag, panelMark)).toBe(false);
  });
});
