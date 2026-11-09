import { type PartTypeDefinition, asElementId, type BimElement, type ElementId, type Partition, type PartInstance, type PartTypeElement, type ServiceEnd, type ServiceLink } from "@permitzip/bim-kernel";

/**
 * A building-sized electrical distribution for the perf gate, built as
 * elements directly (tens of thousands of commands would take minutes on a
 * full-building model). Shapes are exactly what `place_part` and
 * `create_service_link` write; `__tests__/electrical-synthetic.test.ts` checks
 * the same distribution built by commands gives the same reports.
 *
 * MDP (480Y/277 V) feeds a 480 V distribution board per floor; each board
 * feeds, per zone, a 277/480 V lighting and mechanical panel and a 75 kVA
 * transformer to a 120/208 V receptacle panel. Per zone: 24 lighting circuits
 * of 10 fixtures, 3 rooftop units, 30 receptacle circuits of 6, 4 kitchen
 * units: 427 loads, 61 circuits.
 */

export interface SyntheticDistributionOptions {
  readonly floors: number;
  readonly zonesPerFloor: number;
  /** Id prefix, so the distribution can sit beside other synthetic content. */
  readonly prefix?: string;
}

export interface SyntheticDistribution {
  readonly elements: Readonly<Record<string, BimElement>>;
  readonly mdpId: ElementId;
  /** A receptacle and a light whose loads the gate edits. */
  readonly receptacleId: ElementId;
  readonly lightId: ElementId;
  readonly counts: { readonly distribution: number; readonly loads: number; readonly links: number };
}

const LIGHTING_CIRCUITS = 24;
const FIXTURES_PER_CIRCUIT = 10;
const RTUS = 3;
const RECEPTACLE_CIRCUITS = 30;
const RECEPTACLES_PER_CIRCUIT = 6;
const KITCHEN_UNITS = 4;

const GLOBAL: Partition = { level: "*", zone: "*", discipline: "architecture" };
const SOURCE = { kind: "builtin", libraryVersion: "synthetic-distribution" } as const;
const BOX = { geometry: [{ kind: "box" as const, center: [0, 0, 300] as [number, number, number], size: [600, 300, 600] as [number, number, number] }], symbol: [{ kind: "rect" as const, center: [0, 0] as [number, number], size: [600, 300] as [number, number] }] };

function power(id: string, poles: number, voltage: number, flowParam?: string) {
  return { id, label: "Power", domain: "electrical" as const, systemKind: "power" as const, position: [0, 0, 300] as [number, number, number], direction: [0, 0, 1] as [number, number, number], shape: "none" as const, voltage, poles, ...(flowParam ? { flow: { param: flowParam } } : {}) };
}

function distribution(typeName: string, voltage: number, circuits: number, bus: number, mains: string): PartTypeDefinition {
  return {
    familyName: typeName.startsWith("Switchboard") ? "Switchboard" : "Panelboard",
    typeName,
    category: "electrical_equipment",
    typeParams: [
      { name: "voltage", label: "Voltage", kind: "number", unit: "v", min: 0 },
      { name: "phases", label: "Phases", kind: "choice", choices: ["1", "3"] },
      { name: "circuits", label: "Circuits", kind: "number", unit: "count", min: 1 },
      { name: "bus_rating", label: "Bus", kind: "number", unit: "a", min: 0 },
      { name: "mains", label: "Mains", kind: "text" },
    ],
    typeValues: { voltage, phases: "3", circuits, bus_rating: bus, mains },
    instanceParams: [{ name: "panel_name", label: "Panel name", kind: "text" }],
    connectors: [power("feeder", 3, voltage)],
    ...BOX,
    tagFields: ["panel_name"],
    source: SOURCE,
  };
}

function load(familyName: string, category: PartTypeDefinition["category"], poles: number, voltage: number, va: number, loadClass?: string): PartTypeDefinition {
  return {
    familyName,
    typeName: `${va} VA`,
    category,
    typeParams: loadClass ? [{ name: "load_class", label: "Load class", kind: "text" }] : [],
    typeValues: loadClass ? { load_class: loadClass } : {},
    instanceParams: [{ name: "load_va", label: "Load", kind: "number", unit: "va", min: 0, default: va }],
    connectors: [power("power", poles, voltage, "load_va")],
    ...BOX,
    tagFields: ["mark"],
    source: SOURCE,
  };
}

