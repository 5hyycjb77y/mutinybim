/**
 * @jest-environment node
 *
 * Round 3, lane B: a part standing on a beam at a station (structural S-11),
 * a shared type for building and structure elements (S-13), and a recognised
 * class that follows its recognition input (lane B's own open item). Fails on
 * the code before: `PartHost` was a slab or a linked surface only, no
 * `element_type` kind existed (a section was a value on every beam), and a
 * class the upgrade filled stayed `arch.door` after the opening became a window.
 */
import { asElementId, ELEMENT_KINDS, hostState, PARTS_LINE_HOST_FEATURE, type BimElement, type ModelState } from "../src";
import { ELEMENT_TYPES_FEATURE, elementTypeValue, readClassifiedElement } from "../src/elements";
import { bindModelPacks, unbindModelPacks } from "../src/packs";
import { CIVTEST_SET, STRUCTURE, commit, emptyModel, tryCommit } from "./c5e-r3-fixtures";

const MODEL = "c5e-r3-hosts";
beforeAll(() => bindModelPacks(MODEL, CIVTEST_SET));
afterAll(() => unbindModelPacks(MODEL));

const base = { version: 1, authoredRev: {}, partition: { level: "Roof", zone: "Z1", discipline: "structure" as const } };

function frame(): ModelState {
  let m = commit(emptyModel(MODEL), { type: "create_level", levelId: "lvl-roof", name: "Roof", elevationMm: 10_000 });
  const els: BimElement[] = [
    { ...base, id: asElementId("b1"), kind: "beam", sectionName: "W12x26", start: { x: 0, y: 0 }, end: { x: 6000, y: 0 } },
    { ...base, id: asElementId("w1"), kind: "wall", start: { x: 0, y: 5000 }, end: { x: 6000, y: 5000 }, thickness: 200, height: 3000, wallType: "Parapet" },
    { ...base, id: asElementId("w2"), kind: "wall", start: { x: 0, y: 9000 }, end: { x: 6000, y: 9000 }, thickness: 200, height: 3000, wallType: "Parapet" },
    { ...base, id: asElementId("d1"), kind: "opening", openingType: "door", mark: "R1", hostId: asElementId("w1"), offset: 1500, width: 900, height: 2100, position: { x: 1500, y: 5000 } },
  ];
  m = { ...m, elements: { ...m.elements, ...Object.fromEntries(els.map((e) => [e.id, e])) } };
  // The beam slopes: its top 3000 mm above the roof level at its start, 3600 at its end.
  return commit(m, { type: "set_element_placement", elementId: "b1", placement: { kind: "line", levelId: "lvl-roof", start: { x: 0, y: 0 }, end: { x: 6000, y: 0 }, startOffsetMm: 3000, endOffsetMm: 3600, lateral: "center", vertical: "top" } });
}

const onBeam = { type: "place_part", partId: "rtu", typeId: "pt-rtu", partType: STRUCTURE, levelId: "lvl-roof", position: { x: 3000, y: 0 }, offsetMm: 3300, mark: "RTU-1", host: { kind: "element", elementId: "b1", stationMm: 3000 } };

describe("a part standing on a beam", () => {
  it("is seated on the beam's top at its station", () => {
    const m = commit(frame(), onBeam);
    const rtu = m.elements["rtu"];
    if (rtu?.kind !== "part") throw new Error("a part");
    expect(hostState(m, rtu)).toMatchObject({ status: "seated", topMm: 13_300, label: "Stands on beam b1, 9.84 ft along it" });
  });

  it("refuses an element with no line, and an older peer", () => {
    const missing = tryCommit(frame(), { ...onBeam, host: { kind: "element", elementId: "d1", stationMm: 0 } });
    expect(missing.ok ? "" : missing.message).toBe("RTU-1 can't stand on d1: it isn't a beam, wall, grid or component with a line in this model");
    const older = tryCommit(frame(), onBeam, (f) => f !== PARTS_LINE_HOST_FEATURE);
    expect(older.ok ? "" : older.message).toBe("RTU-1 can't be saved standing on a beam yet: the model server this model is open on is an older version that stores only slab and roof hosts. Try again once the server is updated");
  });
});

