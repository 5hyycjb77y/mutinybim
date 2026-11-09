import {
  partTypeDefinitionSchema,
  partTypeIssues,
  type ParamDef,
  type ParamUnit,
  type PartCategory,
  type PartConnector,
  type PartPrimitive,
  type PartTypeDefinition,
  type SymbolPrimitive,
  type SystemKind,
} from "../parts";
import type { ParamValue } from "../types";
import { partTypeImportReport, type ConverterConnectorNote, type PartImportReport } from "../connections/integrity";

/**
 * Revit family types → MutinyBIM part types. Reads the records the full
 * extractor writes (`permitzip.revit-full-extract/v1`: elements/types.jsonl,
 * elements.jsonl bounding boxes, mep/connectors.jsonl) and the parameter
 * exports (`permitzip.revit-parameters/v1`), which carry types and instance
 * parameters but no boxes or connectors. Depends only on those schemas.
 *
 * What it can and cannot know:
 * - parameters: names, storage and display values are exact; lengths come
 *   from Revit's internal feet, other quantities from Revit's own display text;
 * - geometry: a box from a placed instance's bounding box when the extract has
 *   one, otherwise a category-sized placeholder (flagged on the type);
 * - connectors: from the instance's connectors when present, otherwise the
 *   category's usual connection (duct neck, power), flagged in the warnings.
 */

const MM_PER_FT = 304.8;

export interface RevitParameterRecord {
  readonly name: string;
  readonly storage: string;
  readonly hasValue?: boolean;
  readonly readOnly?: boolean;
  readonly value?: unknown;
  readonly display?: string | null;
  /** Forge spec id (full extract: dataType, parameter export: spec). */
  readonly dataType?: string | null;
  readonly spec?: string | null;
}

export interface RevitTypeRecord {
  readonly id: number;
  readonly category: string | null;
  readonly builtInCategory?: string | null;
  readonly family: string | null;
  readonly typeName: string | null;
  readonly isSystemType?: boolean;
  readonly parameters: readonly RevitParameterRecord[];
}

export type RevitXyz = readonly [number, number, number];

export interface RevitConnectorRecord {
  readonly domain: string;
  readonly shape?: string | null;
  readonly origin: RevitXyz;
  readonly direction: RevitXyz;
  readonly radius?: number | null;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly flow?: number | null;
}

/** One placed instance of the type, to learn instance parameters, size and connectors from. */
export interface RevitInstanceSample {
  readonly parameters?: readonly RevitParameterRecord[];
  /** Insertion point in feet (full extract: location.point; parameter export: locationFeet). */
  readonly point?: RevitXyz | null;
  /** Rotation about vertical, radians. */
  readonly rotation?: number | null;
  /** World-aligned model bounding box, feet. */
  readonly bbox?: { readonly min: RevitXyz; readonly max: RevitXyz } | null;
  readonly connectors?: readonly RevitConnectorRecord[];
}

export interface ConvertOptions {
  /** Where the types came from, recorded on each type (project number, file name). */
  readonly origin?: string;
}

export type ConvertResult =
  /** `report`: every bad connector, listed before the type is saved; saving is still allowed with it attached. */
  | { readonly ok: true; readonly id: string; readonly definition: PartTypeDefinition; readonly warnings: readonly string[]; readonly report: PartImportReport }
  | { readonly ok: false; readonly family: string; readonly typeName: string; readonly reason: string };

const CATEGORY_BY_BUILTIN: Readonly<Record<string, PartCategory>> = {
  OST_DuctTerminal: "air_terminal",
  OST_MechanicalEquipment: "mechanical_equipment",
  OST_DuctAccessory: "duct_accessory",
  OST_PipeAccessory: "pipe_accessory",
  OST_PlumbingFixtures: "plumbing_fixture",
  OST_ElectricalEquipment: "electrical_equipment",
  OST_ElectricalFixtures: "electrical_device",
  OST_LightingDevices: "electrical_device",
  OST_CommunicationDevices: "electrical_device",
  OST_DataDevices: "electrical_device",
  OST_FireAlarmDevices: "electrical_device",
  OST_SecurityDevices: "electrical_device",
  OST_NurseCallDevices: "electrical_device",
  OST_TelephoneDevices: "electrical_device",
  OST_LightingFixtures: "lighting_fixture",
  OST_GenericModel: "generic",
  OST_SpecialityEquipment: "generic",
  OST_Sprinklers: "pipe_accessory",
};

