/**
 * @jest-environment node
 *
 * Round 5b phase 3, f-spatial's part of the foundation adjustments
 * (batch-5b-foundation-adjustments.md F1, F2, H1): readers keep what a newer
 * peer or a pack stored; only writers check against this version's lists.
 *
 * - F2: a zone with a pack's purpose (`struct.tributary`) and a pack's derived
 *   rule is kept byte for byte, shown in raw words, listed but not computed;
 *   the command schema still refuses to write that purpose.
 * - F1: a derived-zone rule with `derive` computes regions from any host
 *   (not only placed parts), cached on its declared dependency signature.
 * - H1: an element whose partition discipline is `civil` loads, indexes,
 *   round-trips and filters without throwing.
 *
 * Fails on the old code: `parsePartitionKey` returned null and
 * `interestSchema` refused `civil`; `resolveDerivedZone` refused any host that
 * wasn't a part and had no `derive`; unknown purposes printed as raw ids.
 */
import {
  asElementId,
  changesetPartitions,
  DEFAULT_SETTINGS,
  disciplineWords,
  executeCommand,
  inInterest,
  interestSchema,
  parsePartitionKey,
  partitionKey,
  partitionMembers,
  sliceModel,
  validateModel,
  withUpgradePolicy,
  ZONE_BOUNDS_FEATURE,
  type BimElement,
  type Changeset,
  type KnownDiscipline,
  type ModelState,
  type Partition,
} from "../src";
import { DERIVED_ZONE_RULE_POINT, derivedRegionsOfZone, derivedZonePlacements, resolveDerivedZone, type DerivedZoneRegion, type DerivedZoneRuleDef } from "../src/spaces/derived-zones";
import { PackSet, contribute, definePack, withPackSet } from "../src/packs";
import { executeSpaceDesignCommand, spaceCommandSchema } from "../src/spaces/space-commands";
import type { Zone } from "../src/spaces/types";
import { zoneBoundsOf, zonePurposeWords } from "../src/spaces/zone-bounds";

const L1 = asElementId("L1");
const level: BimElement = { id: L1, kind: "level", version: 1, authoredRev: {}, name: "Level 1", elevationMm: 0 };

function model(extra: readonly BimElement[] = []): ModelState {
  const elements: Record<string, BimElement> = { [L1]: level };
  for (const el of extra) elements[el.id] = el;
  return { modelId: "r5z-readers", revision: 0 as ModelState["revision"], elements, connections: [], settings: DEFAULT_SETTINGS };
}

/** As a newer peer stores it: a value outside this version's type. */
const stored = <T>(value: unknown): T => value as T;

describe("r5z F2: zone purposes and derived rules from a pack", () => {
  const tributary = stored<BimElement>({ id: "zt", kind: "zone", version: 2, authoredRev: {}, name: "Beam B-3 tributary", purpose: "struct.tributary", spaceIds: [], bounds: { kind: "derived", hostId: "beam-3", rule: "struct.tributary_area" }, schemaVersion: 2 });

  it("is read as derived, kept, shown in raw words and listed, not computed", () => {
    const m = model([tributary]);
    const z = m.elements.zt as Zone;
    expect(zoneBoundsOf(z)).toEqual({ kind: "derived", hostId: "beam-3", rule: "struct.tributary_area" });
    expect(zonePurposeWords(z.purpose)).toBe("Tributary");
    expect(resolveDerivedZone(m, asElementId("beam-3"), "struct.tributary_area")).toEqual({ ok: false, reason: 'Listed, not computed: it comes from a rule ("struct.tributary_area") this version doesn\'t know, so it is kept as it is' });
    expect(derivedRegionsOfZone(m, z)).toMatchObject({ ok: false, reason: expect.stringMatching(/^Listed, not computed/) });
  });

  it("a rename keeps its purpose, bounds and version byte for byte", () => {
    const m = model([tributary]);
    const r = withUpgradePolicy((f) => f === ZONE_BOUNDS_FEATURE, () => executeSpaceDesignCommand(m, { type: "edit_zone", zoneId: "zt", name: "B-3 tributary" }));
    if (!r.ok) throw new Error(r.error.message);
    const { name: _n0, ...before } = tributary as unknown as Record<string, unknown>;
    const { name: _n1, version: _v, ...after } = r.model.elements.zt as unknown as Record<string, unknown>;
    const { version: _v0, ...beforeNoVersion } = before;
    expect(after).toEqual(beforeNoVersion);
    expect(r.summary?.join(" ")).toMatch(/Changed zone B-3 tributary: code zone/);
  });

  it("the command schema (a writer) still refuses the pack's purpose", () => {
    expect(spaceCommandSchema.safeParse({ type: "create_zone", zoneId: "z1", name: "T", purpose: "zz.tributary", spaceIds: [] }).success).toBe(false);
    expect(spaceCommandSchema.safeParse({ type: "create_zone", zoneId: "z1", name: "T", purpose: "firm:kitchen_line", spaceIds: [] }).success).toBe(true);
  });

  it("a derived rule that isn't an id at all reads as an unknown kind, kept as stored", () => {
    const odd = stored<Zone>({ id: "zo", kind: "zone", version: 1, authoredRev: {}, name: "Odd", purpose: "thermal", spaceIds: [], bounds: { kind: "derived", hostId: "p1", rule: "Not An Id!" } });
    expect(zoneBoundsOf(odd)).toEqual({ kind: "unknown", storedKind: "derived" });
  });
});

