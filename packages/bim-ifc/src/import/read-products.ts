import { OUTLINE_WITH_HOLES, type ImportGroup, type ImportPort, type ImportPortSize, type ImportProduct, type ImportSource, type ImportStorey, type ParamValue } from "@permitzip/bim-kernel";
import { fromSI, type UnitCode } from "@permitzip/bim-units";
import { generalEntitiesOf } from "../mapping";
import { readStep, type ReadEntity, type StepFile, type StepToken } from "../read";
import { ifcEntityName, isInstantiableEntity, ownAttributes } from "../schema-ifc4x3";
import { GeometryReader, apply, boundsIn, boundsOf, compose, hostFrame, type Frame } from "./geometry";

/**
 * Read a linked IFC model into the importer's neutral products (round 9
 * I9): storeys, groups (distribution systems), and every placed product with
 * its storey, type, host opening, groups, property sets, material, ports and
 * the shape the geometry reader understood. Pure TypeScript over the STEP
 * reader, no wasm; deterministic. Never decides what anything becomes.
 */

export interface IfcReadOptions {
  /** The linked model version the products come from. */
  readonly sourceId: string;
  readonly label: string;
  readonly disciplines: readonly string[];
  /** How the linked model sits in the host (its placement and adjustment), mm and degrees, applied after units. */
  readonly placement?: { readonly dx: number; readonly dy: number; readonly dz: number; readonly rotationDeg: number };
  /** Checked between products; true stops the read with `IfcReadCancelled`. */
  readonly isCancelled?: () => boolean;
}

export class IfcReadCancelled extends Error {
  constructor() {
    super("The conversion was stopped.");
    this.name = "IfcReadCancelled";
  }
}

/** Entities that are places or holes, not products (storeys are read as storeys). */
const NOT_PRODUCTS = new Set([
  "IFCSITE", "IFCBUILDING", "IFCBUILDINGSTOREY", "IFCFACILITY", "IFCFACILITYPART", "IFCBRIDGE", "IFCBRIDGEPART", "IFCROAD", "IFCROADPART",
  "IFCRAILWAY", "IFCRAILWAYPART", "IFCMARINEFACILITY", "IFCMARINEPART", "IFCTUNNEL", "IFCTUNNELPART", "IFCOPENINGELEMENT", "IFCOPENINGSTANDARDCASE",
  "IFCVOIDINGFEATURE", "IFCDISTRIBUTIONPORT", "IFCVIRTUALELEMENT", "IFCANNOTATION", "IFCGRIDAXIS",
]);

const PLACEMENTS = new Set(["IFCLOCALPLACEMENT", "IFCGRIDPLACEMENT", "IFCLINEARPLACEMENT"]);

/** STEP's upper-case name as the schema spells it; IFC2X3 / IFC4 "standard case" subtypes read as their base entity. */
export function schemaEntity(upper: string): string {
  const base = upper.replace(/(STANDARDCASE|ELEMENTEDCASE)$/, "");
  const known = ifcEntityName(base);
  if (known) return known;
  const special: Readonly<Record<string, string>> = { IFCSPACE: "IfcSpace", IFCGRID: "IfcGrid", IFCSYSTEM: "IfcSystem" };
  return special[base] ?? `Ifc${base.slice(3).charAt(0)}${base.slice(4).toLowerCase()}`;
}

function str(t: StepToken | undefined): string | null {
  if (!t) return null;
  if (t.kind === "string") return t.value;
  if (t.kind === "typed") return str(t.value);
  return null;
}

function enumOf(t: StepToken | undefined): string | null {
  return t?.kind === "enum" ? t.value.toUpperCase() : null;
}

function refs(t: StepToken | undefined): number[] {
  if (!t) return [];
  if (t.kind === "ref") return [t.id];
  if (t.kind === "list") return t.items.flatMap((i) => (i.kind === "ref" ? [i.id] : []));
  return [];
}

function globalIdOf(e: ReadEntity): string | null {
  return str(e.args[0]);
}

function value(t: StepToken | undefined): ParamValue | null {
  if (!t) return null;
  if (t.kind === "typed") {
    if (t.value.kind === "enum") return t.value.value === "T" ? true : t.value.value === "F" ? false : null;
    return value(t.value);
  }
  if (t.kind === "string") return t.value;
  if (t.kind === "number") return t.value;
  if (t.kind === "enum") return t.value === "T" ? true : t.value === "F" ? false : t.value;
  return null;
}

