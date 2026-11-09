/**
 * @jest-environment node
 *
 * Round 5b f-spatial: zone bounds as spaces, outline or derived
 * (KERNEL-FOUNDATION §3.4, MIGRATION-PLAN §3/§6 "Spatial").
 *
 * - A v1 zone (only spaceIds) reads as a spaces zone; every space command on
 *   it writes exactly what it wrote before (equivalence).
 * - Outlined and derived zones are `zone@2`: refused in plain words until the
 *   host's policy says every peer reads `schema:zone@2`, then written.
 * - A derived zone stores only its host and rule; its geometry follows the
 *   panel when it moves (computed, cached on the host's revision).
 * - A bounds kind from a newer peer round-trips byte for byte through an
 *   edit and the wire (rolling deploy).
 *
 * Fails on the old code: Zone had no bounds, `create_zone` took no outline,
 * `accept_derived_zone` didn't exist, and the 110.26(E) space lived only
 * inside the lint rule.
 */
import {
  asElementId,
  buildViewScene,
  builtinPartType,
  canonicalJson,
  DEFAULT_SETTINGS,
  executeCommand,
  gatedRecordFeatures,
  recomputeDerived,
  schemaVersionOf,
  storedSchemaVersion,
  validateModel,
  withUpgradePolicy,
  type BimElement,
  type Command,
  type ModelState,
} from "../src";
import { DEDICATED_SPACE_RULE, derivedZoneCandidates, derivedZonePlacements, derivedRegionsOfZone, resolveDerivedZone } from "../src/spaces/derived-zones";
import { executeSpaceDesignCommand, type SpaceDesignCommand } from "../src/spaces/space-commands";
import { spacesOfZone, zonesOfSpace } from "../src/spaces/space-index";
import type { Zone } from "../src/spaces/types";
import { upgradeOnEdit } from "../src/schema-version/upgrade";
import { ZONE_BOUNDS_FEATURE, zoneBoundsOf, zoneBoundsWritable, zoneSpaceIds } from "../src/spaces/zone-bounds";

const FT = 304.8;
const L1 = asElementId("L1");
const everyoneReads = <T>(fn: () => T): T => withUpgradePolicy((f) => f === ZONE_BOUNDS_FEATURE, fn);
const PANEL = builtinPartType("builtin:panelboard-225@1");

function base(): ModelState {
  const level: BimElement = { id: L1, kind: "level", version: 1, authoredRev: {}, name: "Level 1", elevationMm: 0 };
  let model: ModelState = { modelId: "r5z", revision: 0 as ModelState["revision"], elements: { [L1]: level }, connections: [], settings: DEFAULT_SETTINGS };
  const r = executeCommand(model, { type: "create_view", viewId: "v-plan", name: "Level 1 plan", viewType: "floor_plan", props: { level: "Level 1" } });
  if (!r.ok) throw new Error(r.error.message);
  model = r.model;
  return model;
}

function space(m: ModelState, c: SpaceDesignCommand): ModelState {
  const r = executeSpaceDesignCommand(m, c);
  if (!r.ok) throw new Error(`${c.type}: ${r.error.message}`);
  return r.model;
}

function run(m: ModelState, c: Command): ModelState {
  const r = executeCommand(m, c);
  if (!r.ok) throw new Error(`${c.type}: ${r.error.message}`);
  return r.model;
}

const SQ = (x0: number, y0: number, s: number) => [
  { x: x0 * FT, y: y0 * FT },
  { x: (x0 + s) * FT, y: y0 * FT },
  { x: (x0 + s) * FT, y: (y0 + s) * FT },
  { x: x0 * FT, y: (y0 + s) * FT },
];

function withSpaces(m: ModelState): ModelState {
  return space(m, {
    type: "create_space",
    spaces: [
      { spaceId: "s1", number: "101", name: "Dining", levelId: L1, outline: SQ(0, 0, 20) },
      { spaceId: "s2", number: "102", name: "Kitchen", levelId: L1, outline: SQ(20, 0, 20) },
    ],
  });
}

function withPanel(m: ModelState, at = { x: 10 * FT, y: 10 * FT }): ModelState {
  if (!PANEL) throw new Error("starter library is missing the panelboard");
  let next = run(m, { type: "place_part", partId: "p1", typeId: PANEL.id, partType: PANEL.definition, levelId: L1, position: at, offsetMm: 0, mark: "P1", values: { panel_name: "P1" } });
  next = run(next, {
    type: "set_part_clearances",
    id: "p1",
    scope: "instance",
    overrides: { dedicated_space: { name: "Dedicated space above", purpose: "dedicated_space", face: "top", depth: 6 * FT, excludes: "foreign_systems", toStructure: true, endsAtSuspendedCeiling: true, cite: "NEC 2023 110.26(E)(1)(a)" } },
  });
  return next;
}