const CATEGORY_BY_NAME: Readonly<Record<string, PartCategory>> = {
  "air terminals": "air_terminal",
  "mechanical equipment": "mechanical_equipment",
  "duct accessories": "duct_accessory",
  "pipe accessories": "pipe_accessory",
  "plumbing fixtures": "plumbing_fixture",
  "electrical equipment": "electrical_equipment",
  "electrical fixtures": "electrical_device",
  "lighting devices": "electrical_device",
  "communication devices": "electrical_device",
  "data devices": "electrical_device",
  "fire alarm devices": "electrical_device",
  "security devices": "electrical_device",
  "nurse call devices": "electrical_device",
  "telephone devices": "electrical_device",
  "lighting fixtures": "lighting_fixture",
  "generic models": "generic",
  "specialty equipment": "generic",
  sprinklers: "pipe_accessory",
};

/** System families and runs: these are drawn as connected networks, not placed as parts. */
const NETWORK_CATEGORIES = new Set([
  "ducts",
  "duct fittings",
  "flex ducts",
  "duct systems",
  "pipes",
  "pipe fittings",
  "flex pipes",
  "piping systems",
  "conduits",
  "conduit fittings",
  "cable trays",
  "cable tray fittings",
  "wires",
  "electrical circuits",
]);

export function partCategoryOf(record: Pick<RevitTypeRecord, "category" | "builtInCategory">): PartCategory | null {
  if (record.builtInCategory) {
    const byBuiltIn = CATEGORY_BY_BUILTIN[record.builtInCategory];
    if (byBuiltIn) return byBuiltIn;
  }
  return record.category ? (CATEGORY_BY_NAME[record.category.toLowerCase()] ?? null) : null;
}

/** Revit identity and bookkeeping parameters; they describe the file, not the part. */
const SKIPPED = new Set(
  [
    "Family",
    "Family Name",
    "Type",
    "Type Name",
    "Type Id",
    "Family and Type",
    "Category",
    "Image",
    "Type Image",
    "URL",
    "Design Option",
    "Phase Created",
    "Phase Demolished",
    "Workset",
    "Edited by",
    "Export to IFC",
    "Export to IFC As",
    "Export Type to IFC",
    "Export Type to IFC As",
    "IfcGUID",
    "Type IfcGUID",
    "IFC Predefined Type",
    "Type IFC Predefined Type",
    "Host",
    "Host Id",
    "Level",
    "Schedule Level",
    "Elevation from Level",
    "Offset from Host",
    "Mark",
    "Volume",
    "Area",
    "OmniClass Number",
    "OmniClass Title",
    "Code Name",
    "Moves With Nearby Elements",
    "Room Name",
    "Room Number",
    "Space Name",
    "Space Number",
    "System Name",
    "System Type",
    "System Classification",
    "System Abbreviation",
    "Panel",
    "Circuit Number",
  ].map((s) => s.toLowerCase()),
);

const UNIT_BY_TEXT: Readonly<Record<string, { unit: ParamUnit; factor: number }>> = {
  "": { unit: "none", factor: 1 },
  cfm: { unit: "cfm", factor: 1 },
  gpm: { unit: "gpm", factor: 1 },
  w: { unit: "w", factor: 1 },
  kw: { unit: "kw", factor: 1 },
  va: { unit: "va", factor: 1 },
  kva: { unit: "va", factor: 1000 },
  v: { unit: "v", factor: 1 },
  a: { unit: "a", factor: 1 },
  hp: { unit: "hp", factor: 1 },
  "btu/h": { unit: "btuh", factor: 1 },
  mbh: { unit: "btuh", factor: 1000 },
  ton: { unit: "tons", factor: 1 },
  tons: { unit: "tons", factor: 1 },
  "in-wg": { unit: "in_wc", factor: 1 },
  "in. w.c.": { unit: "in_wc", factor: 1 },
  "in wg": { unit: "in_wc", factor: 1 },
  psi: { unit: "psi", factor: 1 },
  lb: { unit: "lb", factor: 1 },
  lbs: { unit: "lb", factor: 1 },
  "%": { unit: "percent", factor: 1 },
  lm: { unit: "lumens", factor: 1 },
};

