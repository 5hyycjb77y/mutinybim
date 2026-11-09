import type { ImportGroup, ImportPort, ImportProduct, ImportSource, ImportStorey, ParamValue } from "@permitzip/bim-kernel";
import { readStep, type ReadEntity, type StepFile, type StepToken } from "../read";
import { ifcEntityName, ownAttributes } from "../schema-ifc4x3";
import { GeometryReader, apply, boundsOf, compose, hostFrame, type Frame } from "./geometry";

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
    const u = file.entities.get(id);
    if (!u) continue;
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
  }
  return 1000;
}

function siScale(u: ReadEntity): number {
  const prefix = enumOf(u.args[2]);
  const per: Readonly<Record<string, number>> = { MILLI: 1, CENTI: 10, DECI: 100, KILO: 1e6 };
  return prefix ? (per[prefix] ?? 1000) : 1000;
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
  for (const r of all("IFCRELVOIDSELEMENT")) voidHost.set(refs(r.args[5])[0] ?? -1, refs(r.args[4])[0] ?? -1);
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
  const portsOf = new Map<number, number[]>();
  for (const r of all("IFCRELNESTS")) {
    const owner = refs(r.args[4])[0];
    if (owner === undefined) continue;
    const ports = refs(r.args[5]).filter((id) => file.entities.get(id)?.type === "IFCDISTRIBUTIONPORT");
    if (ports.length > 0) portsOf.set(owner, [...(portsOf.get(owner) ?? []), ...ports]);
  }
  for (const r of all("IFCRELCONNECTSPORTTOELEMENT")) {
    const port = refs(r.args[4])[0];
    const owner = refs(r.args[5])[0];
    if (port !== undefined && owner !== undefined) portsOf.set(owner, [...(portsOf.get(owner) ?? []), port]);
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

  const products: ImportProduct[] = [];
  const unreadable = new Map<string, { entity: string; count: number; reason: string }>();
  let seen = 0;
  for (const e of file.entities.values()) {
    if (NOT_PRODUCTS.has(e.type) || groupIds.has(e.id)) continue;
    const placementRef = e.args[5];
    if (placementRef?.kind !== "ref" || !PLACEMENTS.has(file.entities.get(placementRef.id)?.type ?? "")) continue;
    const sourceId = globalIdOf(e);
    if (!sourceId) continue;
    if (++seen % 2000 === 0 && opts.isCancelled?.()) throw new IfcReadCancelled();
    const entity = schemaEntity(e.type);
    const frame = world(placementRef);
    const type = typeOf.get(e.id);
    const shape = geo.readShape(e.args[6], frame);
    if (shape.extrusions.length === 0 && shape.points.length === 0 && type) {
      // No shape of its own: its type's representation maps, placed at the product.
      for (const m of refs(type.args[6])) {
        const map = file.entities.get(m);
        if (map) geo.readRepresentation(map.args[1], compose(frame, geo.axis2(map.args[0])), shape);
      }
    }
    if (placementRef && file.entities.get(placementRef.id)?.type !== "IFCLOCALPLACEMENT") shape.unread ??= "placed on a grid or alignment";
    const hasShape = shape.extrusions.length > 0 || shape.points.length > 0;
    if (!hasShape && e.args[6]?.kind !== "ref") {
      const key = entity;
      const u = unreadable.get(key) ?? { entity, count: 0, reason: "it has no shape of its own (its parts may come in on their own)" };
      u.count += 1;
      unreadable.set(key, u);
      continue;
    }
    const spatial = e.type === "IFCSPACE";
    const predefinedIndex = spatial ? 9 : ownIndex(entity, "PredefinedType");
    const widthIndex = ownIndex(entity, "OverallWidth");
    const heightIndex = ownIndex(entity, "OverallHeight");
    const ports: ImportPort[] = (portsOf.get(e.id) ?? []).flatMap((pid) => {
      const port = file.entities.get(pid);
      const id = port ? globalIdOf(port) : null;
      if (!port || !id) return [];
      const at = port.args[5]?.kind === "ref" ? apply(world(port.args[5]), { x: 0, y: 0, z: 0 }) : null;
      return [{ id, name: str(port.args[2]), position: at, flow: enumOf(port.args[7]), connectedTo: (joined.get(pid) ?? []).flatMap((j) => gid(j) ?? []) }];
    });
    const hostId = filledHost.get(e.id);
    products.push({
      sourceId,
      entity,
      predefinedType: predefinedIndex !== null ? enumOf(e.args[predefinedIndex]) : null,
      objectType: str(e.args[4]),
      name: str(e.args[2]),
      longName: spatial ? str(e.args[7]) : null,
      tag: spatial ? null : str(e.args[7]),
      storeyId: storeyOf(e.id),
      typeId: type ? globalIdOf(type) : null,
      typeName: type ? str(type.args[2]) : null,
      hostId: hostId !== undefined ? gid(hostId) : null,
      groupIds: groupsOf.get(e.id) ?? [],
      geometry: { extrusions: shape.extrusions, bounds: boundsOf(shape.points), unread: shape.unread },
      properties: properties(e.id, type),
      overall: {
        width: widthIndex !== null ? numberOf(e.args[widthIndex], scale) : null,
        height: heightIndex !== null ? numberOf(e.args[heightIndex], scale) : null,
      },
      material: materialOf.get(e.id) ?? (type ? (materialOf.get(type.id) ?? null) : null),
      ports,
    });
  }
  return { id: opts.sourceId, label: opts.label, disciplines: opts.disciplines, storeys, groups, products, unreadable: [...unreadable.values()] };
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