const TRANSFORMER: PartTypeDefinition = {
  familyName: "Transformer, dry type",
  typeName: "75 kVA 480D-208Y/120",
  category: "electrical_equipment",
  typeParams: [
    { name: "kva", label: "Rating", kind: "number", unit: "kw", min: 0 },
    { name: "primary_voltage", label: "Primary", kind: "number", unit: "v", min: 0 },
    { name: "secondary_voltage", label: "Secondary", kind: "number", unit: "v", min: 0 },
  ],
  typeValues: { kva: 75, primary_voltage: 480, secondary_voltage: 208 },
  instanceParams: [{ name: "panel_name", label: "Name", kind: "text" }],
  connectors: [power("primary", 3, 480)],
  ...BOX,
  tagFields: ["panel_name"],
  source: SOURCE,
};

/** The part types, by key, as `place_part` would store them. */
export const SYNTHETIC_DISTRIBUTION_TYPES = {
  mdp: distribution("Switchboard 4000A 480Y/277V", 480, 42, 4000, "4000A MCB"),
  board: distribution("Switchboard 1600A 480Y/277V distribution", 480, 96, 1600, "MLO"),
  panel480: distribution("Panelboard 225A 480Y/277V 42 circuit", 480, 42, 225, "MLO"),
  panel208: distribution("Panelboard 225A 208Y/120V 42 circuit", 208, 42, 225, "225A MCB"),
  transformer: TRANSFORMER,
  light: load("Troffer", "lighting_fixture", 1, 277, 40),
  rtu: load("Packaged rooftop unit", "mechanical_equipment", 3, 460, 15_000),
  receptacle: load("Receptacle, duplex", "electrical_device", 1, 120, 180),
  kitchen: load("Kitchen equipment", "electrical_device", 1, 120, 1500, "kitchen"),
} as const satisfies Record<string, PartTypeDefinition>;

export type SyntheticTypeKey = keyof typeof SYNTHETIC_DISTRIBUTION_TYPES;

/** Slots of the `index`-th three-pole breaker on a panel: odd column 1,3,5 / 7,9,11 … then the even column. */
export function threePoleSlots(index: number): number[] {
  const base = 6 * Math.floor(index / 2) + 1 + (index % 2);
  return [base, base + 2, base + 4];
}