/** Millimetres per file length unit, from the project's unit assignment (IFC's default: metres). */
export function lengthScale(file: StepFile): number {
  const project = [...file.entities.values()].find((e) => e.type === "IFCPROJECT");
  const assignment = project ? file.entities.get(refs(project.args[8])[0] ?? -1) : undefined;
  for (const id of refs(assignment?.args[0])) {
    const scale = lengthUnitScale(file, file.entities.get(id));
    if (scale !== null) return scale;
  }
  return 1000;
}

/** Millimetres per one of a length unit (SI, or one converted from SI: feet, inches). Null: not a length unit this reads. */
function lengthUnitScale(file: StepFile, u: ReadEntity | undefined): number | null {
  if (!u) return null;
  if (u.type === "IFCSIUNIT" && enumOf(u.args[1]) === "LENGTHUNIT") return siScale(u);
  if (u.type === "IFCCONVERSIONBASEDUNIT" && enumOf(u.args[1]) === "LENGTHUNIT") {
    const name = (str(u.args[2]) ?? "").toUpperCase();
    if (name === "FOOT" || name === "FEET") return 304.8;
    if (name === "INCH") return 25.4;
    const measure = file.entities.get(refs(u.args[3])[0] ?? -1);
    const factor = measure ? value(measure.args[0]) : null;
    const unit = measure ? file.entities.get(refs(measure.args[1])[0] ?? -1) : undefined;
    if (typeof factor === "number" && unit?.type === "IFCSIUNIT") return factor * siScale(unit);
  }
  return null;
}

function siScale(u: ReadEntity): number {
  const prefix = enumOf(u.args[2]);
  const per: Readonly<Record<string, number>> = { MILLI: 1, CENTI: 10, DECI: 100, KILO: 1e6 };
  return prefix ? (per[prefix] ?? 1000) : 1000;
}

/**
 * What a port on a part connects to, from its PredefinedType (IfcDistributionPortTypeEnum): a part-connector domain
 * of the service registry. A cable carrier (conduit, tray) is a kind of run; what plugs into a part is electrical,
 * as the kernel's `connectorDomainOf` has it.
 */
const PORT_CONNECTS: Readonly<Record<string, string>> = { DUCT: "duct", PIPE: "pipe", CABLE: "electrical", CABLECARRIER: "electrical" };

/**
 * What a port connects to, from the standard property set it carries (`Pset_DistributionPortTypeDuct` is a duct
 * port's): for a port with no PredefinedType of its own, as in IFC2X3. Longest name first, so a cable carrier isn't a cable.
 */
const PORT_SET_CONNECTS: readonly (readonly [string, string])[] = [
  ["TypeCableCarrier", "electrical"],
  ["TypeCable", "electrical"],
  ["TypeDuct", "duct"],
  ["TypePipe", "pipe"],
];

/** The standard port property sets a port's size, flow and voltage are read from (`Pset_DistributionPortTypeDuct`, `…TypePipe`, `…TypeCable` and their kin). */
const PORT_SETS = "Pset_DistributionPort";

/** The standard sets' lengths that say a port's opening. */
const PORT_LENGTHS: ReadonlySet<string> = new Set(["NominalWidth", "NominalHeight", "NominalDiameter", "OuterDiameter"]);

/** The unit a connector counts its design flow in, by what it connects to: what the exporter writes `VolumetricFlowRate` from. */
const PORT_FLOW_UNIT: Readonly<Record<string, UnitCode>> = { duct: "cfm", pipe: "gpm" };

const SI_PREFIX: Readonly<Record<string, number>> = {
  EXA: 1e18, PETA: 1e15, TERA: 1e12, GIGA: 1e9, MEGA: 1e6, KILO: 1e3, HECTO: 1e2, DECA: 10,
  DECI: 1e-1, CENTI: 1e-2, MILLI: 1e-3, MICRO: 1e-6, NANO: 1e-9, PICO: 1e-12, FEMTO: 1e-15, ATTO: 1e-18,
};

/** The power an SI unit name raises its metre to: a prefix on it counts that many times (a milli cubic metre is a millimetre cubed). */
const SI_NAME_POWER: Readonly<Record<string, number>> = { SQUARE_METRE: 2, CUBIC_METRE: 3 };

