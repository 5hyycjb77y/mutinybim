import { qty, type Quantity } from "@permitzip/bim-units";
import type { BimElement, MepSystem, PartInstance, RunSegment, Zone } from "@permitzip/bim-kernel";
import { areaOf } from "@permitzip/bim-pack/runtime";
import { CIVIL_CLASS, CIVIL_PARAM, CIVIL_STORM_SERVICE, STRUCTURE_CLASSES, type CivilClassId } from "./ids";
import { runoffCoefficientProblem, runoffCoefficientRow } from "./runoff";

/**
 * Reads the civil elements of a model into plain storm-network inputs.
 *
 * - Structures (inlets, manholes, outfalls) are parts carrying a civil class;
 *   rim, invert (model elevation, mm) and an inlet's capacity (cfs) are the
 *   pack's parameters in their values. A structure with no invert takes one
 *   from the gravity regime.
 * - Catchments are outlined zones (class `civil.catchment`, or the built-in
 *   `drainage_catchment` purpose) with C or a surface in `values`; the inlet
 *   that serves the zone (`servedBy`) is where it drains, else the one inside it.
 * - The storm system (kind `civil.storm`) carries the design intensity and the
 *   minimum slope in `values`.
 * - Storm pipes are the system's run segments; how they join is the kernel's
 *   to say (`gravityNetworkOf`, network.ts). This reads only their size,
 *   material and roughness.
 *
 * Tolerant: anything it can't use is listed in `problems` in plain words,
 * never dropped silently.
 */

type Vec2 = { readonly x: number; readonly y: number };
type Elements = Readonly<Record<string, BimElement>>;

export interface StormStructure {
  readonly id: string;
  readonly classId: CivilClassId;
  readonly name: string;
  readonly levelId: string;
  readonly position: Vec2;
  readonly rim: Quantity<"length"> | null;
  readonly invert: Quantity<"length"> | null;
  /** Inlets: what the grate can take in. */
  readonly capacity: Quantity<"flow_liquid"> | null;
}

export interface StormCatchment {
  readonly id: string;
  readonly name: string;
  readonly levelId: string;
  readonly outline: readonly Vec2[];
  readonly area: Quantity<"area">;
  /** Null when neither a C nor a known surface is given. */
  readonly c: number | null;
  readonly cFrom: "typed" | "surface" | "none";
  readonly drainsTo: string | null;
  readonly drainsToFrom: "served_by" | "inside" | "none";
}

export interface StormPipe {
  readonly id: string;
  readonly systemId: string;
  readonly diameter: Quantity<"length"> | null;
  /** The pack row's id when the size names one (`civil.rcp`), else the built-in material. */
  readonly material: string | null;
  readonly manningN: number | null;
}

export interface StormSystemSettings {
  readonly id: string;
  readonly intensity: Quantity<"rainfall_intensity"> | null;
  readonly minSlope: Quantity<"slope"> | null;
}

export interface CivilSite {
  readonly structures: readonly StormStructure[];
  readonly catchments: readonly StormCatchment[];
  readonly pipes: readonly StormPipe[];
  readonly systems: readonly StormSystemSettings[];
  readonly problems: readonly string[];
}

function isStructureClass(id: string | undefined): id is CivilClassId {
  return id !== undefined && (STRUCTURE_CLASSES as readonly string[]).includes(id);
}