function specOf(p: RevitParameterRecord): string {
  return p.dataType ?? p.spec ?? "";
}

function isLengthSpec(spec: string): boolean {
  return /:length-|:(pipeSize|ductSize|hvac\.ductSize|piping\.pipeSize)/i.test(spec) || /spec\.aec:length/.test(spec);
}

/** A parameter's MutinyBIM definition and value, or null when it carries nothing useful. */
export function convertParameter(p: RevitParameterRecord, name: string): { readonly def: ParamDef; readonly value: ParamValue } | null {
  if (p.storage === "ElementId" || p.storage === "None" || p.hasValue === false) return null;
  const label = p.name.slice(0, 80);
  if (p.storage === "String") {
    if (typeof p.value !== "string") return null;
    return { def: { name, label, kind: "text" }, value: p.value.slice(0, 400) };
  }
  if (p.storage === "Integer") {
    const display = (p.display ?? "").trim();
    if (/^(yes|no)$/i.test(display)) return { def: { name, label, kind: "boolean" }, value: display.toLowerCase() === "yes" };
    if (typeof p.value !== "number") return null;
    if (display !== "" && !/^-?\d+$/.test(display)) return { def: { name, label, kind: "text" }, value: display.slice(0, 400) };
    return { def: { name, label, kind: "number", unit: "none" }, value: p.value };
  }
  if (p.storage === "Double") {
    if (typeof p.value !== "number" || !Number.isFinite(p.value)) return null;
    if (isLengthSpec(specOf(p))) return { def: { name, label, kind: "length", unit: "mm" }, value: Math.round(p.value * MM_PER_FT * 1000) / 1000 };
    const display = (p.display ?? "").trim();
    // Quantifiers are bounded so "0"-repetition input cannot backtrack
    // polynomially (polynomial-redos CodeQL finding); real numbers are short.
    const m = /^(-?[\d,]{0,64}\.?\d{1,64})\s{0,64}(.*)$/.exec(display);
    if (m && m[1] !== undefined) {
      const unit = UNIT_BY_TEXT[(m[2] ?? "").trim().toLowerCase()];
      const n = Number(m[1].replace(/,/g, ""));
      if (unit && Number.isFinite(n)) return { def: { name, label, kind: "number", unit: unit.unit }, value: n * unit.factor };
    }
    if (display !== "") return { def: { name, label, kind: "text" }, value: display.slice(0, 400) };
    return { def: { name, label, kind: "number", unit: "none" }, value: p.value };
  }
  return null;
}

function snake(name: string): string {
  const s = name
    .toLowerCase()
    // Run quantifiers are bounded so pathological "_"-repetition input cannot
    // backtrack polynomially (polynomial-redos CodeQL finding).
    .replace(/[^a-z0-9]{1,80}/g, "_")
    .replace(/^_{1,80}|_{1,80}$/g, "");
  const lead = /^[a-z]/.test(s) ? s : `p_${s}`;
  return lead.slice(0, 48).replace(/_+$/g, "") || "p";
}

function uniqueName(base: string, used: Set<string>): string {
  let name = base;
  for (let i = 2; used.has(name); i++) name = `${base.slice(0, 44)}_${i}`;
  used.add(name);
  return name;
}

const MAX_PARAMS = 80;

