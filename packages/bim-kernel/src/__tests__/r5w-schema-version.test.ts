/**
 * @jest-environment node
 *
 * Record schema versions (round 5a, f-wire; MIGRATION-PLAN §3 "Records").
 *
 * Fails on the code before round 5a: `schema-version/` did not exist (only
 * drafting had a version, private to annotation/drafting-migrations.ts), so
 * there was no per-kind registry, no gate on what peers read, and no generic
 * upgrade-on-edit. The drafting cases pin that moving drafting onto the
 * registry changed nothing it answers.
 */
import {
  asElementId,
  DRAFTING_MIGRATIONS,
  DRAFTING_SCHEMA_VERSION,
  currentSchemaVersion,
  draftingVersionOf,
  registerSchemaStep,
  schemaSteps,
  schemaVersionOf,
  storedSchemaVersion,
  unregisterSchemaSteps,
  upgradeOnEdit,
  withUpgradePolicy,
  type BimElement,
  type DrawingItem,
  type Level,
} from "@permitzip/bim-kernel";

function drawingItem(shape: DrawingItem["shape"], deleted = false): DrawingItem {
  return {
    id: asElementId(`di-${shape}-${deleted ? "x" : "o"}`),
    version: 1,
    authoredRev: {},
    kind: "drawing_item",
    ownerId: asElementId("det"),
    shape,
    points: [{ x: 0, y: 0 }, { x: 1000, y: 500 }],
    ...(deleted ? { deleted: true } : {}),
  };
}

/** The drafting answer before round 5a, kept verbatim as the reference. */
function oldDraftingVersionOf(item: DrawingItem): number {
  const old = [{ from: 1, applies: (i: DrawingItem) => i.shape === "rect" && !i.deleted }];
  for (const m of old) if (m.applies(item)) return m.from;
  return 2;
}

describe("drafting moved onto the record schema registry", () => {
  it("answers exactly what it answered before", () => {
    expect(DRAFTING_SCHEMA_VERSION).toBe(2);
    expect(currentSchemaVersion("drawing_item")).toBe(2);
    expect(DRAFTING_MIGRATIONS.map((m) => m.name)).toEqual(["rectangle_to_joined_lines"]);
    expect(schemaSteps("drawing_item").map((s) => [s.from, s.to, s.name, s.feature])).toEqual([[1, 2, "rectangle_to_joined_lines", null]]);
    for (const item of [drawingItem("rect"), drawingItem("rect", true), drawingItem("line"), drawingItem("text"), drawingItem("cloud")]) {
      expect(draftingVersionOf(item)).toBe(oldDraftingVersionOf(item));
    }
  });

  it("does not rewrite drafting records on edit: its upgrade stays inside the drafting commands", () => {
    const rect = drawingItem("rect");
    const working: Record<string, BimElement> = { [rect.id]: rect };
    expect(withUpgradePolicy(() => true, () => upgradeOnEdit(working, [rect.id]))).toEqual([]);
    expect(working[rect.id]).toBe(rect);
  });
});

describe("the registry refuses a broken chain", () => {
  afterEach(() => unregisterSchemaSteps("level"));

  it("refuses a step that skips a version or starts past the chain", () => {
    expect(() => registerSchemaStep({ kind: "level", from: 1, to: 3, name: "skip", feature: null })).toThrow(/must go from 1 to 2/);
    expect(() => registerSchemaStep({ kind: "level", from: 2, to: 3, name: "late", feature: null })).toThrow(/chain is at 1/);
  });

  it("refuses a second, different step from the same version", () => {
    registerSchemaStep({ kind: "level", from: 1, to: 2, name: "a", feature: null, upgrade: (r) => r });
    expect(() => registerSchemaStep({ kind: "level", from: 1, to: 2, name: "b", feature: null })).toThrow(/already has a step from 1/);
  });
});

describe("upgrade on edit", () => {
  const FEATURE = "schema:level@2";
  const level: Level = { id: asElementId("lvl-1"), version: 3, authoredRev: {}, kind: "level", name: "Level 1", elevationMm: 0 };
  const other: Level = { ...level, id: asElementId("lvl-2"), name: "Level 2" };

  beforeAll(() => {
    registerSchemaStep({
      kind: "level",
      from: 1,
      to: 2,
      name: "r5w_test_level_note",
      feature: FEATURE,
      upgrade: (r) => (r.kind === "level" ? Object.assign({}, r, { r5wNote: "upgraded" }) : r),
    });
  });
  afterAll(() => unregisterSchemaSteps("level"));

  it("upgrades only the records the edit touched, and stamps their version", () => {
    const working: Record<string, BimElement> = { [level.id]: level, [other.id]: other };
    const upgraded = withUpgradePolicy((f) => f === FEATURE, () => upgradeOnEdit(working, [level.id]));
    expect(upgraded).toEqual([level.id]);
    const after = working[level.id];
    expect(after && storedSchemaVersion(after)).toBe(2);
    expect(after && schemaVersionOf(after)).toBe(2);
    expect(after).toMatchObject({ r5wNote: "upgraded", name: "Level 1", version: 3 });
    expect(working[other.id]).toBe(other);
    expect(level).not.toHaveProperty("schemaVersion"); // the stored record is untouched: undo puts it back
  });

  it("writes nothing while a peer does not read the new shape", () => {
    const working: Record<string, BimElement> = { [level.id]: level };
    expect(upgradeOnEdit(working, [level.id])).toEqual([]); // no host policy: gated steps never run
    expect(withUpgradePolicy(() => false, () => upgradeOnEdit(working, [level.id]))).toEqual([]);
    expect(working[level.id]).toBe(level);
  });

  it("leaves a record already at the current version alone", () => {
    const current = Object.assign({}, level, { schemaVersion: 2 });
    const working: Record<string, BimElement> = { [level.id]: current };
    expect(withUpgradePolicy(() => true, () => upgradeOnEdit(working, [level.id]))).toEqual([]);
    expect(working[level.id]).toBe(current);
  });

  it("restores the policy after the decision, even when it throws", () => {
    expect(() =>
      withUpgradePolicy(() => true, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    const working: Record<string, BimElement> = { [level.id]: level };
    expect(upgradeOnEdit(working, [level.id])).toEqual([]);
  });
});
