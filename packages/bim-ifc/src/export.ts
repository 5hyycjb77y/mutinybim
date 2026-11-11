import {
  BUILDING_FALLBACK_CLASS_ID,
  DERIVED_ZONE_RULE_POINT,
  ZONE_PURPOSE_POINT,
  activeClassRegistry,
  activeServiceRegistry,
  gridAxisFamily,
  hostLineOf,
  hostVoidsOf,
  ifcRelationRowsFor,
  spaceBoundaryFacts,
  withPackParameters,
  buildClassIndex,
  ifcOrganizationProperties,
  linkAdapterId,
  loadAnchorOf,
  localBounds,
  mountedPositions,
  organizationOf,
  parameterOfParamDef,
  partGeometryReady,
  partMesh,
  phaseStatusAt,
  placementOf,
  rawRegistryWords,
  resolveConnectors,
  resolveGeometry,
  siteMapConversion,
  siteOf,
  spaceAreaM2,
  spaceOutlines,
  trueNorthInPlan,
  typicalOfGroup,
  zoneBoundsOf,
  type BimElement,
  type GridLine,
  type Level,
  type LoadPointElement,
  type MepSystem,
  type ModelState,
  type PartInstance,
  type PartTypeElement,
  type PortRef,
  type Registry,
  type ServiceLink,
  type ServiceRegistry,
  type ServiceRow,
  type Space,
  type Zone,
} from "@permitzip/bim-kernel";
import { activePackSet } from "@permitzip/bim-kernel/packs";
import { elementTypeOf } from "@permitzip/bim-kernel/elements";
import { LEGACY_QUANTITY_KEYS, QUANTITY_BINDINGS } from "@permitzip/bim-units";
import { GeometryWriter, type Vec3 } from "./geometry";
import { derivedIfcGuid, isIfcGuid, isUuid, projectNamespace, relationshipIfcGuid, uuidToIfcGuid } from "./guid";
import { PROXY, resolveIfcClass, type ResolvedIfcClass } from "./mapping";
import { ParameterHomes, PropertyBag, baselineParameterHomes, registryParameterHomes, writeSets, type ParameterHome, type PropertyInput } from "./properties";
import { ownAttributes, predefinedTypes } from "./schema-ifc4x3";
import { $, bool, en, int, list, opt, real, str, serializeStep, StepGraph, type StepRef, type StepValue } from "./step";
import { UnitSet } from "./units";

/**
 * Kernel model → IFC 4.3 ADD2 (KERNEL-FOUNDATION §4.3).
 *
 * Everything trade-specific is read from registries: element entities from
 * the class registry, systems from the service registry, parameters from
 * the registry's fields and the baseline parameter sets, units from
 * bim-units. The exporter itself knows only kernel element kinds (where a
 * thing is, how big it is, what it hosts) and the IFC schema.
 *
 * Deterministic: elements are visited in id order, the file's time stamp is
 * the caller's, and every GlobalId is derived from stable ids, so the same
 * model and options give the same bytes.
 */

export const IFC_SCHEMA = "IFC4X3_ADD2";
export const BIM_IFC_VERSION = "0.1.0";

export interface IfcZoneHome {
  readonly entity: "IfcZone" | "IfcSpatialZone";
  /** IfcSpatialZoneTypeEnum member for spatial zones, or USERDEFINED. */
  readonly predefinedType?: string;
  readonly objectType?: string;
}

export interface IfcExportOptions {
  readonly model: ModelState;
  readonly project: { readonly id: string; readonly name: string; readonly number?: string; readonly description?: string };
  /** Classes and fields, layered with packs and the firm library. Absent: the kernel's classes plus the pack set in force. */
  readonly registry?: Registry;
  /** Absent: the built-in service rows plus the pack set in force. */
  readonly services?: ServiceRegistry;
  /** Extra parameter homes, before the registry's and the baseline sets'. */
  readonly parameterHomes?: readonly ParameterHome[];
  /** A zone purpose's IFC home when a pack or firm states one; absent or null: the built-in table, then USERDEFINED. */
  readonly zonePurposeIfc?: (purpose: string) => IfcZoneHome | null;
  /** ISO 8601. The writer never reads a clock. */
  readonly timeStamp: string;
  readonly fileName?: string;
  readonly author?: string;
  readonly organization?: string;
}

export interface IfcExportCounts {
  readonly storeys: number;
  /** Engineers' spaces and architects' rooms. */
  readonly spaces: number;
  readonly zones: number;
  readonly systems: number;
  readonly circuits: number;
  /** Building elements (not spaces, zones, systems or ports). */
  readonly elements: number;
  readonly planned: number;
  readonly ports: number;
  readonly types: number;
  readonly assemblies: number;
  readonly propertySets: number;
  readonly quantitySets: number;
}

export interface IfcExportReport {
  readonly schema: typeof IFC_SCHEMA;
  readonly counts: IfcExportCounts;
  /** Building elements by IFC entity. */
  readonly byEntity: Readonly<Record<string, number>>;
  /** Kernel records not written (drawings, views, definitions), by kind. */
  readonly skipped: Readonly<Record<string, number>>;
  /** Plain words: proxies and why, adjusted predefined types, duplicate imported ids. */
  readonly warnings: readonly string[];
  /** The GlobalId each exported model record got, by its id. */
  readonly globalIds: Readonly<Record<string, string>>;
}

export interface IfcExportResult {
  readonly text: string;
  readonly bytes: Uint8Array;
  readonly report: IfcExportReport;
}

/** Records that are drawings, definitions or settings, never IFC products. */
const NOT_EXPORTED_KINDS = new Set(["part_type", "element_type", "view", "sheet", "tag", "dimension", "viewport", "drawing_item", "drawing_underlay", "question", "service_catalog", "mounting_plane"]);
/** Records the exporter writes in their own way (spatial tree, groups, ports). */
const STRUCTURE_KINDS = new Set(["organization", "site", "level", "space", "room", "zone", "mep_system", "service_link", "load_point"]);

const ZONE_PURPOSE_SPATIAL: Readonly<Record<string, string>> = {
  thermal: "THERMAL",
  ventilation: "VENTILATION",
  fire_area: "FIRESAFETY",
  smoke: "FIRESAFETY",
  sprinkler_hazard: "FIRESAFETY",
  lighting_control: "LIGHTING",
  code_clearance: "RESERVATION",
};

const PHASE_STATUS: Readonly<Record<string, string>> = { new: "NEW", existing: "EXISTING", demolished: "DEMOLISH", temporary: "TEMPORARY" };
const PORT_DOMAIN: Readonly<Record<string, string>> = { duct: "DUCT", pipe: "PIPE", electrical: "CABLE", conduit: "CABLECARRIER" };
const FLOW_DIRECTION: Readonly<Record<string, string>> = { in: "SINK", out: "SOURCE", bidirectional: "SOURCEANDSINK" };

function push<V>(m: Map<string, V[]>, k: string, v: V): void {
  const items = m.get(k);
  if (items) items.push(v);
  else m.set(k, [v]);
}

function byId<T extends { readonly id: string }>(a: T, b: T): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function str255(s: string): StepValue {
  return s === "" ? $ : str(s.length > 255 ? s.slice(0, 255) : s);
}

