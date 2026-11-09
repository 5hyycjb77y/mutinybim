/**
 * @jest-environment node
 */
import { builtinPartType, executeCommand, type PartInstance } from "@permitzip/bim-kernel";
import { CONNECTED_LOAD_ONLY, ElectricalLoadEngine, distributionEquipment, distributionOf, defaultCircuitDescription, electricalConnections, panelSchedule, polesForMembers, slotChoiceLabel, slotChoices } from "@permitzip/bim-pack-electrical";
import { Building, referenceDistribution } from "../../bim-kernel/__tests__/fixtures/electrical-building";

function part(b: Building, id: string): PartInstance {
  const el = b.el(id);
  if (el.kind !== "part") throw new Error(`${id} is not a part`);
  return el;
}

function withReceptacles(n: number): Building {
  const b = referenceDistribution();
  for (let i = 1; i <= n; i++) b.place(`r${i}`, "receptacle", { voltage: 120, load_va: 180 }, `R${i}`);
  return b;
}

describe("panel view read model", () => {
  it("puts a new circuit of four receptacles on L1's lowest free slot and shows it in every slot row", () => {
    const b = withReceptacles(4);
    b.ok({ type: "create_service_link", linkId: "c1", sourceId: "l1", members: [1, 2, 3, 4].map((i) => ({ elementId: `r${i}` })), description: "Office receptacles" });
    const s = panelSchedule(b.head.elements, "l1");
    expect(s).toMatchObject({ name: "L1", named: true, kind: "panelboard", system: "120/208 V 3-phase 4-wire", spaces: 42, mainA: 225, freeSlots: 41 });
    expect(s?.fedBy).toMatchObject({ sourceName: "T1", name: "T1 to L1" });
    expect(s?.circuits).toEqual([
      expect.objectContaining({ linkId: "c1", name: "L1-1", role: "branch", positions: [1], poles: 1, phases: ["A"], ratingA: 20, description: "Office receptacles", feeds: null }),
    ]);
    expect(s?.slots[0]).toMatchObject({ slot: 1, phase: "A", first: true, circuit: expect.objectContaining({ linkId: "c1" }) });
    expect(s?.slots[1]).toMatchObject({ slot: 2, phase: "A", circuit: null });
    expect(s?.slots[2]).toMatchObject({ slot: 3, phase: "B" });
    expect(s?.slots[4]).toMatchObject({ slot: 5, phase: "C" });
    // Loads are the engine's: the panel view reads them from the same report.
    const report = new ElectricalLoadEngine(CONNECTED_LOAD_ONLY).report(b.head, "l1");
    expect(report?.perPhase.map((p) => [p.phase, p.va])).toEqual([["A", 720], ["B", 0], ["C", 0]]);
    expect(report?.links.find((l) => l.linkId === "c1")?.inventory.va).toBe(720);
  });

  it("spreads a three-pole load across its phases and lists a switchboard's feeders without counting their load", () => {
    const b = referenceDistribution();
    b.place("rtu", "mech3", { voltage: 480, load_va: 9000, mocp: 40 }, "RTU-1");
    b.ok({ type: "create_service_link", linkId: "c-rtu", sourceId: "h1", members: [{ elementId: "rtu" }] });
    const h1 = panelSchedule(b.head.elements, "h1");
    expect(h1?.circuits[0]).toMatchObject({ name: "H1-1,3,5", poles: 3, phases: ["A", "B", "C"], ratingA: 40, description: "" });
    expect(new ElectricalLoadEngine(CONNECTED_LOAD_ONLY).report(b.head, "h1")?.perPhase.map((p) => p.va)).toEqual([3000, 3000, 3000]);
    const mdp = panelSchedule(b.head.elements, "mdp");
    expect(mdp?.circuits.map((c) => [c.name, c.role, c.feeds?.name])).toEqual([
      ["MDP-1,3,5", "feeder", "H1"],
      ["MDP-2,4,6", "feeder", "T1"],
    ]);
    const t1 = panelSchedule(b.head.elements, "t1");
    expect(t1).toMatchObject({ kind: "transformer", system: "120/208 V 3-phase 4-wire", supply: "480 V 3-phase 3-wire", slots: [], kva: 75 });
    expect(t1?.circuits[0]).toMatchObject({ name: "T1 to L1", poles: 3, positions: [] });
  });

  it("offers only slot groups a breaker can take: adjacent in one column, each on its own phase, free", () => {
    const b = withReceptacles(1);
    b.ok({ type: "create_service_link", linkId: "c1", sourceId: "l1", positions: [3], members: [{ elementId: "r1" }] });
    const one = slotChoices(b.head.elements, "l1", 1);
    expect(one.slice(0, 3)).toEqual([[1], [2], [4]]);
    const three = slotChoices(b.head.elements, "l1", 3);
    expect(three[0]).toEqual([2, 4, 6]);
    expect(three).not.toContainEqual([1, 3, 5]);
    expect(slotChoices(b.head.elements, "l1", 1, "c1")[2]).toEqual([3]);
    expect(slotChoiceLabel(b.head.elements, "l1", [2, 4, 6])).toBe("2,4,6 (A, B, C)");
    expect(slotChoiceLabel(b.head.elements, "l1", [3])).toBe("3 (phase B)");
    expect(slotChoices(b.head.elements, "t1", 1)).toEqual([]);
  });

  it("says what a device and a panel are on", () => {
    const b = withReceptacles(2);
    expect(electricalConnections(b.head.elements, "r1")).toEqual([{ connector: "power", role: "load", voltage: 120, poles: 1, loadVa: 180, circuit: null }]);
    b.ok({ type: "create_service_link", linkId: "c1", sourceId: "l1", members: [{ elementId: "r1" }] });
    expect(electricalConnections(b.head.elements, "r1")[0]?.circuit).toEqual({ linkId: "c1", name: "L1-1", sourceId: "l1", sourceName: "L1" });
    expect(electricalConnections(b.head.elements, "l1")).toEqual([expect.objectContaining({ connector: "feeder", role: "input", circuit: expect.objectContaining({ name: "T1 to L1", sourceName: "T1" }) })]);
  });

  it("lists distribution equipment by name and names new circuits from what is on them", () => {
    const b = withReceptacles(2);
    b.place("lt", "light", { voltage: 277, load_va: 40 }, "A1");
    expect(distributionEquipment(b.head.elements).map((d) => `${d.name} ${d.kind}`)).toEqual(["H1 panelboard", "L1 panelboard", "MDP switchboard", "T1 transformer"]);
    expect(defaultCircuitDescription(b.head.elements, ["r1", "r2"])).toBe("Receptacles");
    expect(defaultCircuitDescription(b.head.elements, ["lt"])).toBe("Lighting");
    expect(polesForMembers(b.head.elements, [{ elementId: "r1" }, { elementId: "r2" }])).toBe(1);
  });
});

