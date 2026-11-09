/**
 * @jest-environment node
 *
 * Round 5c f-scale: `surfacesAt` reads a plan grid per linked revision and
 * keeps our slab grid across edits that touch no slab, with the same answers
 * as scanning every linked element and slab.
 *
 * Fails on the old code: a linked source re-read for each ask (a new object
 * with the same content, as a host that fetches its index per call hands it
 * over) was gridded again on every ask, a pass over every linked element; a
 * source had no `revision` to key on.
 */
import { asElementId, DEFAULT_SETTINGS, draftElements, executeCommand, freezeElements, type BimElement, type Command, type ModelState } from "../src";
import { surfacesAt, type LinkedSurfaceSource, type SurfacesTarget } from "../src/surfaces";

const FT = 304.8;

function run(m: ModelState, c: Command): ModelState {
  const r = executeCommand(m, c);
  if (!r.ok) throw new Error(`${c.type}: ${r.error.message}`);
  return r.model;
}

/** 20 storeys of 14 ft on a 20 x 20 grid of 10 ft bays: slabs, ceilings, a roof piece now and then, walls; a few surfaces wide enough to skip the grid. */
function tower(count: number): LinkedSurfaceSource {
  const elements: Array<LinkedSurfaceSource["elements"][number]> = [];
  for (let i = 0; i < count; i++) {
    const storey = i % 20;
    const cell = Math.floor(i / 20) % 400;
    const x = (cell % 20) * 10 * FT;
    const y = Math.floor(cell / 20) * 10 * FT;
    const kind = i % 10 === 0 ? "slab" : i % 10 === 1 ? "covering" : i % 97 === 0 ? "roof" : "wall";
    const z0 = storey * 14 * FT + (kind === "covering" ? 9 * FT + (i % 7) * 10 : 0);
    elements.push({ globalId: `e-${i}`, name: `${kind} ${i}`, ifcClass: "IFC", kind, box: [x, y, z0, x + 10 * FT, y + 10 * FT, z0 + (kind === "wall" ? 13 * FT : 300)] });
  }
  for (let s = 0; s < 20; s += 5) elements.push({ globalId: `podium-${s}`, name: `Podium ${s}`, ifcClass: "IFCSLAB", kind: "slab", box: [-50 * FT, -50 * FT, s * 14 * FT - 400, 1_000 * FT, 1_000 * FT, s * 14 * FT - 100] });
  return { modelId: "tower", label: "Tower", elements };
}

function host(): ModelState {
  let m: ModelState = { modelId: "c5s-surfaces", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  for (let f = 0; f < 4; f++) m = run(m, { type: "create_level", levelId: `lvl-${f}`, name: `Level ${f + 1}`, elevationMm: f * 14 * FT });
  const draft = draftElements(m.elements);
  for (let i = 0; i < 400; i++) {
    const x = (i % 20) * 10 * FT;
    const y = Math.floor(i / 20) * 10 * FT;
    const slab = { id: asElementId(`slab-${i}`), kind: "slab", version: 1, authoredRev: {}, partition: { level: `Level ${(i % 3) + 1}`, zone: "Z1", discipline: "structure" }, outline: [{ x, y }, { x: x + 10 * FT, y }, { x: x + 10 * FT, y: y + 10 * FT }, { x, y: y + 10 * FT }], thickness: 300 } as unknown as BimElement; // a slab as the store holds it; the slab command needs a level partition this fixture skips
    draft[slab.id] = slab;
  }
  return { ...m, elements: freezeElements(draft) };
}

/** The old scan: only the linked elements under the point, in source order, so the grid has nothing to choose. */
function scanned(source: LinkedSurfaceSource, p: { x: number; y: number }): LinkedSurfaceSource {
  const under = source.elements.filter((e) => {
    const [x0, y0, , x1, y1] = e.box;
    return p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
  });
  return { modelId: source.modelId, label: source.label, elements: under };
}

function points(n: number): Array<{ x: number; y: number }> {
  return Array.from({ length: n }, (_, i) => ({ x: ((i * 37) % 200) * FT + 17, y: ((i * 53) % 200) * FT + 29 }));
}

describe("c5s surfacesAt per linked revision", () => {
  const source = tower(50_000);

  it("answers as the old scan does at every point and level, with and without a revision", () => {
    const m = host();
    const withRevision: LinkedSurfaceSource = { ...source, revision: "sha-1" };
    for (const [i, p] of points(300).entries()) {
      const target: SurfacesTarget = { point: p, levelId: asElementId(`lvl-${i % 4}`) };
      const expected = surfacesAt(m, target, [scanned(source, p)]);
      expect(surfacesAt(m, target, [source])).toEqual(expected);
      expect(surfacesAt(m, target, [{ ...withRevision }])).toEqual(expected);
    }
  });

  it("a source re-read per ask with the same revision is gridded once, a new revision again", () => {
    const m = host();
    const ask = (s: LinkedSurfaceSource) => surfacesAt(m, { point: { x: 15 * FT, y: 15 * FT }, levelId: asElementId("lvl-1") }, [s]);
    ask({ ...source, revision: "sha-2" });
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) ask({ ...source, revision: "sha-2" });
    const perAskMs = (performance.now() - t0) / 200;
    const t1 = performance.now();
    for (let i = 0; i < 5; i++) ask({ ...source });
    const regridMs = (performance.now() - t1) / 5;
    process.stderr.write(`[c5s surfaces_at] 50k linked, fresh object per ask: same revision ${perAskMs.toFixed(3)} ms/ask; no revision (gridded each time, the old path) ${regridMs.toFixed(2)} ms/ask\n`);
    expect(perAskMs * 10).toBeLessThan(regridMs);
    // A different revision of the same model is its own content.
    const moved: LinkedSurfaceSource = { ...source, revision: "sha-3", elements: source.elements.map((e) => (e.kind === "covering" ? { ...e, box: [e.box[0], e.box[1], e.box[2] + 100, e.box[3], e.box[4], e.box[5] + 100] as const } : e)) };
    const a = ask({ ...source, revision: "sha-2" });
    const b = ask(moved);
    if (!a.ok || !b.ok) throw new Error("no answer");
    expect((b.ceiling?.elevationMm ?? 0) - (a.ceiling?.elevationMm ?? 0)).toBe(100);
  });

  it("our slab grid survives an edit that touches no slab and follows one that does", () => {
    let m = host();
    // slab-22 is the only slab over this bay: Level 2's, 300 mm deep.
    const at: SurfacesTarget = { point: { x: 25 * FT, y: 15 * FT }, levelId: asElementId("lvl-0") };
    const before = surfacesAt(m, at);
    m = run(m, { type: "create_level", levelId: "lvl-9", name: "Level 9", elevationMm: 9 * 14 * FT });
    expect(surfacesAt(m, at)).toEqual(before);
    const slab = m.elements["slab-22"];
    if (slab?.kind !== "slab") throw new Error("fixture");
    const draft = draftElements(m.elements);
    draft[slab.id] = { ...slab, thickness: 600 };
    m = { ...m, elements: freezeElements(draft) };
    const after = surfacesAt(m, at);
    if (!after.ok || !before.ok) throw new Error("no answer");
    expect(after.structureAbove?.source).toMatchObject({ kind: "slab", id: "slab-22" });
    expect((before.structureAbove?.elevationMm ?? 0) - (after.structureAbove?.elevationMm ?? 0)).toBe(300);
  });
});
