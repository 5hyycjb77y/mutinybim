import { formatParam, resolveConnectors, type ParamDef, type PartTypeDefinition, type SystemKind } from "../parts";
import { DEFAULT_PARTITION, DEFAULT_SETTINGS, asRevision, type BimElement, type ModelState, type ParamValue, type RunSegment } from "../types";
import type { MepSystem } from "../routing/types";
import { runAirway, runOuterSize, insulationLabel, linerSurface, thicknessLabel } from "../routing/run-insulation";
import { pipeDims, specOfSize } from "../routing/pipe/specs";
import { activePackSet } from "../packs/scope";
import { PACK_READ_POINT } from "../packs/points";
import { headlineKindValue, storedField } from "../kinds";
import { elementKindTable } from "../registry/element-kind-point";
import { sizeLabel } from "../routing/rules";
import { resolveField } from "../fields/resolver";
import type { SheetRevision } from "../documents";

/**
 * One element's v1 schedule record: its values as they print and its numbers
 * in their stored unit. Shared by the v1 table (`schedule.ts`, which prints
 * exactly as before) and the v2 row engine's v1 field vocabulary
 * (`engine/fields.ts`), so both read the model the same way.
 */

/** Fields of a duct schedule, after the base fields. */
export const DUCT_FIELDS: Readonly<Record<string, string>> = {
  system: "SYSTEM",
  size: "SIZE",
  insulation: "INSULATION",
  liner_surface: "LINER SURFACE",
  inside_size: "INSIDE SIZE",
  outside_size: "OUTSIDE SIZE",
  length: "LENGTH",
  cfm: "CFM",
  velocity_fpm: "VELOCITY (FPM)",
  friction_in_per_100ft: "FRICTION (IN/100 FT)",
};

/** Fields of a pipe schedule, after the base fields. */
export const PIPE_FIELDS: Readonly<Record<string, string>> = {
  system: "SYSTEM",
  size: "SIZE",
  material: "MATERIAL",
  insulation: "INSULATION",
  insulation_thickness: "INSULATION THICKNESS",
  outside_size: "OUTSIDE DIAMETER (INSULATED)",
  length: "LENGTH",
};

/** Live electrical fields of anything with a power connector (fields/resolver.ts). */
export const POWERED_FIELDS: Readonly<Record<string, string>> = {
  voltage_phase: "VOLTS/PH",
  load: "LOAD (VA)",
  circuit: "CIRCUIT",
  panel: "PANEL",
  "circuit.breaker": "BREAKER",
  "circuit.conductors": "CONDUCTORS",
};

/** Live fields of distribution equipment. */
export const PANEL_FIELDS: Readonly<Record<string, string>> = {
  supply_from: "SUPPLY FROM",
  bus: "BUS",
  mains_text: "MAINS",
  volts: "VOLTAGE",
  connected_kva: "CONNECTED (kVA)",
  demand_kva: "DEMAND (kVA)",
};

/** Fields every element schedule has, before the category's parameters. */
export const BASE_FIELDS: Readonly<Record<string, string>> = {
  mark: "MARK",
  family: "FAMILY",
  type: "TYPE",
  level: "LEVEL",
  count: "COUNT",
};

export const SHEET_FIELDS: Readonly<Record<string, string>> = {
  number: "SHEET NUMBER",
  name: "SHEET NAME",
  revision: "REV",
  revision_date: "REV DATE",
  revision_description: "REV DESCRIPTION",
};

export interface Record_ {
  readonly ids: readonly string[];
  readonly values: Readonly<Record<string, string>>;
  readonly numbers: Readonly<Record<string, number>>;
}

function paramRecord(defs: readonly ParamDef[], values: Readonly<Record<string, string | number | boolean>>, into: Record<string, string>, numbers: Record<string, number>): void {
  for (const def of defs) {
    const v = values[def.name] ?? def.default;
    if (v === undefined) continue;
    into[def.name] = formatParam(def, v);
    if (typeof v === "number") numbers[def.name] = v;
  }
}

/** Level names by id: the one-pass index on a full evaluation, a direct read in the incremental engine. */
export type LevelNames = Pick<ReadonlyMap<string, string>, "get">;

/** One row's raw values for an element of the category. */
export function elementRecord(model: Pick<ModelState, "elements">, el: BimElement, levels: LevelNames): Record_ | null {
  if (el.kind === "part") {
    const type = model.elements[el.typeId];
    if (type?.kind !== "part_type") return null;
    const def = type.definition;
    const values: Record<string, string> = { mark: el.mark, family: def.familyName, type: def.typeName, level: levels.get(el.levelId) ?? "" };
    const numbers: Record<string, number> = {};
    paramRecord(def.typeParams, def.typeValues, values, numbers);
    paramRecord(def.instanceParams, el.values, values, numbers);
    const cfm = partAirflowCfm(def, el.values);
    if (cfm !== null && values.cfm === undefined) {
      values.cfm = String(Math.round(cfm));
      numbers.cfm = cfm;
    }
    return { ids: [el.id], values, numbers };
  }
  const level = (el.partition ?? DEFAULT_PARTITION).level;
  const table = elementKindTable();
  const row = table.row(el.kind);
  if (row?.scheduleListing !== undefined) {
    // The kind's headline value (its add-on's row) keeps its stored column key.
    const own = headlineKindValue(el, table)?.value ?? 0;
    return { ids: [el.id], values: { mark: textOf(el, "mark"), family: row.scheduleFamily ?? row.label, type: textOf(el, "typeName"), level, cfm: String(Math.round(own)) }, numbers: { cfm: own } };
  }
  if (el.kind === "run_segment") return el.domain === "pipe" ? pipeRecord(model, el, levels) : ductRecord(model, el, levels);
  return null;
}

