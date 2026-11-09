/**
 * @jest-environment node
 *
 * Upgrade on edit for typed elements (5c item b): a wall in an old model that
 * an edit touches gains the class the built-in registry recognises it as, in
 * the same changeset; undo restores the stored record; walls the edit didn't
 * touch are unchanged; a peer that doesn't read `elements:core` never gets
 * the new fields. Fails on the code before 5c: no element kind had a schema
 * step, so an edited wall was written exactly as before.
 */
import { asElementId, canonicalJson, commandSchema, DEFAULT_SETTINGS, gatedRecordFeatures, planCommit, upgradeOnEdit, withUpgradePolicy, withoutUpgrades, type BimElement, type Changeset, type ModelState, type Wall } from "../src";
import { builtinClassOf, ELEMENTS_CORE_FEATURE, type CoreElement } from "../src/elements";

const actor = { id: "avery", name: "Avery", kind: "human" as const };
let seq = 0;

function commit(head: ModelState, command: unknown, history: readonly Changeset[] = []): { model: ModelState; changeset: Changeset } {
  seq += 1;
  const d = planCommit(head, [], { idempotencyKey: `c5e-upgrade-${seq}`, baseRevision: head.revision, actor, command: commandSchema.parse(command) }, () => "2026-10-29T00:00:00.000Z", history);
  if (!d.ok) throw new Error(d.error.message);
  return { model: d.model, changeset: d.changeset };
}

/** An old model: three walls traced before element core existed (no policy, so nothing gated is written). */
function oldModel(): ModelState {
  let m: ModelState = { modelId: "c5e-upgrade", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  m = commit(m, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 }).model;
  m = commit(m, {
    type: "add_architecture",
    levelId: "lvl-1",
    walls: [
      { wallId: "w1", start: { x: 0, y: 0 }, end: { x: 5000, y: 0 }, thicknessMm: 200 },
      { wallId: "w2", start: { x: 5000, y: 0 }, end: { x: 5000, y: 4000 }, thicknessMm: 200 },
      { wallId: "w3", start: { x: 5000, y: 4000 }, end: { x: 0, y: 4000 }, thicknessMm: 200 },
    ],
  }).model;
  return m;
}

const wall = (m: ModelState, id: string): Wall => {
  const el = m.elements[id];
  if (el?.kind !== "wall") throw new Error(`${id} is a wall`);
  return el;
};

describe("elements:core rides 5a's gated record steps", () => {
  it("every building and structure kind has the step, and peers of this release advertise the feature", () => {
    expect(gatedRecordFeatures()).toContain(ELEMENTS_CORE_FEATURE);
  });

  it("an old model's walls carry no element-core fields", () => {
    const m = oldModel();
    for (const id of ["w1", "w2", "w3"]) {
      expect(wall(m, id)).not.toHaveProperty("classId");
      expect(wall(m, id)).not.toHaveProperty("schemaVersion");
    }
  });
});

describe("edit a wall in an old model", () => {
  const start = oldModel();
  const untouchedBefore = canonicalJson(wall(start, "w3"));
  const edited = withUpgradePolicy(() => true, () => commit(start, { type: "move_wall", wallId: "w1", delta: { x: 0, y: 100 } }));

  it("the edited wall gains its class and version in the same changeset", () => {
    expect(wall(edited.model, "w1")).toMatchObject({ classId: "arch.wall", schemaVersion: 2, start: { x: 0, y: 100 } });
    const inChangeset = edited.changeset.elements.find((el) => el.id === "w1");
    expect(inChangeset).toMatchObject({ classId: "arch.wall", schemaVersion: 2 });
  });

  it("walls the edit didn't touch are byte for byte what they were", () => {
    expect(canonicalJson(wall(edited.model, "w3"))).toBe(untouchedBefore);
    expect(wall(edited.model, "w3")).not.toHaveProperty("classId");
  });

  it("the wall joined to it follows (round 16) and is upgraded in the same changeset, as an edited wall", () => {
    expect(wall(edited.model, "w2")).toMatchObject({ classId: "arch.wall", schemaVersion: 2, start: { x: 5000, y: 100 }, end: { x: 5000, y: 4000 } });
    expect(edited.changeset.elements.map((el) => el.id).sort()).toEqual(["w1", "w2"]);
  });

  it("undo puts the stored record back, without upgrading it again", () => {
    const undone = withoutUpgrades(() => commit(edited.model, { type: "undo", revision: edited.changeset.revision }, [edited.changeset]));
    const w1 = wall(undone.model, "w1");
    expect(w1).not.toHaveProperty("classId");
    expect(w1).not.toHaveProperty("schemaVersion");
    expect(w1.start).toEqual({ x: 0, y: 0 });
  });

  it("the next edit after undo upgrades it again", () => {
    const undone = withoutUpgrades(() => commit(edited.model, { type: "undo", revision: edited.changeset.revision }, [edited.changeset]));
    const again = withUpgradePolicy(() => true, () => commit(undone.model, { type: "move_wall", wallId: "w1", delta: { x: 0, y: 50 } }));
    expect(wall(again.model, "w1")).toMatchObject({ classId: "arch.wall", schemaVersion: 2 });
  });

  it("a peer that doesn't read elements:core gets the old shape", () => {
    const older = withUpgradePolicy((f) => f !== ELEMENTS_CORE_FEATURE, () => commit(start, { type: "move_wall", wallId: "w1", delta: { x: 0, y: 100 } }));
    expect(wall(older.model, "w1")).not.toHaveProperty("classId");
    expect(wall(older.model, "w1")).not.toHaveProperty("schemaVersion");
  });
});

