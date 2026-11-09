/**
 * @jest-environment node
 *
 * Round 4 electrical code checks (ROADMAP E3, E5), each with the fixture that
 * fails and the fix that clears it:
 *
 * - dedicated-space-intrusion: a duct in the space above a panel (the
 *   duct-in-soffit case, NEC 110.26(E)(1)(a)); cleared by a suspended ceiling
 *   below it; says when no structural ceiling is known (zone taken to 6 ft).
 *   Old code: the zone variant and the rule did not exist, so a part with
 *   this zone either failed validation or reported nothing.
 * - ocpd-ignitable-material: a panel in a space used as laundry or a clothes
 *   closet (NEC 240.24(D)). Old code: no such rule.
 * - aic-below-available: a 65 kAIC panel with 22 kA available passes; at
 *   18 kAIC it is a finding with the point-to-point chain. Old code: nothing
 *   read the fault current calc.
 */
import { builtinPartType, type PartTypeDefinition } from "@permitzip/bim-kernel";
import { necEdition } from "@permitzip/bim-calc";
import { dedicatedSpaceZone } from "@permitzip/bim-pack-electrical";
import { distributionType } from "../../bim-kernel/__tests__/fixtures/electrical-building";
import { config, engineFor, FT, linkedBuilding, Model, rulesFired, SUPPLY } from "./fixtures";

const PANEL = builtinPartType("builtin:panelboard-225@1");
const NEC = necEdition("2023");

function placePanel(m: Model, at = { x: 10 * FT, y: 10 * FT }): void {
  if (!PANEL) throw new Error("starter library is missing the panelboard");
  m.ok({ type: "place_part", partId: "mdp-1", typeId: PANEL.id, partType: PANEL.definition, levelId: "lvl-1", position: at, offsetMm: 0, mark: "MDP-1", values: { panel_name: "MDP-1" } });
}

function withDedicatedSpace(m: Model, extra: { suspendedCeilingMm?: number; structureMm?: number } = {}): void {
  const z = dedicatedSpaceZone(NEC);
  m.ok({ type: "set_part_clearances", id: "mdp-1", scope: "instance", overrides: { [z.id]: { name: z.name, purpose: z.purpose, face: z.face, depth: z.depth as number, excludes: "foreign_systems", toStructure: true, endsAtSuspendedCeiling: true, cite: z.cite, ...extra } } });
}