describe("r5z zone bounds: v1 zones read as spaces and edit exactly as before", () => {
  it("a zone with only spaceIds reads as a spaces zone and the index follows it", () => {
    let m = withSpaces(base());
    m = space(m, { type: "create_zone", zoneId: "z1", name: "Zone 1", purpose: "thermal", spaceIds: ["s1", "s2"] });
    const z = m.elements.z1 as Zone;
    expect(z).not.toHaveProperty("bounds");
    expect(zoneBoundsOf(z)).toEqual({ kind: "spaces", spaceIds: ["s1", "s2"] });
    expect(spacesOfZone(m.elements, z.id).map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(schemaVersionOf(z)).toBe(1);
  });

  it("with no upgrade policy (old peers), create, edit and delete write the v1 shape byte for byte", () => {
    let m = withSpaces(base());
    m = space(m, { type: "create_zone", zoneId: "z1", name: "Zone 1", purpose: "thermal", spaceIds: ["s1"] });
    m = space(m, { type: "edit_zone", zoneId: "z1", addSpaceIds: ["s2"], name: "Zone A" });
    expect(canonicalJson(m.elements.z1)).toBe(canonicalJson({ ...(m.elements.z1 as Zone), spaceIds: ["s1", "s2"] }));
    expect(m.elements.z1).not.toHaveProperty("bounds");
    expect(m.elements.z1).not.toHaveProperty("schemaVersion");
    m = space(m, { type: "delete_spaces", spaceIds: ["s1"] });
    expect((m.elements.z1 as Zone).spaceIds).toEqual(["s2"]);
    expect(m.elements.z1).not.toHaveProperty("bounds");
  });

  it("registers zone@2 as a gated feature every new peer advertises", () => {
    expect(gatedRecordFeatures()).toContain(ZONE_BOUNDS_FEATURE);
    expect(zoneBoundsWritable()).toBe(false);
    expect(everyoneReads(() => zoneBoundsWritable())).toBe(true);
  });

  it("quiet upgrade on edit: a touched v1 zone gains bounds beside spaceIds; the stored record is untouched", () => {
    let m = withSpaces(base());
    m = space(m, { type: "create_zone", zoneId: "z1", name: "Zone 1", purpose: "thermal", spaceIds: ["s1"] });
    const stored = m.elements.z1 as Zone;
    const r = everyoneReads(() => executeSpaceDesignCommand(m, { type: "edit_zone", zoneId: "z1", name: "Zone A" }));
    if (!r.ok) throw new Error(r.error.message);
    const after = r.model.elements.z1 as Zone;
    expect(after).toMatchObject({ name: "Zone A", spaceIds: ["s1"], bounds: { kind: "spaces", spaceIds: ["s1"] } });
    expect(storedSchemaVersion(after)).toBe(2);
    expect(stored).not.toHaveProperty("bounds");
    // A later space edit keeps the mirror and the bounds equal.
    const r2 = everyoneReads(() => executeSpaceDesignCommand(r.model, { type: "edit_zone", zoneId: "z1", addSpaceIds: ["s2"] }));
    if (!r2.ok) throw new Error(r2.error.message);
    const z2 = r2.model.elements.z1 as Zone;
    expect(z2.spaceIds).toEqual(["s1", "s2"]);
    expect(z2.bounds).toEqual({ kind: "spaces", spaceIds: ["s1", "s2"] });
    expect(zonesOfSpace(r2.model.elements, asElementId("s2")).map((z) => z.id)).toEqual(["z1"]);
  });

  it("the step is pure and idempotent on a record already at zone@2", () => {
    const z: Zone = { id: asElementId("z9"), kind: "zone", version: 1, authoredRev: {}, name: "Z", purpose: "thermal", spaceIds: [], bounds: { kind: "spaces", spaceIds: [] } };
    const working: Record<string, BimElement> = { [z.id]: z };
    expect(everyoneReads(() => upgradeOnEdit(working, [z.id]))).toEqual([]);
    expect(working[z.id]).toBe(z);
  });
});

describe("r5z outlined zones", () => {
  const outline = { levelId: "L1", outline: SQ(0, 0, 30), topMm: 9 * FT };

  it("refuses in plain words while a peer can't read them, and writes nothing", () => {
    const m = base();
    const r = executeSpaceDesignCommand(m, { type: "create_zone", zoneId: "fa1", name: "Fire area 1", purpose: "fire_area", outline });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/older version that can't read outlined or code zones yet.*reload/);
  });

  it("draws a fire area across a corridor as an outline on the level, no spaces needed", () => {
    const m = everyoneReads(() => space(base(), { type: "create_zone", zoneId: "fa1", name: "Fire area 1", purpose: "fire_area", outline }));
    const z = m.elements.fa1 as Zone;
    expect(z.bounds).toEqual({ kind: "outline", levelId: L1, outline: SQ(0, 0, 30), top: 9 * FT });
    expect(z.spaceIds).toEqual([]);
    expect(zoneSpaceIds(z)).toEqual([]);
    expect(schemaVersionOf(z)).toBe(2);
  });

  it("refuses spaces and an outline together, a bad outline, and adding spaces to an outlined zone", () => {
    const m = withSpaces(base());
    const both = everyoneReads(() => executeSpaceDesignCommand(m, { type: "create_zone", zoneId: "fa1", name: "F", purpose: "fire_area", outline, spaceIds: ["s1"] }));
    expect(!both.ok && both.error.message).toMatch(/either drawn as an outline or made of spaces/);
    const crossed = everyoneReads(() => executeSpaceDesignCommand(m, { type: "create_zone", zoneId: "fa2", name: "F", purpose: "fire_area", outline: { levelId: "L1", outline: [SQ(0, 0, 10)[0], SQ(0, 0, 10)[2], SQ(0, 0, 10)[1], SQ(0, 0, 10)[3]].flatMap((p) => (p ? [p] : [])) } }));
    expect(!crossed.ok && crossed.error.message).toMatch(/crosses itself/);
    const made = everyoneReads(() => space(m, { type: "create_zone", zoneId: "fa1", name: "F", purpose: "fire_area", outline }));
    const add = everyoneReads(() => executeSpaceDesignCommand(made, { type: "edit_zone", zoneId: "fa1", addSpaceIds: ["s1"] }));
    expect(!add.ok && add.error.message).toMatch(/is drawn as an outline, so it has no spaces to add or take out/);
  });
});

describe("r5z derived zones: the NEC 110.26(E) space above a panel", () => {
  it("is offered for P1, computed from its clearance, and kept as host + rule only", () => {
    const m = withPanel(base());
    const offered = derivedZoneCandidates(m, { levelId: L1 });
    expect(offered.map((c) => [c.hostLabel, c.rule, c.zoneId])).toEqual([["P1", DEDICATED_SPACE_RULE, null]]);
    const region = offered[0]?.regions[0];
    expect(region).toMatchObject({ hostId: "p1", clearanceId: "dedicated_space", cite: "NEC 2023 110.26(E)(1)(a)", levelId: L1 });
    expect(region && region.topMm - region.bottomMm).toBeCloseTo(6 * FT, 3);

    const kept = everyoneReads(() => space(m, { type: "accept_derived_zone", zoneId: "dz1", hostId: "p1" }));
    const z = kept.elements.dz1 as Zone;
    expect(z.bounds).toEqual({ kind: "derived", hostId: "p1", rule: DEDICATED_SPACE_RULE });
    expect(z).toMatchObject({ name: "Dedicated space above P1", purpose: "code_clearance", spaceIds: [] });
    expect(JSON.stringify(z)).not.toMatch(/corners|outline|topMm/); // computed, never stored
    expect(derivedZoneCandidates(kept, { levelId: L1 })[0]?.zoneId).toBe("dz1");
  });

  it("follows the panel when it moves, and says plainly when the panel is gone", () => {
    let m = everyoneReads(() => space(withPanel(base()), { type: "accept_derived_zone", zoneId: "dz1", hostId: "p1" }));
    const before = derivedRegionsOfZone(m, m.elements.dz1 as Zone);
    m = run(m, { type: "move_elements", ids: ["p1"], delta: { x: 5 * FT, y: 0 } });
    const after = derivedRegionsOfZone(m, m.elements.dz1 as Zone);
    if (!before?.ok || !after?.ok) throw new Error("expected regions");
    expect((after.regions[0]?.centre.x ?? 0) - (before.regions[0]?.centre.x ?? 0)).toBeCloseTo(5 * FT, 3);
    m = run(m, { type: "delete_elements", ids: ["p1"], policy: "cascade" });
    const gone = resolveDerivedZone(m, asElementId("p1"), DEDICATED_SPACE_RULE);
    expect(gone).toEqual({ ok: false, reason: "The equipment this zone comes from (p1) was deleted" });
  });

  it("refuses a second copy, an unknown rule, a part with no such clearance, and old peers", () => {
    const m = withPanel(base());
    const old = executeSpaceDesignCommand(m, { type: "accept_derived_zone", zoneId: "dz1", hostId: "p1" });
    expect(!old.ok && old.error.message).toMatch(/older version/);
    const kept = everyoneReads(() => space(m, { type: "accept_derived_zone", zoneId: "dz1", hostId: "p1" }));
    const twice = everyoneReads(() => executeSpaceDesignCommand(kept, { type: "accept_derived_zone", zoneId: "dz2", hostId: "p1" }));
    expect(!twice.ok && twice.error.message).toMatch(/is already that zone/);
    const unknown = everyoneReads(() => executeSpaceDesignCommand(m, { type: "accept_derived_zone", zoneId: "dz3", hostId: "p1", rule: "intake_sphere" }));
    expect(!unknown.ok && unknown.error.message).toBe('There is no code zone rule "intake_sphere"');
    const none = everyoneReads(() => executeSpaceDesignCommand(m, { type: "accept_derived_zone", zoneId: "dz4", hostId: "p1", rule: "clearance:service_access" }));
    expect(!none.ok && none.error.message).toMatch(/P1 has no service access clearance now/);
  });

  it("is cached on the host's revision: rereads place nothing; an edit to the panel re-places it once", () => {
    const m = withPanel(base());
    resolveDerivedZone(m, asElementId("p1"), DEDICATED_SPACE_RULE);
    const n = derivedZonePlacements();
    for (let i = 0; i < 50; i++) resolveDerivedZone(m, asElementId("p1"), DEDICATED_SPACE_RULE);
    expect(derivedZonePlacements()).toBe(n);
    const moved = run(m, { type: "move_elements", ids: ["p1"], delta: { x: FT, y: 0 } });
    resolveDerivedZone(moved, asElementId("p1"), DEDICATED_SPACE_RULE);
    resolveDerivedZone(moved, asElementId("p1"), DEDICATED_SPACE_RULE);
    expect(derivedZonePlacements()).toBe(n + 1);
    // A level elevation change moves the zone even though the part record didn't change.
    const raised = run(moved, { type: "update_level", levelId: L1, elevationMm: 1000 });
    const r = resolveDerivedZone(raised, asElementId("p1"), DEDICATED_SPACE_RULE);
    const r0 = resolveDerivedZone(moved, asElementId("p1"), DEDICATED_SPACE_RULE);
    if (!r.ok || !r0.ok) throw new Error("expected regions");
    expect((r.regions[0]?.bottomMm ?? 0) - (r0.regions[0]?.bottomMm ?? 0)).toBeCloseTo(1000, 3);
  });
});

describe("r5z rolling deploy: zone@2 and unknown bounds kinds", () => {
  function future(m: ModelState): ModelState {
    // A newer peer's zone: a bounds kind this version has never seen, plus a field it doesn't know.
    const z = { id: asElementId("zf"), kind: "zone", version: 3, authoredRev: {}, name: "Future", purpose: "thermal", spaceIds: [], bounds: { kind: "sphere", hostId: "p9", radiusMm: 3048 }, futureField: { a: 1 } } as unknown as BimElement;
    return { ...m, elements: { ...m.elements, [z.id]: z } };
  }

  it("reads an unknown bounds kind as unknown, never as spaces", () => {
    const m = future(base());
    expect(zoneBoundsOf(m.elements.zf as Zone)).toEqual({ kind: "unknown", storedKind: "sphere" });
    expect(zoneSpaceIds(m.elements.zf as Zone)).toEqual([]);
  });

  it("a rename keeps the unknown bounds and field byte for byte; adding spaces is refused", () => {
    const m = withSpaces(future(base()));
    const before = m.elements.zf as Zone;
    const renamed = everyoneReads(() => space(m, { type: "edit_zone", zoneId: "zf", name: "Future 2" }));
    const after = renamed.elements.zf as Zone;
    const { name: _a, ...restBefore } = before;
    const { name: _b, ...restAfter } = after;
    expect(canonicalJson(restAfter)).toBe(canonicalJson(restBefore));
    const add = everyoneReads(() => executeSpaceDesignCommand(m, { type: "edit_zone", zoneId: "zf", addSpaceIds: ["s1"] }));
    expect(!add.ok && add.error.message).toMatch(/kind of zone this version can't change/);
  });

  it("an old reader (JSON wire) draws, validates and derives the same with outlined, derived and unknown zones present", () => {
    const before = withPanel(base());
    let m = everyoneReads(() => space(before, { type: "create_zone", zoneId: "fa1", name: "Fire area", purpose: "fire_area", outline: { levelId: "L1", outline: SQ(0, 0, 30) } }));
    m = everyoneReads(() => space(m, { type: "accept_derived_zone", zoneId: "dz1", hostId: "p1" }));
    m = future(m);
    const wire = JSON.parse(JSON.stringify(m)) as ModelState;
    for (const id of ["fa1", "dz1", "zf"]) expect(canonicalJson(wire.elements[id])).toBe(canonicalJson(m.elements[id]));
    expect(() => recomputeDerived(wire)).not.toThrow();
    expect(validateModel(wire)).toEqual(validateModel(before));
    expect(canonicalJson(buildViewScene(wire, "v-plan").scene.primitives)).toBe(canonicalJson(buildViewScene(before, "v-plan").scene.primitives));
    // Other edits go on around them.
    expect(executeCommand(wire, { type: "update_level", levelId: L1, name: "First floor" }).ok).toBe(true);
  });
});
