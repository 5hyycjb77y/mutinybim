/**
 * @jest-environment node
 *
 * Plumbing, gas and air on the network adapters, like electrical
 * (NEXT-BATCH 5b-1). Air sources are registered beside electrical and
 * plumbing and keyed by the service registry's adapter id; the plumbing
 * adapter reads its piped services and source roles from the registry.
 *
 * Fails on the old code: `tradeAdapter("mechanical")` was null, so no load
 * could name an air handler; and a grease interceptor refused a grease waste
 * connection (its served set was hard-coded to sanitary).
 */
import { asElementId, withUpgradePolicy, type PartTypeDefinition, type SystemKind } from "../src";
import { adapterForService, sourceTradeOf, tradeAdapter } from "../src/connections/model";
import { airSourceRole, mechanicalAdapter } from "@permitzip/bim-pack-mechanical";
import { plumbingAdapter } from "@permitzip/bim-pack-plumbing";
import { SERVICES_REGISTRY_FEATURE } from "../src/services/types";
import { DrainageBuilding, FT } from "./drainage-fixtures";

const duct = (id: string, kind: SystemKind, out: boolean, x: number) => ({ id, label: id, domain: "duct" as const, systemKind: kind, position: [x, 0, 300] as [number, number, number], direction: [out ? 1 : -1, 0, 0] as [number, number, number], shape: "round" as const, diameter: 300, flowDirection: out ? ("out" as const) : ("in" as const) });

function equipment(familyName: string, connectors: PartTypeDefinition["connectors"], category: PartTypeDefinition["category"] = "mechanical_equipment"): PartTypeDefinition {
  return { familyName, typeName: "Test", category, typeParams: [], typeValues: {}, instanceParams: [], tagFields: [], geometry: [{ kind: "box", center: [0, 0, 300], size: [600, 600, 600] }], symbol: [{ kind: "rect", center: [0, 0], size: [600, 600] }], connectors, source: { kind: "builtin", libraryVersion: "test" } };
}

const RTU = equipment("Rooftop unit", [duct("supply", "supply_air", true, 300), duct("return", "return_air", false, -300), duct("oa", "outside_air", false, 0)]);
const EF = equipment("Exhaust fan", [duct("inlet", "exhaust_air", false, -300), duct("discharge", "exhaust_air", true, 300)]);
const DIFFUSER = equipment("Supply diffuser", [duct("neck", "supply_air", false, 0)], "air_terminal");
const HOOD = equipment("Kitchen hood", [duct("exhaust", "exhaust_air", true, 0)], "generic");

function building() {
  const b = new DrainageBuilding();
  let x = 0;
  for (const [id, def] of [["rtu-1", RTU], ["ef-1", EF], ["s-1", DIFFUSER], ["hood-1", HOOD]] as const) {
    b.ok({ type: "place_part", partId: id, typeId: `type-${id}`, partType: def, levelId: "lvl-1", position: { x, y: 0 }, mark: id.toUpperCase() });
    x += 10 * FT;
  }
  return b;
}

function part(b: DrainageBuilding, id: string) {
  const p = b.head.elements[id];
  if (p?.kind !== "part") throw new Error(id);
  return p;
}