describe("recognition for each kind", () => {
  const base = { version: 1, authoredRev: {} };
  const opening = (openingType: string): CoreElement => ({ ...base, id: asElementId(`o-${openingType}`), kind: "opening", openingType, mark: "", hostId: asElementId("w1"), offset: 1000, width: 900, height: 2100, position: { x: 1000, y: 0 } });

  it("doors and windows by type; a type this release doesn't know stays unclassified and is still stamped", () => {
    expect(builtinClassOf(opening("door"))).toBe("arch.door");
    expect(builtinClassOf(opening("window"))).toBe("arch.window");
    expect(builtinClassOf(opening("louver"))).toBeNull();
    const louver = opening("louver");
    const working: Record<string, BimElement> = { [louver.id]: louver };
    withUpgradePolicy(() => true, () => upgradeOnEdit(working, [louver.id]));
    expect(working[louver.id]).toEqual({ ...louver, schemaVersion: 2 });
  });

  it("columns, beams, grids, slabs, rooms and components each map to their built-in class", () => {
    const els: CoreElement[] = [
      { ...base, id: asElementId("c"), kind: "column", material: "timber", position: { x: 0, y: 0 }, size: { x: 300, y: 300 } },
      { ...base, id: asElementId("b"), kind: "beam", sectionName: "W12x26", start: { x: 0, y: 0 }, end: { x: 6000, y: 0 } },
      { ...base, id: asElementId("g"), kind: "grid", label: "A", start: { x: 0, y: 0 }, end: { x: 0, y: 9000 } },
      { ...base, id: asElementId("s"), kind: "slab", outline: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], thickness: 150 },
      { ...base, id: asElementId("r"), kind: "room", number: "101", name: "Office", outline: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], areaSqM: 0 },
      { ...base, id: asElementId("k"), kind: "component", category: "paving", typeName: "Pavers", position: { x: 0, y: 0 }, size: { x: 1, y: 1 }, rotationDeg: 0 },
    ];
    expect(els.map(builtinClassOf)).toEqual(["struct.column", "struct.beam", "struct.grid", "arch.slab", "arch.room", "arch.component"]);
  });
});

describe("elements.upgrade_on_edit.250k (micro)", () => {
  it("upgrading the one edited wall in a 250,000-element record touches only that wall", () => {
    const working: Record<string, BimElement> = {};
    for (let i = 0; i < 250_000; i++) {
      const id = asElementId(`w-${i}`);
      working[id] = { id, version: 1, authoredRev: {}, kind: "wall", start: { x: i, y: 0 }, end: { x: i, y: 3000 }, thickness: 100, height: 3000, wallType: "Partition" };
    }
    const target = asElementId("w-123456");
    const before = working[asElementId("w-7")];
    const t0 = performance.now();
    const upgraded = withUpgradePolicy(() => true, () => upgradeOnEdit(working, [target]));
    const ms = performance.now() - t0;
    expect(upgraded).toEqual([target]);
    expect(working[target]).toMatchObject({ classId: "arch.wall", schemaVersion: 2 });
    expect(working[asElementId("w-7")]).toBe(before);
    // Measured for the perf row (the edit-path cost is per touched record, independent of model size).
    expect(ms).toBeLessThan(25);
  });
});
