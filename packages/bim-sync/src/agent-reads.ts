import {
  headlineKindValue,
  builtinPartTypes,
  PART_CATEGORY_LABELS,
  ductAirway,
  ductOuterSize,
  insulationLabel,
  formatParam,
  paramValue,
  elementValues,
  evaluateEquipmentSchedule,
  partitionKey,
  partitionOf,
  resolveFitting,
  runLabel,
  sizeLabel,
  systemRules,
  validateModel,
  type BimElement,
  type Discipline,
  type ElementKind,
  type ModelState,
  type ParamDef,
  type PartCategory,
  type PartTypeDefinition,
  type Partition,
  type ScheduleRow,
  elementCount,
  bagSummary,
  catalogEntryName,
  connectionTypeOf,
  connectionTypeSummary,
  connectionTypeTrade,
  connectionTypeSections,
  loadPointAt,
  loadPointHostState,
  loadPointLabel,
  loadPointQuantities,
  anchorWords,
  loadAnchorOf,
  runEndOf,
} from "@permitzip/bim-kernel";

/**
 * Compact, plain read models for agents. Every read states the revision it
 * was taken at, so an agent can say exactly what it looked at and pass that
 * revision back as the base of its edit.
 */

const MM_PER_FT = 304.8;
const ft = (mm: number) => Math.round((mm / MM_PER_FT) * 100) / 100;

export interface ModelSummary {
  readonly modelId: string;
  readonly revision: number;
  readonly elementCount: number;
  readonly countsByKind: Readonly<Record<string, number>>;
  readonly areas: readonly { readonly level: string; readonly zone: string; readonly discipline: Discipline; readonly elements: number }[];
  readonly systems: readonly { readonly equipmentId: string; readonly mark: string; readonly totalCfm: number }[];
  /** Routed duct and pipe systems (route_run), by id. */
  readonly routedSystems: readonly { readonly id: string; readonly name: string; readonly system: string; readonly carriedIn: string }[];
  readonly openIssues: number;
}

export function summarizeModel(model: ModelState): ModelSummary {
  const countsByKind: Record<string, number> = {};
  const areas = new Map<string, { partition: Partition; elements: number }>();
  const systems: { equipmentId: string; mark: string; totalCfm: number }[] = [];
  const routedSystems: { id: string; name: string; system: string; carriedIn: string }[] = [];
  for (const el of elementValues(model.elements)) {
    if (el.kind === "mep_system") routedSystems.push({ id: el.id, name: el.name, system: systemRules(el.systemKind).label, carriedIn: el.domain });
    countsByKind[el.kind] = (countsByKind[el.kind] ?? 0) + 1;
    const p = partitionOf(el);
    const key = partitionKey(p);
    const area = areas.get(key) ?? { partition: p, elements: 0 };
    area.elements += 1;
    areas.set(key, area);
    if (el.kind === "equipment") systems.push({ equipmentId: el.id, mark: el.mark, totalCfm: headlineKindValue(el)?.value ?? 0 });
  }
  return {
    modelId: model.modelId,
    revision: model.revision,
    elementCount: elementCount(model.elements),
    countsByKind,
    areas: [...areas.values()]
      .map((a) => ({ level: a.partition.level, zone: a.partition.zone, discipline: a.partition.discipline, elements: a.elements }))
      .sort((a, b) => `${a.level}|${a.zone}|${a.discipline}`.localeCompare(`${b.level}|${b.zone}|${b.discipline}`)),
    systems,
    routedSystems,
    openIssues: validateModel(model).length,
  };
}

export interface ElementQuery {
  readonly kinds?: readonly ElementKind[];
  readonly level?: string;
  readonly zone?: string;
  readonly discipline?: Discipline;
  readonly ids?: readonly string[];
  readonly limit?: number;
}

/** One line of facts an agent needs to plan an edit, in feet and CFM. */
export interface ElementRow {
  readonly id: string;
  readonly kind: ElementKind;
  readonly area: string;
  readonly facts: Readonly<Record<string, string | number | boolean>>;
}

function profileText(p: { shape: "rect"; width: number; height: number } | { shape: "round"; diameter: number }): string {
  const inch = (mm: number) => Math.round(mm / 25.4);
  return p.shape === "rect" ? `${inch(p.width)}"x${inch(p.height)}"` : `${inch(p.diameter)}" round`;
}

