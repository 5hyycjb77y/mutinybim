/**
 * @jest-environment node
 */
import { linksFedFrom, serviceLinkName, validateModel, type Command, type PartInstance, type ServiceLink } from "../src";
import { distributionOf } from "@permitzip/bim-pack-electrical";
import { Building, referenceDistribution } from "./fixtures/electrical-building";

function link(b: Building, id: string): ServiceLink {
  const el = b.el(id);
  if (el.kind !== "service_link") throw new Error(`${id} is not a link`);
  return el;
}

function part(b: Building, id: string): PartInstance {
  const el = b.el(id);
  if (el.kind !== "part") throw new Error(`${id} is not a part`);
  return el;
}

describe("served-from links: distribution", () => {
  it("reads voltage systems off the panel, switchboard and transformer parameters", () => {
    const b = referenceDistribution();
    const els = b.head.elements;
    expect(distributionOf(els, part(b, "mdp"))).toMatchObject({ kind: "switchboard", system: { lineToLine: 480, lineToNeutral: 277, phases: 3, wires: 4 }, spaces: 30, busA: 800, mainA: 800 });
    expect(distributionOf(els, part(b, "t1"))).toMatchObject({ kind: "transformer", supply: { lineToLine: 480, lineToNeutral: null, phases: 3 }, system: { lineToLine: 208, lineToNeutral: 120 }, kva: 75, input: "primary", port: "secondary" });
    expect(distributionOf(els, part(b, "l1"))).toMatchObject({ kind: "panelboard", mainA: 225, busA: 225 });
  });

  it("keeps both ends of every feeder: MDP feeds H1 and T1, T1 feeds L1 with no breaker positions", () => {
    const b = referenceDistribution();
    b.valid();
    expect(part(b, "mdp").feeds).toEqual(["f-h1", "f-t1"]);
    expect(part(b, "h1").served).toEqual({ feeder: "f-h1" });
    expect(link(b, "f-h1")).toMatchObject({ role: "feeder", source: { elementId: "mdp", port: "bus", positions: [1, 3, 5] }, electrical: { ratingA: 225, feederType: "F225" } });
    expect(link(b, "f-l1")).toMatchObject({ role: "feeder", source: { elementId: "t1", port: "secondary", positions: [] } });
    expect(serviceLinkName(b.head.elements, link(b, "f-h1"))).toBe("MDP-1,3,5");
    expect(serviceLinkName(b.head.elements, link(b, "f-l1"))).toBe("T1 to L1");
    expect(linksFedFrom(b.head.elements, "mdp").map((l) => l.id)).toEqual(["f-h1", "f-t1"]);
  });

  it("accepts a 277/480 V single-phase panel off the three-phase board with a two-pole breaker, and refuses three poles", () => {
    const b = referenceDistribution();
    b.place("p1", "panel480single", { panel_name: "P1" });
    expect(b.refused({ type: "create_service_link", linkId: "f-p1", sourceId: "mdp", positions: [7, 9, 11], members: [{ elementId: "p1" }] })).toBe("P1 has 2 hot conductors, so its feeder breaker needs 2 poles, not 3");
    b.ok({ type: "create_service_link", linkId: "f-p1", sourceId: "mdp", positions: [7, 9], members: [{ elementId: "p1" }] });
    b.valid();
  });

  it("refuses a 120/208 V panel straight off the 480 V board, and a feeder loop", () => {
    const b = referenceDistribution();
    b.place("l2", "panel208", { panel_name: "L2" });
    expect(b.refused({ type: "create_service_link", linkId: "f-l2", sourceId: "mdp", members: [{ elementId: "l2" }] })).toBe("L2 needs 120/208 V 3-phase 4-wire; MDP is 277/480 V 3-phase 4-wire, so it can't feed it");
    expect(b.refused({ type: "create_service_link", linkId: "f-loop", sourceId: "h1", members: [{ elementId: "mdp" }] })).toBe("MDP already feeds H1; feeding it from there would make a loop");
  });
});