function convertParameters(records: readonly RevitParameterRecord[], used: Set<string>, skipNames: ReadonlySet<string>, editableOnly: boolean): { defs: ParamDef[]; values: Record<string, ParamValue>; byRevitName: Map<string, string> } {
  const defs: ParamDef[] = [];
  const values: Record<string, ParamValue> = {};
  const byRevitName = new Map<string, string>();
  const seen = new Set<string>();
  for (const p of records) {
    const key = p.name.toLowerCase();
    if (SKIPPED.has(key) || skipNames.has(key) || seen.has(key)) continue;
    if (editableOnly && p.readOnly) continue;
    if (defs.length >= MAX_PARAMS) break;
    const name = snake(p.name);
    const converted = convertParameter(p, name);
    if (!converted) continue;
    seen.add(key);
    const unique = uniqueName(name, used);
    defs.push({ ...converted.def, name: unique });
    values[unique] = converted.value;
    byRevitName.set(key, unique);
  }
  return { defs, values, byRevitName };
}

function displayOf(records: readonly RevitParameterRecord[] | undefined, name: string): string | null {
  const p = records?.find((r) => r.name.toLowerCase() === name.toLowerCase() && r.display);
  return p?.display ?? null;
}

const SYSTEM_BY_CLASSIFICATION: Readonly<Record<string, SystemKind>> = {
  "supply air": "supply_air",
  "return air": "return_air",
  "exhaust air": "exhaust_air",
  "outside air": "outside_air",
  "domestic cold water": "domestic_cold_water",
  "domestic hot water": "domestic_hot_water",
  sanitary: "sanitary",
  vent: "vent",
  storm: "storm",
  "hydronic supply": "hydronic_supply",
  "hydronic return": "hydronic_return",
  "fire protection wet": "other",
  "natural gas": "natural_gas",
  gas: "natural_gas",
};

function systemKindFor(domain: PartConnector["domain"], classification: string | null, hint: string): SystemKind {
  if (domain === "electrical") return "power";
  const fromClass = classification ? SYSTEM_BY_CLASSIFICATION[classification.toLowerCase()] : undefined;
  if (fromClass) return fromClass;
  if (domain === "duct") {
    if (/return/i.test(hint)) return "return_air";
    if (/exhaust/i.test(hint)) return "exhaust_air";
    return "supply_air";
  }
  return "other";
}

/** Local frame of a placed instance: translate to the insertion point, undo its rotation. */
function toLocal(point: RevitXyz, origin: RevitXyz, rotation: number): [number, number, number] {
  const dx = point[0] - origin[0];
  const dy = point[1] - origin[1];
  const c = Math.cos(-rotation);
  const s = Math.sin(-rotation);
  return [(dx * c - dy * s) * MM_PER_FT, (dx * s + dy * c) * MM_PER_FT, (point[2] - origin[2]) * MM_PER_FT];
}