function partFacts(el: Extract<BimElement, { kind: "part" }>, model: ModelState): Record<string, string | number | boolean> {
  const type = model.elements[el.typeId];
  const level = model.elements[el.levelId];
  const facts: Record<string, string | number | boolean> = {
    mark: el.mark,
    type_id: el.typeId,
    level: level?.kind === "level" ? level.name : el.levelId,
    x_ft: ft(el.position.x),
    y_ft: ft(el.position.y),
    height_above_level_ft: ft(el.offsetMm),
    rotation_deg: el.rotationDeg,
  };
  if (type?.kind !== "part_type") return facts;
  const def = type.definition;
  facts.category = def.category;
  facts.type = `${def.familyName}: ${def.typeName}`;
  for (const c of def.connectors) {
    const link = el.links?.[c.id];
    facts[`connector_${c.id}`] = `${c.label} (${c.domain}, ${c.systemKind.replace(/_/g, " ")}): ${link ? `connected to ${link.elementId}` : "free"}`;
  }
  for (const p of def.instanceParams) {
    const v = paramValue(def, el.values, p.name);
    if (v !== undefined) facts[p.name] = typeof v === "number" && p.kind === "length" ? formatParam(p, v) : v;
  }
  return facts;
}

function factsOf(el: BimElement, model: ModelState): Record<string, string | number | boolean> {
  switch (el.kind) {
    case "part":
      return partFacts(el, model);
    case "level":
      return { name: el.name, elevation_ft: ft(el.elevationMm) };
    case "part_type":
      return { category: el.definition.category, type: `${el.definition.familyName}: ${el.definition.typeName}` };
    case "equipment":
      return { mark: el.mark, type: el.typeName, x_ft: ft(el.position.x), y_ft: ft(el.position.y), total_cfm: headlineKindValue(el)?.value ?? 0 };
    case "duct_segment":
      return {
        size: profileText(el.profile),
        length_ft: ft(Math.hypot(el.end.x - el.start.x, el.end.y - el.start.y)),
        flow_cfm: headlineKindValue(el)?.value ?? 0,
        system: el.systemClass,
      };
    case "tap":
      return { host: el.hostId, s_ft: ft(el.s), size: profileText(el.profile) };
    case "elbow":
      return { size: profileText(el.profile) };
    case "terminal":
      return { mark: el.mark, type: el.typeName, cfm: headlineKindValue(el)?.value ?? 0, anchored: el.anchored, x_ft: ft(el.position.x), y_ft: ft(el.position.y) };
    case "riser_segment":
      return { riser: el.riserId, size: profileText(el.profile), service: el.service };
    case "dimension":
      return { from: el.aId, to: el.bId, value_ft: ft(el.valueMm) };
    case "mep_system":
      return {
        name: el.name,
        system: systemRules(el.systemKind).label,
        carried_in: el.domain,
        ...(el.design?.insulation ? { default_insulation: insulationLabel(el.design.insulation) } : {}),
        ...(el.design?.sizing?.frictionInPer100Ft !== undefined ? { sizing_friction_in_per_100ft: el.design.sizing.frictionInPer100Ft } : {}),
        ...(el.design?.sizing?.maxVelocityFpm !== undefined ? { sizing_max_velocity_fpm: el.design.sizing.maxVelocityFpm } : {}),
        ...(el.design?.sizing?.maxAspectRatio !== undefined ? { sizing_max_aspect_ratio: el.design.sizing.maxAspectRatio } : {}),
      };
    case "run_segment": {
      const system = model.elements[el.systemId];
      const unit = system?.kind === "mep_system" ? systemRules(system.systemKind).flowUnit : "";
      return {
        what: runLabel(model.elements, el),
        size: sizeLabel(el.size),
        ...(el.insulation
          ? { insulation: insulationLabel(el.insulation), inside_size: sizeLabel(ductAirway(el.size, el.insulation)), outside_size: sizeLabel(ductOuterSize(el.size, el.insulation)) }
          : {}),
        system: el.systemId,
        from_ft: `${ft(el.start.x)}, ${ft(el.start.y)} at ${ft(el.start.z)} ft`,
        to_ft: `${ft(el.end.x)}, ${ft(el.end.y)} at ${ft(el.end.z)} ft`,
        length_ft: ft(Math.hypot(el.end.x - el.start.x, el.end.y - el.start.y, el.end.z - el.start.z)),
        flow: unit ? `${el.flow} ${unit}` : el.flow,
        start: el.links.start ? `connected to ${el.links.start.elementId}` : openEnd(model, el.id, "start"),
        end: el.links.end ? `connected to ${el.links.end.elementId}` : openEnd(model, el.id, "end"),
        branches: el.branches.join(", "),
      };
    }
    case "run_fitting": {
      const system = model.elements[el.systemId];
      const resolved = resolveFitting(system?.kind === "mep_system" ? system : null, el);
      return {
        what: runLabel(model.elements, el),
        type: resolved ? `${resolved.family.name}${resolved.defaulted ? " (system default)" : ""}` : el.fittingType,
        ...(resolved ? { type_id: resolved.family.id } : {}),
        ...(resolved && Object.keys(resolved.params).length > 0 ? { type_params: Object.entries(resolved.params).map(([k, v]) => `${k} ${v}`).join(", ") } : {}),
        ...(el.coefficientOverride ? { engineer_c: `${el.coefficientOverride.c} (${el.coefficientOverride.role}, ${el.coefficientOverride.by})` } : {}),
        ...(el.insulation ? { insulation: insulationLabel(el.insulation) } : {}),
        system: el.systemId,
        x_ft: ft(el.position.x),
        y_ft: ft(el.position.y),
        height_ft: ft(el.position.z),
        ...(el.host ? { trunk: el.host.segmentId, s_ft: ft(el.host.s) } : {}),
        ports: el.ports.map((p) => `${p.id} ${sizeLabel(p.size)}: ${p.link ? `connected to ${p.link.elementId}` : "open"}`).join("; "),
      };
    }
    case "tag":
      return { text: el.text, target: el.targetId };
    case "load_point": {
      const ct = el.connectionType ? connectionTypeOf(model.elements, el.connectionType) : null;
      return {
        what: loadPointLabel(model.elements, el),
        on: runEndOf(el) ? `${runEndOf(el)?.elementId} ${runEndOf(el)?.port}` : anchorWords(loadAnchorOf(el), (id) => id),
        connection_type: el.connectionType || "none",
        loads: bagSummary(loadPointQuantities(model.elements, el)),
        ...(Object.keys(el.values).length > 0 ? { own_values: bagSummary(el.values) } : {}),
        ...(el.mark ? { mark: el.mark } : {}),
        ...(el.attachedPartId ? { fixture: el.attachedPartId } : {}),
        ...(el.schematic ? { schematic: true } : {}),
        ...(ct ? {} : el.connectionType ? { missing_type: true } : {}),
        ...(loadPointHostState(model.elements, el) !== "ok" ? { host: loadPointHostState(model.elements, el) } : {}),
      };
    }
    case "service_catalog":
      return el.entry.type === "connection_type"
        ? { what: `connection type ${el.entry.designator}`, trade: connectionTypeTrade(el.entry), description: el.entry.description, loads: bagSummary(el.entry.quantities ?? {}), ...(typeof el.entry.loadVa === "number" && el.entry.loadVa > 0 ? { electrical: connectionTypeSummary(el.entry) } : {}), ...multiTradeSections(el.entry) }
        : { what: el.entry.type.replace(/_/g, " "), name: catalogEntryName(el.entry) };
    default:
      return {};
  }
}