describe("element types", () => {
  const section = { type: "create_element_type", typeId: "w12x26", name: "W12x26", classId: "struct.beam", forKinds: ["beam"], values: { "civtest.depth_mm": 310, "civtest.grade": "A992" } };

  it("is a kind of its own, typing beams; type values read under instance values", () => {
    expect(ELEMENT_KINDS).toContain("element_type");
    let m = commit(frame(), section);
    const type = m.elements["w12x26"];
    expect(type).toMatchObject({ kind: "element_type", name: "W12x26", classId: "struct.beam", forKinds: ["beam"] });
    const read = readClassifiedElement(type);
    expect(read.ok && read.element).toBe(type);
    m = commit(m, { type: "set_element_type", elementIds: ["b1"], typeId: "w12x26" });
    const b1 = m.elements["b1"];
    if (!b1) throw new Error("b1");
    expect(elementTypeValue(m.elements, b1, "civtest.depth_mm")).toBe(310);
    m = commit(m, { type: "set_element_values", elementIds: ["b1"], values: { "civtest.depth_mm": 318 } });
    const after = m.elements["b1"];
    if (!after) throw new Error("b1");
    expect(elementTypeValue(m.elements, after, "civtest.depth_mm")).toBe(318);
    expect(elementTypeValue(m.elements, after, "civtest.grade")).toBe("A992");
    // A type edit reaches every instance.
    m = commit(m, { type: "set_element_values", elementIds: ["w12x26"], values: { "civtest.grade": "A572" } });
    expect(elementTypeValue(m.elements, after, "civtest.grade")).toBe("A572");
  });

  it("refuses typing a wall with a beam type, a class for other kinds, and an older peer", () => {
    const m = commit(frame(), section);
    const wall = tryCommit(m, { type: "set_element_type", elementIds: ["w1"], typeId: "w12x26" });
    expect(wall.ok ? "" : wall.message).toBe("W12x26 is a type for beams; Wall w1 is a wall");
    const cls = tryCommit(frame(), { ...section, typeId: "t2", classId: "arch.wall" });
    expect(cls.ok ? "" : cls.message).toBe("Walls is a class of walls; Type W12x26 is for beams");
    const older = tryCommit(frame(), section, (f) => f !== ELEMENT_TYPES_FEATURE);
    expect(older.ok ? "" : older.message).toBe("The type W12x26 can't be saved yet: the model server this model is open on is an older version that doesn't store element types. Try again once the server is updated");
  });
});

describe("a recognised class follows its recognition input; an explicit one never does", () => {
  it("the upgrade marks the class it filled as recognised", () => {
    const m = commit(frame(), { type: "set_element_values", elementIds: ["d1"], values: { "civtest.note": "x" } });
    expect(m.elements["d1"]).toMatchObject({ classId: "arch.door", classSource: "recognised" });
  });

  it("an edit after the opening became a window refreshes the recognised class, and leaves an explicit one", () => {
    const m = frame();
    const d1 = m.elements["d1"];
    if (d1?.kind !== "opening") throw new Error("d1");
    const recognised: ModelState = { ...m, elements: { ...m.elements, d1: { ...d1, openingType: "window", classId: "arch.door", classSource: "recognised", schemaVersion: 2 } } };
    expect(commit(recognised, { type: "set_element_values", elementIds: ["d1"], values: { "civtest.note": "x" } }).elements["d1"]).toMatchObject({ classId: "arch.window", classSource: "recognised" });
    const explicit: ModelState = { ...m, elements: { ...m.elements, d1: { ...d1, openingType: "window", classId: "arch.door", schemaVersion: 2 } } };
    const kept = commit(explicit, { type: "set_element_values", elementIds: ["d1"], values: { "civtest.note": "x" } }).elements["d1"];
    expect(kept).toMatchObject({ classId: "arch.door" });
    expect(kept).not.toHaveProperty("classSource");
  });
});