function rotateDir(d: RevitXyz, rotation: number): [number, number, number] {
  const c = Math.cos(-rotation);
  const s = Math.sin(-rotation);
  return [round3(d[0] * c - d[1] * s), round3(d[0] * s + d[1] * c), round3(d[2])];
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

const DEFAULT_SIZE: Readonly<Record<PartCategory, [number, number, number]>> = {
  air_terminal: [609.6, 609.6, 50],
  mechanical_equipment: [1200, 900, 900],
  duct_accessory: [300, 300, 300],
  pipe_accessory: [200, 200, 200],
  plumbing_fixture: [500, 700, 800],
  electrical_equipment: [508, 146, 1524],
  electrical_device: [100, 50, 115],
  lighting_fixture: [1219.2, 609.6, 120],
  generic: [300, 300, 300],
};

/** "24X12" / "22x12" face sizes on air terminals (inches). */
function faceSizeMm(texts: readonly (string | null)[]): [number, number] | null {
  for (const t of texts) {
    const m = t ? /(\d{1,64}(?:\.\d{1,64})?)\s{0,32}["]?\s{0,32}[xX×]\s{0,32}(\d{1,64}(?:\.\d{1,64})?)/.exec(t) : null;
    if (m && m[1] && m[2]) return [Number(m[1]) * 25.4, Number(m[2]) * 25.4];
  }
  return null;
}

function connectorFrom(c: RevitConnectorRecord, index: number, origin: RevitXyz, rotation: number, classification: string | null, hint: string, notes: ConverterConnectorNote[]): PartConnector | null {
  const domain = /hvac/i.test(c.domain) ? "duct" : /piping/i.test(c.domain) ? "pipe" : /electrical/i.test(c.domain) ? "electrical" : null;
  if (!domain) return null;
  const local = toLocal(c.origin, origin, rotation);
  const said = /round/i.test(c.shape ?? "") ? "round" : /rect|oval/i.test(c.shape ?? "") ? "rect" : "none";
  // An opening the export says is round or rectangular but gives no size for is kept with no size (so the type still saves) and named in the report.
  const sized = said === "round" ? Boolean(c.radius && c.radius > 0) : said === "rect" ? Boolean(c.width && c.height && c.width > 0 && c.height > 0) : true;
  const shape = sized ? said : "none";
  const id = `c${index + 1}`;
  const flow =
    c.flow === undefined || c.flow === null || domain === "electrical"
      ? undefined
      : round3(domain === "duct" ? c.flow * 60 : c.flow * 448.831);
  const label = domain === "electrical" ? "Power" : `${domain === "duct" ? "Duct" : "Pipe"} ${index + 1}`;
  if (!sized) notes.push({ connectorId: id, connectorLabel: label, message: `${label} is ${said === "round" ? "round" : "rectangular"} in the export, but the export gives no size; it was kept with no size` });
  return {
    id,
    label,
    domain,
    systemKind: systemKindFor(domain, classification, hint),
    position: [round3(local[0]), round3(local[1]), round3(local[2])],
    direction: rotateDir(c.direction, rotation),
    shape,
    ...(shape === "round" && c.radius ? { diameter: round3(c.radius * 2 * MM_PER_FT) } : {}),
    ...(shape === "rect" && c.width && c.height ? { width: round3(c.width * MM_PER_FT), height: round3(c.height * MM_PER_FT) } : {}),
    ...(flow !== undefined ? { flow } : {}),
  };
}

function typeIdFor(family: string, typeName: string): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      // Run quantifiers are bounded so pathological "-"-repetition input
      // cannot backtrack polynomially (polynomial-redos CodeQL finding).
      .replace(/[^a-z0-9]{1,80}/g, "-")
      .replace(/^-{1,80}|-{1,80}$/g, "")
      .slice(0, 80);
  return `revit:${slug(family)}:${slug(typeName)}`;
}

/** Convert one Revit family type (with an optional placed instance to learn from) into a part type. */
export function convertRevitType(record: RevitTypeRecord, sample: RevitInstanceSample | null, options: ConvertOptions = {}): ConvertResult {
  const family = record.family ?? "Unnamed family";
  const typeName = record.typeName ?? "Unnamed type";
  const fail = (reason: string): ConvertResult => ({ ok: false, family, typeName, reason });
  if (record.isSystemType || (record.category && NETWORK_CATEGORIES.has(record.category.toLowerCase()))) {
    return fail(`${record.category ?? "This category"} is a connected run in MutinyBIM, not a placed part`);
  }
  const category = partCategoryOf(record);
  if (!category) return fail(`Revit category ${record.category ?? "(none)"} has no part category yet`);
  const warnings: string[] = [];

  const used = new Set<string>();
  const typeSide = convertParameters(record.parameters, used, new Set(), false);
  const typeNames = new Set(record.parameters.map((p) => p.name.toLowerCase()));
  const instanceSide = convertParameters(sample?.parameters ?? [], used, typeNames, true);
  if (typeSide.defs.length >= MAX_PARAMS) warnings.push(`Kept the first ${MAX_PARAMS} type parameters that carry a value`);

  const classification = displayOf(sample?.parameters, "System Classification");
  const hint = `${family} ${typeName}`;
  const origin = sample?.point ?? null;
  const rotation = sample?.rotation ?? 0;

  let size: [number, number, number];
  let center: [number, number, number];
  if (sample?.bbox && origin) {
    const lo = toLocal(sample.bbox.min, origin, 0);
    const hi = toLocal(sample.bbox.max, origin, 0);
    const quarter = Math.abs(Math.sin(rotation)) > 0.7;
    const dx = Math.abs(hi[0] - lo[0]);
    const dy = Math.abs(hi[1] - lo[1]);
    size = [round3(quarter ? dy : dx), round3(quarter ? dx : dy), round3(Math.abs(hi[2] - lo[2]))];
    const mid: RevitXyz = [(sample.bbox.min[0] + sample.bbox.max[0]) / 2, (sample.bbox.min[1] + sample.bbox.max[1]) / 2, (sample.bbox.min[2] + sample.bbox.max[2]) / 2];
    const c = toLocal(mid, origin, rotation);
    center = [round3(c[0]), round3(c[1]), round3(c[2])];
    const off = Math.abs(Math.sin(2 * rotation));
    if (off > 0.05) warnings.push("Placed at an angle in Revit; the box is the instance's world-aligned bounds");
  } else {
    const face = category === "air_terminal" ? faceSizeMm([displayOf(record.parameters, "FACE SIZE(IN.)"), displayOf(sample?.parameters, "Size"), typeName]) : null;
    const d = DEFAULT_SIZE[category];
    size = face ? [round3(face[0]), round3(face[1]), d[2]] : [...d];
    // Ceiling terminals hang from their insertion point; everything else sits on it.
    center = [0, 0, category === "air_terminal" || category === "lighting_fixture" ? round3(-size[2] / 2) : round3(size[2] / 2)];
    warnings.push(face ? "Size from the face size; no bounding box in this export" : "Placeholder size: this export has no bounding box for the type");
  }

  const connectors: PartConnector[] = [];
  const notes: ConverterConnectorNote[] = [];
  if (sample?.connectors && sample.connectors.length > 0 && origin) {
    sample.connectors.forEach((c, i) => {
      const converted = connectorFrom(c, i, origin, rotation, classification, hint, notes);
      if (converted && connectors.length < 24) connectors.push(converted);
    });
  } else if (category === "air_terminal") {
    const flowName = instanceSide.byRevitName.get("flow") ?? typeSide.byRevitName.get("flow");
    connectors.push({
      id: "neck",
      label: "Neck",
      domain: "duct",
      systemKind: systemKindFor("duct", classification, hint),
      position: [0, 0, 150],
      direction: [0, 0, 1],
      shape: "round",
      diameter: 203.2,
      ...(flowName ? { flow: { param: flowName } } : {}),
    });
    warnings.push("Duct connection assumed at the top (no connectors in this export)");
  } else if (category === "electrical_device" || category === "lighting_fixture" || category === "electrical_equipment" || (category === "mechanical_equipment" && typeSide.byRevitName.has("voltage"))) {
    connectors.push({ id: "power", label: "Power", domain: "electrical", systemKind: "power", position: [0, 0, round3(size[2])], direction: [0, 0, 1], shape: "none" });
    warnings.push("Power connection assumed (no connectors in this export)");
  } else {
    warnings.push("No connectors in this export; add them before connecting this part");
  }

  const geometry: PartPrimitive[] = [{ kind: "box", center, size }];
  const symbol: SymbolPrimitive[] = [{ kind: "rect", center: [center[0], center[1]], size: [size[0], size[1]] }];
  if (category === "mechanical_equipment" || category === "electrical_equipment") {
    const [hx, hy] = [size[0] / 2, size[1] / 2];
    symbol.push(
      { kind: "line", from: [center[0] - hx, center[1] - hy], to: [center[0] + hx, center[1] + hy] },
      { kind: "line", from: [center[0] - hx, center[1] + hy], to: [center[0] + hx, center[1] - hy] },
    );
  }

  const flowParam = instanceSide.byRevitName.get("flow");
  const definition: PartTypeDefinition = {
    familyName: family.slice(0, 200),
    typeName: typeName.slice(0, 200),
    category,
    typeParams: typeSide.defs,
    typeValues: typeSide.values,
    instanceParams: instanceSide.defs,
    connectors,
    geometry,
    symbol,
    tagFields: category === "air_terminal" && flowParam ? ["mark", flowParam] : ["mark"],
    source: {
      kind: "revit",
      familyName: family.slice(0, 200),
      typeName: typeName.slice(0, 200),
      revitCategory: (record.category ?? record.builtInCategory ?? "Unknown").slice(0, 120),
      ...(options.origin ? { origin: options.origin.slice(0, 200) } : {}),
      boundingBoxGeometry: true,
    },
  };
  const parsed = partTypeDefinitionSchema.safeParse(definition);
  if (!parsed.success) return fail(`Converted type is not usable: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  const issue = partTypeIssues(parsed.data)[0];
  if (issue) return fail(`Converted type is not usable: ${issue.message}`);
  return { ok: true, id: typeIdFor(family, typeName), definition: parsed.data, warnings, report: partTypeImportReport(parsed.data, { notes }) };
}

/** Records shaped like the parameter export (`permitzip.revit-parameters/v1`). */
export interface RevitParametersExport {
  readonly schema: string;
  readonly model?: string;
  readonly elements: readonly {
    readonly typeId?: number | null;
    readonly category?: string | null;
    readonly locationFeet?: RevitXyz | null;
    readonly parameters?: readonly RevitParameterRecord[];
  }[];
  /** Keyed by element id; the records carry it as `elementId` (the full extract says `id`). */
  readonly types: Readonly<Record<string, Omit<RevitTypeRecord, "id"> & { readonly id?: number; readonly elementId?: number }>>;
}

/** Every placeable type in a parameter export, each with its first placed instance as the sample. */
export function convertParametersExport(file: RevitParametersExport, options: ConvertOptions = {}): ConvertResult[] {
  const firstInstance = new Map<number, RevitParametersExport["elements"][number]>();
  for (const el of file.elements) {
    if (typeof el.typeId === "number" && !firstInstance.has(el.typeId)) firstInstance.set(el.typeId, el);
  }
  const out: ConvertResult[] = [];
  for (const [key, raw] of Object.entries(file.types)) {
    const record: RevitTypeRecord = { ...raw, id: raw.id ?? raw.elementId ?? Number(key) };
    const inst = firstInstance.get(record.id);
    const sample: RevitInstanceSample | null = inst ? { parameters: inst.parameters ?? [], point: inst.locationFeet ?? null } : null;
    out.push(convertRevitType(record, sample, { origin: options.origin ?? file.model }));
  }
  return out;
}

/** The full extractor's records (elements/types.jsonl, elements/elements.jsonl, mep/connectors.jsonl), already parsed. */
export interface RevitFullExtractRecords {
  readonly types: readonly RevitTypeRecord[];
  readonly elements: readonly {
    readonly id: number;
    readonly typeId?: number | null;
    readonly location?: { readonly point?: RevitXyz | null; readonly rotation?: number | null } | null;
    readonly bbox?: { readonly min: RevitXyz; readonly max: RevitXyz } | null;
    readonly parameters?: readonly RevitParameterRecord[];
  }[];
  readonly connectors: readonly { readonly elementId: number; readonly connectors: readonly RevitConnectorRecord[] }[];
}

/**
 * Every placeable type in a full extract. Each type learns its size,
 * connectors and instance parameters from its first placed instance that has
 * a location (and a box, when the extract recorded geometry).
 */
export function convertFullExtract(records: RevitFullExtractRecords, options: ConvertOptions = {}): ConvertResult[] {
  const connectorsOf = new Map(records.connectors.map((c) => [c.elementId, c.connectors]));
  const sampleOf = new Map<number, RevitInstanceSample>();
  for (const el of records.elements) {
    if (typeof el.typeId !== "number" || !el.location?.point) continue;
    const existing = sampleOf.get(el.typeId);
    // Prefer an instance with a box over one without.
    if (existing && (existing.bbox || !el.bbox)) continue;
    sampleOf.set(el.typeId, {
      parameters: el.parameters ?? [],
      point: el.location.point,
      rotation: el.location.rotation ?? 0,
      bbox: el.bbox ?? null,
      connectors: connectorsOf.get(el.id) ?? [],
    });
  }
  return records.types.map((t) => convertRevitType(t, sampleOf.get(t.id) ?? null, options));
}
