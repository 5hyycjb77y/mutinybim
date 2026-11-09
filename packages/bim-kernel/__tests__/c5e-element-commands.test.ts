/**
 * @jest-environment node
 *
 * Typed-element commands (5c items b and c): class, type, values, geometric
 * placement beyond a point, and locks with a plain reason; the tolerant
 * readers for the open lists; part categories read tolerantly. Fails on the
 * code before 5c: none of these commands, fields or readers existed, and a
 * column of "timber" or a component of "paving" had no type to be.
 */
import { z } from "zod";
import {
  asElementId,
  commandSchema,
  DEFAULT_SETTINGS,
  partTypeDefinitionSchema,
  planCommit,
  readPartCategory,
  storedPartTypeDefinitionSchema,
  withUpgradePolicy,
  type BimElement,
  type ExecuteResult,
  type ModelState,
  type PartTypeDefinition,
} from "../src";
import {
  elementCommandSchemas,
  elementPlacementOf,
  executeElementCommand,
  layerSetOf,
  partCategoryClass,
  readCoreElement,
  readMaterialLayerSet,
  type CoreElement,
} from "../src/elements";

const parse = (c: unknown) => z.discriminatedUnion("type", [...elementCommandSchemas]).parse(c);
const L = asElementId("lvl-1");
const base = { version: 1, authoredRev: {}, partition: { level: "Level 1", zone: "Z1", discipline: "architecture" as const } };

function model(): ModelState {
  const els: BimElement[] = [
    { id: L, version: 1, authoredRev: {}, kind: "level", name: "Level 1", elevationMm: 0 },
    { ...base, id: asElementId("w1"), kind: "wall", start: { x: 0, y: 0 }, end: { x: 6000, y: 0 }, thickness: 200, height: 3000, wallType: "Exterior" },
    { ...base, id: asElementId("w2"), kind: "wall", start: { x: 6000, y: 0 }, end: { x: 6000, y: 4000 }, thickness: 200, height: 3000, wallType: "Exterior" },
    { ...base, id: asElementId("d1"), kind: "opening", openingType: "door", mark: "101", hostId: asElementId("w1"), offset: 1500, width: 900, height: 2100, position: { x: 1500, y: 0 } },
    { ...base, id: asElementId("b1"), kind: "beam", sectionName: "W12x26", start: { x: 0, y: 0 }, end: { x: 6000, y: 0 } },
    { ...base, id: asElementId("c1"), kind: "column", material: "steel", position: { x: 0, y: 0 }, size: { x: 300, y: 300 } },
    { ...base, id: asElementId("s1"), kind: "slab", outline: [{ x: 0, y: 0 }, { x: 6000, y: 0 }, { x: 6000, y: 4000 }, { x: 0, y: 4000 }], thickness: 150 },
    { ...base, id: asElementId("r1"), kind: "room", number: "101", name: "Office", outline: [{ x: 0, y: 0 }, { x: 6000, y: 0 }, { x: 6000, y: 4000 }, { x: 0, y: 4000 }], areaSqM: 24 },
  ];
  return { modelId: "c5e-elements", revision: 3 as ModelState["revision"], elements: Object.fromEntries(els.map((e) => [e.id, e])), connections: [], settings: DEFAULT_SETTINGS };
}

const readsCore = <T>(fn: () => T): T => withUpgradePolicy(() => true, fn);

function ok(r: ExecuteResult): ModelState {
  if (!r.ok) throw new Error(r.error.message);
  return r.model;
}

function el(m: ModelState, id: string): CoreElement {
  const e = m.elements[id];
  const r = readCoreElement(e);
  if (!r.ok) throw new Error(r.reason);
  return r.element;
}