function stringField(el: BimElement, key: string): string | null {
  const v: unknown = Reflect.get(el, key);
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function zoneHomeOf(v: unknown): IfcZoneHome | null {
  if (typeof v !== "object" || v === null) return null;
  const entity: unknown = Reflect.get(v, "entity");
  if (entity !== "IfcZone" && entity !== "IfcSpatialZone") return null;
  const pt: unknown = Reflect.get(v, "predefinedType");
  const ot: unknown = Reflect.get(v, "objectType");
  return { entity, ...(typeof pt === "string" ? { predefinedType: pt } : {}), ...(typeof ot === "string" ? { objectType: ot } : {}) };
}

function finite(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function numberField(el: BimElement, key: string): number | null {
  const v: unknown = Reflect.get(el, key);
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** The GlobalId an element was imported with (`provenance.ifcGlobalId`; levels: their storey's). */
function importedGlobalId(el: BimElement): string | null {
  const prov: unknown = Reflect.get(el, "provenance");
  const fromProv: unknown = typeof prov === "object" && prov !== null ? Reflect.get(prov, "ifcGlobalId") : undefined;
  if (isIfcGuid(fromProv)) return fromProv;
  if (el.kind === "level" && isIfcGuid(el.source?.storeyId)) return el.source.storeyId;
  return null;
}

class Guids {
  private readonly used = new Set<string>();
  readonly byRecord: Record<string, string> = {};
  constructor(
    readonly ns: string,
    private readonly warn: (s: string) => void,
  ) {}

  private claim(guid: string, what: string): string {
    if (this.used.has(guid)) throw new Error(`IFC export made the GlobalId ${guid} twice (${what})`);
    this.used.add(guid);
    return guid;
  }

  derived(name: string): string {
    return this.claim(derivedIfcGuid(this.ns, name), name);
  }

  rel(type: string, ends: readonly string[]): string {
    return this.claim(relationshipIfcGuid(this.ns, type, ends), `${type} ${ends.join(",")}`);
  }

  /** Imported id, else the UUID id compressed, else derived from the id. */
  record(el: BimElement): string {
    const imported = importedGlobalId(el);
    let guid: string;
    if (imported && !this.used.has(imported)) guid = this.claim(imported, el.id);
    else {
      if (imported) this.warn(`${el.id} was imported with GlobalId ${imported}, which another record already has; it gets a new one`);
      const compressed = isUuid(el.id) ? uuidToIfcGuid(el.id) : null;
      guid = compressed && !this.used.has(compressed) ? this.claim(compressed, el.id) : this.derived(`element:${el.id}`);
    }
    this.byRecord[el.id] = guid;
    return guid;
  }
}

interface Product {
  readonly ref: StepRef;
  readonly guid: string;
  /** Its own placement, for ports and children. Null when planned. */
  readonly placement: StepRef | null;
}

/** Export a model to IFC 4.3 ADD2 STEP text. Throws only on a writer defect; anything odd in the model is a warning in the report. */
export function exportIfc(opts: IfcExportOptions): IfcExportResult {
  const { model } = opts;
  const registry = opts.registry ?? activeClassRegistry();
  const services = opts.services ?? activeServiceRegistry();
  const derivedRules = new Map(activePackSet().items(DERIVED_ZONE_RULE_POINT).map((r) => [r.id, r]));
  // A zone purpose row may state its IFC home (`ifc`, read tolerantly: the purpose point's v1 shape has no such field yet).
  const purposeHomes = new Map<string, IfcZoneHome>();
  for (const p of activePackSet().items(ZONE_PURPOSE_POINT)) {
    const home = zoneHomeOf(Reflect.get(p, "ifc"));
    if (home) purposeHomes.set(p.id, home);
  }
  const homes = new ParameterHomes([...(opts.parameterHomes ?? []), ...registryParameterHomes(withPackParameters(registry)), ...baselineParameterHomes()]);
  const warnings: string[] = [];
  const missingProxyClasses = new Map<string, number>();
  const warn = (s: string) => warnings.push(s);
  const ns = projectNamespace(opts.project.id);
  const guids = new Guids(ns, warn);
  const g = new StepGraph();
  const units = new UnitSet();
  const index = buildClassIndex(registry, model);
  const org = organizationOf(model);
  const lastPhase = Math.max(0, org.phases.length - 1);

  const elements: BimElement[] = Object.values(model.elements).sort(byId);
  const els = model.elements;
  const skipped: Record<string, number> = {};
  const byEntity: Record<string, number> = {};
  const counts = { storeys: 0, spaces: 0, zones: 0, systems: 0, circuits: 0, elements: 0, planned: 0, ports: 0, types: 0, assemblies: 0, propertySets: 0, quantitySets: 0 };

  // ---------------------------------------------------------------- project, contexts, site
  const projectHandle = g.reserve();
  const projectGuid = isUuid(opts.project.id) ? uuidToIfcGuid(opts.project.id) : guids.derived("project");
  const world = g.add("IFCAXIS2PLACEMENT3D", [g.add("IFCCARTESIANPOINT", [list([real(0), real(0), real(0)])]), $, $]);
  const site = siteOf(model);
  const north = trueNorthInPlan(site);
  const context = g.add("IFCGEOMETRICREPRESENTATIONCONTEXT", [$, str("Model"), { int: 3 }, real(1e-5), world, g.add("IFCDIRECTION", [list([real(north.x), real(north.y)])])]);
  const bodyContext = g.add("IFCGEOMETRICREPRESENTATIONSUBCONTEXT", [str("Body"), str("Model"), { derived: true }, { derived: true }, { derived: true }, { derived: true }, context, $, en("MODEL_VIEW"), $]);
  const geo = new GeometryWriter(g, bodyContext);
  if (els["site"]?.kind === "site") {
    const mc = siteMapConversion(site);
    const metre = g.add("IFCSIUNIT", [{ derived: true }, en("LENGTHUNIT"), $, en("METRE")]);
    const crs = g.add("IFCPROJECTEDCRS", [str("MutinyBIM shared site"), str("The project's shared coordinates (survey point and true north as set in MutinyBIM)"), $, $, $, $, metre]);
    // Eastings and northings are in the CRS unit (metres); Scale takes the file's millimetres to metres.
    g.add("IFCMAPCONVERSION", [context, crs, real(mc.eastings), real(mc.northings), real(mc.orthogonalHeight), real(mc.xAxisAbscissa), real(mc.xAxisOrdinate), real(0.001)]);
  }

  const siteGuid = els["site"] ? guids.record(els["site"]) : guids.derived("site");
  const sitePlacement = geo.placement(null, geo.axis({ x: 0, y: 0, z: 0 }));
  const siteRef = g.add("IFCSITE", [str(siteGuid), $, str("Site"), $, $, sitePlacement, $, $, en("ELEMENT"), $, $, $, $, $]);
  const buildingGuid = guids.derived("building");
  const buildingPlacement = geo.placement(sitePlacement, geo.axis({ x: 0, y: 0, z: 0 }));
  const buildingName = [opts.project.number, opts.project.name].filter((s): s is string => !!s && s.trim() !== "").join(" ") || "Building";
  const buildingRef = g.add("IFCBUILDING", [str(buildingGuid), $, str255(buildingName), $, $, buildingPlacement, $, $, en("ELEMENT"), $, $, $]);
  const aggregate = (relating: StepRef, relatingGuid: string, related: readonly StepRef[]) => {
    if (related.length === 0) return;
    g.add("IFCRELAGGREGATES", [str(guids.rel("IfcRelAggregates", [relatingGuid])), $, $, $, relating, list(related)]);
  };
  aggregate(projectHandle, projectGuid, [siteRef]);
  aggregate(siteRef, siteGuid, [buildingRef]);

  // ---------------------------------------------------------------- storeys
  const levels = elements.filter((e): e is Level => e.kind === "level").sort((a, b) => a.elevationMm - b.elevationMm || byId(a, b));
  const storeys = new Map<string, { readonly ref: StepRef; readonly guid: string; readonly placement: StepRef }>();
  const levelByName = new Map<string, string>();
  for (const lv of levels) {
    const guid = guids.record(lv);
    const placement = geo.placement(buildingPlacement, geo.axis({ x: 0, y: 0, z: lv.elevationMm }));
    const ref = g.add("IFCBUILDINGSTOREY", [str(guid), $, str255(lv.name), $, $, placement, $, $, en("ELEMENT"), real(lv.elevationMm)]);
    storeys.set(lv.id, { ref, guid, placement });
    if (!levelByName.has(lv.name)) levelByName.set(lv.name, lv.id);
    counts.storeys++;
  }
  aggregate(buildingRef, buildingGuid, levels.map((l) => storeys.get(l.id)?.ref).filter((r): r is StepRef => !!r));

  const levelOf = (el: BimElement): string | null => {
    if (el.kind === "part" && el.planned) return el.planned.levelHint && storeys.has(el.planned.levelHint) ? el.planned.levelHint : null;
    const direct = stringField(el, "levelId");
    if (direct && storeys.has(direct)) return direct;
    const named = el.partition?.level;
    if (named) return storeys.has(named) ? named : (levelByName.get(named) ?? null);
    return null;
  };
  const frameOf = (levelId: string | null): StepRef => (levelId ? (storeys.get(levelId)?.placement ?? buildingPlacement) : buildingPlacement);

  // Properties attach after the object exists; collected here and written per object.
  const attachSets = (objectRef: StepRef, objectGuid: string, key: string, bag: PropertyBag) => {
    if (bag.empty) return [];
    const written = writeSets(g, units, bag, (name) => guids.derived(`set:${key}:${name}`));
    for (const w of written) {
      const setGuid = derivedIfcGuid(ns, `set:${key}:${w.name}`);
      g.add("IFCRELDEFINESBYPROPERTIES", [str(guids.rel("IfcRelDefinesByProperties", [objectGuid, setGuid])), $, $, $, list([objectRef]), w.ref]);
    }
    counts.propertySets += bag.psets.size;
    counts.quantitySets += bag.qtos.size;
    return written;
  };
  const organizationSets = (bag: PropertyBag, el: BimElement) => {
    const props = ifcOrganizationProperties(model, el);
    if (!props) return;
    for (const [name, value] of Object.entries(props.propertySet.properties)) bag.set(props.propertySet.name, { kind: "text", name, value });
    const status = phaseStatusAt(org, el, lastPhase);
    const word = PHASE_STATUS[status];
    if (word) bag.set(props.propertySet.name, { kind: "text", name: "Status", value: word });
  };

  // ---------------------------------------------------------------- spaces and rooms
  const spaceRefs = new Map<string, { readonly ref: StepRef; readonly guid: string; readonly levelId: string | null }>();
  const storeyChildren = new Map<string | null, StepRef[]>();
  const pushChild = (levelId: string | null, ref: StepRef) => {
    const list0 = storeyChildren.get(levelId) ?? [];
    list0.push(ref);
    storeyChildren.set(levelId, list0);
  };
  const roomsInSpaces = new Map<string, string>();
  const spaces = elements.filter((e): e is Space => e.kind === "space");
  for (const sp of spaces) if (sp.bounds.kind === "rooms") for (const r of sp.bounds.roomIds) if (!roomsInSpaces.has(r)) roomsInSpaces.set(r, sp.id);
  for (const room of elements) {
    if (room.kind !== "room") continue;
    const guid = guids.record(room);
    const levelId = levelOf(room);
    const placement = geo.placement(frameOf(levelId), geo.axis({ x: 0, y: 0, z: 0 }));
    const cls = resolveIfcClass(registry, index, room);
    const pt = cls.entity === "IfcSpace" && cls.predefinedType && predefinedTypes("IfcSpace").has(cls.predefinedType) ? cls.predefinedType : "INTERNAL";
    const ref = g.add("IFCSPACE", [str(guid), $, str255(room.number), $, $, placement, $, str255(room.name), en("ELEMENT"), en(pt), $]);
    spaceRefs.set(room.id, { ref, guid, levelId });
    counts.spaces++;
    const bag = new PropertyBag();
    bag.set("Pset_SpaceCommon", { kind: "text", name: "Reference", value: room.number });
    const area = Number.isFinite(room.areaSqM) && room.areaSqM > 0 ? room.areaSqM : null;
    if (area !== null) bag.quantity("Qto_SpaceBaseQuantities", { kind: "number", name: "NetFloorArea", value: area, unit: "m2" });
    bag.set("MutinyBIM_Space", { kind: "text", name: "Source", value: "Architect's room" });
    attachSets(ref, guid, room.id, bag);
    if (!roomsInSpaces.has(room.id)) pushChild(levelId, ref);
  }
  for (const sp of spaces) {
    const guid = guids.record(sp);
    const levelId = sp.levelId && storeys.has(sp.levelId) ? sp.levelId : null;
    const placement = geo.placement(frameOf(levelId), geo.axis({ x: 0, y: 0, z: 0 }));
    const outlines = spaceOutlines(els, sp);
    const height = sp.ceilingHeightMm ?? null;
    const body = outlines.length === 1 && outlines[0] && height ? geo.prism(outlines[0], 0, height) : null;
    const ref = g.add("IFCSPACE", [str(guid), $, str255(sp.number), $, $, placement, body ?? $, str255(sp.name), en("ELEMENT"), en("SPACE"), $]);
    spaceRefs.set(sp.id, { ref, guid, levelId });
    counts.spaces++;
    pushChild(levelId, ref);
    const rooms = sp.bounds.kind === "rooms" ? sp.bounds.roomIds.filter((r) => roomsInSpaces.get(r) === sp.id).map((r) => spaceRefs.get(r)?.ref).filter((r): r is StepRef => !!r) : [];
    aggregate(ref, guid, rooms);
    const bag = new PropertyBag();
    bag.set("Pset_SpaceCommon", { kind: "text", name: "Reference", value: sp.number });
    const area = spaceAreaM2(els, sp);
    if (area !== null) bag.quantity("Qto_SpaceBaseQuantities", { kind: "number", name: "NetFloorArea", value: area, unit: "m2" });
    if (height) bag.quantity("Qto_SpaceBaseQuantities", { kind: "number", name: "Height", value: height, unit: "mm" });
    if (sp.occupants !== undefined) bag.set("Pset_SpaceOccupancyRequirements", { kind: "number", name: "OccupancyNumber", value: sp.occupants, unit: "ea" });
    if (sp.use?.name) bag.set("Pset_SpaceOccupancyRequirements", { kind: "text", name: "OccupancyType", value: sp.use.name });
    if (sp.use) bag.set("MutinyBIM_Space", { kind: "text", name: "Use", value: `${sp.use.libraryId}/${sp.use.useId}` });
    bag.set("MutinyBIM_Space", { kind: "text", name: "Origin", value: sp.origin.kind });
    if (sp.block !== undefined) bag.set("MutinyBIM_Space", { kind: "bool", name: "BlockLoad", value: sp.block });
    attachSets(ref, guid, sp.id, bag);
  }

  // ---------------------------------------------------------------- building elements
  const products = new Map<string, Product>();
  const contained = new Map<string, { readonly structure: StepRef; readonly structureGuid: string; readonly items: StepRef[] }>();
  const contain = (structureKey: string, structure: StepRef, structureGuid: string, item: StepRef) => {
    const c = contained.get(structureKey) ?? { structure, structureGuid, items: [] };
    c.items.push(item);
    contained.set(structureKey, c);
  };
  const containIn = (levelId: string | null, spaceId: string | null, item: StepRef) => {
    const space = spaceId ? spaceRefs.get(spaceId) : undefined;
    if (space) return contain(`space:${spaceId}`, space.ref, space.guid, item);
    const storey = levelId ? storeys.get(levelId) : undefined;
    if (storey) return contain(`storey:${levelId}`, storey.ref, storey.guid, item);
    contain("building", buildingRef, buildingGuid, item);
  };

  const typeObjects = new Map<string, { readonly ref: StepRef; readonly guid: string; readonly members: StepRef[] }>();
  const typicalMembers = new Map<string, { readonly levelId: string | null; readonly items: StepRef[] }>();
  const groupMembers = new Map<string, StepRef[]>();

  const writeType = (key: string, entity: string, predefined: string | null, name: string, elementType: string | null, bag: PropertyBag | null): { ref: StepRef; guid: string; members: StepRef[] } => {
    const existing = typeObjects.get(key);
    if (existing) return existing;
    const guid = guids.derived(`type:${key}`);
    const sets = bag && !bag.empty ? writeSets(g, units, bag, (n) => guids.derived(`set:type:${key}:${n}`)) : [];
    if (bag) {
      counts.propertySets += bag.psets.size;
      counts.quantitySets += bag.qtos.size;
    }
    const members = predefinedTypes(entity);
    const tail = ownAttributes(entity).map((a): StepValue => {
      if (a === "PredefinedType") return en(predefined && members.has(predefined) ? predefined : "NOTDEFINED");
      if (a === "OperationType" || a === "PartitioningType") return en("NOTDEFINED");
      return $;
    });
    const ref = g.add(entity.toUpperCase(), [str(guid), $, str255(name), $, $, sets.length > 0 ? list(sets.map((s) => s.ref)) : $, $, $, elementType ? str255(elementType) : $, ...tail]);
    const entry = { ref, guid, members: [] as StepRef[] };
    typeObjects.set(key, entry);
    counts.types++;
    return entry;
  };

  const writeElement = (el: BimElement, cls: ResolvedIfcClass, name: string | null, tag: string | null, placement: StepRef | null, body: StepRef | null, extra: Readonly<Record<string, number>> = {}): Product => {
    const guid = guids.record(el);
    const tail = ownAttributes(cls.entity).map((a): StepValue => {
      if (a === "PredefinedType") return cls.predefinedType ? en(cls.predefinedType) : $;
      const v = extra[a];
      return v !== undefined && v > 0 ? real(v) : $;
    });
    const ref = g.add(cls.entity.toUpperCase(), [str(guid), $, opt(name), $, opt(cls.objectType), placement ?? $, body ?? $, opt(tag), ...tail]);
    byEntity[cls.entity] = (byEntity[cls.entity] ?? 0) + 1;
    counts.elements++;
    if (cls.entity === PROXY && cls.classId === BUILDING_FALLBACK_CLASS_ID && "classId" in el && el.classId && !registry.getClass(el.classId)) {
      missingProxyClasses.set(el.classId, (missingProxyClasses.get(el.classId) ?? 0) + 1);
    }
    if (cls.note && cls.entity === PROXY) warn(`${el.id}: written as ${PROXY} (${cls.note})`);
    else if (cls.note) warn(`${el.id}: ${cls.note}`);
    const p = { ref, guid, placement };
    products.set(el.id, p);
    return p;
  };

  const grids: GridLine[] = [];

  const partTypeOf = (part: PartInstance): PartTypeElement | null => {
    const t = els[part.typeId];
    return t?.kind === "part_type" ? t : null;
  };

  const partValues = (bag: PropertyBag, def: PartTypeElement["definition"], values: Readonly<Record<string, number | string | boolean>>, scope: "instance" | "type") => {
    const params = scope === "type" ? def.typeParams : def.instanceParams;
    for (const p of [...params].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const v = values[p.name];
      if (v === undefined) continue;
      const q = parameterOfParamDef(p, scope);
      const home = homes.find([q.key, `param.${p.name}`]);
      const input: PropertyInput =
        typeof v === "number" ? (q.valueType === "quantity" ? { kind: "number", name: p.label, value: v, ...(q.storedUnit ? { unit: q.storedUnit } : {}) } : { kind: "number", name: p.label, value: v }) : typeof v === "boolean" ? { kind: "bool", name: p.label, value: v } : { kind: "text", name: p.label, value: v };
      bag.put(home, input);
    }
  };

  for (const el of elements) {
    if (NOT_EXPORTED_KINDS.has(el.kind)) {
      skipped[el.kind] = (skipped[el.kind] ?? 0) + 1;
      continue;
    }
    if (STRUCTURE_KINDS.has(el.kind)) continue;
    if (el.kind === "grid") {
      grids.push(el);
      continue;
    }
    const resolved = resolveIfcClass(registry, index, el);
    // A separation line bounds rooms and is never built.
    const cls: ResolvedIfcClass = el.kind === "space_separator" ? { ...resolved, entity: "IfcVirtualElement", predefinedType: "BOUNDARY", note: null } : resolved;
    const levelId = levelOf(el);
    const frame = frameOf(levelId);
    const bag = new PropertyBag();
    let product: Product;
    let spaceHint: string | null = null;
    let planned = false;

    if (el.kind === "part") {
      const type = partTypeOf(el);
      const where = placementOf(el);
      const mark = el.mark.trim() || null;
      const name = mark ?? type?.definition.typeName ?? null;
      if (where.state === "planned") {
        planned = true;
        spaceHint = where.spaceHint && spaceRefs.has(where.spaceHint) ? where.spaceHint : null;
        product = writeElement(el, cls, name, mark, null, null);
        bag.set("MutinyBIM_Placement", { kind: "text", name: "State", value: "PLANNED" });
        if (where.note) bag.set("MutinyBIM_Placement", { kind: "text", name: "Note", value: where.note });
        counts.planned++;
      } else {
        const placement = geo.placement(frame, geo.turned({ x: where.position.x, y: where.position.y, z: where.offsetMm }, where.rotationDeg));
        let body: StepRef | null = null;
        if (type) {
          try {
            if (type.definition.model && partGeometryReady()) {
              // The same solid the screen, sheets and clash read; its feature boxes are for picking only.
              const local = partMesh(type.definition, el.values, "fine");
              body = geo.mesh(mountedPositions(local.positions, el.mount), local.indices, true);
            } else {
              if (type.definition.model) warn(`${el.id}: the geometry engine isn't loaded, so its modeled body is written as its box`);
              const box = localBounds(resolveGeometry(type.definition, el.values));
              body = geo.box({ x: box.min[0], y: box.min[1], z: box.min[2] }, { x: box.max[0], y: box.max[1], z: box.max[2] });
            }
          } catch (err) {
            console.error("[bim-ifc] part geometry did not resolve; exported without a body", { partId: el.id, err });
            warn(`${el.id}: its part geometry did not resolve, so it has no body in the file`);
          }
        }
        product = writeElement(el, cls, name, mark, placement, body);
        bag.set("MutinyBIM_Placement", { kind: "text", name: "State", value: "PLACED" });
      }
      if (type) {
        const t = writeType(`${type.id}|${cls.entity}`, cls.typeEntity ?? "IfcBuildingElementProxyType", cls.predefinedType, type.definition.typeName, type.definition.familyName, (() => {
          const tb = new PropertyBag();
          partValues(tb, type.definition, type.definition.typeValues, "type");
          return tb;
        })());
        t.members.push(product.ref);
        partValues(bag, type.definition, el.values, "instance");
      } else warn(`${el.id}: its part type ${el.typeId} is not in the model`);
    } else if (el.kind === "wall") {
      const dx = el.end.x - el.start.x;
      const dy = el.end.y - el.start.y;
      const placement = geo.placement(frame, geo.turned({ x: el.start.x, y: el.start.y, z: 0 }, (Math.atan2(dy, dx) * 180) / Math.PI));
      product = writeElement(el, cls, el.wallType || null, null, placement, geo.strip(Math.hypot(dx, dy), el.thickness, el.height));
      if (cls.typeEntity && el.wallType && !elementTypeOf(els, el)) writeType(`wall:${el.wallType}|${cls.entity}`, cls.typeEntity, cls.predefinedType, el.wallType, null, null).members.push(product.ref);
    } else if (el.kind === "slab") {
      const placement = geo.placement(frame, geo.axis({ x: 0, y: 0, z: 0 }));
      product = writeElement(el, cls, null, null, placement, geo.prism(el.outline, -el.thickness, el.thickness));
    } else if (el.kind === "opening") {
      // Turned with its host and boxed through it, from its sill to its head, so a reader sees the door's own shape.
      const hostEl = els[el.hostId];
      const line = hostEl ? hostLineOf(hostEl, els) : null;
      const v = hostVoidsOf(els, el.hostId).find((x) => x.elementId === el.id);
      const sill = v ? Math.min(...v.profile.map((q) => q.y)) : 0;
      const angle = line ? (Math.atan2(line.end.y - line.start.y, line.end.x - line.start.x) * 180) / Math.PI : 0;
      const depth = line?.widthMm ?? 0;
      const placement = geo.placement(frame, geo.turned({ x: el.position.x, y: el.position.y, z: sill }, angle));
      const body = el.width > 0 && el.height > 0 && depth > 0 ? geo.box({ x: -el.width / 2, y: -depth / 2, z: 0 }, { x: el.width / 2, y: depth / 2, z: el.height }) : null;
      product = writeElement(el, cls, el.mark.trim() || null, el.mark.trim() || null, placement, body, { OverallWidth: el.width, OverallHeight: el.height });
    } else if (el.kind === "run_segment") {
      const placement = geo.placement(frame, geo.axis({ x: 0, y: 0, z: 0 }));
      const s = el.size;
      const section = s.shape === "rect" || s.shape === "oval" ? { width: s.width, height: s.height } : s.shape === "round" ? { diameter: s.diameter } : s.shape === "pipe" ? { diameter: s.nominalMm } : { diameter: s.tradeSizeMm };
      product = writeElement(el, cls, null, null, placement, geo.sweep(el.start, el.end, section));
    } else {
      // Every other kind: placed at its stated point, with a body only where the kernel states a box.
      const pos: unknown = Reflect.get(el, "position");
      const p = typeof pos === "object" && pos !== null ? { x: finite(Reflect.get(pos, "x")), y: finite(Reflect.get(pos, "y")), z: finite(Reflect.get(pos, "z")) } : null;
      const rotation = numberField(el, "rotationDeg") ?? 0;
      const placement = p ? geo.placement(frame, geo.turned(p, rotation)) : null;
      const name = stringField(el, "mark") ?? stringField(el, "label") ?? stringField(el, "typeName") ?? stringField(el, "sectionName");
      product = writeElement(el, cls, name, stringField(el, "mark"), placement, null);
    }

    const elementType = el.kind === "part" ? null : elementTypeOf(els, el);
    if (elementType) {
      const tb = new PropertyBag();
      for (const [key, v] of Object.entries(elementType.values ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        const input: PropertyInput = typeof v === "number" ? { kind: "number", name: key, value: v } : typeof v === "boolean" ? { kind: "bool", name: key, value: v } : { kind: "text", name: key, value: String(v) };
        tb.put(homes.find([key]), input, "MutinyBIM_Type");
      }
      writeType(`etype:${elementType.id}|${cls.entity}`, cls.typeEntity ?? "IfcBuildingElementProxyType", cls.predefinedType, elementType.name, null, tb).members.push(product.ref);
    }
    organizationSets(bag, el);
    attachSets(product.ref, product.guid, el.id, bag);
    const typical = typicalOfGroup(els, el.groupId);
    if (typical) {
      const t = typicalMembers.get(typical.groupId) ?? { levelId, items: [] };
      t.items.push(product.ref);
      typicalMembers.set(typical.groupId, t);
    } else containIn(levelId, planned ? spaceHint : null, product.ref);
    const groupName = ifcOrganizationProperties(model, el)?.group.name;
    if (groupName) push(groupMembers, groupName, product.ref);
  }

  for (const [, t] of [...typeObjects].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (t.members.length === 0) continue;
    g.add("IFCRELDEFINESBYTYPE", [str(guids.rel("IfcRelDefinesByType", [t.guid])), $, $, $, list(t.members), t.ref]);
  }

  // ---------------------------------------------------------------- relationships (`kernel.ifc_relation`)
  // Openings between hosts and their doors, a roof's slab part, a stair's flight: synthetic objects and the relationships the rows ask for.
  const synthetic = new Map<string, { readonly ref: StepRef; readonly guid: string }>();
  const endOf = (key: string): { readonly ref: StepRef; readonly guid: string } | null => products.get(key) ?? synthetic.get(key) ?? null;
  const relationRef = (entity: string, a: { readonly guid: string }, b: { readonly guid: string }): StepValue => str(guids.rel(entity, [a.guid, b.guid]));
  for (const el of elements) {
    const rows = ifcRelationRowsFor(el.kind);
    if (rows.length === 0) continue;
    const owner = products.get(el.id);
    for (const row of rows) {
      let out: ReturnType<typeof row.relations>;
      try {
        out = row.relations(el, els);
      } catch (err) {
        console.error("[bim-ifc] an IFC relation row failed; its relationships are left out", { row: row.id, elementId: el.id, err });
        warn(`${el.id}: the ${row.label} relationships couldn't be written`);
        continue;
      }
      for (const o of out.objects) {
        if (synthetic.has(o.key)) continue;
        const guid = guids.derived(`synthetic:${o.key}`);
        const members = predefinedTypes(o.entity);
        const tail = ownAttributes(o.entity).map((a): StepValue => {
          if (a === "PredefinedType") return o.predefinedType && members.has(o.predefinedType) ? en(o.predefinedType) : $;
          const v = o.attributes?.[a];
          if (v === undefined || !Number.isFinite(v)) return $;
          return a.startsWith("NumberOf") ? int(Math.round(v)) : real(v);
        });
        const placement = owner?.placement ? geo.placement(owner.placement, geo.axis({ x: 0, y: 0, z: 0 })) : null;
        const ref = g.add(o.entity.toUpperCase(), [str(guid), $, opt(o.name), $, $, placement ?? $, $, $, ...tail]);
        synthetic.set(o.key, { ref, guid });
        byEntity[o.entity] = (byEntity[o.entity] ?? 0) + 1;
      }
      for (const r of out.relations) {
        const relating = endOf(r.relating);
        const related = r.related.map(endOf).filter((x): x is { readonly ref: StepRef; readonly guid: string } => x !== null);
        if (!relating || related.length === 0) {
          warn(`${el.id}: a ${r.entity} names something not in the file`);
          continue;
        }
        if (r.entity === "IfcRelVoidsElement" || r.entity === "IfcRelFillsElement") {
          for (const x of related) g.add(r.entity.toUpperCase(), [relationRef(r.entity, relating, x), $, $, $, relating.ref, x.ref]);
        } else if (r.entity === "IfcRelAggregates") {
          aggregate(relating.ref, relating.guid, related.map((x) => x.ref));
        } else if (r.entity === "IfcRelSpaceBoundary") {
          for (const x of related) g.add("IFCRELSPACEBOUNDARY", [relationRef(r.entity, relating, x), $, $, $, relating.ref, x.ref, $, en(r.physicalOrVirtual ?? "NOTDEFINED"), en(r.internalOrExternal ?? "NOTDEFINED")]);
        } else warn(`${el.id}: ${r.entity} from a relation row isn't written by this exporter`);
        byEntity[r.entity] = (byEntity[r.entity] ?? 0) + 1;
      }
    }
  }

  // ---------------------------------------------------------------- space boundaries (2nd level, from each bounded space's facts)
  for (const sp of spaces) {
    if (sp.bounds.kind !== "bounded") continue;
    const space = spaceRefs.get(sp.id);
    const facts = spaceBoundaryFacts(model, sp.id);
    if (!space || !Array.isArray(facts)) continue;
    for (const f of facts) {
      const element = products.get(f.elementId);
      if (!element) continue;
      const side = f.otherSide.kind === "space" ? "INTERNAL" : f.otherSide.kind === "outside" ? "EXTERNAL" : "NOTDEFINED";
      g.add("IFCRELSPACEBOUNDARY", [str(guids.rel("IfcRelSpaceBoundary", [space.guid, element.guid])), $, $, $, space.ref, element.ref, $, en(f.virtual ? "VIRTUAL" : "PHYSICAL"), en(side)]);
      byEntity.IfcRelSpaceBoundary = (byEntity.IfcRelSpaceBoundary ?? 0) + 1;
    }
  }

  // ---------------------------------------------------------------- grids: one IfcGrid, U and V axes with their tags
  if (grids.length > 0) {
    const point = (p: { readonly x: number; readonly y: number }): StepRef => g.add("IFCCARTESIANPOINT", [list([real(p.x), real(p.y)])]);
    const axis = (gl: GridLine): StepRef => g.add("IFCGRIDAXIS", [str255(gl.label.trim() || gl.id), g.add("IFCPOLYLINE", [list([point(gl.start), point(gl.end)])]), bool(true)]);
    const u = grids.filter((gl) => gridAxisFamily(gl.start, gl.end) === "U").map(axis);
    const v = grids.filter((gl) => gridAxisFamily(gl.start, gl.end) === "V").map(axis);
    const lowest = levels[0]?.id ?? null;
    const guid = guids.derived("grid");
    const ref = g.add("IFCGRID", [str(guid), $, str("Grid"), $, $, geo.placement(frameOf(lowest), geo.axis({ x: 0, y: 0, z: 0 })), $, list(u), list(v), $, en("RECTANGULAR")]);
    byEntity.IfcGrid = (byEntity.IfcGrid ?? 0) + 1;
    byEntity.IfcGridAxis = (byEntity.IfcGridAxis ?? 0) + u.length + v.length;
    containIn(lowest, null, ref);
  }

  // ---------------------------------------------------------------- typicals as assemblies
  for (const [groupId, t] of [...typicalMembers].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const ref = typicalOfGroup(els, groupId);
    if (!ref) continue;
    const { spec } = ref;
    const frame = frameOf(t.levelId);
    const typeGuid = guids.derived(`typical-type:${groupId}`);
    const assemblyType = g.add("IFCELEMENTASSEMBLYTYPE", [str(typeGuid), $, str255(spec.label), $, $, $, $, $, $, en("NOTDEFINED")]);
    counts.types++;
    const instances: StepRef[] = [];
    const originalGuid = guids.derived(`typical:${groupId}`);
    const original = g.add("IFCELEMENTASSEMBLY", [str(originalGuid), $, str255(`${spec.label} ${spec.mark}`), $, str255(spec.label), geo.placement(frame, geo.axis({ x: 0, y: 0, z: 0 })), $, str255(spec.mark), $, $]);
    aggregate(original, originalGuid, t.items);
    instances.push(original);
    const bagOf = (mark: string, copyOf: string | null) => {
      const bag = new PropertyBag();
      bag.set("MutinyBIM_Typical", { kind: "text", name: "Mark", value: mark });
      bag.set("MutinyBIM_Typical", { kind: "text", name: "Typical", value: spec.label });
      if (copyOf) bag.set("MutinyBIM_Typical", { kind: "text", name: "CopyOf", value: copyOf });
      return bag;
    };
    attachSets(original, originalGuid, `typical:${groupId}`, bagOf(spec.mark, null));
    for (const copy of [...spec.copies].sort(byId)) {
      const a = (copy.rotationDeg * Math.PI) / 180;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const b = spec.basePoint;
      const origin = { x: b.x + copy.offset.x - (c * b.x - s * b.y), y: b.y + copy.offset.y - (s * b.x + c * b.y), z: 0 };
      const guid = guids.derived(`typical:${groupId}:copy:${copy.id}`);
      const inst = g.add("IFCELEMENTASSEMBLY", [str(guid), $, str255(`${spec.label} ${copy.mark}`), $, str255(spec.label), geo.placement(frame, geo.turned(origin, copy.rotationDeg)), $, str255(copy.mark), $, $]);
      attachSets(inst, guid, `typical:${groupId}:copy:${copy.id}`, bagOf(copy.mark, spec.mark));
      instances.push(inst);
    }
    for (const inst of instances) containIn(t.levelId, null, inst);
    g.add("IFCRELDEFINESBYTYPE", [str(guids.rel("IfcRelDefinesByType", [typeGuid])), $, $, $, list(instances), assemblyType]);
    counts.assemblies += instances.length;
  }

  // ---------------------------------------------------------------- ports and connections
  const ports = new Map<string, { readonly ref: StepRef; readonly guid: string }>();
  const nests = new Map<string, { readonly host: Product; readonly items: StepRef[] }>();
  const writePort = (hostId: string, portId: string, name: string, flow: string | undefined, domain: string | undefined, systemKind: string | undefined, placement: StepRef | null): StepRef | null => {
    const host = products.get(hostId);
    if (!host) return null;
    const key = `${hostId}|${portId}`;
    if (ports.has(key)) return ports.get(key)?.ref ?? null;
    const guid = guids.derived(`port:${key}`);
    const sys = systemKind ? services.byId.get(systemKind)?.ifc : undefined;
    const sysType = sys && sys.system === "IfcDistributionSystem" && predefinedTypes("IfcDistributionSystem").has(sys.predefinedType) ? en(sys.predefinedType) : $;
    const ref = g.add("IFCDISTRIBUTIONPORT", [str(guid), $, str255(name), $, $, placement ?? $, $, en(FLOW_DIRECTION[flow ?? ""] ?? "NOTDEFINED"), en(PORT_DOMAIN[domain ?? ""] ?? "NOTDEFINED"), sysType]);
    ports.set(key, { ref, guid });
    const n = nests.get(hostId) ?? { host, items: [] };
    n.items.push(ref);
    nests.set(hostId, n);
    counts.ports++;
    return ref;
  };
  const systemKindOf = (systemId: string): string | undefined => {
    const s = els[systemId];
    return s?.kind === "mep_system" ? s.systemKind : undefined;
  };
  const connections: Array<readonly [string, string]> = [];
  for (const el of elements) {
    const host = products.get(el.id);
    if (!host) continue;
    if (el.kind === "part") {
      const type = partTypeOf(el);
      if (!type) continue;
      for (const c of resolveConnectors(type.definition, el.values)) {
        const placement = host.placement ? geo.placement(host.placement, geo.axis({ x: c.position[0], y: c.position[1], z: c.position[2] })) : null;
        const flow = type.definition.connectors.find((d) => d.id === c.id)?.flowDirection;
        writePort(el.id, c.id, c.label, flow, c.domain, c.systemKind, placement);
      }
      for (const [connector, link] of Object.entries(el.links ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))) connections.push([`${el.id}|${connector}`, `${link.elementId}|${link.port}`]);
    } else if (el.kind === "run_segment") {
      const sk = systemKindOf(el.systemId);
      const at = (p: Vec3) => (host.placement ? geo.placement(host.placement, geo.axis(p)) : null);
      writePort(el.id, "start", "Start", undefined, el.domain, sk, at(el.start));
      writePort(el.id, "end", "End", undefined, el.domain, sk, at(el.end));
      const ends: Array<readonly ["start" | "end", PortRef | undefined]> = [
        ["start", el.links.start],
        ["end", el.links.end],
      ];
      for (const [end, link] of ends) if (link) connections.push([`${el.id}|${end}`, `${link.elementId}|${link.port}`]);
    } else if (el.kind === "run_fitting") {
      const sk = systemKindOf(el.systemId);
      for (const port of [...el.ports].sort(byId)) {
        writePort(el.id, port.id, port.id, undefined, el.domain, sk, host.placement ? geo.placement(frameOf(levelOf(el)), geo.axis(port.position)) : null);
        if (port.link) connections.push([`${el.id}|${port.id}`, `${port.link.elementId}|${port.link.port}`]);
      }
    }
  }
  const seenPairs = new Set<string>();
  for (const [a, b] of connections) {
    const [first, second] = a < b ? [a, b] : [b, a];
    const pairKey = `${first}~${second}`;
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);
    const pa = ports.get(first);
    const pb = ports.get(second);
    if (!pa || !pb) continue;
    g.add("IFCRELCONNECTSPORTS", [str(guids.rel("IfcRelConnectsPorts", [pa.guid, pb.guid])), $, $, $, pa.ref, pb.ref, $]);
  }

  // Load points: a port for what is connected where no fixture is modelled.
  for (const lp of elements.filter((e): e is LoadPointElement => e.kind === "load_point")) {
    const anchor = loadAnchorOf(lp);
    const hostId = lp.attachedPartId && products.has(lp.attachedPartId) ? lp.attachedPartId : anchor.kind === "run_end" && products.has(anchor.hostId) ? anchor.hostId : anchor.kind === "part" && products.has(anchor.partId) ? anchor.partId : null;
    const name = lp.mark ?? (lp.connectionType || lp.id);
    const guid = guids.record(lp);
    const service = lp.service ? services.byId.get(lp.service) : undefined;
    const carried = service?.carriedBy ? services.byId.get(service.carriedBy) : service;
    const sysType = carried?.ifc.system === "IfcDistributionSystem" && predefinedTypes("IfcDistributionSystem").has(carried.ifc.predefinedType) ? en(carried.ifc.predefinedType) : $;
    const ref = g.add("IFCDISTRIBUTIONPORT", [str(guid), $, str255(name), $, str("Load point"), $, $, en("SINK"), en(PORT_DOMAIN[carried?.connector ?? ""] ?? "NOTDEFINED"), sysType]);
    counts.ports++;
    const host = hostId ? products.get(hostId) : undefined;
    if (host && hostId) {
      const n = nests.get(hostId) ?? { host, items: [] };
      n.items.push(ref);
      nests.set(hostId, n);
    } else if (anchor.kind === "space") containIn(spaceRefs.get(anchor.id)?.levelId ?? null, anchor.id, ref);
    else if (anchor.kind === "point") containIn(storeys.has(anchor.levelId) ? anchor.levelId : null, null, ref);
    else containIn(null, null, ref);
    const bag = new PropertyBag();
    for (const key of [...LEGACY_QUANTITY_KEYS].sort()) {
      const v = lp.values[key];
      if (typeof v !== "number") continue;
      bag.put(homes.find([`load.${key}`]), { kind: "number", name: key, value: v, unit: QUANTITY_BINDINGS[key].unit }, "MutinyBIM_Loads");
    }
    for (const c of lp.values.custom ?? []) bag.set("MutinyBIM_Loads", { kind: "number", name: c.name, value: c.value, unit: c.unit });
    if (lp.connectionType) bag.set("MutinyBIM_Load", { kind: "text", name: "ConnectionType", value: lp.connectionType });
    if (lp.mark) bag.set("MutinyBIM_Load", { kind: "text", name: "Mark", value: lp.mark });
    if (lp.note) bag.set("MutinyBIM_Load", { kind: "text", name: "Note", value: lp.note });
    if (lp.service) bag.set("MutinyBIM_Load", { kind: "text", name: "Service", value: lp.service });
    attachSets(ref, guid, lp.id, bag);
  }
  for (const [, n] of [...nests].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    g.add("IFCRELNESTS", [str(guids.rel("IfcRelNests", [n.host.guid, "ports"])), $, $, $, n.host.ref, list(n.items)]);
  }

  // ---------------------------------------------------------------- zones
  const zoneOf = (purpose: string): IfcZoneHome => {
    const stated = opts.zonePurposeIfc?.(purpose) ?? purposeHomes.get(purpose);
    if (stated) return stated;
    const spatial = ZONE_PURPOSE_SPATIAL[purpose];
    return spatial ? { entity: "IfcSpatialZone", predefinedType: spatial } : { entity: "IfcSpatialZone", predefinedType: "USERDEFINED", objectType: rawRegistryWords(purpose) };
  };
  const referenced = new Map<string, { readonly structure: StepRef; readonly structureGuid: string; readonly items: StepRef[] }>();
  for (const z of elements.filter((e): e is Zone => e.kind === "zone")) {
    const guid = guids.record(z);
    const bounds = zoneBoundsOf(z);
    const home = zoneOf(z.purpose);
    const bag = new PropertyBag();
    bag.set("MutinyBIM_Zone", { kind: "text", name: "Purpose", value: z.purpose });
    const server = z.servedBy ? els[z.servedBy] : undefined;
    if (server) bag.set("MutinyBIM_Zone", { kind: "text", name: "ServedBy", value: stringField(server, "mark") ?? server.id });
    counts.zones++;
    if (bounds.kind === "spaces") {
      const ref = g.add("IFCZONE", [str(guid), $, str255(z.name), $, str255(rawRegistryWords(z.purpose)), $]);
      const members = bounds.spaceIds.map((id) => spaceRefs.get(id)?.ref).filter((r): r is StepRef => !!r);
      if (members.length > 0) g.add("IFCRELASSIGNSTOGROUP", [str(guids.rel("IfcRelAssignsToGroup", [guid])), $, $, $, list(members), $, ref]);
      attachSets(ref, guid, z.id, bag);
      continue;
    }
    // A derived zone's rule states its own IFC type (a pack's rule too); others go by purpose.
    const rulePt = bounds.kind === "derived" ? derivedRules.get(bounds.rule)?.ifcPredefinedType : undefined;
    const statedPt = rulePt ?? (home.entity === "IfcSpatialZone" ? home.predefinedType : undefined);
    const pt = statedPt && predefinedTypes("IfcSpatialZone").has(statedPt) ? statedPt : "USERDEFINED";
    const objectType = pt === "USERDEFINED" ? (home.objectType ?? rawRegistryWords(z.purpose)) : null;
    let levelId: string | null = null;
    let placement: StepRef | null = null;
    let body: StepRef | null = null;
    if (bounds.kind === "outline") {
      levelId = storeys.has(bounds.levelId) ? bounds.levelId : null;
      placement = geo.placement(frameOf(levelId), geo.axis({ x: 0, y: 0, z: 0 }));
      const bottom = bounds.bottom ?? 0;
      if (bounds.top !== undefined) body = geo.prism(bounds.outline, bottom, bounds.top - bottom);
    } else if (bounds.kind === "derived") {
      const host = els[bounds.hostId];
      levelId = host ? levelOf(host) : null;
      bag.set("MutinyBIM_Zone", { kind: "text", name: "Rule", value: bounds.rule });
      bag.set("MutinyBIM_Zone", { kind: "text", name: "Host", value: host ? (stringField(host, "mark") ?? host.id) : bounds.hostId });
    } else warn(`${z.id}: zone bounds of kind "${bounds.storedKind}" are not known to this exporter; written without a shape`);
    const ref = g.add("IFCSPATIALZONE", [str(guid), $, str255(z.name), $, opt(objectType), placement ?? $, body ?? $, $, en(pt)]);
    attachSets(ref, guid, z.id, bag);
    const storey = levelId ? storeys.get(levelId) : undefined;
    const key = storey ? `storey:${levelId}` : "building";
    const r = referenced.get(key) ?? { structure: storey?.ref ?? buildingRef, structureGuid: storey?.guid ?? buildingGuid, items: [] };
    r.items.push(ref);
    referenced.set(key, r);
  }

  // ---------------------------------------------------------------- systems and circuits
  const zonesServedBy = new Map<string, string[]>();
  for (const z of elements.filter((e): e is Zone => e.kind === "zone")) {
    if (!z.servedBy) continue;
    const b = zoneBoundsOf(z);
    if (b.kind === "spaces") zonesServedBy.set(z.servedBy, [...(zonesServedBy.get(z.servedBy) ?? []), ...b.spaceIds]);
  }
  const writeSystem = (guid: string, name: string, row: ServiceRow | undefined, fallbackType: string, circuit: boolean): StepRef => {
    const ifc = row?.ifc;
    if (circuit || !ifc || ifc.system === "IfcDistributionSystem") {
      const entity = circuit ? "IFCDISTRIBUTIONCIRCUIT" : "IFCDISTRIBUTIONSYSTEM";
      const valid = ifc && ifc.system === "IfcDistributionSystem" && predefinedTypes("IfcDistributionSystem").has(ifc.predefinedType);
      const pt = valid ? ifc.predefinedType : "USERDEFINED";
      const objectType = pt === "USERDEFINED" ? (ifc?.objectType ?? fallbackType) : null;
      return g.add(entity, [str(guid), $, str255(name), $, opt(objectType), $, en(pt)]);
    }
    if (ifc.system === "IfcBuiltSystem") {
      const pt = predefinedTypes("IfcBuiltSystem").has(ifc.predefinedType) ? ifc.predefinedType : "USERDEFINED";
      return g.add("IFCBUILTSYSTEM", [str(guid), $, str255(name), $, opt(pt === "USERDEFINED" ? (ifc.objectType ?? fallbackType) : null), en(pt), $]);
    }
    return g.add("IFCSTRUCTURALANALYSISMODEL", [str(guid), $, str255(name), $, opt(ifc.objectType ?? null), en(/^[A-Z_0-9]+$/.test(ifc.predefinedType) ? ifc.predefinedType : "NOTDEFINED"), $, $, $, $]);
  };
  const servesSpaces = (sysRef: StepRef, sysGuid: string, spaceIds: Iterable<string>) => {
    const refs = [...new Set(spaceIds)].sort().map((id) => spaceRefs.get(id)?.ref).filter((r): r is StepRef => !!r);
    if (refs.length > 0) g.add("IFCRELSERVICESBUILDINGS", [str(guids.rel("IfcRelServicesBuildings", [sysGuid])), $, $, $, sysRef, list(refs)]);
  };
  const plannedSpaceOf = (id: string): string | null => {
    const e = els[id];
    return e?.kind === "part" && e.planned?.spaceHint ? e.planned.spaceHint : null;
  };
  // System members in one pass: runs by their system, parts by the runs they connect to.
  const runsBySystem = new Map<string, string[]>();
  const partsByRun = new Map<string, string[]>();
  for (const e of elements) {
    if ((e.kind === "run_segment" || e.kind === "run_fitting") && products.has(e.id)) push(runsBySystem, e.systemId, e.id);
    if (e.kind === "part" && products.has(e.id)) for (const l of Object.values(e.links ?? {})) push(partsByRun, l.elementId, e.id);
  }
  for (const sys of elements.filter((e): e is MepSystem => e.kind === "mep_system")) {
    const guid = guids.record(sys);
    const row = services.byId.get(sys.systemKind);
    if (!row) warn(`${sys.id}: system kind "${sys.systemKind}" is not in the service registry; written as a USERDEFINED distribution system`);
    const ref = writeSystem(guid, sys.name, row, rawRegistryWords(sys.systemKind), false);
    counts.systems++;
    const runs = runsBySystem.get(sys.id) ?? [];
    const memberIds = new Set<string>([...runs, ...runs.flatMap((r) => partsByRun.get(r) ?? [])]);
    const members = [...memberIds].sort().map((id) => products.get(id)?.ref).filter((r): r is StepRef => !!r);
    if (members.length > 0) g.add("IFCRELASSIGNSTOGROUP", [str(guids.rel("IfcRelAssignsToGroup", [guid])), $, $, $, list(members), $, ref]);
    servesSpaces(ref, guid, [...memberIds].flatMap((id) => [...(zonesServedBy.get(id) ?? []), ...(plannedSpaceOf(id) ? [plannedSpaceOf(id) ?? ""] : [])]));
  }
  for (const link of elements.filter((e): e is ServiceLink => e.kind === "service_link")) {
    const guid = guids.record(link);
    const adapter = linkAdapterId(link);
    const row = services.rows.find((r) => r.asSystem && r.adapter === adapter);
    const ref = writeSystem(guid, link.description || link.id, row, rawRegistryWords(adapter), true);
    counts.circuits++;
    const ids = [link.source.elementId, ...link.members.map((m) => m.elementId)];
    const members = [...new Set(ids)].map((id) => products.get(id)?.ref).filter((r): r is StepRef => !!r);
    if (members.length > 0) g.add("IFCRELASSIGNSTOGROUP", [str(guids.rel("IfcRelAssignsToGroup", [guid])), $, $, $, list(members), $, ref]);
    const bag = new PropertyBag();
    bag.set("MutinyBIM_Circuit", { kind: "text", name: "Role", value: link.role });
    bag.set("MutinyBIM_Circuit", { kind: "text", name: "Adapter", value: adapter });
    if (link.source.positions.length > 0) bag.set("MutinyBIM_Circuit", { kind: "text", name: "Positions", value: link.source.positions.join(",") });
    attachSets(ref, guid, link.id, bag);
    servesSpaces(ref, guid, link.members.flatMap((m) => [...(zonesServedBy.get(m.elementId) ?? []), ...(plannedSpaceOf(m.elementId) ? [plannedSpaceOf(m.elementId) ?? ""] : [])]));
  }

  // ---------------------------------------------------------------- groups, containment, units, project
  for (const [name, members] of [...groupMembers].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const guid = guids.derived(`group:${name}`);
    const ref = g.add("IFCGROUP", [str(guid), $, str255(name), $, $]);
    g.add("IFCRELASSIGNSTOGROUP", [str(guids.rel("IfcRelAssignsToGroup", [guid])), $, $, $, list(members), $, ref]);
  }
  for (const [levelId, children] of [...storeyChildren].sort(([a], [b]) => ((a ?? "") < (b ?? "") ? -1 : 1))) {
    const storey = levelId ? storeys.get(levelId) : undefined;
    if (storey) aggregate(storey.ref, storey.guid, children);
    else aggregate(buildingRef, `${buildingGuid}:spaces`, children);
  }
  for (const [, c] of [...contained].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    g.add("IFCRELCONTAINEDINSPATIALSTRUCTURE", [str(guids.rel("IfcRelContainedInSpatialStructure", [c.structureGuid])), $, $, $, list(c.items), c.structure]);
  }
  for (const [, r] of [...referenced].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    g.add("IFCRELREFERENCEDINSPATIALSTRUCTURE", [str(guids.rel("IfcRelReferencedInSpatialStructure", [r.structureGuid])), $, $, $, list(r.items), r.structure]);
  }
  const unitAssignment = units.write(g);
  g.fill(projectHandle, "IFCPROJECT", [str(projectGuid), $, str255(opts.project.name || "Project"), opt(opts.project.description), $, opt(opts.project.number), $, list([context]), unitAssignment]);

  const text = serializeStep(
    {
      description: ["ViewDefinition [ReferenceView]"],
      implementationLevel: "2;1",
      fileName: opts.fileName ?? `${model.modelId}.ifc`,
      timeStamp: opts.timeStamp,
      author: [opts.author ?? ""],
      organization: [opts.organization ?? ""],
      preprocessor: `MutinyBIM bim-ifc ${BIM_IFC_VERSION}`,
      originatingSystem: "MutinyBIM",
      authorization: "",
      schemas: [IFC_SCHEMA],
    },
    g,
  );
  for (const [classId, count] of missingProxyClasses) {
    warn(`IFC export used ${PROXY} for ${count} building element${count === 1 ? "" : "s"} because class "${classId}" is unavailable. Check that the export host has the add-on or library that provides this class.`);
  }
  return {
    text,
    bytes: new TextEncoder().encode(text),
    report: { schema: IFC_SCHEMA, counts, byEntity, skipped, warnings, globalIds: guids.byRecord },
  };
}