export function syntheticDistribution(options: SyntheticDistributionOptions): SyntheticDistribution {
  const p = options.prefix ?? "e";
  const out: Record<string, BimElement> = {};
  const parts = new Map<string, { -readonly [K in keyof PartInstance]: PartInstance[K] } & { feeds: ElementId[]; served: Record<string, ElementId> }>();
  let loads = 0;
  let links = 0;
  let distributionCount = 0;
  for (const [key, definition] of Object.entries(SYNTHETIC_DISTRIBUTION_TYPES)) {
    const t: PartTypeElement = { id: asElementId(`${p}-type-${key}`), kind: "part_type", version: 0, authoredRev: {}, partition: GLOBAL, definition };
    out[t.id] = t;
  }
  const levelId = asElementId(`${p}-lvl`);
  out[levelId] = { id: levelId, kind: "level", version: 0, authoredRev: {}, partition: GLOBAL, name: "Electrical", elevationMm: 0 };

  const place = (id: string, type: SyntheticTypeKey, zone: string, values: Record<string, number | string>, mark: string) => {
    const part = { id: asElementId(id), kind: "part" as const, version: 0, authoredRev: {}, partition: { level: "Electrical", zone, discipline: "electrical" as const }, typeId: asElementId(`${p}-type-${type}`), levelId, position: { x: parts.size * 1000, y: 0 }, offsetMm: 0, rotationDeg: 0, mark, values, feeds: [] as ElementId[], served: {} as Record<string, ElementId> };
    parts.set(id, part);
    if (type === "mdp" || type === "board" || type === "panel480" || type === "panel208" || type === "transformer") distributionCount += 1;
    else loads += 1;
    return part;
  };
  const link = (id: string, source: string, port: "bus" | "secondary", positions: readonly number[], members: readonly string[], role: ServiceLink["role"], ratingA: number | undefined, description = "") => {
    const ends: ServiceEnd[] = members.map((m) => ({ elementId: asElementId(m), connector: role === "feeder" ? (parts.get(m)?.typeId.endsWith("transformer") ? "primary" : "feeder") : "power" }));
    const l: ServiceLink = { id: asElementId(id), kind: "service_link", version: 0, authoredRev: {}, partition: GLOBAL, trade: "electrical", role, source: { elementId: asElementId(source), port, positions: [...positions] }, members: ends, description, ...(ratingA !== undefined ? { electrical: { ratingA } } : {}) };
    out[l.id] = l;
    parts.get(source)?.feeds.push(l.id);
    for (const e of ends) {
      const m = parts.get(e.elementId);
      if (m) m.served[e.connector] = l.id;
    }
    links += 1;
  };

  const mdp = `${p}-mdp`;
  place(mdp, "mdp", "E0", { panel_name: "MDP" }, "MDP");
  let receptacleId = "";
  let lightId = "";
  for (let f = 0; f < options.floors; f++) {
    const board = `${p}-d${f + 1}`;
    place(board, "board", `F${f + 1}`, { panel_name: `D${f + 1}` }, `D${f + 1}`);
    link(`${board}-f`, mdp, "bus", threePoleSlots(f), [board], "feeder", 1600);
    for (let z = 0; z < options.zonesPerFloor; z++) {
      const zone = `F${f + 1}Z${z + 1}`;
      const h = `${p}-h${f + 1}-${z + 1}`;
      const t = `${p}-t${f + 1}-${z + 1}`;
      const l = `${p}-l${f + 1}-${z + 1}`;
      place(h, "panel480", zone, { panel_name: `H${f + 1}-${z + 1}` }, `H${f + 1}-${z + 1}`);
      place(t, "transformer", zone, { panel_name: `T${f + 1}-${z + 1}` }, `T${f + 1}-${z + 1}`);
      place(l, "panel208", zone, { panel_name: `L${f + 1}-${z + 1}` }, `L${f + 1}-${z + 1}`);
      link(`${h}-f`, board, "bus", threePoleSlots(2 * z), [h], "feeder", 225);
      link(`${t}-f`, board, "bus", threePoleSlots(2 * z + 1), [t], "feeder", 100);
      link(`${l}-f`, t, "secondary", [], [l], "feeder", undefined);
      for (let c = 0; c < LIGHTING_CIRCUITS; c++) {
        const members = Array.from({ length: FIXTURES_PER_CIRCUIT }, (_, i) => place(`${h}-lt${c + 1}-${i + 1}`, "light", zone, {}, `LT-${c + 1}`).id);
        if (!lightId) lightId = members[0] ?? "";
        link(`${h}-c${c + 1}`, h, "bus", [c + 1], members, "branch", 20, "Lighting");
      }
      for (let u = 0; u < RTUS; u++) link(`${h}-rtu${u + 1}`, h, "bus", threePoleSlots(8 + u), [place(`${h}-rtu${u + 1}-p`, "rtu", zone, {}, `RTU-${u + 1}`).id], "branch", 30, "Rooftop unit");
      for (let c = 0; c < RECEPTACLE_CIRCUITS; c++) {
        const members = Array.from({ length: RECEPTACLES_PER_CIRCUIT }, (_, i) => place(`${l}-r${c + 1}-${i + 1}`, "receptacle", zone, {}, `R-${c + 1}`).id);
        if (!receptacleId) receptacleId = members[0] ?? "";
        link(`${l}-c${c + 1}`, l, "bus", [c + 1], members, "branch", 20, "Receptacles");
      }
      for (let k = 0; k < KITCHEN_UNITS; k++) link(`${l}-k${k + 1}`, l, "bus", [RECEPTACLE_CIRCUITS + k + 1], [place(`${l}-k${k + 1}-p`, "kitchen", zone, {}, `K-${k + 1}`).id], "branch", 20, "Kitchen equipment");
    }
  }
  for (const part of parts.values()) {
    const { feeds, served, ...rest } = part;
    out[part.id] = { ...rest, ...(feeds.length > 0 ? { feeds } : {}), ...(Object.keys(served).length > 0 ? { served } : {}) };
  }
  return { elements: out, mdpId: asElementId(mdp), receptacleId: asElementId(receptacleId), lightId: asElementId(lightId), counts: { distribution: distributionCount, loads, links } };
}