/**
 * How many SI units one of a file unit is: an SI unit with its prefix, a unit converted from another (a foot, a
 * US gallon, a minute), or one derived from others (cubic feet per minute). Null: not a unit this reads.
 */
function siFactor(file: StepFile, u: ReadEntity | undefined, depth = 0): number | null {
  if (!u || depth > 4) return null;
  if (u.type === "IFCSIUNIT") {
    const prefix = enumOf(u.args[2]);
    const name = enumOf(u.args[3]) ?? "";
    const scale = prefix ? (SI_PREFIX[prefix] ?? null) : 1;
    if (scale === null) return null;
    // The SI unit of mass is the kilogram, and IFC names the gram.
    return scale ** (SI_NAME_POWER[name] ?? 1) * (name === "GRAM" ? 1e-3 : 1);
  }
  if (u.type === "IFCCONVERSIONBASEDUNIT" || u.type === "IFCCONVERSIONBASEDUNITWITHOFFSET") {
    const measure = file.entities.get(refs(u.args[3])[0] ?? -1);
    const factor = measure ? value(measure.args[0]) : null;
    const base = measure ? siFactor(file, file.entities.get(refs(measure.args[1])[0] ?? -1), depth + 1) : null;
    return typeof factor === "number" && factor > 0 && base !== null ? factor * base : null;
  }
  if (u.type === "IFCDERIVEDUNIT") {
    let out = 1;
    for (const id of refs(u.args[0])) {
      const element = file.entities.get(id);
      const base = siFactor(file, file.entities.get(refs(element?.args[0])[0] ?? -1), depth + 1);
      const exponent = value(element?.args[1]);
      if (base === null || typeof exponent !== "number") return null;
      out *= base ** exponent;
    }
    return out;
  }
  return null;
}

/** A predefined type that says nothing: left out, or NOTDEFINED. */
const unset = (predefined: string | null): boolean => predefined === null || predefined === "NOTDEFINED";

/** Where a type object's own attributes start: after the shared prefix and its ElementType. */
const TYPE_OWN_START = 9;

/** The PredefinedType of a product's type object, or null when the type has none (an IFC2X3 style, a property-only type). */
function typePredefined(type: ReadEntity | undefined): string | null {
  if (!type || !type.type.endsWith("TYPE")) return null;
  const name = ifcEntityName(type.type);
  const i = name ? ownAttributes(name).indexOf("PredefinedType") : -1;
  return i >= 0 ? enumOf(type.args[TYPE_OWN_START + i]) : null;
}

/** The attribute index of a named own attribute after the 8-attribute element prefix (null when the entity doesn't have it). */
function ownIndex(entity: string, name: string): number | null {
  // Only element entities share the 8-attribute prefix; a space or a grid doesn't.
  if (!ifcEntityName(entity)) return null;
  const i = ownAttributes(entity).indexOf(name);
  return i >= 0 ? 8 + i : null;
}