describe("served-from links: branch circuits", () => {
  it("refuses MUA-1 on L1 with the plain reason, and circuits it on H1 at its MOCP", () => {
    const b = referenceDistribution();
    b.place("mua1", "mech3", { voltage: 480, load_va: 10_000, mca: 15, mocp: 20 }, "MUA-1");
    expect(b.refused({ type: "create_service_link", linkId: "c-mua", sourceId: "l1", members: [{ elementId: "mua1" }] })).toBe("MUA-1 needs 480 V 3-phase; L1 is 120/208 V 3-phase 4-wire, so it can't serve it");
    b.ok({ type: "create_service_link", linkId: "c-mua", sourceId: "h1", members: [{ elementId: "mua1" }], description: "MUA-1" });
    expect(link(b, "c-mua")).toMatchObject({ role: "branch", source: { positions: [1, 3, 5] }, electrical: { ratingA: 20 } });
    expect(part(b, "mua1").served).toEqual({ power: "c-mua" });
    b.valid();
  });

  it("maps nameplate to nominal voltage (460 V RTU on 480 V) and takes the next free three-pole space", () => {
    const b = referenceDistribution();
    b.place("rtu1", "mech3", { voltage: 460, load_va: 22_000, mca: 32, mocp: 40 }, "RTU-1");
    b.place("rtu2", "mech3", { voltage: 460, load_va: 12_500, mca: 18, mocp: 25 }, "RTU-2");
    b.ok({ type: "create_service_link", linkId: "c-rtu1", sourceId: "h1", members: [{ elementId: "rtu1" }] });
    b.ok({ type: "create_service_link", linkId: "c-rtu2", sourceId: "h1", members: [{ elementId: "rtu2" }] });
    expect(link(b, "c-rtu1")).toMatchObject({ source: { positions: [1, 3, 5] }, electrical: { ratingA: 40 } });
    expect(link(b, "c-rtu2")).toMatchObject({ source: { positions: [2, 4, 6] }, electrical: { ratingA: 25 } });
  });

  it("checks poles, neutral and slot spacing", () => {
    const b = referenceDistribution();
    b.place("r1", "receptacle", { voltage: 120, load_va: 180 }, "R-1");
    b.place("wh1", "equip2", { voltage: 208, load_va: 4500 }, "WH-1");
    expect(b.refused({ type: "create_service_link", linkId: "c-x", sourceId: "h1", members: [{ elementId: "r1" }] })).toBe("R-1 needs 120 V, 1 pole; H1 is 277/480 V 3-phase 4-wire, so it can't serve it");
    expect(b.refused({ type: "create_service_link", linkId: "c-x", sourceId: "l1", positions: [1], members: [{ elementId: "wh1" }] })).toBe("WH-1 needs a 2-pole circuit; this circuit has 1 pole");
    expect(b.refused({ type: "create_service_link", linkId: "c-x", sourceId: "l1", positions: [1, 2], members: [{ elementId: "wh1" }] })).toBe("A 2-pole breaker takes circuits next to each other in one column (like 1,3); 1,2 aren't");
    expect(b.refused({ type: "create_service_link", linkId: "c-x", sourceId: "l1", positions: [43], members: [{ elementId: "r1" }] })).toBe("L1 has 42 circuits; there is no circuit 43");
    b.ok({ type: "create_service_link", linkId: "c-wh", sourceId: "l1", members: [{ elementId: "wh1" }] });
    expect(link(b, "c-wh").source.positions).toEqual([1, 3]);
    expect(b.refused({ type: "create_service_link", linkId: "c-x", sourceId: "l1", positions: [3], members: [{ elementId: "r1" }] })).toBe("Circuit 3 on L1 is already used by L1-1,3");
    expect(b.refused({ type: "create_service_link", linkId: "c-x", sourceId: "t1", positions: [1], members: [{ elementId: "r1" }] })).toBe("T1 is a transformer; what it feeds takes no breaker positions on it");
  });

  it("circuits explicitly listed receptacles together, adds and removes members, and keeps one circuit per connector", () => {
    const b = referenceDistribution();
    for (const n of [1, 2, 3, 4]) b.place(`r${n}`, "receptacle", { voltage: 120, load_va: 180 }, `R-${n}`);
    b.ok({ type: "create_service_link", linkId: "c-off1", sourceId: "l1", members: [{ elementId: "r1" }, { elementId: "r2" }, { elementId: "r3" }], description: "Office 101 receptacles" });
    expect(link(b, "c-off1")).toMatchObject({ source: { positions: [1] }, electrical: { ratingA: 20 }, description: "Office 101 receptacles" });
    expect(b.refused({ type: "create_service_link", linkId: "c-off2", sourceId: "l1", members: [{ elementId: "r3" }] })).toBe("R-3 is already on L1-1; take it off that one first");
    b.ok({ type: "add_link_members", linkId: "c-off1", members: [{ elementId: "r4" }] });
    b.ok({ type: "remove_link_members", linkId: "c-off1", elementIds: ["r2"] });
    expect(link(b, "c-off1").members.map((m) => m.elementId)).toEqual(["r1", "r3", "r4"]);
    expect(part(b, "r2").served).toBeUndefined();
    expect(b.refused({ type: "remove_link_members", linkId: "c-off1", elementIds: ["r2"] })).toBe("r2 is not on L1-1");
    b.valid();
  });

  it("edits positions, design values and source, re-checking every member", () => {
    const b = referenceDistribution();
    b.place("ef1", "mech1", { voltage: 120, load_va: 600 }, "EF-1");
    b.ok({ type: "create_service_link", linkId: "c-ef", sourceId: "l1", members: [{ elementId: "ef1" }] });
    b.ok({ type: "edit_service_link", linkId: "c-ef", positions: [12], electrical: { ratingA: 15, conductors: { sets: 1, phaseSize: "10", groundSize: "10", material: "cu" }, lengthFt: 300 } });
    expect(link(b, "c-ef")).toMatchObject({ source: { positions: [12] }, electrical: { ratingA: 15, lengthFt: 300, conductors: { phaseSize: "10" } } });
    b.ok({ type: "edit_service_link", linkId: "c-ef", electrical: { lengthFt: null } });
    expect(link(b, "c-ef").electrical?.lengthFt).toBeUndefined();
    expect(b.refused({ type: "edit_service_link", linkId: "c-ef", sourceId: "h1" })).toBe("EF-1 needs 120 V, 1 pole; H1 is 277/480 V 3-phase 4-wire, so it can't serve it");
    b.place("l2", "panel208", { panel_name: "L2" });
    b.ok({ type: "create_service_link", linkId: "f-l2", sourceId: "t1", members: [{ elementId: "l2" }] });
    b.ok({ type: "edit_service_link", linkId: "c-ef", sourceId: "l2" });
    expect(part(b, "l1").feeds).toBeUndefined();
    expect(part(b, "l2").feeds).toEqual(["c-ef"]);
    expect(link(b, "c-ef").source).toEqual({ elementId: "l2", port: "bus", positions: [1] });
    b.valid();
  });

  it("refuses a retried create with the same id instead of making a second circuit", () => {
    const b = referenceDistribution();
    b.place("r1", "receptacle", { voltage: 120, load_va: 180 }, "R-1");
    const create: Command = { type: "create_service_link", linkId: "c-1", sourceId: "l1", members: [{ elementId: "r1" }] };
    b.ok(create);
    expect(b.refused(create)).toBe("c-1 already exists; choose a new id");
    expect(part(b, "l1").feeds).toEqual(["c-1"]);
  });
});