/** A connection type that serves several trades (the fryer), read per trade: "Electrical: 120 V, 1 pole, 1,800 VA; Gas: 80 MBH; Drainage: 1 DFU". */
function multiTradeSections(entry: Parameters<typeof connectionTypeSections>[0]): { by_trade?: string } {
  const sections = connectionTypeSections(entry);
  if (sections.length < 2) return {};
  return { by_trade: sections.map((s) => `${s.label}: ${s.summary}`).join("; ") };
}

/** "open", or "open, load point K01-2 (Hand sink)" when a load point sits on that end. */
function openEnd(model: ModelState, segmentId: string, end: "start" | "end"): string {
  const lp = loadPointAt(model.elements, segmentId, end);
  return lp ? `open, ${loadPointLabel(model.elements, lp).replace(/^Load point/, "load point")} (${lp.id})` : "open";
}

export function queryElements(model: ModelState, query: ElementQuery): { readonly revision: number; readonly total: number; readonly rows: readonly ElementRow[] } {
  const kinds = query.kinds ? new Set<string>(query.kinds) : null;
  const ids = query.ids ? new Set(query.ids) : null;
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 500);
  const matches: ElementRow[] = [];
  let total = 0;
  for (const el of elementValues(model.elements)) {
    if (kinds && !kinds.has(el.kind)) continue;
    if (ids && !ids.has(el.id)) continue;
    const p = partitionOf(el);
    if (query.level && p.level !== query.level) continue;
    if (query.zone && p.zone !== query.zone) continue;
    if (query.discipline && p.discipline !== query.discipline) continue;
    total += 1;
    if (matches.length < limit) matches.push({ id: el.id, kind: el.kind, area: partitionKey(p), facts: factsOf(el, model) });
  }
  return { revision: model.revision, total, rows: matches };
}

