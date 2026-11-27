/**
 * @jest-environment node
 *
 * i9-import-apply: an import only adds. A chunk with a record already in the
 * model, or one that doesn't say which linked model it came from, is refused
 * whole and names the record; landing in memory drops the named records (and
 * whatever hangs on them, a door on a dropped wall) and lands the rest.
 * Records joined to each other land in one chunk (each names the other, and a
 * chunk is checked as it lands), and a join to a dropped record is taken off
 * the record that stays.
 *
 * Fails on round 8b's code: there is no import landing (`landImportChunk`).
 */
import { DEFAULT_SETTINGS, asElementId, asRevision, importChunks, landImport, landImportChunk, usesDropped, withoutDropped, type BimElement, type MepSystem, type ModelState, type Opening, type PartInstance, type PortRef, type RunFitting, type RunSegment, type Wall } from "@permitzip/bim-kernel";

const level: BimElement = { id: asElementId("L1"), kind: "level", version: 1, authoredRev: {}, name: "Level 1", elevationMm: 0 };
const model: ModelState = { modelId: "i9-apply", revision: asRevision(1), elements: { L1: level }, connections: [], settings: DEFAULT_SETTINGS };
const provenance = { ifcGlobalId: "0000000000000000000001", source: "ver-1" };
const partition = { level: "Level 1", zone: "Z1", discipline: "architecture" };

function wall(id: string, y: number): Wall {
  return { id: asElementId(id), kind: "wall", version: 0, authoredRev: {}, partition, provenance, start: { x: 0, y }, end: { x: 4000, y }, thickness: 200, height: 3000, wallType: "Imported" };
}

function door(id: string, host: string, y: number): Opening {
  return { id: asElementId(id), kind: "opening", version: 0, authoredRev: {}, partition, provenance, openingType: "door", mark: "D1", hostId: asElementId(host), offset: 1000, width: 900, height: 2100, position: { x: 1000, y } };
}

const size = { shape: "rect", width: 600, height: 300 } as const;
const ref = (elementId: string, port: string): PortRef => ({ elementId: asElementId(elementId), port });
const system: MepSystem = { id: asElementId("imp.a.sys"), kind: "mep_system", version: 0, authoredRev: {}, provenance, name: "Supply Air 1", systemKind: "supply_air", domain: "duct" };

/** A level duct piece `n` pieces along x. */
function piece(id: string, n: number, links: RunSegment["links"], branches: readonly string[] = []): RunSegment {
  return { id: asElementId(id), kind: "run_segment", version: 0, authoredRev: {}, partition, provenance, domain: "duct", systemId: system.id, levelId: level.id, start: { x: n * 3000, y: 0, z: 3000 }, end: { x: (n + 1) * 3000, y: 0, z: 3000 }, size, links, branches: branches.map(asElementId), flow: 0 };
}

function elbow(id: string, a: PortRef, b: PortRef): RunFitting {
  const at = { x: 3000, y: 0, z: 3000 };
  return {
    id: asElementId(id),
    kind: "run_fitting",
    version: 0,
    authoredRev: {},
    partition,
    provenance,
    fittingType: "elbow",
    label: "Elbow",
    domain: "duct",
    systemId: system.id,
    levelId: level.id,
    position: at,
    angleDeg: 90,
    ports: [
      { id: "a", position: at, direction: { x: -1, y: 0, z: 0 }, size, link: a },
      { id: "b", position: at, direction: { x: 0, y: 1, z: 0 }, size, link: b },
    ],
  };
}

/** A placed part joined by its connectors, as an import brings one in. */
function unit(id: string, links: PartInstance["links"]): PartInstance {
  return { id: asElementId(id), kind: "part", version: 0, authoredRev: {}, partition, provenance, typeId: asElementId("imp.a.type"), levelId: level.id, position: { x: 0, y: 0 }, offsetMm: 3000, rotationDeg: 0, mark: "U-1", values: {}, ...(links ? { links } : {}) };
}

const ids = (chunks: readonly (readonly BimElement[])[]) => chunks.map((c) => c.map((r) => r.id));

