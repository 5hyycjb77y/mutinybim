/**
 * @jest-environment node
 *
 * Round 5b f-spatial: `surfacesAt` (ROADMAP S3) — the floor or roof under a
 * part or point, and the ceiling, roof and structure over it, each with its
 * height and source. The proof case is 7352's RTU-1 on the roof (levels as
 * the architect's storeys came in: Level 1 at 0, Roof at 14 ft; the RTU stood
 * on the linked roof deck, as the round 4 rooftop drill left it).
 *
 * Fails on the old code: there was no surfaces query (`surfaces/` didn't
 * exist); the roof height was only inside the lint engine's index.
 */
import { asElementId, builtinPartType, DEFAULT_SETTINGS, executeCommand, type BimElement, type Command, type ModelState } from "../src";
import { executeSpaceDesignCommand } from "../src/spaces/space-commands";
import { surfacesAt, type LinkedSurfaceSource } from "../src/surfaces";

const FT = 304.8;
const RTU = builtinPartType("builtin:rtu-5-ton@1");

function run(m: ModelState, c: Command): ModelState {
  const r = executeCommand(m, c);
  if (!r.ok) throw new Error(`${c.type}: ${r.error.message}`);
  return r.model;
}

/** The architect's model: Level 1 slab, a ceiling at 9 ft over the dining room, the roof deck at 14 ft (1 ft deep). */
function architecture(extra: LinkedSurfaceSource["elements"] = []): LinkedSurfaceSource {
  const box = (z0: number, z1: number, x0 = 0, y0 = 0, x1 = 60 * FT, y1 = 40 * FT) => [x0, y0, z0, x1, y1, z1] as const;
  return {
    modelId: "linked-arch-7352",
    label: "Architecture",
    elements: [
      { globalId: "slab-l1", name: "Level 1 slab", ifcClass: "IFCSLAB", kind: "slab", box: box(-FT, 0) },
      { globalId: "clg-dining", name: "ACT ceiling", ifcClass: "IFCCOVERING", kind: "covering", box: box(9 * FT, 9 * FT + 20, 0, 0, 30 * FT, 40 * FT) },
      { globalId: "roof-deck", name: "Roof deck", ifcClass: "IFCROOF", kind: "roof", box: box(13 * FT, 14 * FT) },
      { globalId: "wall-1", name: "Wall", ifcClass: "IFCWALL", kind: "wall", box: box(0, 13 * FT, 0, 0, FT, 40 * FT) },
      ...extra,
    ],
  };
}