export interface NetworkInspection {
  readonly revision: number;
  readonly element: ElementRow;
  readonly connectedTo: readonly ElementRow[];
  /** From this element up to its equipment, nearest first (empty if it is not on a network). */
  readonly pathToEquipment: readonly ElementRow[];
}

export function inspectNetwork(model: ModelState, elementId: string): NetworkInspection | null {
  const el = model.elements[elementId];
  if (!el) return null;
  const neighbors = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    const list = neighbors.get(a) ?? [];
    list.push(b);
    neighbors.set(a, list);
  };
  for (const c of model.connections) {
    link(c.a.elementId, c.b.elementId);
    link(c.b.elementId, c.a.elementId);
  }
  // Taps are hosted, not connected: treat the host as a neighbour too. Routed runs keep their links on the elements.
  for (const other of elementValues(model.elements)) {
    if (other.kind === "tap") {
      link(other.id, other.hostId);
      link(other.hostId, other.id);
    }
    if (other.kind === "run_segment") {
      for (const l of [other.links.start, other.links.end]) if (l) link(other.id, l.elementId);
      for (const b of other.branches) link(other.id, b);
    }
    if (other.kind === "run_fitting") {
      for (const p of other.ports) if (p.link) link(other.id, p.link.elementId);
      if (other.host) link(other.id, other.host.segmentId);
    }
    if (other.kind === "part") for (const l of Object.values(other.links ?? {})) link(other.id, l.elementId);
  }
  const row = (id: string): ElementRow | null => {
    const found = model.elements[id];
    return found ? { id: found.id, kind: found.kind, area: partitionKey(partitionOf(found)), facts: factsOf(found, model) } : null;
  };
  const connectedTo = [...new Set(neighbors.get(elementId) ?? [])].map(row).filter((r): r is ElementRow => r !== null);

  // Shortest path to the nearest equipment.
  const prev = new Map<string, string | null>([[elementId, null]]);
  const queue = [elementId];
  const isEquipment = (id: string): boolean => {
    const x = model.elements[id];
    if (x?.kind === "equipment") return true;
    if (x?.kind !== "part") return false;
    const t = model.elements[x.typeId];
    return t?.kind === "part_type" && (t.definition.category === "mechanical_equipment" || t.definition.category === "electrical_equipment");
  };
  let found: string | null = isEquipment(elementId) ? elementId : null;
  while (queue.length > 0 && !found) {
    const id = queue.shift() as string;
    for (const next of neighbors.get(id) ?? []) {
      if (prev.has(next)) continue;
      prev.set(next, id);
      if (isEquipment(next)) {
        found = next;
        break;
      }
      queue.push(next);
    }
  }
  const path: ElementRow[] = [];
  for (let id: string | null | undefined = found; id; id = prev.get(id)) {
    const r = row(id);
    if (r) path.unshift(r);
  }
  const self = row(elementId) as ElementRow;
  return { revision: model.revision, element: self, connectedTo, pathToEquipment: found ? path : [] };
}

export function validationIssues(model: ModelState, limit = 50): { readonly revision: number; readonly total: number; readonly issues: readonly { readonly code: string; readonly message: string; readonly elementIds: readonly string[] }[] } {
  const issues = validateModel(model);
  return { revision: model.revision, total: issues.length, issues: issues.slice(0, Math.max(1, Math.min(limit, 500))) };
}

export function airDeviceSchedule(model: ModelState): { readonly revision: number; readonly rows: readonly ScheduleRow[] } {
  return { revision: model.revision, rows: evaluateEquipmentSchedule(model) };
}

