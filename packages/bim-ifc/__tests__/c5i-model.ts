import { DEFAULT_SETTINGS, asElementId, asRevision, type BimElement, type ModelState, type PartTypeDefinition } from "@permitzip/bim-kernel";

/**
 * Synthetic models for the bim-ifc tests: a two-storey building with an
 * engineers' space and an architect's room, a supply-air system with a duct
 * run into a placed air handler, a planned fryer, a panel circuit, a load
 * point, a fire-area outline zone and a thermal zone. No client data.
 */

export const PROJECT_ID = "0b7f4c52-6a1e-4d2b-9a43-5d2f0c9e7a11";
export const TIME_STAMP = "2026-10-29T12:00:00";

const base = { version: 1, authoredRev: {} };
const id = asElementId;

export function ahuType(): PartTypeDefinition {
  return {
    familyName: "Air handler",
    typeName: "AHU 2000 CFM",
    category: "mechanical_equipment",
    typeParams: [
      { name: "supply_cfm", label: "Supply airflow", kind: "number", unit: "cfm" },
      { name: "voltage", label: "Voltage", kind: "number", unit: "v" },
      { name: "manufacturer", label: "Manufacturer", kind: "text" },
    ],
    typeValues: { supply_cfm: 2000, voltage: 208, manufacturer: "Acme's \"Air\" Co." },
    instanceParams: [{ name: "serviced", label: "Serviced", kind: "boolean" }],
    connectors: [{ id: "supply", label: "Supply", domain: "duct", systemKind: "supply_air", position: [600, 0, 400], direction: [1, 0, 0], shape: "rect", width: 400, height: 300, flowDirection: "out" }],
    geometry: [{ kind: "box", center: [0, 0, 500], size: [1200, 900, 1000] }],
    symbol: [],
    tagFields: ["mark"],
    source: { kind: "builtin", libraryVersion: "test" },
  };
}

export function fryerType(): PartTypeDefinition {
  return {
    familyName: "Fryer",
    typeName: "Fryer 50 lb",
    category: "electrical_equipment",
    typeParams: [{ name: "kw", label: "Power", kind: "number", unit: "kw" }],
    typeValues: { kw: 8 },
    instanceParams: [],
    connectors: [{ id: "power", label: "Power", domain: "electrical", systemKind: "power", position: [0, 0, 300], direction: [0, -1, 0], shape: "none", voltage: 240, poles: 2 }],
    geometry: [{ kind: "box", center: [0, 0, 450], size: [400, 800, 900] }],
    symbol: [],
    tagFields: ["mark"],
    source: { kind: "builtin", libraryVersion: "test" },
  };
}