function site7352(): ModelState {
  let m: ModelState = { modelId: "site-7352", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  m = run(m, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  m = run(m, { type: "create_level", levelId: "lvl-roof", name: "Roof", elevationMm: 14 * FT });
  if (!RTU) throw new Error("starter library is missing the RTU");
  m = run(m, { type: "place_part", partId: "rtu-1", typeId: RTU.id, partType: RTU.definition, levelId: "lvl-roof", position: { x: 20 * FT, y: 20 * FT }, offsetMm: 0, mark: "RTU-1" });
  m = run(m, { type: "set_part_host", ids: ["rtu-1"], host: { kind: "linked", referenceId: "linked-arch-7352", globalId: "roof-deck", name: "Roof deck", surface: "roof", topMm: 14 * FT } });
  return m;
}

describe("r5z surfacesAt", () => {
  it("7352 RTU-1: stands on the roof deck at 14 ft; the roof height is 14 ft, from its stated host", () => {
    const r = surfacesAt(site7352(), { elementId: asElementId("rtu-1") }, [architecture()]);
    if (!r.ok) throw new Error(r.reason);
    expect(r.level?.name).toBe("Roof");
    expect(r.floor).toMatchObject({ role: "floor", elevationMm: 14 * FT, source: { kind: "host", name: "Roof deck (linked)" } });
    expect(r.roof).toMatchObject({ role: "roof", elevationMm: 14 * FT, aboveFloorMm: 0 });
    expect(r.ceiling).toBeNull();
    expect(r.structureAbove).toBeNull();
    expect(r.notes).toEqual([]);
  });

  it("says when the stated host and the linked model disagree, and keeps the statement", () => {
    const m = run(site7352(), { type: "set_part_host", ids: ["rtu-1"], host: { kind: "linked", referenceId: "linked-arch-7352", globalId: "roof-deck", name: "Roof deck", surface: "roof", topMm: 14 * FT + 300 }, seat: true });
    const r = surfacesAt(m, { elementId: asElementId("rtu-1") }, [architecture()]);
    if (!r.ok) throw new Error(r.reason);
    expect(r.floor?.elevationMm).toBeCloseTo(14 * FT + 300, 3);
    expect(r.notes.join(" ")).toMatch(/stood on Roof deck \(linked\) at 15'-0"/);
    expect(r.notes.join(" ")).toMatch(/the linked model shows Roof deck at 14'-0" under it; the stated host is used/);
  });

  it("a point on Level 1 under the roof: floor at the level, the ceiling, the roof and the structure over it, with sources", () => {
    const r = surfacesAt(site7352(), { point: { x: 10 * FT, y: 10 * FT }, levelId: asElementId("lvl-1") }, [architecture()]);
    if (!r.ok) throw new Error(r.reason);
    expect(r.floor).toMatchObject({ elevationMm: 0 });
    expect(r.ceiling).toMatchObject({ role: "ceiling", elevationMm: 9 * FT, aboveFloorMm: Math.round(9 * FT), source: { kind: "linked", name: "ACT ceiling", ifcClass: "IFCCOVERING" } });
    expect(r.roof).toMatchObject({ role: "roof", elevationMm: 13 * FT, source: { kind: "linked", name: "Roof deck" } });
    expect(r.structureAbove).toMatchObject({ elevationMm: 13 * FT });
  });

  it("a space's stated ceiling height wins over the linked ceiling, and the difference is said", () => {
    let m = site7352();
    const made = executeSpaceDesignCommand(m, { type: "create_space", spaces: [{ spaceId: "s1", number: "101", name: "Dining", levelId: "lvl-1", outline: [{ x: 0, y: 0 }, { x: 30 * FT, y: 0 }, { x: 30 * FT, y: 40 * FT }, { x: 0, y: 40 * FT }], ceilingHeightMm: 10 * FT }] });
    if (!made.ok) throw new Error(made.error.message);
    m = made.model;
    const r = surfacesAt(m, { point: { x: 10 * FT, y: 10 * FT }, levelId: asElementId("lvl-1") }, [architecture()]);
    if (!r.ok) throw new Error(r.reason);
    expect(r.ceiling).toMatchObject({ elevationMm: 10 * FT, source: { kind: "space", id: "s1", name: "101 Dining" } });
    expect(r.notes.join(" ")).toMatch(/Space 101 says its ceiling is at 10'-0", but the linked model shows ACT ceiling at 9'-0" above the floor/);
  });

  it("with no linked model: our levels and slabs only, and it says so", () => {
    let m = site7352();
    const slab = { id: asElementId("slab-roof"), kind: "slab", version: 1, authoredRev: {}, partition: { level: "Roof" }, outline: [{ x: 0, y: 0 }, { x: 60 * FT, y: 0 }, { x: 60 * FT, y: 40 * FT }, { x: 0, y: 40 * FT }], thickness: 300 } as unknown as BimElement;
    m = { ...m, elements: { ...m.elements, [slab.id]: slab } };
    const r = surfacesAt(m, { point: { x: 10 * FT, y: 10 * FT }, levelId: asElementId("lvl-1") });
    if (!r.ok) throw new Error(r.reason);
    expect(r.structureAbove).toMatchObject({ elevationMm: 14 * FT - 300, source: { kind: "slab", id: "slab-roof" } });
    expect(r.roof).toBeNull();
    expect(r.notes).toContain("No linked model was read, so roofs and ceilings come only from this model");
  });

  it("refuses plainly: an unknown element, a non-part, a point with no level", () => {
    const m = site7352();
    expect(surfacesAt(m, { elementId: asElementId("nope") })).toEqual({ ok: false, reason: "There is no element nope" });
    expect(surfacesAt(m, { elementId: asElementId("lvl-1") })).toEqual({ ok: false, reason: "lvl-1 is a level; ask about a placed part, or give a point and level" });
    expect(surfacesAt(m, { point: { x: 0, y: 0 } })).toEqual({ ok: false, reason: "Say which level the point is on (or its elevation)" });
  });

  it("surfaces_at.7352: 1,000 asks against a linked model of 5,000 elements", () => {
    const filler: Array<LinkedSurfaceSource["elements"][number]> = [];
    for (let i = 0; i < 5_000; i++) filler.push({ globalId: `w-${i}`, name: "Wall", ifcClass: "IFCWALL", kind: i % 10 === 0 ? "slab" : "wall", box: [(i % 100) * FT, Math.floor(i / 100) * FT, 0, (i % 100) * FT + 200, Math.floor(i / 100) * FT + 200, 13 * FT] });
    const source = architecture(filler);
    const m = site7352();
    surfacesAt(m, { elementId: asElementId("rtu-1") }, [source]); // the index's surfaces are filtered once
    const samples: number[] = [];
    for (let k = 0; k < 7; k++) {
      const t0 = performance.now();
      for (let i = 0; i < 1_000; i++) surfacesAt(m, { elementId: asElementId("rtu-1") }, [source]);
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    process.stderr.write(`[r5z surfaces_at.7352] 1,000 asks: p50 ${(samples[3] ?? 0).toFixed(1)} ms, p95 ${(samples[6] ?? 0).toFixed(1)} ms\n`);
    expect(samples[3]).toBeLessThan(2_000);
  });

  it("surfaces_at.250k: 1,000 asks across a 250,000-element linked model and 2,000 of our slabs", () => {
    // A 50-storey tower 500 x 500 ft: every 10th linked element is a slab, roof or ceiling piece on a 10 ft bay grid.
    const filler: Array<LinkedSurfaceSource["elements"][number]> = [];
    for (let i = 0; i < 250_000; i++) {
      const storey = i % 50;
      const cell = Math.floor(i / 50) % 2_500;
      const x = (cell % 50) * 10 * FT;
      const y = Math.floor(cell / 50) * 10 * FT;
      const kind = i % 10 === 0 ? "slab" : i % 10 === 1 ? "covering" : i % 997 === 0 ? "roof" : "wall";
      const z0 = storey * 14 * FT + (kind === "covering" ? 9 * FT : 0);
      filler.push({ globalId: `e-${i}`, name: kind, ifcClass: "IFC", kind, box: [x, y, z0, x + 10 * FT, y + 10 * FT, z0 + (kind === "wall" ? 13 * FT : 300)] });
    }
    const source: LinkedSurfaceSource = { modelId: "tower", label: "Tower", elements: filler };
    let m = site7352();
    const slabs: Record<string, BimElement> = {};
    for (let i = 0; i < 2_000; i++) {
      const x = (i % 50) * 10 * FT;
      const y = Math.floor(i / 50) * 10 * FT;
      slabs[`slab-${i}`] = { id: asElementId(`slab-${i}`), kind: "slab", version: 1, authoredRev: {}, partition: { level: i % 2 === 0 ? "Level 1" : "Roof", zone: "Z1", discipline: "structure" }, outline: [{ x, y }, { x: x + 10 * FT, y }, { x: x + 10 * FT, y: y + 10 * FT }, { x, y: y + 10 * FT }], thickness: 300 } as unknown as BimElement;
    }
    m = { ...m, elements: { ...m.elements, ...slabs } };
    const points = Array.from({ length: 1_000 }, (_, i) => ({ x: ((i * 37) % 500) * FT, y: ((i * 53) % 400) * FT }));
    surfacesAt(m, { point: points[0] ?? { x: 0, y: 0 }, levelId: asElementId("lvl-1") }, [source]);
    const samples: number[] = [];
    for (let k = 0; k < 5; k++) {
      const t0 = performance.now();
      for (const p of points) surfacesAt(m, { point: p, levelId: asElementId("lvl-1") }, [source]);
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    process.stderr.write(`[r5z surfaces_at.250k] 1,000 asks: p50 ${(samples[2] ?? 0).toFixed(1)} ms, p95 ${(samples[4] ?? 0).toFixed(1)} ms\n`);
    expect(samples[2]).toBeLessThan(60_000);
  });
});