const textOf = (el: object, name: string): string => {
  const v = storedField(el, name);
  return typeof v === "string" ? v : "";
};

/** Which air a part's CFM is: what it supplies, else what it exhausts, returns or takes in. */
const AIRFLOW_ORDER: readonly SystemKind[] = ["supply_air", "exhaust_air", "return_air", "outside_air"];

/** A part's airflow from its duct connectors' design flow (the CFM column), null when it moves no air. */
function partAirflowCfm(def: PartTypeDefinition, values: Readonly<Record<string, ParamValue>>): number | null {
  if (!def.connectors.some((c) => c.domain === "duct" && c.flow !== undefined)) return null;
  // Most flows read type values only: work those out once per type, not once per placed part.
  const known = typeAirflow.get(def);
  if (known !== undefined) return known;
  const cfm = airflowOf(def, values);
  const flows = JSON.stringify(def.connectors.map((c) => c.flow ?? null));
  if (!def.instanceParams.some((p) => flows.includes(p.name))) typeAirflow.set(def, cfm);
  return cfm;
}

const typeAirflow = new WeakMap<PartTypeDefinition, number | null>();

function airflowOf(def: PartTypeDefinition, values: Readonly<Record<string, ParamValue>>): number | null {
  const ducts = resolveConnectors(def, values).filter((c) => c.domain === "duct" && c.flow !== undefined && c.flow > 0);
  for (const kind of AIRFLOW_ORDER) {
    const of = ducts.filter((c) => c.systemKind === kind);
    if (of.length > 0) return of.reduce((sum, c) => sum + (c.flow ?? 0), 0);
  }
  return null;
}

const LINER_SURFACE_WORD: Readonly<Record<string, string>> = { faced: "Faced", spray_coated: "Spray-coated", none: "" };
const SHAPE_WORD: Readonly<Record<string, string>> = { rect: "Rectangular", round: "Round", oval: "Flat oval" };

/** The pack read that says how a run performs at its flow (velocity, friction); its add-on contributes it. */
export const RUN_PERFORMANCE_READ = "run_performance";

/** What `RUN_PERFORMANCE_READ` is given and answers. */
export interface RunPerformanceInput {
  readonly flow: number;
  readonly size: RunSegment["size"];
  readonly insulation: RunSegment["insulation"];
  readonly design: MepSystem["design"];
}
export interface RunPerformanceAnswer {
  readonly velocityFpm: number;
  readonly frictionInPer100Ft: number;
}

const isAnswer = (v: unknown): v is RunPerformanceAnswer => typeof v === "object" && v !== null && typeof Reflect.get(v, "velocityFpm") === "number" && typeof Reflect.get(v, "frictionInPer100Ft") === "number";

/** A run's velocity and friction from the add-on that reads it; null when no add-on here does, or it can't (a size it doesn't flow). */
function runPerformance(model: Pick<ModelState, "elements">, el: RunSegment, design: MepSystem["design"]): RunPerformanceAnswer | null {
  const read = activePackSet().items(PACK_READ_POINT).find((r) => r.id === RUN_PERFORMANCE_READ);
  if (!read) return null;
  const input: RunPerformanceInput = { flow: el.flow, size: el.size, insulation: el.insulation, design };
  // The read answers from its input alone; it gets the records it may look up and nothing else.
  const answer = read.run({ modelId: "", revision: asRevision(0), elements: model.elements, connections: [], settings: DEFAULT_SETTINGS }, input);
  return isAnswer(answer) ? answer : null;
}

function ductRecord(model: Pick<ModelState, "elements">, el: RunSegment, levels: LevelNames): Record_ {
  const system = model.elements[el.systemId];
  const design = system?.kind === "mep_system" ? system.design : undefined;
  const lengthMm = Math.hypot(el.end.x - el.start.x, el.end.y - el.start.y, el.end.z - el.start.z);
  const perf = el.flow > 0 ? runPerformance(model, el, design) : null;
  const r = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;
  const values: Record<string, string> = {
    mark: "",
    family: "Duct",
    type: SHAPE_WORD[el.size.shape] ?? el.size.shape,
    level: levels.get(el.levelId) ?? (el.partition ?? DEFAULT_PARTITION).level,
    system: system?.kind === "mep_system" ? system.name : "",
    size: sizeLabel(el.size),
    insulation: el.insulation ? insulationLabel(el.insulation) : "",
    liner_surface: LINER_SURFACE_WORD[linerSurface(el.insulation) ?? "none"] ?? "",
    inside_size: sizeLabel(runAirway(el.size, el.insulation)),
    outside_size: sizeLabel(runOuterSize(el.size, el.insulation)),
    length: feetInchesLabel(lengthMm),
    cfm: el.flow > 0 ? String(Math.round(el.flow)) : "",
    velocity_fpm: perf ? String(Math.round(perf.velocityFpm)) : "",
    friction_in_per_100ft: perf ? String(r(perf.frictionInPer100Ft, 3)) : "",
  };
  const numbers: Record<string, number> = { length: lengthMm, cfm: el.flow, ...(perf ? { velocity_fpm: perf.velocityFpm, friction_in_per_100ft: perf.frictionInPer100Ft } : {}) };
  return { ids: [el.id], values, numbers };
}