export function syntheticModel(extra: readonly BimElement[] = []): ModelState {
  const els: BimElement[] = [
    { ...base, id: id("lvl-1"), kind: "level", name: "Level 1", elevationMm: 0 },
    { ...base, id: id("lvl-2"), kind: "level", name: "Level 2", elevationMm: 4000, source: { referenceId: "arch", storeyId: "3YvctVUKr0kugbFTf53O9L", storeyName: "Level 2" } },
    { ...base, id: id("room-101"), kind: "room", number: "101", name: "Kitchen", outline: [{ x: 0, y: 0 }, { x: 8000, y: 0 }, { x: 8000, y: 6000 }, { x: 0, y: 6000 }], areaSqM: 48, partition: { level: "lvl-1", zone: "Z1", discipline: "mechanical" } },
    { ...base, id: id("sp-101"), kind: "space", number: "101", name: "Kitchen", levelId: id("lvl-1"), bounds: { kind: "rooms", roomIds: [id("room-101")] }, origin: { kind: "from_room", roomId: id("room-101") }, occupants: 6, ceilingHeightMm: 3000 },
    { ...base, id: id("sp-201"), kind: "space", number: "201", name: "Office", levelId: id("lvl-2"), bounds: { kind: "outline", outline: [{ x: 0, y: 0 }, { x: 5000, y: 0 }, { x: 5000, y: 4000 }, { x: 0, y: 4000 }] }, origin: { kind: "drawn" }, ceilingHeightMm: 2700 },
    { ...base, id: id("zone-thermal"), kind: "zone", name: "Zone 1", purpose: "thermal", spaceIds: [id("sp-101"), id("sp-201")], servedBy: id("ahu-1") },
    { ...base, id: id("zone-fire"), kind: "zone", name: "Fire area A", purpose: "fire_area", spaceIds: [], bounds: { kind: "outline", levelId: id("lvl-1"), outline: [{ x: 0, y: 0 }, { x: 10000, y: 0 }, { x: 10000, y: 8000 }], top: 4000 } },
    { ...base, id: id("pt-ahu"), kind: "part_type", definition: ahuType() },
    { ...base, id: id("pt-fryer"), kind: "part_type", definition: fryerType() },
    {
      ...base,
      id: id("ahu-1"),
      kind: "part",
      typeId: id("pt-ahu"),
      levelId: id("lvl-1"),
      position: { x: 1000, y: 1000 },
      offsetMm: 0,
      rotationDeg: 90,
      mark: "AHU-1",
      values: { serviced: true },
      links: { supply: { elementId: id("duct-1"), port: "start" } },
    },
    { ...base, id: id("fryer-1"), kind: "part", typeId: id("pt-fryer"), levelId: id("lvl-1"), position: { x: 0, y: 0 }, offsetMm: 0, rotationDeg: 0, mark: "K-2", values: {}, planned: { levelHint: id("lvl-1"), spaceHint: id("sp-101") } },
    { ...base, id: id("panel-p1"), kind: "part", typeId: id("pt-fryer"), levelId: id("lvl-1"), position: { x: 7000, y: 500 }, offsetMm: 0, rotationDeg: 0, mark: "P1", values: {} },
    { ...base, id: id("sys-sa"), kind: "mep_system", name: "Supply Air 1", systemKind: "supply_air", domain: "duct" },
    { ...base, id: id("sys-gw"), kind: "mep_system", name: "Grease Waste 1", systemKind: "grease_waste", domain: "pipe" },
    {
      ...base,
      id: id("duct-1"),
      kind: "run_segment",
      domain: "duct",
      systemId: id("sys-sa"),
      levelId: id("lvl-1"),
      start: { x: 1600, y: 1000, z: 400 },
      end: { x: 6000, y: 1000, z: 400 },
      size: { shape: "rect", width: 400, height: 300 },
      links: { start: { elementId: id("ahu-1"), port: "supply" } },
      branches: [],
      flow: 2000,
    },
    { ...base, id: id("ckt-1"), kind: "service_link", trade: "electrical", role: "branch", source: { elementId: id("panel-p1"), port: "bus", positions: [1, 3] }, members: [{ elementId: id("fryer-1"), connector: "power" }], description: "Fryer circuit" },
    { ...base, id: id("lp-sink"), kind: "load_point", connectionType: "P41", values: { wsfu_cold: 1.5, wsfu_hot: 1.5, dfu: 3 }, mark: "P41-1", anchor: { kind: "space", id: id("sp-101") }, service: "cold_water" },
    { ...base, id: id("wall-1"), kind: "wall", start: { x: 0, y: 0 }, end: { x: 8000, y: 0 }, thickness: 150, height: 3000, wallType: "Partition 4 1/2\"", partition: { level: "lvl-1", zone: "Z1", discipline: "architecture" } },
    { ...base, id: id("view-1"), kind: "view", name: "Level 1 plan", viewType: "floor_plan", cropMin: { x: 0, y: 0 }, cropMax: { x: 1, y: 1 } },
    ...extra,
  ];
  return { modelId: "synthetic", revision: asRevision(7), elements: Object.fromEntries(els.map((e) => [e.id, e])), connections: [], settings: DEFAULT_SETTINGS };
}