describe("the air adapter registers beside electrical and plumbing", () => {
  it("is the mechanical trade's adapter and the adapter of every air service row", () => {
    expect(tradeAdapter("mechanical")).toBe(mechanicalAdapter);
    for (const s of ["supply_air", "return_air", "exhaust_air", "outside_air"]) expect(adapterForService(s)).toBe(mechanicalAdapter);
    expect(adapterForService("sanitary")).toBe(plumbingAdapter);
    expect(adapterForService("cold_water")).toBe(plumbingAdapter);
    expect(adapterForService("vent")).toBeNull();
    expect(adapterForService("future_kind")).toBeNull();
  });

  it("an RTU and an exhaust fan are air sources; a diffuser and a hood are not", () => {
    const b = building();
    const els = b.head.elements;
    expect(airSourceRole(els, part(b, "rtu-1"))).toBe("equipment");
    expect(sourceTradeOf(els, part(b, "rtu-1"))).toMatchObject({ adapter: mechanicalAdapter, info: { name: "RTU-1", port: "supply", spaces: "none" } });
    expect(sourceTradeOf(els, part(b, "ef-1"))?.info.port).toBe("discharge");
    expect(sourceTradeOf(els, part(b, "s-1"))).toBeNull();
    expect(sourceTradeOf(els, part(b, "hood-1"))).toBeNull();
  });

  it("a source serves only the air its own connections carry, and says so in plain words", () => {
    const b = building();
    const els = b.head.elements;
    expect(mechanicalAdapter.connectors(els, part(b, "s-1"))).toEqual(["neck"]);
    expect(mechanicalAdapter.refusal(els, part(b, "rtu-1"), [], { part: part(b, "s-1"), connector: "neck" }, "branch")).toBeNull();
    expect(mechanicalAdapter.refusal(els, part(b, "ef-1"), [], { part: part(b, "s-1"), connector: "neck" }, "branch")).toBe("EF-1 has no supply air connection, so it can't serve S-1's neck");
    expect(mechanicalAdapter.refusal(els, part(b, "hood-1"), [], { part: part(b, "s-1"), connector: "neck" }, "branch")).toBe("HOOD-1 is not an air handler, rooftop unit, fan or energy recovery unit, so no air can be served from it");
    expect(mechanicalAdapter.positionsRefusal(els, part(b, "rtu-1"), [1])).toBe("RTU-1 has no numbered positions; what it serves takes none");
  });

  it("a load can now name the rooftop unit as its source (refused before: nothing served air)", () => {
    const b = building();
    expect(b.try({ type: "create_load", loads: [{ id: "lp-s1", mark: "S-1", service: "supply_air", values: { cfm: 450 }, servedBy: "rtu-1" }] })).toBeNull();
    const lp = b.head.elements["lp-s1"];
    expect(lp?.kind === "load_point" ? lp.servedBy : null).toBe(asElementId("rtu-1"));
  });
});

describe("the plumbing adapter reads the registry", () => {
  const gi = (inlet: SystemKind): PartTypeDefinition => ({
    ...equipment("Grease interceptor", [
      { id: "in", label: "Inlet", domain: "pipe", systemKind: inlet, position: [-300, 0, 0], direction: [-1, 0, 0], shape: "round", diameter: 101.6, flowDirection: "in" },
      { id: "out", label: "Outlet", domain: "pipe", systemKind: "sanitary", position: [300, 0, 0], direction: [1, 0, 0], shape: "round", diameter: 101.6, flowDirection: "out" },
    ], "pipe_accessory"),
    typeParams: [{ name: "plumbing_source", label: "Plumbing source", kind: "text" }],
    typeValues: { plumbing_source: "grease_interceptor" },
  });

  it("a grease interceptor serves a fixture's grease waste connection (it refused one before)", () => {
    const b = new DrainageBuilding();
    withUpgradePolicy((f) => f === SERVICES_REGISTRY_FEATURE, () => {
      b.ok({ type: "place_part", partId: "gi-1", typeId: "type-gi", partType: gi("grease_waste"), levelId: "lvl-1", position: { x: 0, y: 0 }, mark: "GI-1" });
      b.ok({ type: "place_part", partId: "sk3", typeId: "type-sk3", partType: equipment("Sink, three compartment", [{ id: "w", label: "Waste", domain: "pipe", systemKind: "grease_waste", position: [0, 0, 0], direction: [0, 0, -1], shape: "round", diameter: 50.8 }], "plumbing_fixture"), levelId: "lvl-1", position: { x: -10 * FT, y: 0 }, mark: "SK3-1" });
    });
    const els = b.head.elements;
    expect(plumbingAdapter.connectors(els, part(b, "sk3"))).toEqual(["w"]);
    expect(plumbingAdapter.refusal(els, part(b, "gi-1"), [], { part: part(b, "sk3"), connector: "w" }, "branch")).toBeNull();
    // What it serves arrives at its grease waste inlet, so links name that port.
    expect(plumbingAdapter.source(els, part(b, "gi-1"))?.port).toBe("in");
  });
});
