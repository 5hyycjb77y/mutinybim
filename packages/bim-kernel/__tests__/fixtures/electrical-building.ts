import {
  applyChangeset,
  canonicalJson,
  DEFAULT_SETTINGS,
  planCommit,
  validateModel,
  type BimElement,
  type Changeset,
  type Command,
  type ModelState,
  type ParamDef,
  type PartConnector,
  type PartTypeDefinition,
} from "../../src";

/**
 * The reference building from the electrical analysis ("small commercial
 * building"): MDP 277/480 V feeds H1 (277/480 V) and transformer T1, which
 * feeds L1 (120/208 V). Part types are made up here so the test owns every
 * value it hand-calculates.
 */

const NOW = () => "2026-10-21T00:00:00.000Z";
const IN = 25.4;

function num(name: string, label: string, unit: ParamDef["unit"], def?: number): ParamDef {
  return { name, label, kind: "number", unit, min: 0, ...(def !== undefined ? { default: def } : {}) };
}
const text = (name: string, label: string): ParamDef => ({ name, label, kind: "text" });

function power(id: string, poles: number, voltage: PartConnector["voltage"], flow?: PartConnector["flow"]): PartConnector {
  return { id, label: "Power", domain: "electrical", systemKind: "power", position: [0, 0, 300], direction: [0, 0, 1], shape: "none", voltage, poles, ...(flow !== undefined ? { flow } : {}) };
}

function box(): Pick<PartTypeDefinition, "geometry" | "symbol"> {
  return { geometry: [{ kind: "box", center: [0, 0, 300], size: [600, 300, 600] }], symbol: [{ kind: "rect", center: [0, 0], size: [600, 300] }] };
}

const builtin = { kind: "builtin", libraryVersion: "test" } as const;

/** Panelboard or switchboard: voltage + phases, circuits, bus, mains; fed at "feeder". */
export function distributionType(familyName: string, typeName: string, voltage: number, phases: "1" | "3", circuits: number, bus: number, mains: string, extra: Partial<Record<string, string>> = {}): PartTypeDefinition {
  return {
    familyName,
    typeName,
    category: "electrical_equipment",
    typeParams: [num("voltage", "Voltage", "v"), { name: "phases", label: "Phases", kind: "choice", choices: ["1", "3"] }, num("circuits", "Circuits", "count"), num("bus_rating", "Bus", "a"), text("mains", "Mains"), text("voltage_system", "Voltage system")],
    typeValues: { voltage, phases, circuits, bus_rating: bus, mains, ...Object.fromEntries(Object.entries(extra).filter((e): e is [string, string] => e[1] !== undefined)) },
    instanceParams: [text("panel_name", "Panel name"), text("fed_from", "Fed from")],
    connectors: [power("feeder", phases === "3" ? 3 : 2, { param: "voltage" })],
    ...box(),
    tagFields: ["panel_name"],
    source: builtin,
  };
}

export const TRANSFORMER: PartTypeDefinition = {
  familyName: "Transformer, dry type",
  typeName: "75 kVA 480D-208Y/120",
  category: "electrical_equipment",
  typeParams: [num("kva", "Rating", "kw"), num("primary_voltage", "Primary", "v"), num("secondary_voltage", "Secondary", "v")],
  typeValues: { kva: 75, primary_voltage: 480, secondary_voltage: 208 },
  instanceParams: [text("panel_name", "Name")],
  connectors: [power("primary", 3, 480)],
  ...box(),
  tagFields: ["panel_name"],
  source: builtin,
};

/** Equipment or device with one power connector; load, voltage and class are instance values. */
export function loadType(familyName: string, category: PartTypeDefinition["category"], poles: number): PartTypeDefinition {
  return {
    familyName,
    typeName: `${poles}-pole load`,
    category,
    typeParams: [],
    typeValues: {},
    instanceParams: [num("voltage", "Voltage", "v", 120), num("load_va", "Load", "va", 0), num("mca", "MCA", "a"), num("mocp", "MOCP", "a"), text("load_class", "Load class"), text("circuit", "Circuit")],
    connectors: [power("power", poles, { param: "voltage" }, { param: "load_va" })],
    ...box(),
    tagFields: ["mark"],
    source: builtin,
  };
}