export interface PartTypeListing {
  readonly id: string;
  readonly category: PartCategory;
  readonly categoryLabel: string;
  readonly family: string;
  readonly type: string;
  /** Already in this model (placing it needs only the id); otherwise send its definition with place_part. */
  readonly inModel: boolean;
  readonly source: PartTypeDefinition["source"]["kind"];
  readonly typeValues: Readonly<Record<string, string | number | boolean>>;
  readonly instanceParameters: readonly { readonly name: string; readonly label: string; readonly kind: ParamDef["kind"]; readonly unit?: string; readonly choices?: readonly string[]; readonly default?: string | number | boolean }[];
  readonly connectors: readonly string[];
}

function listing(id: string, def: PartTypeDefinition, inModel: boolean): PartTypeListing {
  return {
    id,
    category: def.category,
    categoryLabel: PART_CATEGORY_LABELS[def.category],
    family: def.familyName,
    type: def.typeName,
    inModel,
    source: def.source.kind,
    typeValues: Object.fromEntries(def.typeParams.flatMap((p) => {
      const v = def.typeValues[p.name] ?? p.default;
      return v === undefined ? [] : [[p.name, typeof v === "number" ? formatParam(p, v) : v]];
    })),
    instanceParameters: def.instanceParams.map((p) => ({
      name: p.name,
      label: p.label,
      kind: p.kind,
      ...(p.unit && p.unit !== "none" ? { unit: p.unit } : {}),
      ...(p.choices ? { choices: p.choices } : {}),
      ...(p.default !== undefined ? { default: p.default } : {}),
    })),
    connectors: def.connectors.map((c) => `${c.id}: ${c.label} (${c.domain}, ${c.systemKind.replace(/_/g, " ")}${c.intake ? `, with a ${c.intake}` : ""})`),
  };
}

/** Part types an agent can place: the model's own, then the starter library's not yet in the model. */
export function listPartTypes(model: ModelState, query: { readonly category?: PartCategory; readonly search?: string; readonly limit?: number } = {}): { readonly revision: number; readonly total: number; readonly types: readonly PartTypeListing[] } {
  const inModel: PartTypeListing[] = [];
  const seen = new Set<string>();
  for (const el of elementValues(model.elements)) {
    if (el.kind !== "part_type") continue;
    seen.add(el.id);
    inModel.push(listing(el.id, el.definition, true));
  }
  const library = builtinPartTypes().filter((t) => !seen.has(t.id)).map((t) => listing(t.id, t.definition, false));
  const needle = query.search?.trim().toLowerCase() ?? "";
  const all = [...inModel, ...library].filter(
    (t) => (!query.category || t.category === query.category) && (needle === "" || `${t.family} ${t.type} ${t.categoryLabel}`.toLowerCase().includes(needle)),
  );
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  return { revision: model.revision, total: all.length, types: all.slice(0, limit) };
}

/** Levels in the model, lowest first. */
interface MountingPlaneRead {
  readonly id: string;
  readonly name: string;
  readonly height_above_level_ft: number;
  readonly corner1_ft: { readonly x: number; readonly y: number };
  readonly corner2_ft: { readonly x: number; readonly y: number };
}

export function listLevels(model: ModelState): {
  readonly revision: number;
  readonly levels: readonly { readonly id: string; readonly name: string; readonly elevation_ft: number; readonly mounting_planes?: readonly MountingPlaneRead[] }[];
} {
  const all = elementValues(model.elements);
  const planes = all.filter((el): el is Extract<BimElement, { kind: "mounting_plane" }> => el.kind === "mounting_plane");
  const levels = all
    .filter((el): el is Extract<BimElement, { kind: "level" }> => el.kind === "level")
    .sort((a, b) => a.elevationMm - b.elevationMm)
    .map((l) => {
      const own: MountingPlaneRead[] = planes
        .filter((p) => p.levelId === l.id)
        .map((p) => ({ id: p.id, name: p.name, height_above_level_ft: ft(p.heightMm), corner1_ft: { x: ft(p.min.x), y: ft(p.min.y) }, corner2_ft: { x: ft(p.max.x), y: ft(p.max.y) } }));
      return { id: l.id, name: l.name, elevation_ft: ft(l.elevationMm), ...(own.length > 0 ? { mounting_planes: own } : {}) };
    });
  return { revision: model.revision, levels };
}
