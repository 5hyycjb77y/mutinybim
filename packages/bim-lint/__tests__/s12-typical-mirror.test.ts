/**
 * @jest-environment node
 *
 * s12-typical-mirror: a typical unit mirrored next door is checked as drawn.
 *
 * Unit 001 has a rooftop unit's outdoor-air intake at the front and an
 * exhaust fan's outlet 9 m behind it, with the base point between them.
 * Next door, 2 m along: copied as is, every intake stays 9 m from every
 * exhaust (quiet). Mirrored front for back (the Oct 26 review), the copy's
 * intake lands 2 m from unit 001's exhaust and unit 001's intake 2 m from
 * the copy's exhaust: two per-copy findings, named by virtual id. Plans draw
 * the mirrored copy's parts flipped; virtual ids, counts and an unmirrored
 * copy's placement are unchanged.
 *
 * Fails on round 11's code: `mirror` on a copy is refused by the command
 * schema, and `copyPoint` ignores it (the mirrored case would find nothing).
 */
import { builtinPartType, withUpgradePolicy, TYPICALS_MIRROR_FEATURE, copyPoint, copyRotationDeg, organizationOf, typicalCopiesOf, typicalCount, virtualCopyId, type PartInstance, type TypicalCopy, type TypicalSpec } from "@permitzip/bim-kernel";
import { config, engineFor, Model } from "./fixtures";

const RTU = builtinPartType("builtin:rtu-5-ton@2");
const FAN = builtinPartType("builtin:inline-fan-10@1");

function unit(mirror: boolean): Model {
  if (!RTU || !FAN) throw new Error("starter library is missing the RTU or the fan");
  const m = new Model();
  m.ok({ type: "place_part", partId: "rtu-1", typeId: RTU.id, partType: RTU.definition, levelId: "lvl-roof", position: { x: 0, y: 0 }, mark: "RTU-1" });
  m.ok({ type: "place_part", partId: "ef-1", typeId: FAN.id, partType: FAN.definition, levelId: "lvl-roof", position: { x: 0, y: 9000 }, mark: "EF-1", intakes: { outlet: "hood" } });
  m.ok({ type: "create_group", groupId: "g-unit", name: "Unit 001" });
  m.ok({ type: "assign_elements_to_group", ids: ["rtu-1", "ef-1"], groupId: "g-unit" });
  // The peers on this model draw mirrored copies (a hub advertises the feature).
  withUpgradePolicy(
    (f) => f === TYPICALS_MIRROR_FEATURE,
    () => m.ok({ type: "set_group_typical", groupId: "g-unit", mark: "001", basePoint: { x: 0, y: 4500 }, copies: [{ mark: "002", offset: { x: 2000, y: 0 }, ...(mirror ? { mirror: { axis: "y" as const } } : {}) }] }),
  );
  return m;
}

function intakeFindings(m: Model) {
  return engineFor(m.head)
    .check({ config: config({ ruleset: "issue", max_findings: 8 }) })
    .filter((f) => f.rule === "typical-copy-intake-near-exhaust");
}

describe("s12-typical-mirror", () => {
  it("a peer that doesn't draw mirrored copies is never sent one", () => {
    const m = new Model();
    m.ok({ type: "create_group", groupId: "g-unit", name: "Unit 001" });
    expect(m.try({ type: "set_group_typical", groupId: "g-unit", copies: [{ mark: "002", offset: { x: 2000, y: 0 }, mirror: { axis: "x" } }] })).toMatch(/older version that doesn't draw mirrored copies/);
  });

  it("copied as is next door, intakes stay clear of exhausts", () => {
    expect(intakeFindings(unit(false))).toEqual([]);
  });

  it("mirrored next door, the per-copy check runs on the mirrored geometry and names each copy", () => {
    const m = unit(true);
    const fired = intakeFindings(m);
    expect(fired).toHaveLength(2);
    expect(fired.flatMap((f) => f.elementIds).sort()).toEqual(["ef-1", "g-unit#002/ef-1", "g-unit#002/rtu-1", "rtu-1"].sort());
    const spec = organizationOf(m.head).groups.find((g) => g.id === "g-unit")?.entry.typical;
    expect(spec?.copies[0]?.mirror).toEqual({ axis: "y" });
    expect(spec ? typicalCount(spec) : 0).toBe(2);
  });

  it("plans draw a mirrored copy's parts flipped and turned; an unmirrored copy lands as before", () => {
    const spec: TypicalSpec = { label: "Unit", mark: "001", basePoint: { x: 0, y: 4500 }, copies: [] };
    const plain: TypicalCopy = { id: "c2", mark: "002", offset: { x: 2000, y: 0 }, rotationDeg: 90 };
    const flipped: TypicalCopy = { ...plain, mirror: { axis: "x" } };
    // Unmirrored: turn about the base point then move, exactly as round 11 did.
    expect(copyPoint(spec, plain, { x: 1000, y: 4500 })).toEqual({ x: 2000 + 1000 * Math.cos(Math.PI / 2), y: 4500 + 1000 });
    const p = copyPoint(spec, flipped, { x: 1000, y: 4500 });
    expect(p.x).toBeCloseTo(2000, 9);
    expect(p.y).toBeCloseTo(4500 - 1000, 9);
    expect(copyRotationDeg(flipped, 30)).toBe(240);
    expect(copyRotationDeg({ ...plain, rotationDeg: 0, mirror: { axis: "y" } }, 30)).toBe(330);
    const m = unit(true);
    const parts = Object.values(m.head.elements).filter((e): e is PartInstance => e.kind === "part");
    const copies = typicalCopiesOf(m.head, parts);
    const ef = copies.find((c) => c.id === "ef-1");
    expect(ef?.position.x).toBeCloseTo(2000, 6);
    expect(ef?.position.y).toBeCloseTo(0, 6);
    expect(virtualCopyId("g-unit", { mark: "002", copy: flipped }, "ef-1")).toBe("g-unit#002/ef-1");
  });
});