function num(values: Readonly<Record<string, unknown>> | undefined, key: string): number | null {
  const v = values?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(values: Readonly<Record<string, unknown>> | undefined, key: string): string | null {
  const v = values?.[key];
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/** Plan point-in-polygon (crossing number). */
export function insideOutline(p: Vec2, outline: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const a = outline[i];
    const b = outline[j];
    if (!a || !b) continue;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function readStructure(part: PartInstance, classId: CivilClassId, problems: string[]): StormStructure {
  const name = part.mark || part.id;
  const rim = num(part.values, CIVIL_PARAM.rimElevation);
  const invert = num(part.values, CIVIL_PARAM.invertElevation);
  const capacity = num(part.values, CIVIL_PARAM.inletCapacity);
  if (rim !== null && invert !== null && rim < invert) problems.push(`${name}'s rim is below its invert`);
  return {
    id: part.id,
    classId,
    name,
    levelId: part.levelId,
    position: part.position,
    rim: rim === null ? null : qty("length", rim, "mm"),
    invert: invert === null ? null : qty("length", invert, "mm"),
    capacity: capacity === null ? null : qty("flow_liquid", capacity, "cfs"),
  };
}

function coefficientOf(values: Readonly<Record<string, unknown>> | undefined, name: string, problems: string[]): { c: number | null; from: StormCatchment["cFrom"] } {
  const typed = num(values, CIVIL_PARAM.runoffCoefficient);
  if (typed !== null) {
    const problem = runoffCoefficientProblem(typed);
    if (!problem) return { c: typed, from: "typed" };
    problems.push(`${name}: ${problem}`);
  }
  const surface = str(values, CIVIL_PARAM.surface);
  if (surface) {
    const row = runoffCoefficientRow(surface);
    if (row) return { c: row.design, from: "surface" };
    problems.push(`${name}'s surface "${surface}" isn't one the pack knows; give it a runoff coefficient`);
    return { c: null, from: "none" };
  }
  problems.push(`${name} has no surface type or runoff coefficient, so its runoff is unknown`);
  return { c: null, from: "none" };
}

function readCatchment(zone: Zone, problems: string[]): StormCatchment | null {
  const bounds = zone.bounds;
  if (bounds?.kind !== "outline") {
    problems.push(`Catchment ${zone.name} isn't an outlined area`);
    return null;
  }
  const { c, from } = coefficientOf(zone.values, zone.name, problems);
  return {
    id: zone.id,
    name: zone.name,
    levelId: bounds.levelId,
    outline: bounds.outline,
    area: qty("area", Math.abs(areaOf({ outline: bounds.outline }).planAreaMm2), "mm2"),
    c,
    cFrom: from,
    drainsTo: zone.servedBy ?? null,
    drainsToFrom: zone.servedBy ? "served_by" : "none",
  };
}

function isStormSystem(el: BimElement | undefined): el is MepSystem {
  if (el?.kind !== "mep_system") return false;
  // Stored kinds are any registry id (`systemKindSchema`); compare as text.
  const kind: string = el.systemKind;
  return kind === CIVIL_STORM_SERVICE;
}

function isCatchmentZone(el: BimElement): el is Zone {
  return el.kind === "zone" && (el.classId === CIVIL_CLASS.catchment || (el.classId === undefined && el.purpose === "drainage_catchment"));
}

function readPipe(seg: RunSegment, problems: string[]): StormPipe {
  const size = seg.size;
  const diameterMm = size.shape === "pipe" ? size.nominalMm : size.shape === "round" ? size.diameter : null;
  if (diameterMm === null) problems.push(`Storm pipe ${seg.id} has no round size, so its capacity can't be found`);
  return {
    id: seg.id,
    systemId: seg.systemId,
    diameter: diameterMm === null ? null : qty("length", diameterMm, "mm"),
    material: size.shape === "pipe" ? (size.materialId ?? size.material) : null,
    manningN: num(seg.values, CIVIL_PARAM.manningN),
  };
}

/** Read every civil storm element in `elements`. */
export function readCivilSite(elements: Elements): CivilSite {
  const problems: string[] = [];
  const structures: StormStructure[] = [];
  const catchments: StormCatchment[] = [];
  const pipes: StormPipe[] = [];
  const systems: StormSystemSettings[] = [];
  for (const el of Object.values(elements)) {
    if (el.kind === "part" && isStructureClass(el.classId)) structures.push(readStructure(el, el.classId, problems));
    else if (isCatchmentZone(el)) {
      const c = readCatchment(el, problems);
      if (c) catchments.push(c);
    } else if (el.kind === "run_segment" && el.domain === "pipe" && isStormSystem(elements[el.systemId])) pipes.push(readPipe(el, problems));
    else if (isStormSystem(el)) {
      const i = num(el.values, CIVIL_PARAM.designIntensity);
      const s = num(el.values, CIVIL_PARAM.minSlope);
      systems.push({ id: el.id, intensity: i === null ? null : qty("rainfall_intensity", i, "in/h"), minSlope: s === null ? null : qty("slope", s, "%") });
    }
  }

  const byId = new Map(structures.map((s) => [s.id, s]));
  const inlets = structures.filter((s) => s.classId === CIVIL_CLASS.stormInlet);
  const resolved = catchments.map((c): StormCatchment => {
    if (c.drainsTo) {
      if (!byId.has(c.drainsTo)) problems.push(`${c.name} is served by ${c.drainsTo}, which isn't a storm structure in this model`);
      return c;
    }
    const inside = inlets.filter((i) => insideOutline(i.position, c.outline));
    if (inside.length === 1 && inside[0]) return { ...c, drainsTo: inside[0].id, drainsToFrom: "inside" };
    problems.push(inside.length === 0 ? `${c.name} has no inlet inside it and no inlet serves it` : `${c.name} holds ${inside.length} inlets; say which one serves it`);
    return c;
  });

  return { structures, catchments: resolved, pipes, systems, problems };
}