describe("dedicated-space-intrusion (NEC 110.26(E))", () => {
  it("the NEC zone: the equipment's footprint, 6 ft up from its top, ducts and pipes kept out", () => {
    const z = dedicatedSpaceZone(NEC);
    expect(z).toMatchObject({ purpose: "dedicated_space", face: "top", depth: 1828.8, excludes: "foreign_systems", toStructure: true, endsAtSuspendedCeiling: true, cite: "NEC 2023 110.26(E)(1)(a)" });
    expect(z.width).toBeUndefined();
    expect(z.height).toBeUndefined();
  });

  it("a duct in the soffit above MDP-1 is an error naming the duct, the panel and the clause", () => {
    const m = new Model();
    placePanel(m);
    withDedicatedSpace(m);
    // The 60 in. tall panel's zone runs from 5 ft to 11 ft; the duct at 8 ft crosses it.
    m.duct("sa", SUPPLY, [[0, 10], [30, 10]], 8);
    const hits = rulesFired(m.head, [linkedBuilding()]).get("dedicated-space-intrusion") ?? [];
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(/^Supply Air 1 .*is in the dedicated space above MDP-1 \(within 6'-0"\): NEC 2023 110\.26\(E\)\(1\)\(a\)$/);
    // It is not also reported as an ordinary solid intrusion.
    expect(rulesFired(m.head, [linkedBuilding()]).get("clearance-intrusion") ?? []).toEqual([]);
  });

  it("with no structure known above, the message says the zone was taken to the full 6 ft", () => {
    const m = new Model();
    placePanel(m);
    withDedicatedSpace(m);
    m.duct("sa", SUPPLY, [[0, 10], [30, 10]], 8);
    const hits = rulesFired(m.head, []).get("dedicated-space-intrusion") ?? [];
    expect(hits[0]).toMatch(/no structural ceiling known, so taken to 6'-0"/);
  });

  it("fix: a suspended ceiling at 7 ft over the panel puts the duct above it, and the finding clears", () => {
    const m = new Model();
    placePanel(m);
    withDedicatedSpace(m, { suspendedCeilingMm: 7 * FT });
    m.duct("sa", SUPPLY, [[0, 10], [30, 10]], 8);
    expect(rulesFired(m.head, [linkedBuilding()]).get("dedicated-space-intrusion") ?? []).toEqual([]);
  });

  it("fix: the duct moved clear of the panel's footprint", () => {
    const m = new Model();
    placePanel(m);
    withDedicatedSpace(m);
    m.duct("sa", SUPPLY, [[0, 20], [30, 20]], 8);
    expect(rulesFired(m.head, [linkedBuilding()]).get("dedicated-space-intrusion") ?? []).toEqual([]);
  });

  it("the structure stated lower than 6 ft above the panel ends the zone below the duct", () => {
    const m = new Model();
    placePanel(m);
    withDedicatedSpace(m, { structureMm: 7 * FT });
    m.duct("sa", SUPPLY, [[0, 10], [30, 10]], 8);
    expect(rulesFired(m.head, [linkedBuilding()]).get("dedicated-space-intrusion") ?? []).toEqual([]);
  });
});

describe("ocpd-ignitable-material (NEC 240.24(D))", () => {
  const SQUARE = (x0: number, y0: number, s: number) => [
    { x: x0 * FT, y: y0 * FT },
    { x: (x0 + s) * FT, y: y0 * FT },
    { x: (x0 + s) * FT, y: (y0 + s) * FT },
    { x: x0 * FT, y: (y0 + s) * FT },
  ];
  const laundryUse = { libraryId: "builtin:space-uses", useId: "laundry", name: "Laundry rooms" };

  it("a panel inside a space used as a laundry is an error naming the panel, the space and the clause", () => {
    const m = new Model();
    m.ok({ type: "create_space", spaces: [{ spaceId: "sp-103", number: "103", name: "Utility", levelId: "lvl-1", outline: SQUARE(5, 5, 10), use: laundryUse }] });
    placePanel(m, { x: 10 * FT, y: 10 * FT });
    const hits = rulesFired(m.head, []).get("ocpd-ignitable-material") ?? [];
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(/^MDP-1 is in 103 .*\(its use is Laundry rooms\): NEC 240\.24\(D\)/);
  });

  it("with no use set, a space named Laundry counts, and says it went by the name", () => {
    const m = new Model();
    m.ok({ type: "create_space", spaces: [{ spaceId: "sp-104", number: "104", name: "Laundry", levelId: "lvl-1", outline: SQUARE(5, 5, 10) }] });
    placePanel(m, { x: 10 * FT, y: 10 * FT });
    expect((rulesFired(m.head, []).get("ocpd-ignitable-material") ?? [])[0]).toMatch(/its name is Laundry \(no use set\)/);
  });

  it("next to the space (within 1 ft) is a warning; an electrical closet and a far panel are fine", () => {
    const near = new Model();
    near.ok({ type: "create_space", spaces: [{ spaceId: "sp-103", number: "103", name: "Utility", levelId: "lvl-1", outline: SQUARE(5, 5, 10), use: laundryUse }] });
    placePanel(near, { x: 15.6 * FT, y: 10 * FT });
    const f = engineFor(near.head).check({ config: config({ ruleset: "issue" }) }).find((x) => x.rule === "ocpd-ignitable-material");
    expect(f?.severity).toBe("warning");
    expect(f?.message).toMatch(/^MDP-1 is next to 103/);

    const elec = new Model();
    elec.ok({ type: "create_space", spaces: [{ spaceId: "sp-105", number: "105", name: "Electrical closet", levelId: "lvl-1", outline: SQUARE(5, 5, 10) }] });
    placePanel(elec, { x: 10 * FT, y: 10 * FT });
    expect(rulesFired(elec.head, []).get("ocpd-ignitable-material") ?? []).toEqual([]);

    const far = new Model();
    far.ok({ type: "create_space", spaces: [{ spaceId: "sp-103", number: "103", name: "Utility", levelId: "lvl-1", outline: SQUARE(5, 5, 10), use: laundryUse }] });
    placePanel(far, { x: 30 * FT, y: 30 * FT });
    expect(rulesFired(far.head, []).get("ocpd-ignitable-material") ?? []).toEqual([]);
  });

  it("fix: the panel moved out of the laundry clears it", () => {
    const m = new Model();
    m.ok({ type: "create_space", spaces: [{ spaceId: "sp-103", number: "103", name: "Utility", levelId: "lvl-1", outline: SQUARE(5, 5, 10), use: laundryUse }] });
    placePanel(m, { x: 10 * FT, y: 10 * FT });
    m.ok({ type: "move_elements", ids: ["mdp-1"], delta: { x: 20 * FT, y: 20 * FT } });
    expect(rulesFired(m.head, []).get("ocpd-ignitable-material") ?? []).toEqual([]);
  });
});

describe("aic-below-available (NEC 110.9, point to point)", () => {
  /** A switchboard that carries the utility's figure and a rating, as the coordinator's implicit parameters will allow on every type. */
  function rated(def: PartTypeDefinition): PartTypeDefinition {
    return { ...def, instanceParams: [...def.instanceParams, { name: "aic", label: "Short-circuit rating", kind: "number", unit: "a", min: 0 }, { name: "available_fault_current", label: "Available fault current", kind: "number", unit: "a", min: 0 }] };
  }

  function service(mdpAic: number): Model {
    const m = new Model();
    m.ok({ type: "place_part", partId: "mdp", typeId: "type-swbd", partType: rated(distributionType("Switchboard", "800A 480Y/277V", 480, "3", 30, 800, "800A MCB")), levelId: "lvl-1", position: { x: 0, y: 0 }, offsetMm: 0, mark: "MDP", values: { panel_name: "MDP", aic: mdpAic, available_fault_current: 22_000 } });
    m.ok({ type: "place_part", partId: "h1", typeId: "type-h", partType: rated(distributionType("Panelboard", "225A 480Y/277V", 480, "3", 42, 225, "MLO")), levelId: "lvl-1", position: { x: 20 * FT, y: 0 }, offsetMm: 0, mark: "H1", values: { panel_name: "H1", aic: 14_000 } });
    m.ok({ type: "create_service_link", linkId: "f-h1", sourceId: "mdp", positions: [1, 3, 5], members: [{ elementId: "h1" }], electrical: { ratingA: 225, lengthFt: 100, conductors: { sets: 1, phaseSize: "3/0", groundSize: "4", material: "cu" } } });
    return m;
  }

  it("a 65 kAIC MDP with 22 kA available passes; H1 at 14 kAIC with 14,941 A available fails", () => {
    const hits = rulesFired(service(65_000).head, []).get("aic-below-available") ?? [];
    expect(hits).toHaveLength(1);
    // 22,000 A at MDP; 100 ft of 3/0 Cu (non-magnetic, the raceway is not stated): C = 16,802.
    // f = 1.732 × 100 × 22,000 / (16,802 × 1 × 480) = 0.4725; M = 0.6791; 22,000 × 0.67913 = 14,941 A.
    expect(hits[0]).toBe("H1: 14 kAIC is below the 14,941 A available (NEC 110.9): 22,000 A at MDP → 100 ft #3/0 Cu");
  });

  it("lowering MDP's rating below the 22 kA available raises a finding with the trail", () => {
    const hits = rulesFired(service(18_000).head, []).get("aic-below-available") ?? [];
    expect(hits).toContain("MDP: 18 kAIC is below the 22,000 A available (NEC 110.9): 22,000 A at MDP");
  });

  it("no available fault current entered anywhere: nothing is flagged (the panel view says why)", () => {
    const m = new Model();
    if (!PANEL) throw new Error("starter library is missing the panelboard");
    m.ok({ type: "place_part", partId: "p1", typeId: PANEL.id, partType: PANEL.definition, levelId: "lvl-1", position: { x: 0, y: 0 }, offsetMm: 0, mark: "P1", values: { panel_name: "P1", aic: 10_000 } });
    expect(rulesFired(m.head, []).get("aic-below-available") ?? []).toEqual([]);
  });
});