export function readIfcSource(text: string, opts: IfcReadOptions): ImportSource {
  const file = readStep(text);
  const scale = lengthScale(file);
  const geo = new GeometryReader(file, scale);
  const host = hostFrame(opts.placement);
  const byType = new Map<string, ReadEntity[]>();
  for (const e of file.entities.values()) {
    const list = byType.get(e.type) ?? [];
    list.push(e);
    byType.set(e.type, list);
  }
  const all = (type: string): readonly ReadEntity[] => byType.get(type) ?? [];
  const gid = (id: number): string | null => {
    const e = file.entities.get(id);
    return e ? globalIdOf(e) : null;
  };
  const world = (placement: StepToken | undefined): Frame => compose(host, geo.placement(placement));

  // Storeys, and what each spatial element sits in.
  const storeys: ImportStorey[] = all("IFCBUILDINGSTOREY").flatMap((s) => {
    const id = globalIdOf(s);
    if (!id) return [];
    return [{ sourceId: id, name: str(s.args[2]) ?? str(s.args[7]) ?? "Storey", elevationMm: apply(world(s.args[5]), { x: 0, y: 0, z: 0 }).z }];
  });
  const storeyIds = new Set(all("IFCBUILDINGSTOREY").map((s) => s.id));
  const parent = new Map<number, number>();
  for (const r of all("IFCRELAGGREGATES")) for (const child of refs(r.args[5])) parent.set(child, refs(r.args[4])[0] ?? -1);
  const container = new Map<number, number>();
  for (const r of all("IFCRELCONTAINEDINSPATIALSTRUCTURE")) for (const child of refs(r.args[4])) container.set(child, refs(r.args[5])[0] ?? -1);
  const storeyOf = (id: number): string | null => {
    let at = container.get(id) ?? parent.get(id);
    for (let i = 0; i < 10 && at !== undefined; i++) {
      if (storeyIds.has(at)) return gid(at);
      at = container.get(at) ?? parent.get(at);
    }
    return null;
  };

  // Types, property sets, hosts, groups, materials, ports.
  const typeOf = new Map<number, ReadEntity>();
  for (const r of all("IFCRELDEFINESBYTYPE")) {
    const t = file.entities.get(refs(r.args[5])[0] ?? -1);
    if (t) for (const o of refs(r.args[4])) typeOf.set(o, t);
  }
  const psetsOf = new Map<number, number[]>();
  for (const r of all("IFCRELDEFINESBYPROPERTIES")) for (const o of refs(r.args[4])) psetsOf.set(o, [...(psetsOf.get(o) ?? []), ...refs(r.args[5])]);
  const voidHost = new Map<number, number>();
  const openingsIn = new Map<number, number>();
  for (const r of all("IFCRELVOIDSELEMENT")) {
    const host = refs(r.args[4])[0] ?? -1;
    voidHost.set(refs(r.args[5])[0] ?? -1, host);
    openingsIn.set(host, (openingsIn.get(host) ?? 0) + 1);
  }
  const filledHost = new Map<number, number>();
  for (const r of all("IFCRELFILLSELEMENT")) {
    const opening = refs(r.args[4])[0] ?? -1;
    const hostId = voidHost.get(opening);
    if (hostId !== undefined) for (const el of refs(r.args[5])) filledHost.set(el, hostId);
  }
  const groupsOf = new Map<number, string[]>();
  const groupIds = new Set<number>();
  for (const r of all("IFCRELASSIGNSTOGROUP")) {
    const g = refs(r.args[6])[0];
    if (g === undefined) continue;
    const id = gid(g);
    if (!id) continue;
    groupIds.add(g);
    for (const o of refs(r.args[4])) groupsOf.set(o, [...(groupsOf.get(o) ?? []), id]);
  }
  const materialOf = new Map<number, string>();
  for (const r of all("IFCRELASSOCIATESMATERIAL")) {
    const name = materialName(file, refs(r.args[5])[0] ?? -1);
    if (name) for (const o of refs(r.args[4])) materialOf.set(o, name);
  }
  // A port is on its product by nesting (IFC4 on) or by the older port-to-element relation; a file may say both.
  const portsOf = new Map<number, number[]>();
  const portOn = (owner: number, port: number) => {
    const have = portsOf.get(owner);
    if (!have) portsOf.set(owner, [port]);
    else if (!have.includes(port)) have.push(port);
  };
  for (const r of all("IFCRELNESTS")) {
    const owner = refs(r.args[4])[0];
    if (owner === undefined) continue;
    for (const id of refs(r.args[5])) if (file.entities.get(id)?.type === "IFCDISTRIBUTIONPORT") portOn(owner, id);
  }
  for (const r of all("IFCRELCONNECTSPORTTOELEMENT")) {
    const port = refs(r.args[4])[0];
    const owner = refs(r.args[5])[0];
    if (port !== undefined && owner !== undefined && file.entities.get(port)?.type === "IFCDISTRIBUTIONPORT") portOn(owner, port);
  }
  const joined = new Map<number, number[]>();
  for (const r of all("IFCRELCONNECTSPORTS")) {
    const a = refs(r.args[4])[0];
    const b = refs(r.args[5])[0];
    if (a === undefined || b === undefined) continue;
    joined.set(a, [...(joined.get(a) ?? []), b]);
    joined.set(b, [...(joined.get(b) ?? []), a]);
  }

  const groups: ImportGroup[] = [...groupIds].flatMap((id) => {
    const g = file.entities.get(id);
    const sourceId = g ? globalIdOf(g) : null;
    if (!g || !sourceId) return [];
    return [{ sourceId, entity: schemaEntity(g.type), name: str(g.args[2]), predefinedType: enumOf(g.args[6]), objectType: str(g.args[4]) }];
  });

  const properties = (id: number, type: ReadEntity | undefined): Record<string, Record<string, ParamValue>> => {
    const out: Record<string, Record<string, ParamValue>> = {};
    const read = (psetIds: readonly number[]) => {
      for (const p of psetIds) {
        const set = file.entities.get(p);
        if (set?.type !== "IFCPROPERTYSET") continue;
        const name = str(set.args[2]);
        if (!name) continue;
        const into = (out[name] ??= {});
        for (const propId of refs(set.args[4])) {
          const prop = file.entities.get(propId);
          if (prop?.type !== "IFCPROPERTYSINGLEVALUE") continue;
          const key = str(prop.args[0]);
          const v = value(prop.args[2]);
          if (key && v !== null) into[key] = v;
        }
      }
    };
    if (type) read(refs(type.args[5]));
    read(psetsOf.get(id) ?? []);
    return out;
  };

  /** SI units per one of the project's unit of a kind (the file's unit assignment). Absent from it: the SI unit itself, as IFC reads a value with no unit. */
  const projectUnits = new Map<string, number>();
  const projectUnit = (type: string): number => {
    let factor = projectUnits.get(type);
    if (factor === undefined) {
      const project = all("IFCPROJECT")[0];
      const assignment = project ? file.entities.get(refs(project.args[8])[0] ?? -1) : undefined;
      const unit = refs(assignment?.args[0]).map((id) => file.entities.get(id)).find((u) => enumOf(u?.args[1]) === type);
      factor = siFactor(file, unit) ?? 1;
      projectUnits.set(type, factor);
    }
    return factor;
  };
  /**
   * What the standard port property sets say of a port: each number once, with the unit the property names (else
   * the project's). A plain value, or a bounded value's set point (else its two bounds when they agree). Many ports
   * may share one set.
   */
  const portSets = (pid: number): ReadEntity[] =>
    (psetsOf.get(pid) ?? []).flatMap((p) => {
      const set = file.entities.get(p);
      return set?.type === "IFCPROPERTYSET" && (str(set.args[2]) ?? "").startsWith(PORT_SETS) ? [set] : [];
    });
  /** What a port's standard property sets say it connects to, when they all say the same. Null: none says, or they disagree. */
  const portSetConnects = (pid: number): string | null => {
    const said = new Set(portSets(pid).flatMap((set) => PORT_SET_CONNECTS.find(([end]) => (str(set.args[2]) ?? "").endsWith(end))?.[1] ?? []));
    return said.size === 1 ? ([...said][0] ?? null) : null;
  };
  const portNumbers = (pid: number): ReadonlyMap<string, { readonly value: number; readonly unit: ReadEntity | undefined }> => {
    const out = new Map<string, { value: number; unit: ReadEntity | undefined }>();
    for (const set of portSets(pid)) {
      for (const propId of refs(set.args[4])) {
        const prop = file.entities.get(propId);
        const key = prop ? str(prop.args[0]) : null;
        if (!prop || !key || out.has(key)) continue;
        let v: ParamValue | null = null;
        let unit: StepToken | undefined;
        if (prop.type === "IFCPROPERTYSINGLEVALUE") {
          v = value(prop.args[2]);
          unit = prop.args[3];
        } else if (prop.type === "IFCPROPERTYBOUNDEDVALUE") {
          const upper = value(prop.args[2]);
          v = value(prop.args[5]) ?? (upper !== null && upper === value(prop.args[3]) ? upper : null);
          unit = prop.args[4];
        }
        if (typeof v === "number" && v > 0) out.set(key, { value: v, unit: file.entities.get(refs(unit)[0] ?? -1) });
      }
    }
    return out;
  };
  /** A port's opening, and the numbers it is rated at, from the standard port property sets. */
  const portFacts = (pid: number, domain: string | null): Pick<ImportPort, "size" | "rated"> => {
    const numbers = portNumbers(pid);
    const length = (key: string): number | undefined => {
      const n = PORT_LENGTHS.has(key) ? numbers.get(key) : undefined;
      return n ? n.value * (lengthUnitScale(file, n.unit) ?? scale) : undefined;
    };
    const inSI = (key: string, type: string): number | undefined => {
      const n = numbers.get(key);
      return n ? n.value * (siFactor(file, n.unit) ?? projectUnit(type)) : undefined;
    };
    const width = length("NominalWidth");
    const height = length("NominalHeight");
    const diameter = length("NominalDiameter") ?? length("OuterDiameter");
    let size: ImportPortSize | null = null;
    if (diameter !== undefined) size = { shape: "round", diameter };
    else if (width !== undefined && height !== undefined) size = { shape: "rect", width, height };
    // A width alone is a round opening's diameter, as the standard set words it.
    else if (width !== undefined) size = { shape: "round", diameter: width };
    // A connector counts its flow in its own unit (air or liquid); a millionth of it is noise from the conversion.
    const rated: Record<string, number> = {};
    const flowUnit = PORT_FLOW_UNIT[domain ?? ""];
    const flow = flowUnit ? inSI("VolumetricFlowRate", "VOLUMETRICFLOWRATEUNIT") : undefined;
    if (flowUnit && flow !== undefined) rated.flow = Math.round(fromSI(flow, flowUnit) * 1e6) / 1e6;
    const volts = inSI("Voltage", "ELECTRICVOLTAGEUNIT");
    if (volts !== undefined) rated.voltage = Math.round(volts * 1e6) / 1e6;
    return { size, ...(Object.keys(rated).length > 0 ? { rated } : {}) };
  };
  const readPort = (pid: number): ImportPort[] => {
    const port = file.entities.get(pid);
    const id = port ? globalIdOf(port) : null;
    if (!port || !id) return [];
    // Only a local placement says where a port is: with none, or on a grid or an alignment, it has no position here.
    const placed = geo.entity(port.args[5]);
    const frame = placed?.type === "IFCLOCALPLACEMENT" ? world(port.args[5]) : null;
    // Its placement's own z axis is the way it faces and its own x axis runs along its width, read only where the file writes them out.
    const own = frame ? geo.entity(placed?.args[1]) : null;
    const stated = (i: number): boolean => own?.type === "IFCAXIS2PLACEMENT3D" && geo.entity(own.args[i])?.type === "IFCDIRECTION";
    const systemType = enumOf(port.args[9]);
    // What it connects to is its own PredefinedType; a port with none (IFC2X3) may still say it by the standard set it carries.
    const domain = PORT_CONNECTS[enumOf(port.args[8]) ?? ""] ?? portSetConnects(pid);
    return [
      {
        id,
        name: str(port.args[2]),
        position: frame ? frame.o : null,
        flow: enumOf(port.args[7]),
        connectedTo: (joined.get(pid) ?? []).flatMap((j) => gid(j) ?? []),
        direction: frame && stated(1) ? frame.z : null,
        across: frame && stated(2) ? frame.x : null,
        domain,
        systemType: unset(systemType) ? null : systemType,
        ...portFacts(pid, domain),
      },
    ];
  };

  const products: ImportProduct[] = [];
  const unreadable: ImportSource["unreadable"][number][] = [];
  const shapeless = new Map<string, number>();
  let seen = 0;
  for (const e of file.entities.values()) {
    if (NOT_PRODUCTS.has(e.type) || groupIds.has(e.id)) continue;
    const sourceId = globalIdOf(e);
    if (!sourceId) continue;
    const placementRef = e.args[5];
    const placement = placementRef?.kind === "ref" ? file.entities.get(placementRef.id) : undefined;
    const placed = placement !== undefined && PLACEMENTS.has(placement.type);
    const entity = schemaEntity(e.type);
    // Without a placement, distinguish product occurrences from types, relationships and properties.
    if (!placed && entity !== "IfcSpace" && entity !== "IfcGrid" && (entity.endsWith("Type") || !isInstantiableEntity(entity))) continue;
    if (++seen % 2000 === 0 && opts.isCancelled?.()) throw new IfcReadCancelled();
    const spatial = e.type === "IFCSPACE";
    const type = typeOf.get(e.id);
    const predefinedIndex = spatial ? 9 : ownIndex(entity, "PredefinedType");
    // What a product is may be said once, on its type: its own PredefinedType wins, and the type's fills in when it is unset.
    const own = predefinedIndex !== null ? enumOf(e.args[predefinedIndex]) : null;
    const typed = unset(own) ? typePredefined(type) : null;
    const predefinedType = unset(typed) ? own : typed;
    // A user-defined kind named on the type is named in the type's ElementType.
    const objectType = str(e.args[4]) ?? (typed === "USERDEFINED" ? str(type?.args[TYPE_OWN_START - 1]) : null);
    const name = str(e.args[2]);
    const general = generalEntitiesOf(entity);
    if (!placed) {
      const label = name ? `${name} (${sourceId})` : sourceId;
      let reason = `${label} has no placement reference in the file`;
      if (placementRef?.kind === "ref") {
        reason = placement
          ? `${label} refers to #${placementRef.id}, which is not a placement`
          : `the placement of ${label} refers to #${placementRef.id}, which is missing from the file`;
      }
      unreadable.push({ entity, count: 1, reason, classHint: { predefinedType, objectType, ...(general.length > 0 ? { generalEntities: general } : {}) } });
      continue;
    }
    const frame = world(placementRef);
    const shape = geo.readShape(e.args[6], frame);
    if (shape.extrusions.length === 0 && shape.points.length === 0 && type) {
      // No shape of its own: its type's representation maps, placed at the product.
      for (const m of refs(type.args[6])) {
        const map = file.entities.get(m);
        if (map) geo.readRepresentation(map.args[1], compose(frame, geo.axis2(map.args[0])), shape);
      }
    }
    const local = placement.type === "IFCLOCALPLACEMENT";
    if (!local) shape.unread ??= "placed on a grid or alignment";
    const hasShape = shape.extrusions.length > 0 || shape.points.length > 0;
    if (!hasShape && e.args[6]?.kind !== "ref") {
      shapeless.set(entity, (shapeless.get(entity) ?? 0) + 1);
      continue;
    }
    const widthIndex = ownIndex(entity, "OverallWidth");
    const heightIndex = ownIndex(entity, "OverallHeight");
    const ports = (portsOf.get(e.id) ?? []).flatMap(readPort);
    const hostId = filledHost.get(e.id);
    const openings = openingsIn.get(e.id) ?? 0;
    products.push({
      sourceId,
      entity,
      ...(general.length > 0 ? { generalEntities: general } : {}),
      predefinedType,
      objectType,
      name,
      longName: spatial ? str(e.args[7]) : null,
      tag: spatial ? null : str(e.args[7]),
      storeyId: storeyOf(e.id),
      typeId: type ? globalIdOf(type) : null,
      typeName: type ? str(type.args[2]) : null,
      hostId: hostId !== undefined ? gid(hostId) : null,
      ...(openings > 0 ? { openings } : {}),
      groupIds: groupsOf.get(e.id) ?? [],
      geometry: { extrusions: shape.extrusions, bounds: boundsOf(shape.points), unread: shape.unread ?? (shape.holed ? OUTLINE_WITH_HOLES : null) },
      placement: local ? { origin: frame.o, xAxis: frame.x, zAxis: frame.z, bounds: boundsIn(frame, shape.points) } : null,
      properties: properties(e.id, type),
      overall: {
        width: widthIndex !== null ? numberOf(e.args[widthIndex], scale) : null,
        height: heightIndex !== null ? numberOf(e.args[heightIndex], scale) : null,
      },
      material: materialOf.get(e.id) ?? (type ? (materialOf.get(type.id) ?? null) : null),
      ports,
    });
  }
  for (const [entity, count] of shapeless) unreadable.push({ entity, count, reason: "it has no shape of its own (its parts may come in on their own)" });
  return { id: opts.sourceId, label: opts.label, disciplines: opts.disciplines, storeys, groups, products, unreadable };
}

function numberOf(t: StepToken | undefined, scale: number): number | null {
  const v = value(t);
  return typeof v === "number" && v > 0 ? v * scale : null;
}

function materialName(file: StepFile, id: number, depth = 0): string | null {
  const m = file.entities.get(id);
  if (!m || depth > 4) return null;
  switch (m.type) {
    case "IFCMATERIAL":
      return str(m.args[0]);
    case "IFCMATERIALLAYERSETUSAGE":
      return materialName(file, refs(m.args[0])[0] ?? -1, depth + 1);
    case "IFCMATERIALLAYERSET":
      return materialName(file, refs(m.args[0])[0] ?? -1, depth + 1);
    case "IFCMATERIALLAYER":
      return materialName(file, refs(m.args[0])[0] ?? -1, depth + 1);
    case "IFCMATERIALLIST":
      return materialName(file, refs(m.args[0])[0] ?? -1, depth + 1);
    case "IFCMATERIALCONSTITUENTSET":
      return materialName(file, refs(m.args[2])[0] ?? -1, depth + 1);
    case "IFCMATERIALCONSTITUENT":
      return materialName(file, refs(m.args[2])[0] ?? -1, depth + 1);
    default:
      return null;
  }
}