describe("r5z F1: derived-zone rules that compute their own regions", () => {
  // A door's swing clearance from a room-like host: any element kind, its level a declared dependency.
  let derives = 0;
  const doorClearance: DerivedZoneRuleDef = {
    id: "r5z.door_clearance",
    label: "Door clearance",
    ifcPredefinedType: "RESERVATION",
    dependsOn: (m) => [m.elements[L1]],
    derive: (m, host, ctx): DerivedZoneRegion[] => {
      derives += 1;
      const lvl = m.elements[L1];
      const z0 = lvl?.kind === "level" ? lvl.elevationMm : 0;
      return [{ hostId: host.id, rule: ctx.rule, clearanceId: "swing", name: "Door clearance", cite: "ADA 404.2.4", levelId: L1, outline: [{ x: 0, y: 0 }, { x: 1500, y: 0 }, { x: 1500, y: 1500 }, { x: 0, y: 1500 }], centre: { x: 750, y: 750 }, bottomMm: z0, topMm: z0 + 2032, floorMm: z0 }];
    },
  };
  // A pack's rule (round 6: no global registration), in force for the models bound to its set.
  const DOOR_SET = PackSet.create([definePack({ id: "r5z", name: "Door clearances", version: "1.0.0", kernel: "^1.3.0" }, [contribute(DERIVED_ZONE_RULE_POINT, [doorClearance])])]);
  const inDoorSet = <R,>(fn: () => R): R => withPackSet(DOOR_SET, fn);
  const room: BimElement = { id: asElementId("room-1"), kind: "room", version: 1, authoredRev: {}, partition: { level: "Level 1", zone: "Z1", discipline: "architecture" }, number: "101", name: "Office", outline: [{ x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 4000 }, { x: 0, y: 4000 }], areaSqM: 16 };

  it("resolves on a host that isn't a part, cached until a declared dependency changes", () =>
    inDoorSet(() => {
      const m = model([room]);
      const before = derivedZonePlacements();
      const r = resolveDerivedZone(m, room.id, "r5z.door_clearance");
      expect(r).toMatchObject({ ok: true, regions: [{ hostId: "room-1", cite: "ADA 404.2.4", bottomMm: 0 }] });
      resolveDerivedZone(m, room.id, "r5z.door_clearance");
      expect(derives).toBe(1);
      expect(derivedZonePlacements()).toBe(before + 1);
      const raised = { ...m, elements: { ...m.elements, [L1]: { ...level, elevationMm: 3000 } as BimElement } };
      const r2 = resolveDerivedZone(raised, room.id, "r5z.door_clearance");
      expect(derives).toBe(2);
      expect(r2.ok && r2.regions[0]?.bottomMm).toBe(3000);
    }));

  it("accept_derived_zone keeps it as host + rule only, the stored shape unchanged", () =>
    inDoorSet(() => {
      const m = model([room]);
      const r = withUpgradePolicy((f) => f === ZONE_BOUNDS_FEATURE, () => executeSpaceDesignCommand(m, { type: "accept_derived_zone", zoneId: "dz", hostId: "room-1", rule: "r5z.door_clearance" }));
      if (!r.ok) throw new Error(r.error.message);
      expect((r.model.elements.dz as Zone).bounds).toEqual({ kind: "derived", hostId: "room-1", rule: "r5z.door_clearance" });
    }));

  it("a clearance rule still says plainly that it needs placed equipment", () => {
    const m = model([room]);
    expect(resolveDerivedZone(m, room.id, "dedicated")).toEqual({ ok: false, reason: "room-1 is a room; code zones come from placed equipment" });
  });
});