function pipeRecord(model: Pick<ModelState, "elements">, el: RunSegment, levels: LevelNames): Record_ {
  const system = model.elements[el.systemId];
  const lengthMm = Math.hypot(el.end.x - el.start.x, el.end.y - el.start.y, el.end.z - el.start.z);
  const spec = el.size.shape === "pipe" ? specOfSize(el.size) : null;
  const odMm = el.size.shape === "pipe" ? pipeDims(el.size).odMm : 0;
  const wrap = el.insulation?.kind === "wrap" ? el.insulation.thicknessMm : 0;
  const values: Record<string, string> = {
    mark: "",
    family: "Pipe",
    type: spec?.name ?? "",
    level: levels.get(el.levelId) ?? (el.partition ?? DEFAULT_PARTITION).level,
    system: system?.kind === "mep_system" ? system.name : "",
    size: sizeLabel(el.size),
    material: spec?.name ?? "",
    insulation: el.insulation ? insulationLabel(el.insulation) : "",
    insulation_thickness: el.insulation ? thicknessLabel(el.insulation.thicknessMm) : "",
    outside_size: odMm > 0 ? `${Math.round(((odMm + 2 * wrap) / 25.4) * 100) / 100}"` : "",
    length: feetInchesLabel(lengthMm),
  };
  const numbers: Record<string, number> = { length: lengthMm, ...(el.size.shape === "pipe" ? { size: el.size.nominalMm } : {}), ...(el.insulation ? { insulation_thickness: el.insulation.thicknessMm } : {}) };
  return { ids: [el.id], values, numbers };
}

function feetInchesLabel(mm: number): string {
  const totalIn = Math.round(mm / 25.4);
  return `${Math.floor(totalIn / 12)}'-${totalIn % 12}"`;
}

export function isDeleted(el: BimElement): boolean {
  return "deleted" in el && el.deleted === true;
}

export function lastRevision(revisions: readonly SheetRevision[] | undefined): SheetRevision | undefined {
  return revisions && revisions.length > 0 ? revisions[revisions.length - 1] : undefined;
}

/** The same live values tags and form schedules print (fields/resolver.ts), never a copy typed into a parameter. */
export function withRelationshipFields(model: Pick<ModelState, "elements">, id: string, rec: Record_, paths: readonly string[]): Record_ {
  const values = { ...rec.values };
  const numbers = { ...rec.numbers };
  for (const p of paths) {
    const v = resolveField(model.elements, id, p);
    values[p] = v.text;
    if (typeof v.value === "number") numbers[p] = v.value;
    else delete numbers[p];
  }
  return { ids: rec.ids, values, numbers };
}

/**
 * One element's v1 values for the v2 row engine (`engine/fields.ts`):
 * text as it prints, numbers in their stored unit, and the ids the record
 * read (the element, its part type, its level). Reads by id only; never
 * scans the model. Null when the element is not something a v1 schedule lists.
 */
export function legacyScheduleRecord(
  model: Pick<ModelState, "elements">,
  el: BimElement,
  relationshipFields: readonly string[],
): { readonly values: Readonly<Record<string, string>>; readonly numbers: Readonly<Record<string, number>>; readonly reads: readonly string[] } | null {
  if (el.kind === "sheet") {
    if (el.deleted) return null;
    const rev = lastRevision(el.props?.revisions);
    return { values: { number: el.number, name: el.title, revision: rev?.number ?? "", revision_date: rev?.date ?? "", revision_description: rev?.description ?? "" }, numbers: {}, reads: [el.id] };
  }
  if (isDeleted(el)) return null;
  const levelName: LevelNames = {
    get: (id) => {
      const level = model.elements[id];
      return level?.kind === "level" ? level.name : undefined;
    },
  };
  const base = elementRecord(model, el, levelName);
  if (!base) return null;
  const reads = [el.id];
  if (el.kind === "part") reads.push(el.typeId, el.levelId);
  else if (el.kind === "run_segment") reads.push(el.levelId, el.systemId);
  const rec = relationshipFields.length > 0 && (el.kind === "part" || el.kind === "service_link") ? withRelationshipFields(model, el.id, base, relationshipFields) : base;
  return { values: rec.values, numbers: rec.numbers, reads };
}