export const TYPES = {
  switchboard: distributionType("Switchboard", "800A 480Y/277V", 480, "3", 30, 800, "800A MCB"),
  panel480: distributionType("Panelboard", "225A 480Y/277V 42 circuit", 480, "3", 42, 225, "MLO"),
  panel208: distributionType("Panelboard", "225A 208Y/120V 42 circuit", 208, "3", 42, 225, "225A MCB"),
  panel480single: distributionType("Panelboard", "100A 277/480V 1PH", 480, "1", 24, 100, "MLO", { voltage_system: "277/480 1PH 3W" }),
  transformer: TRANSFORMER,
  mech3: loadType("Mechanical unit", "mechanical_equipment", 3),
  mech1: loadType("Mechanical unit", "mechanical_equipment", 1),
  equip2: loadType("Water heater", "mechanical_equipment", 2),
  receptacle: loadType("Receptacle, duplex", "electrical_device", 1),
  kitchen: loadType("Kitchen equipment", "electrical_device", 1),
  light: loadType("Light fixture", "lighting_fixture", 1),
} as const satisfies Record<string, PartTypeDefinition>;

export type TypeKey = keyof typeof TYPES;

let keySeq = 0;

/** In-test sequencer: the authority's planCommit, every changeset re-applied as a client would. */
export class Building {
  head: ModelState = { modelId: "e1", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  readonly log: Changeset[] = [];
  private readonly placedTypes = new Set<string>();
  private x = 0;

  constructor() {
    this.ok({ type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  }

  submit(command: Command, actor = "avery") {
    keySeq += 1;
    const base = this.head.revision;
    const d = planCommit(this.head, [], { idempotencyKey: `e1-key-${keySeq}`, baseRevision: base, actor: { id: actor, name: actor, kind: "human" }, command }, NOW, this.log);
    if (d.ok) {
      expect(canonicalJson(applyChangeset(this.head, d.changeset))).toBe(canonicalJson(d.model));
      this.head = d.model;
      this.log.push(d.changeset);
    }
    return d;
  }

  ok(command: Command, actor?: string): Changeset {
    const d = this.submit(command, actor);
    if (!d.ok) throw new Error(`expected ${command.type} to commit: ${d.error.message}`);
    return d.changeset;
  }

  refused(command: Command): string {
    const d = this.submit(command);
    if (d.ok) throw new Error(`expected ${command.type} to be refused`);
    return d.error.message;
  }

  /** Place a part of a fixture type with instance values; returns its id. */
  place(id: string, type: TypeKey, values: Record<string, number | string> = {}, mark = id, at?: { readonly x: number; readonly y: number }): string {
    const typeId = `type-${type}`;
    const first = !this.placedTypes.has(typeId);
    this.placedTypes.add(typeId);
    this.x += 2 * IN * 12;
    this.ok({ type: "place_part", partId: id, typeId, ...(first ? { partType: TYPES[type] } : {}), levelId: "lvl-1", position: at ?? { x: this.x, y: 0 }, mark, values });
    return id;
  }

  el(id: string): BimElement {
    const found = this.head.elements[id];
    if (!found) throw new Error(`missing ${id}`);
    return found;
  }

  valid(): void {
    expect(validateModel(this.head)).toEqual([]);
  }
}

/** The distribution of the reference building, fed and placed: MDP → H1, MDP → T1 → L1. */
export function referenceDistribution(): Building {
  const b = new Building();
  b.place("mdp", "switchboard", { panel_name: "MDP" });
  b.place("h1", "panel480", { panel_name: "H1" });
  b.place("t1", "transformer", { panel_name: "T1" });
  b.place("l1", "panel208", { panel_name: "L1" });
  b.ok({ type: "create_service_link", linkId: "f-h1", sourceId: "mdp", positions: [1, 3, 5], members: [{ elementId: "h1" }], electrical: { ratingA: 225, feederType: "F225" } });
  b.ok({ type: "create_service_link", linkId: "f-t1", sourceId: "mdp", positions: [2, 4, 6], members: [{ elementId: "t1" }], electrical: { ratingA: 100, feederType: "F100T" } });
  b.ok({ type: "create_service_link", linkId: "f-l1", sourceId: "t1", members: [{ elementId: "l1" }] });
  return b;
}

/**
 * The reference building, circuited (every value the acceptance tests
 * hand-calculate):
 *
 * H1 (277/480 V): RTU-1 24,000 VA on 1,3,5; RTU-2 15,000 VA on 2,4,6; MUA-1
 * 10,000 VA on 7,9,11; open-office and warehouse lighting, 20 x 40 W each on
 * 13 (A) and 15 (B); site lighting 6 x 150 W on 17 (C), 300 ft of #10; K-3, a
 * 9,000 VA 480 V dishwasher booster heater (kitchen equipment) on 19,21,23.
 *
 * L1 (120/208 V): four offices of 3 receptacles at 180 VA on 1, 3, 5, 7; two
 * break-room counter receptacles on 9; EF-1 600 VA on 11; WH-1 4,500 VA
 * 2-pole on 13,15; reach-in freezer E.05 1,320 VA on 2, K-1 1,500 VA on 4,
 * K-2 1,800 VA on 6 (kitchen equipment).
 */
export function referenceBuilding(): Building {
  const b = referenceDistribution();
  b.place("rtu1", "mech3", { voltage: 460, load_va: 24_000, mca: 32, mocp: 40 }, "RTU-1");
  b.place("rtu2", "mech3", { voltage: 460, load_va: 15_000, mca: 18, mocp: 25 }, "RTU-2");
  b.place("mua1", "mech3", { voltage: 480, load_va: 10_000, mca: 15, mocp: 20 }, "MUA-1");
  b.ok({ type: "create_service_link", linkId: "c-rtu1", sourceId: "h1", members: [{ elementId: "rtu1" }] });
  b.ok({ type: "create_service_link", linkId: "c-rtu2", sourceId: "h1", members: [{ elementId: "rtu2" }] });
  b.ok({ type: "create_service_link", linkId: "c-mua1", sourceId: "h1", members: [{ elementId: "mua1" }] });
  const lights = (prefix: string, n: number, watts: number) => Array.from({ length: n }, (_, i) => ({ elementId: b.place(`${prefix}${i + 1}`, "light", { voltage: 277, load_va: watts }) }));
  b.ok({ type: "create_service_link", linkId: "c-lt1", sourceId: "h1", positions: [13], members: lights("lta", 20, 40), description: "Open office lighting" });
  b.ok({ type: "create_service_link", linkId: "c-lt2", sourceId: "h1", positions: [15], members: lights("ltb", 20, 40), description: "Warehouse lighting" });
  b.ok({ type: "create_service_link", linkId: "c-site", sourceId: "h1", positions: [17], members: lights("site", 6, 150), description: "Site lighting", electrical: { lengthFt: 300, conductors: { sets: 1, phaseSize: "10", groundSize: "10", material: "cu" } } });
  b.place("k3", "mech3", { voltage: 480, load_va: 9000, load_class: "kitchen", mocp: 15 }, "K-3");
  b.ok({ type: "create_service_link", linkId: "c-k3", sourceId: "h1", positions: [19, 21, 23], members: [{ elementId: "k3" }], description: "Dishwasher booster heater" });

  const receptacles = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => ({ elementId: b.place(`${prefix}${i + 1}`, "receptacle", { voltage: 120, load_va: 180 }) }));
  [1, 3, 5, 7].forEach((slot, i) => b.ok({ type: "create_service_link", linkId: `c-off${i + 1}`, sourceId: "l1", positions: [slot], members: receptacles(`off${i + 1}-r`, 3), description: `Office ${101 + i} receptacles` }));
  b.ok({ type: "create_service_link", linkId: "c-brk", sourceId: "l1", positions: [9], members: receptacles("brk-r", 2), description: "Break room counter" });
  b.place("ef1", "mech1", { voltage: 120, load_va: 600 }, "EF-1");
  b.ok({ type: "create_service_link", linkId: "c-ef1", sourceId: "l1", positions: [11], members: [{ elementId: "ef1" }] });
  b.place("wh1", "equip2", { voltage: 208, load_va: 4500 }, "WH-1");
  b.ok({ type: "create_service_link", linkId: "c-wh1", sourceId: "l1", positions: [13, 15], members: [{ elementId: "wh1" }] });
  const kitchen: ReadonlyArray<readonly [string, string, number, number]> = [
    ["e05", "E.05", 1320, 2],
    ["k1", "K-1", 1500, 4],
    ["k2", "K-2", 1800, 6],
  ];
  for (const [id, mark, va, slot] of kitchen) {
    b.place(id, "kitchen", { voltage: 120, load_va: va, load_class: "kitchen" }, mark);
    b.ok({ type: "create_service_link", linkId: `c-${id}`, sourceId: "l1", positions: [slot], members: [{ elementId: id }] });
  }
  b.valid();
  return b;
}