describe("served-from links: delete, copy and undo", () => {
  function circuited(): Building {
    const b = referenceDistribution();
    b.place("r1", "receptacle", { voltage: 120, load_va: 180 }, "R-1");
    b.place("r2", "receptacle", { voltage: 120, load_va: 180 }, "R-2");
    b.ok({ type: "create_service_link", linkId: "c-1", sourceId: "l1", members: [{ elementId: "r1" }, { elementId: "r2" }] });
    return b;
  }

  it("deleting a device takes it off its circuit (refuse lists the cut; disconnect makes it)", () => {
    const b = circuited();
    expect(b.refused({ type: "delete_elements", ids: ["r1"], policy: "refuse" })).toBe("Nothing deleted: this would leave 1 connection pointing at nothing. Delete them too, or cut the connections and keep the rest.");
    b.ok({ type: "delete_elements", ids: ["r1"], policy: "disconnect" });
    expect(link(b, "c-1").members).toEqual([{ elementId: "r2", connector: "power" }]);
    b.valid();
  });

  it("a panel's circuits are its dependents: cascade deletes them and clears their members", () => {
    const b = circuited();
    expect(b.refused({ type: "delete_elements", ids: ["l1"], policy: "disconnect" })).toContain("Nothing deleted");
    b.ok({ type: "delete_elements", ids: ["l1"], policy: "cascade" });
    expect(b.head.elements["c-1"]).toBeUndefined();
    expect(part(b, "r1").served).toBeUndefined();
    expect(link(b, "f-l1").members).toEqual([]);
    b.valid();
  });

  it("deleting a circuit clears both ends; undo brings it back whole", () => {
    const b = circuited();
    const cs = b.ok({ type: "delete_elements", ids: ["c-1"], policy: "refuse" });
    expect(part(b, "l1").feeds).toBeUndefined();
    expect(part(b, "r2").served).toBeUndefined();
    b.valid();
    b.ok({ type: "undo", revision: cs.revision });
    expect(part(b, "l1").feeds).toEqual(["c-1"]);
    expect(part(b, "r2").served).toEqual({ power: "c-1" });
    b.valid();
  });

  it("undoing a create removes the circuit and both back-links", () => {
    const b = referenceDistribution();
    b.place("r1", "receptacle", { voltage: 120, load_va: 180 }, "R-1");
    const cs = b.ok({ type: "create_service_link", linkId: "c-1", sourceId: "l1", members: [{ elementId: "r1" }] });
    b.ok({ type: "undo", revision: cs.revision });
    expect(b.head.elements["c-1"]).toBeUndefined();
    expect(part(b, "r1").served).toBeUndefined();
    expect(part(b, "l1").feeds).toBeUndefined();
    b.valid();
  });

  it("a copy of a circuited device starts on no circuit", () => {
    const b = circuited();
    b.ok({ type: "copy_elements", ids: ["r1"], newIds: ["r1-copy"], delta: { x: 1000, y: 0 } });
    expect(part(b, "r1-copy").served).toBeUndefined();
    expect(link(b, "c-1").members).toHaveLength(2);
    b.valid();
  });

  it("validation catches a one-sided link", () => {
    const b = circuited();
    const broken = { ...b.head, elements: { ...b.head.elements, r1: { ...part(b, "r1"), served: undefined } } };
    expect(validateModel(broken).map((i) => i.message)).toEqual(["L1-1 serves R-1, which doesn't name it"]);
  });
});