describe("electrical starter library", () => {
  it.each([
    ["builtin:panelboard-225-480@1", "panelboard", "277/480 V 3-phase 4-wire"],
    ["builtin:switchboard-800-480@1", "switchboard", "277/480 V 3-phase 4-wire"],
    ["builtin:transformer-75kva@1", "transformer", "120/208 V 3-phase 4-wire"],
    ["builtin:panelboard-225@1", "panelboard", "120/208 V 3-phase 4-wire"],
  ])("%s reads as a %s supplying %s", (id, kind, system) => {
    const entry = builtinPartType(id);
    if (!entry) throw new Error(`${id} missing`);
    const b = new Building();
    b.ok({ type: "place_part", partId: "eq", typeId: id, partType: entry.definition, levelId: "lvl-1", position: { x: 0, y: 0 }, values: { panel_name: "EQ" } });
    const d = distributionOf(b.head.elements, part(b, "eq"));
    expect(d?.kind).toBe(kind);
    expect(panelSchedule(b.head.elements, "eq")?.system).toBe(system);
  });

  it("the makeup air unit refuses a 208 V panel in plain words and circuits on a 480 V one", () => {
    const b = new Building();
    const place = (partId: string, typeId: string, values: Record<string, string> = {}, mark?: string) => {
      const entry = builtinPartType(typeId);
      if (!entry) throw new Error(`${typeId} missing`);
      b.ok({ type: "place_part", partId, typeId, partType: entry.definition, levelId: "lvl-1", position: { x: partId.length * 1000, y: 0 }, values, ...(mark ? { mark } : {}) });
    };
    place("l1", "builtin:panelboard-225@1", { panel_name: "L1" });
    place("h1", "builtin:panelboard-225-480@1", { panel_name: "H1" });
    place("mau", "builtin:makeup-air-unit-480@1", {}, "MAU-1");
    const refused = executeCommand(b.head, { type: "create_service_link", linkId: "c", sourceId: "l1", members: [{ elementId: "mau" }] });
    expect(refused.ok ? null : refused.error.message).toBe("MAU-1 needs 480 V 3-phase; L1 is 120/208 V 3-phase 4-wire, so it can't serve it");
    place("mau2", "builtin:makeup-air-unit-480@1");
    const unmarked = executeCommand(b.head, { type: "create_service_link", linkId: "c2", sourceId: "l1", members: [{ elementId: "mau2" }] });
    expect(unmarked.ok ? null : unmarked.error.message).toBe("Makeup air unit needs 480 V 3-phase; L1 is 120/208 V 3-phase 4-wire, so it can't serve it");
    b.ok({ type: "create_service_link", linkId: "c", sourceId: "h1", members: [{ elementId: "mau" }] });
    expect(panelSchedule(b.head.elements, "h1")?.circuits[0]).toMatchObject({ name: "H1-1,3,5", ratingA: 20 });
  });
});