describe("i9-import-apply", () => {
  it("adds a chunk as one revision", () => {
    const result = landImportChunk(model, [wall("imp.a.w1", 0), door("imp.a.d1", "imp.a.w1", 0)]);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.changedIds).toEqual(expect.arrayContaining(["imp.a.w1", "imp.a.d1"]));
    expect(result.model.elements["imp.a.d1"]).toMatchObject({ hostId: "imp.a.w1", position: { x: 1000, y: 0 } });
  });

  it("refuses a record already in the model, and one without its source", () => {
    const dup = landImportChunk(model, [{ ...wall("L1", 0) }]);
    expect(dup).toMatchObject({ ok: false, error: { code: "already_exists", elementIds: ["L1"] } });
    const { provenance: _drop, ...bare } = wall("imp.a.w2", 0);
    const noSource = landImportChunk(model, [bare]);
    expect(noSource).toMatchObject({ ok: false, error: { code: "invalid_value", elementIds: ["imp.a.w2"] } });
  });

  it("landing drops what a chunk refuses, with what hangs on it, and lands the rest", () => {
    const w1 = wall("imp.a.w1", 0);
    const landed = landImport(model, [w1, door("imp.a.d1", "imp.a.w1", 0), wall("imp.a.w3", 3000), { ...w1 }, door("imp.a.d3", "imp.a.w3", 3000)], { size: 10 });
    expect(landed.dropped.map((d) => d.id)).toEqual(["imp.a.w1"]);
    expect(Object.keys(landed.model.elements).sort()).toEqual(["L1", "imp.a.d3", "imp.a.w3"]);
    expect(landed.revisions).toBe(1);
  });

  it("chunks keep records that are joined to each other together, and everything else in order", () => {
    const walls = [wall("imp.a.w1", 0), wall("imp.a.w2", 1000), wall("imp.a.w3", 2000), wall("imp.a.w4", 3000), wall("imp.a.w5", 4000)];
    // Nothing joined: the plan's order, cut every `size` records.
    expect(ids(importChunks(walls, 2))).toEqual([["imp.a.w1", "imp.a.w2"], ["imp.a.w3", "imp.a.w4"], ["imp.a.w5"]]);

    // Two pieces joined through an elbow, with walls between them in the plan: the three land together, where the last of them was (so what they use has landed).
    const s1 = piece("imp.a.s1", 0, { end: ref("imp.a.f1", "a") });
    const s2 = piece("imp.a.s2", 1, { start: ref("imp.a.f1", "b") });
    const f1 = elbow("imp.a.f1", ref("imp.a.s1", "end"), ref("imp.a.s2", "start"));
    const open = piece("imp.a.s3", 5, {});
    const [w1, w2, w3] = walls;
    if (!w1 || !w2 || !w3) throw new Error("fixture");
    expect(ids(importChunks([w1, s1, w2, s2, open, w3, f1], 2))).toEqual([["imp.a.w1", "imp.a.w2"], ["imp.a.s3", "imp.a.w3"], ["imp.a.s1", "imp.a.s2", "imp.a.f1"]]);
    // A run with a fitting on its side is with it too: the fitting names its host, and the host lists the fitting.
    const host = piece("imp.a.s4", 7, {}, ["imp.a.f2"]);
    const tap: RunFitting = { ...elbow("imp.a.f2", ref("imp.a.s5", "start"), ref("imp.a.s5", "start")), fittingType: "tap", ports: [], host: { segmentId: host.id, s: 1500, side: 1 } };
    expect(ids(importChunks([host, w1, w2, tap], 2))).toEqual([["imp.a.w1", "imp.a.w2"], ["imp.a.s4", "imp.a.f2"]]);
    // A part and the run on its connector are with each other as well.
    const fed = piece("imp.a.s6", 0, { start: ref("imp.a.u1", "supply") });
    expect(ids(importChunks([unit("imp.a.u1", { supply: ref("imp.a.s6", "start") }), w1, w2, w3, fed], 2))).toEqual([["imp.a.w1", "imp.a.w2"], ["imp.a.w3"], ["imp.a.u1", "imp.a.s6"]]);
  });

  it("joined records that outnumber the chunk size land whole, and a long chain is grouped in near-linear time", () => {
    // Pieces joined end to end, one after the other.
    const chain = (n: number) => Array.from({ length: n }, (_, i) => piece(`imp.a.c${i}`, i, { ...(i > 0 ? { start: ref(`imp.a.c${i - 1}`, "end") } : {}), ...(i < n - 1 ? { end: ref(`imp.a.c${i + 1}`, "start") } : {}) }));
    const forty = chain(40);
    const chunks = importChunks([wall("imp.a.w1", 0), ...forty, wall("imp.a.w2", 1000)], 3);
    expect(chunks.map((c) => c.length)).toEqual([1, 40, 1]);
    const landed = landImport(model, [system, ...forty], { size: 3 });
    expect(landed.dropped).toEqual([]);
    expect(landed.revisions).toBe(2);

    // The grouping walks each join a few times at most: ten times the records takes about ten times as long, not a hundred.
    const time = (n: number) => {
      const records = chain(n);
      let best = Infinity;
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now();
        expect(importChunks(records, 2000)).toHaveLength(1);
        best = Math.min(best, performance.now() - t0);
      }
      return best;
    };
    time(20_000);
    const small = time(20_000);
    const large = time(200_000);
    expect(large).toBeLessThan(Math.max(small, 1) * 40);
  });

  it("a dropped record takes what can't land without it, and its joins come off what stays", () => {
    const s1 = piece("imp.a.s1", 0, { end: ref("imp.a.f1", "a") });
    const s2 = piece("imp.a.s2", 1, { start: ref("imp.a.f1", "b") });
    const f1 = elbow("imp.a.f1", ref("imp.a.s1", "end"), ref("imp.a.s2", "start"));
    const host = piece("imp.a.s4", 7, {}, ["imp.a.f2"]);
    const tap: RunFitting = { ...elbow("imp.a.f2", ref("imp.a.s5", "start"), ref("imp.a.s5", "start")), fittingType: "tap", ports: [{ id: "branch", position: { x: 22500, y: 300, z: 3000 }, direction: { x: 0, y: 1, z: 0 }, size, link: ref("imp.a.s5", "start") }], host: { segmentId: host.id, s: 1500, side: 1 } };
    const branch: RunSegment = { ...piece("imp.a.s5", 0, { start: ref("imp.a.f2", "branch") }), start: { x: 22500, y: 300, z: 3000 }, end: { x: 22500, y: 3300, z: 3000 } };

    // A link is not a need: a piece joined to a dropped fitting still lands. A fitting needs the run it sits on, its system and its level.
    expect(usesDropped(s1, f1.id)).toBe(false);
    expect(usesDropped(f1, s2.id)).toBe(false);
    expect(usesDropped(tap, host.id)).toBe(true);
    expect(usesDropped(f1, system.id)).toBe(true);
    expect(usesDropped(s1, level.id)).toBe(true);

    // The elbow is dropped: both pieces stay, each open where it was.
    expect(withoutDropped([s1, s2, f1], new Set([f1.id]))).toEqual([{ ...s1, links: {} }, { ...s2, links: {} }]);
    // One piece is dropped: the elbow stays, open on that side only.
    const [, left] = withoutDropped([s1, s2, f1], new Set([s2.id]));
    expect(left?.kind === "run_fitting" ? left.ports.map((p) => p.link) : null).toEqual([ref("imp.a.s1", "end"), undefined]);
    // The trunk is dropped: its tap can't stay, and the branch that was on the tap is open there.
    expect(withoutDropped([host, tap, branch], new Set([host.id]))).toEqual([{ ...branch, links: {} }]);
    // The tap is dropped: the trunk no longer lists it.
    expect(withoutDropped([host, tap, branch], new Set([tap.id]))).toEqual([{ ...host, branches: [] }, { ...branch, links: {} }]);
    // A part and the runs on its connectors: whichever is dropped, the other stays with that connector or end open, and its other joins kept.
    const fed = piece("imp.a.s6", 0, { start: ref("imp.a.u1", "supply"), end: ref("imp.a.f1", "a") });
    const two = unit("imp.a.u1", { supply: ref("imp.a.s6", "start"), return: ref("imp.a.s7", "start") });
    expect(usesDropped(fed, two.id)).toBe(false);
    expect(usesDropped(two, fed.id)).toBe(false);
    expect(usesDropped(two, asElementId("imp.a.type"))).toBe(true);
    expect(withoutDropped([two, fed], new Set([two.id]))).toEqual([{ ...fed, links: { end: ref("imp.a.f1", "a") } }]);
    expect(withoutDropped([two, fed], new Set([fed.id]))).toEqual([unit("imp.a.u1", { return: ref("imp.a.s7", "start") })]);
    const [bare] = withoutDropped([unit("imp.a.u1", { supply: ref("imp.a.s6", "start") }), fed], new Set([fed.id]));
    expect(bare && "links" in bare).toBe(false);
    // Nothing dropped: the same records.
    expect(withoutDropped([s1, s2, f1], new Set())).toEqual([s1, s2, f1]);

    // Landing: a piece already in the model is refused by name; the rest of the run lands with no link left pointing at it.
    const taken: ModelState = { ...model, elements: { ...model.elements, [s2.id]: wall(s2.id, 9000) } };
    const landed = landImport(taken, [system, s1, s2, f1]);
    expect(landed.dropped.map((d) => d.id)).toEqual([s2.id]);
    const fitting = landed.model.elements[f1.id];
    expect(fitting?.kind === "run_fitting" ? fitting.ports.map((p) => p.link?.elementId) : null).toEqual([s1.id, undefined]);
    expect(landed.model.elements[s1.id]).toMatchObject({ links: { end: ref("imp.a.f1", "a") } });
  });
});
