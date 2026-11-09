/**
 * @jest-environment node
 *
 * i9-import-apply: an import only adds. A chunk with a record already in the
 * model, or one that doesn't say which linked model it came from, is refused
 * whole and names the record; landing in memory drops the named records (and
 * whatever hangs on them, a door on a dropped wall) and lands the rest.
 *
 * Fails on round 8b's code: there is no import landing (`landImportChunk`).
 */
import { DEFAULT_SETTINGS, asElementId, asRevision, landImport, landImportChunk, type BimElement, type ModelState, type Opening, type Wall } from "@permitzip/bim-kernel";

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
});