describe("the write gate", () => {
  it("refuses while the model server doesn't store element-core fields, in plain words", () => {
    const r = executeElementCommand(model(), parse({ type: "set_element_class", elementIds: ["w1"], classId: "arch.wall" }));
    expect(r.ok ? "" : r.error.message).toBe("Wall w1 can't take a class, type, values, placement or lock yet: the model server this model is open on is an older version that doesn't store them. Try again once the server is updated");
  });

  it("refuses parts and other kinds by name", () => {
    const r = readsCore(() => executeElementCommand(model(), parse({ type: "set_element_class", elementIds: ["lvl-1"], classId: "arch.wall" })));
    expect(r.ok ? "" : r.error.message).toMatch(/^lvl-1 is a level; classes are for building elements, zones, spaces, systems, run segments and parts$/);
  });
});

describe("class, type and values", () => {
  it("sets and clears an explicit class, writing the record at the current version", () => {
    const m = ok(readsCore(() => executeElementCommand(model(), parse({ type: "set_element_class", elementIds: ["c1"], classId: "struct.column" }))));
    expect(el(m, "c1")).toMatchObject({ classId: "struct.column", schemaVersion: 2 });
    const cleared = ok(readsCore(() => executeElementCommand(m, parse({ type: "set_element_class", elementIds: ["c1"], classId: null }))));
    expect(el(cleared, "c1")).not.toHaveProperty("classId");
    expect(el(cleared, "c1").schemaVersion).toBe(2); // stays cleared: a stamped record is never re-recognised
  });

  it("a class the model doesn't have (no pack defines it), a kernel-namespace class that doesn't exist, or an id with no namespace, is refused", () => {
    // Civil's classes: an add-on this model doesn't use (Structural, used here before round 14, is first-party now).
    const pack = readsCore(() => executeElementCommand(model(), parse({ type: "set_element_class", elementIds: ["b1"], classId: "civil.storm_pipe" })));
    expect(pack.ok ? "" : pack.error.message).toBe(`"civil.storm_pipe" isn't a class this model knows: add the pack that defines civil classes to the model, or choose a class it has`);
    const bad = readsCore(() => executeElementCommand(model(), parse({ type: "set_element_class", elementIds: ["w1"], classId: "arch.curtain_thing" })));
    expect(bad.ok ? "" : bad.error.message).toBe(`"arch.curtain_thing" isn't one of the model's arch classes`);
    const bare = readsCore(() => executeElementCommand(model(), parse({ type: "set_element_class", elementIds: ["w1"], classId: "wall" })));
    expect(bare.ok ? "" : bare.error.message).toMatch(/isn't a class: a class id has a namespace/);
  });

  it("an edit through a value command recognises the class too (one change, one version)", () => {
    const m = ok(readsCore(() => executeElementCommand(model(), parse({ type: "set_element_values", elementIds: ["w1", "w2"], values: { "material.layer_set": "ext-2x6", "arch.fire_rating_hr": 1 } }))));
    expect(el(m, "w1")).toMatchObject({ classId: "arch.wall", schemaVersion: 2, values: { "material.layer_set": "ext-2x6", "arch.fire_rating_hr": 1 } });
    const less = ok(readsCore(() => executeElementCommand(m, parse({ type: "set_element_values", elementIds: ["w1"], values: { "arch.fire_rating_hr": null } }))));
    expect(el(less, "w1").values).toEqual({ "material.layer_set": "ext-2x6" });
    expect(el(less, "w2").values).toEqual({ "material.layer_set": "ext-2x6", "arch.fire_rating_hr": 1 });
  });

  it("a type must be an element in the model, and not the element itself", () => {
    const missing = readsCore(() => executeElementCommand(model(), parse({ type: "set_element_type", elementIds: ["w1"], typeId: "wt-missing" })));
    expect(missing.ok ? "" : missing.error.message).toBe("wt-missing isn't a type in this model");
    const self = readsCore(() => executeElementCommand(model(), parse({ type: "set_element_type", elementIds: ["w1"], typeId: "w1" })));
    expect(self.ok ? "" : self.error.message).toBe("Wall w1 can't be its own type");
    const m = ok(readsCore(() => executeElementCommand(model(), parse({ type: "set_element_type", elementIds: ["w1"], typeId: "w2" }))));
    expect(el(m, "w1").typeId).toBe("w2");
  });

  it("a layer set is found through the element's value or its type's", () => {
    const set = readMaterialLayerSet({ id: "ext-2x6", layers: [{ materialId: "gyp", thicknessMm: 16, function: "finish" }, { materialId: "stud", thicknessMm: 140, function: "structure" }, { materialId: "osb", thicknessMm: 11, function: "fp.rated_sheathing", note: "kept" }] });
    if (!set.ok) throw new Error(set.reason);
    expect(set.unknownFunctions).toEqual(["fp.rated_sheathing"]);
    expect(set.set.layers[2]).toMatchObject({ note: "kept" });
    const catalogue = new Map([[set.set.id, set.set]]);
    let m = ok(readsCore(() => executeElementCommand(model(), parse({ type: "set_element_values", elementIds: ["w2"], values: { "material.layer_set": "ext-2x6" } }))));
    m = ok(readsCore(() => executeElementCommand(m, parse({ type: "set_element_type", elementIds: ["w1"], typeId: "w2" }))));
    expect(layerSetOf(m.elements, el(m, "w1"), catalogue)?.id).toBe("ext-2x6");
    expect(readMaterialLayerSet({ id: "x", layers: [{ materialId: "a", thicknessMm: -1 }] })).toEqual({ ok: false, reason: "layer 1 of x needs a thickness of 0 mm or more" });
  });
});

describe("placement beyond a point", () => {
  it("a wall placed by its left face mirrors its centreline into start and end; an older peer's move keeps the extras", () => {
    const m = ok(readsCore(() => executeElementCommand(model(), parse({ type: "set_element_placement", elementId: "w2", placement: { kind: "line", levelId: "lvl-1", start: { x: 6000, y: 0 }, end: { x: 6000, y: 4000 }, startOffsetMm: 0, endOffsetMm: 0, lateral: "left", vertical: "bottom" } }))));
    // Travelling north, the left face is to the west: the centre is 100 mm east.
    expect(el(m, "w2")).toMatchObject({ start: { x: 6100, y: 0 }, end: { x: 6100, y: 4000 }, placement: { lateral: "left" } });
    const view = elementPlacementOf(m.elements, el(m, "w2"));
    expect(view).toMatchObject({ source: "stored", levelKnown: true }); // the stored face and the flat centreline agree
    const moved = planCommit(m, [], { idempotencyKey: "c5e-move-w2", baseRevision: m.revision, actor: { id: "a", name: "A", kind: "human" }, command: commandSchema.parse({ type: "move_wall", wallId: "w2", delta: { x: 500, y: 0 } }) }, () => "2026-10-29T00:00:00.000Z");
    if (!moved.ok) throw new Error(moved.error.message);
    const after = elementPlacementOf(moved.model.elements, el(moved.model, "w2"));
    // move_wall writes the line once (round 16): the stored face moves with the centreline and keeps its justification.
    expect(after).toMatchObject({ source: "stored", placement: { kind: "line", start: { x: 6500, y: 0 }, end: { x: 6500, y: 4000 }, lateral: "left" } });
    // An older peer's move (the flat line only) still reads with the extras kept.
    const w2 = el(moved.model, "w2");
    const older = { ...w2, start: { x: 7100, y: 0 }, end: { x: 7100, y: 4000 } } as typeof w2;
    expect(elementPlacementOf(moved.model.elements, older)).toMatchObject({ source: "flat", placement: { kind: "line", start: { x: 7000, y: 0 }, end: { x: 7000, y: 4000 }, lateral: "left" } });
  });

  it("a beam follows a curved path with stations; its flat ends are the path's ends", () => {
    const m = ok(readsCore(() => executeElementCommand(model(), parse({ type: "set_element_placement", elementId: "b1", placement: { kind: "path", levelId: "lvl-1", start: { x: 0, y: 0 }, segments: [{ kind: "arc", to: { x: 6000, y: 0 }, bulge: 0.2 }], startStationMm: 0, offsetMm: 3000, lateral: "center" } }))));
    expect(el(m, "b1")).toMatchObject({ start: { x: 0, y: 0 }, end: { x: 6000, y: 0 } });
    expect(elementPlacementOf(m.elements, el(m, "b1"))).toMatchObject({ source: "stored", placement: { kind: "path" } });
  });

  it("a slab over an area with a shaft and a span direction; a room's area is recomputed less its holes", () => {
    const outline = [{ x: 0, y: 0 }, { x: 6000, y: 0 }, { x: 6000, y: 4000 }, { x: 0, y: 4000 }];
    const holes = [[{ x: 1000, y: 1000 }, { x: 1000, y: 2000 }, { x: 2000, y: 2000 }, { x: 2000, y: 1000 }]];
    let m = ok(readsCore(() => executeElementCommand(model(), parse({ type: "set_element_placement", elementId: "s1", placement: { kind: "area", levelId: "lvl-1", outline, holes, offsetMm: 0, vertical: "top", spanDirectionDeg: 90 } }))));
    expect(elementPlacementOf(m.elements, el(m, "s1"))).toMatchObject({ source: "stored", placement: { spanDirectionDeg: 90 } });
    m = ok(readsCore(() => executeElementCommand(m, parse({ type: "set_element_placement", elementId: "r1", placement: { kind: "area", levelId: "lvl-1", outline, holes, offsetMm: 0, vertical: "bottom" } }))));
    const r1 = el(m, "r1");
    expect(r1.kind === "room" && r1.areaSqM).toBe(23);
  });

  it("refuses a hosted opening, a placement kind the element can't take, a missing level and a profile that goes backwards", () => {
    const tries: [unknown, RegExp][] = [
      [{ type: "set_element_placement", elementId: "d1", placement: { kind: "point", levelId: "lvl-1", position: { x: 0, y: 0 }, offsetMm: 0, rotationDeg: 0 } }, /^Door 101 sits in its wall; move it along the wall/],
      [{ type: "set_element_placement", elementId: "c1", placement: { kind: "area", levelId: "lvl-1", outline: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], offsetMm: 0, vertical: "top" } }, /can't be placed as an area; it takes a point or a line$/],
      [{ type: "set_element_placement", elementId: "c1", placement: { kind: "point", levelId: "lvl-9", position: { x: 0, y: 0 }, offsetMm: 0, rotationDeg: 0 } }, /can't be placed on lvl-9: it isn't a level in this model/],
      [{ type: "set_element_placement", elementId: "b1", placement: { kind: "path", levelId: "lvl-1", start: { x: 0, y: 0 }, segments: [{ kind: "line", to: { x: 6000, y: 0 } }], profile: [{ stationMm: 10, elevationMm: 0 }, { stationMm: 5, elevationMm: 0 }], offsetMm: 0, lateral: "center" } }, /profile stations must go up/],
    ];
    for (const [cmd, why] of tries) {
      const r = readsCore(() => executeElementCommand(model(), parse(cmd)));
      expect(r.ok ? "" : r.error.message).toMatch(why);
    }
  });
});

describe("locks", () => {
  const locked = () => ok(readsCore(() => executeElementCommand(model(), parse({ type: "lock_elements", elementIds: ["w1"], state: "existing", reason: "Surveyed as built, Oct 2026" }), { actorId: "avery" })));

  it("a locked wall refuses every edit, with the reason", () => {
    const m = locked();
    expect(el(m, "w1").locked).toEqual({ state: "existing", reason: "Surveyed as built, Oct 2026", by: "avery" });
    const move = readsCore(() => planCommit(m, [], { idempotencyKey: "c5e-lock-move", baseRevision: m.revision, actor: { id: "a", name: "A", kind: "human" }, command: commandSchema.parse({ type: "move_wall", wallId: "w1", delta: { x: 0, y: 100 } }) }, () => "2026-10-29T00:00:00.000Z"));
    expect(move.ok ? "" : move.error.message).toBe("Wall w1 is locked as existing conditions (Surveyed as built, Oct 2026), so it can't be changed. Unlock it first");
    const values = readsCore(() => executeElementCommand(m, parse({ type: "set_element_values", elementIds: ["w1"], values: { "arch.note": "x" } })));
    expect(values.ok ? "" : values.error.code).toBe("locked");
  });

  it("unlocking lets it change again; unlocking what isn't locked says so", () => {
    const m = ok(readsCore(() => executeElementCommand(locked(), parse({ type: "unlock_elements", elementIds: ["w1"] }))));
    expect(el(m, "w1")).not.toHaveProperty("locked");
    expect(readsCore(() => executeElementCommand(m, parse({ type: "set_element_values", elementIds: ["w1"], values: { "arch.note": "x" } }))).ok).toBe(true);
    const again = readsCore(() => executeElementCommand(m, parse({ type: "unlock_elements", elementIds: ["w1"] })));
    expect(again.ok ? "" : again.error.message).toBe("Wall w1 isn't locked");
  });

  it("a lock state a newer peer wrote still locks", () => {
    const m = model();
    const w1 = el(m, "w1");
    const newer: CoreElement = { ...w1, locked: { state: "permitted", reason: "Permit set" } };
    const withNewer: ModelState = { ...m, elements: { ...m.elements, w1: newer } };
    const r = readsCore(() => executeElementCommand(withNewer, parse({ type: "set_element_values", elementIds: ["w1"], values: { "arch.note": "x" } })));
    expect(r.ok ? "" : r.error.message).toBe('Wall w1 is locked as "permitted" (Permit set), so it can\'t be changed. Unlock it first');
  });
});

describe("tolerant readers, strict writers", () => {
  it("a newer peer's opening type, component category and column material read as themselves, the same object", () => {
    const raws = [
      { ...base, id: "o", kind: "opening", openingType: "louver", mark: "", hostId: "w1", offset: 1, width: 1, height: 1, position: { x: 0, y: 0 }, futureField: { a: 1 } },
      { ...base, id: "k", kind: "component", category: "paving", typeName: "Pavers", position: { x: 0, y: 0 }, size: { x: 1, y: 1 }, rotationDeg: 0 },
      { ...base, id: "c", kind: "column", material: "timber", position: { x: 0, y: 0 }, size: { x: 1, y: 1 }, placement: { kind: "helix", levelId: "lvl-1", turns: 3 } },
    ];
    for (const raw of raws) {
      const r = readCoreElement(raw);
      expect(r.ok && r.element).toBe(raw);
    }
    // An unknown placement kind is kept, not drawn.
    const column = readCoreElement(raws[2]);
    expect(column.ok ? elementPlacementOf({}, column.element) : "unread").toBeNull();
  });

  it("refuses a record missing a field it reads, by name", () => {
    expect(readCoreElement({ ...base, id: "w", kind: "wall", start: { x: 0, y: 0 }, thickness: 1, height: 1, wallType: "" })).toMatchObject({ ok: false, reason: expect.stringMatching(/^end:/) });
  });

  it("a part category this release doesn't know is kept and behaves as generic; writers still take only the known list", () => {
    expect(readPartCategory("struct.connection_plate")).toEqual({ stored: "struct.connection_plate", known: null, behavesAs: "generic" });
    expect(readPartCategory("plumbing_fixture")).toMatchObject({ known: "plumbing_fixture" });
    expect(readPartCategory("Not An Id")).toBeNull();
    expect(partCategoryClass("struct.connection_plate")).toBe("gen.generic_model");
    expect(partCategoryClass("plumbing_fixture")).toBe("mep.plumbing_fixture");
    const def: PartTypeDefinition = { familyName: "Plate", typeName: "PL1/2", category: "generic", typeParams: [], typeValues: {}, instanceParams: [], connectors: [], geometry: [], symbol: [], tagFields: [], source: { kind: "builtin", libraryVersion: "test" } };
    const newer = { ...def, category: "struct.connection_plate" };
    expect(storedPartTypeDefinitionSchema.safeParse(newer).success).toBe(true);
    expect(partTypeDefinitionSchema.safeParse(newer).success).toBe(false);
  });
});