describe("r5z H1: a stored partition discipline outside the six", () => {
  const civil = stored<Partition>({ level: "Level 1", zone: "Z1", discipline: "civil" });
  const slab = stored<BimElement>({ id: "slab-site", kind: "slab", version: 1, authoredRev: {}, partition: civil, outline: [{ x: 0, y: 0 }, { x: 9000, y: 0 }, { x: 9000, y: 9000 }, { x: 0, y: 9000 }], thickness: 150 });
  const duct = stored<BimElement>({ id: "slab-mech", kind: "slab", version: 1, authoredRev: {}, partition: { level: "Level 1", zone: "Z1", discipline: "mechanical" }, outline: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], thickness: 150 });

  it("loads, indexes and round-trips its partition key", () => {
    const m = JSON.parse(JSON.stringify(model([slab, duct]))) as ModelState;
    expect(partitionKey(civil)).toBe("Level 1|Z1|civil");
    expect(parsePartitionKey("Level 1|Z1|civil")).toEqual(civil);
    expect(parsePartitionKey("Level 1|Z1|general_contracting")?.discipline).toBe("general_contracting");
    expect(parsePartitionKey("Level 1|Z1|Not a discipline")).toBeNull();
    expect(partitionMembers(m, (p) => p.discipline === civil.discipline).map((e) => e.id)).toEqual(["slab-site"]);
    const cs = stored<Changeset>({ revision: 1, elements: [slab], removedIds: [], before: {} });
    expect(changesetPartitions(cs)).toEqual(["Level 1|Z1|civil"]);
    expect(() => validateModel(m)).not.toThrow();
    expect(executeCommand(m, { type: "update_level", levelId: L1, name: "Ground" }).ok).toBe(true);
  });

  it("filters: an interest may ask for civil (a newer page), and a mechanical interest leaves it out", () => {
    const m = model([slab, duct]);
    const civilOnly = interestSchema.parse({ areas: [{ level: "Level 1" }], disciplines: ["civil"] });
    expect(Object.keys(sliceModel(m, civilOnly).elements).filter((id) => id.startsWith("slab"))).toEqual(["slab-site"]);
    const mech = interestSchema.parse({ areas: [{ level: "Level 1" }], disciplines: ["mechanical"] });
    expect(inInterest(civil, mech)).toBe(false);
    expect(Object.keys(sliceModel(m, mech).elements).filter((id) => id.startsWith("slab"))).toEqual(["slab-mech"]);
    expect(interestSchema.safeParse({ areas: [{ level: "Level 1" }], disciplines: ["Civil Works"] }).success).toBe(false);
  });

  it("is labelled in words: the six by the host's labels, the rest in raw words", () => {
    const words: Readonly<Record<KnownDiscipline, string>> = { architecture: "Architecture", structure: "Structure", mechanical: "Mechanical", plumbing: "Plumbing", electrical: "Electrical", fire_protection: "Fire protection" };
    expect(disciplineWords("fire_protection", words)).toBe("Fire protection");
    expect(disciplineWords("general_contracting", words)).toBe("General contracting");
    expect(disciplineWords("firm:site_work", words)).toBe("Site work");
  });
});
