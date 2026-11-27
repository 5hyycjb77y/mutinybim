import { to } from "@permitzip/bim-units";
import type { BimElement, FieldProvider, FieldWriter } from "@permitzip/bim-kernel";
import { CIVIL_CLASS, STRUCTURE_CLASSES } from "./ids";
import { solveStormNetwork, type StormNetworkResult, type StormPipeResult } from "./network";
import { decodeGradingRecord, gradingSurfaceStats } from "./surfaces";

/**
 * Derived fields for Civil schedules and the Inspector (`FIELD_PROVIDER_POINT`).
 * Parameter-backed fields (rim, invert, inlet capacity, catchment surface, C,
 * design intensity, min slope, Manning's n) come from `CIVIL_PARAMETER_SETS`;
 * this provider adds the live solved network totals, pipe slopes/capacities,
 * catchment runoff, and TIN grading surface stats.
 */

type Field = NonNullable<FieldProvider["fields"]>[number];
type Elements = Readonly<Record<string, BimElement>>;

const locked = (reason: string): FieldWriter => ({ kind: "none", reason });
const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

const READS_STORM = { elementKinds: ["part", "run_segment", "zone", "mep_system"] } as const;

interface StormIndex {
  readonly solved: StormNetworkResult;
  readonly structureName: ReadonlyMap<string, string>;
  readonly structureDepthMm: ReadonlyMap<string, number>;
  readonly pipeBySegment: ReadonlyMap<string, StormPipeResult>;
  readonly catchmentById: ReadonlyMap<string, StormNetworkResult["site"]["catchments"][number]>;
}

const stormCache = new WeakMap<Elements, StormIndex>();

function stormIndexOf(elements: Elements): StormIndex {
  const hit = stormCache.get(elements);
  if (hit) return hit;
  const solved = solveStormNetwork(elements);
  const structureName = new Map<string, string>();
  const structureDepthMm = new Map<string, number>();
  for (const s of solved.site.structures) {
    structureName.set(s.id, s.name);
    if (s.rim !== null && s.invert !== null) {
      structureDepthMm.set(s.id, to(s.rim, "mm") - to(s.invert, "mm"));
    }
  }
  const pipeBySegment = new Map<string, StormPipeResult>();
  for (const p of solved.pipes) {
    pipeBySegment.set(p.id, p);
    const segId = solved.runs.segmentOf.get(p.id);
    if (segId) pipeBySegment.set(segId, p);
  }
  const catchmentById = new Map(solved.site.catchments.map((c) => [c.id, c] as const));
  const idx: StormIndex = { solved, structureName, structureDepthMm, pipeBySegment, catchmentById };
  stormCache.set(elements, idx);
  return idx;
}

function pipeDiameterMm(el: BimElement): number | null {
  if (el.kind !== "run_segment") return null;
  if (el.size.shape === "pipe") return el.size.nominalMm;
  if (el.size.shape === "round") return el.size.diameter;
  return null;
}

function pipeStatus(p: StormPipeResult): string {
  const slope = p.gravity?.slope;
  if (slope !== null && slope !== undefined && slope <= 0) return "Backfall";
  if (p.gravity?.status === "too_flat") return "Flat";
  if (p.flow !== null && p.capacity !== null && p.flow > p.capacity) return "Surcharged";
  return "OK";
}

const derivedQuantity = (
  path: string,
  label: string,
  classes: readonly string[],
  kind: NonNullable<Field["kind"]>,
  unit: NonNullable<Field["unit"]>,
  group: string,
  read: (el: BimElement, els: Elements) => number | null,
  deps?: Field["deps"],
): Field => ({
  path,
  label,
  classes,
  valueType: "quantity",
  kind,
  unit,
  writer: locked("Computed by the civil add-on."),
  group,
  ...(deps ? { deps } : {}),
  read: (el, ctx) => finite(read(el, ctx.elements)),
});

const derivedText = (
  path: string,
  label: string,
  classes: readonly string[],
  group: string,
  read: (el: BimElement, els: Elements) => string | null,
  deps?: Field["deps"],
): Field => ({
  path,
  label,
  classes,
  valueType: "text",
  writer: locked("Computed by the civil add-on."),
  group,
  ...(deps ? { deps } : {}),
  read: (el, ctx) => read(el, ctx.elements),
});

function structureTypeLabel(el: BimElement): string | null {
  if (el.kind !== "part") return null;
  if (el.classId === CIVIL_CLASS.stormInlet) return "Storm Inlet";
  if (el.classId === CIVIL_CLASS.manhole) return "Manhole";
  if (el.classId === CIVIL_CLASS.outfall) return "Outfall";
  return null;
}

export const CIVIL_FIELD_PROVIDER: FieldProvider = {
  id: "civil.site",
  fields: [
    // Storm structure derived fields
    derivedText("civil.structure_type", "Structure type", STRUCTURE_CLASSES, "Identity", (el) => structureTypeLabel(el)),
    derivedQuantity("civil.structure_depth", "Structure depth", STRUCTURE_CLASSES, "length", "mm", "Drainage", (el, els) => stormIndexOf(els).structureDepthMm.get(el.id) ?? null, READS_STORM),
    derivedQuantity("civil.surface_runoff", "Surface runoff", STRUCTURE_CLASSES, "flow_liquid", "cfs", "Drainage", (el, els) => {
      const q = stormIndexOf(els).solved.surfaceRunoff.get(el.id);
      return q === undefined ? null : to(q, "cfs");
    }, READS_STORM),
    derivedQuantity("civil.total_runoff", "Total runoff", STRUCTURE_CLASSES, "flow_liquid", "cfs", "Drainage", (el, els) => {
      const q = stormIndexOf(els).solved.totalRunoff.get(el.id);
      return q === undefined ? null : to(q, "cfs");
    }, READS_STORM),
    derivedText("civil.downstream_structure", "Drains to", STRUCTURE_CLASSES, "Drainage", (el, els) => {
      const idx = stormIndexOf(els);
      if (!idx.solved.downstream.has(el.id)) return null;
      const next = idx.solved.downstream.get(el.id);
      if (next === null || next === undefined) return "Outfall";
      return idx.structureName.get(next) ?? next;
    }, READS_STORM),

    // Storm pipe derived fields
    derivedText("civil.pipe_from", "Upstream", [CIVIL_CLASS.stormPipe], "Drainage", (el, els) => {
      const idx = stormIndexOf(els);
      const p = idx.pipeBySegment.get(el.id);
      return p ? (idx.structureName.get(p.from) ?? p.from) : null;
    }, READS_STORM),
    derivedText("civil.pipe_to", "Downstream", [CIVIL_CLASS.stormPipe], "Drainage", (el, els) => {
      const idx = stormIndexOf(els);
      const p = idx.pipeBySegment.get(el.id);
      return p ? (idx.structureName.get(p.to) ?? p.to) : null;
    }, READS_STORM),
    derivedQuantity("civil.pipe_diameter", "Diameter", [CIVIL_CLASS.stormPipe], "length", "mm", "Drainage", (el) => pipeDiameterMm(el)),
    derivedQuantity("civil.pipe_length", "Pipe length", [CIVIL_CLASS.stormPipe], "length", "mm", "Drainage", (el, els) => {
      const p = stormIndexOf(els).pipeBySegment.get(el.id);
      return p ? to(p.length, "mm") : null;
    }, READS_STORM),
    derivedQuantity("civil.pipe_slope", "Slope", [CIVIL_CLASS.stormPipe], "slope", "%", "Drainage", (el, els) => {
      const slope = stormIndexOf(els).pipeBySegment.get(el.id)?.gravity?.slope;
      return slope === null || slope === undefined ? null : slope * 100;
    }, READS_STORM),
    derivedQuantity("civil.pipe_flow", "Design flow", [CIVIL_CLASS.stormPipe], "flow_liquid", "cfs", "Drainage", (el, els) => {
      const q = stormIndexOf(els).pipeBySegment.get(el.id)?.flow;
      return q === null || q === undefined ? null : to(q, "cfs");
    }, READS_STORM),
    derivedQuantity("civil.pipe_capacity", "Full capacity", [CIVIL_CLASS.stormPipe], "flow_liquid", "cfs", "Drainage", (el, els) => {
      const cap = stormIndexOf(els).pipeBySegment.get(el.id)?.capacity;
      return cap === null || cap === undefined ? null : to(cap, "cfs");
    }, READS_STORM),
    derivedText("civil.pipe_status", "Hydraulic status", [CIVIL_CLASS.stormPipe], "Drainage", (el, els) => {
      const p = stormIndexOf(els).pipeBySegment.get(el.id);
      return p ? pipeStatus(p) : null;
    }, READS_STORM),

    // Catchment derived fields
    derivedText("civil.catchment_name", "Catchment", [CIVIL_CLASS.catchment], "Identity", (el) => (el.kind === "zone" ? el.name : null)),
    derivedQuantity("civil.catchment_area", "Catchment area", [CIVIL_CLASS.catchment], "area", "m2", "Drainage", (el, els) => {
      const c = stormIndexOf(els).catchmentById.get(el.id);
      return c ? to(c.area, "m2") : null;
    }, READS_STORM),
    derivedQuantity("civil.effective_c", "Effective C", [CIVIL_CLASS.catchment], "ratio", "1", "Drainage", (el, els) => stormIndexOf(els).catchmentById.get(el.id)?.c ?? null, READS_STORM),
    derivedText("civil.drains_to", "Drains to", [CIVIL_CLASS.catchment], "Drainage", (el, els) => {
      const idx = stormIndexOf(els);
      const target = idx.catchmentById.get(el.id)?.drainsTo;
      return target ? (idx.structureName.get(target) ?? target) : null;
    }, READS_STORM),
    derivedQuantity("civil.catchment_runoff", "Peak runoff", [CIVIL_CLASS.catchment], "flow_liquid", "cfs", "Drainage", (el, els) => {
      const q = stormIndexOf(els).solved.catchmentRunoff.get(el.id);
      return q === undefined ? null : to(q, "cfs");
    }, READS_STORM),

    // Grading surface derived fields
    derivedText("civil.surface_name", "Surface", [CIVIL_CLASS.gradingSurface], "Identity", (el) => {
      const d = decodeGradingRecord(el);
      return d.ok ? d.surface.name : null;
    }),
    derivedText("civil.surface_role", "Role", [CIVIL_CLASS.gradingSurface], "Grading", (el) => {
      const d = decodeGradingRecord(el);
      return d.ok ? d.surface.role : null;
    }),
    derivedText("civil.surface_unit", "Source unit", [CIVIL_CLASS.gradingSurface], "Grading", (el) => {
      const d = decodeGradingRecord(el);
      return d.ok ? d.surface.sourceLinearUnit : null;
    }),
    derivedQuantity("civil.surface_vertices", "Vertices", [CIVIL_CLASS.gradingSurface], "dimensionless", "1", "Grading", (el) => {
      const d = decodeGradingRecord(el);
      return d.ok ? d.surface.points.length : null;
    }),
    derivedQuantity("civil.surface_faces", "Triangles", [CIVIL_CLASS.gradingSurface], "dimensionless", "1", "Grading", (el) => {
      const d = decodeGradingRecord(el);
      return d.ok ? d.surface.faces.length : null;
    }),
    derivedQuantity("civil.surface_area", "Plan area", [CIVIL_CLASS.gradingSurface], "area", "m2", "Grading", (el) => {
      const d = decodeGradingRecord(el);
      return d.ok ? (gradingSurfaceStats(d.surface)?.planAreaM2 ?? null) : null;
    }),
    derivedQuantity("civil.surface_min_elevation", "Min elevation", [CIVIL_CLASS.gradingSurface], "length", "mm", "Grading", (el) => {
      const d = decodeGradingRecord(el);
      return d.ok ? (gradingSurfaceStats(d.surface)?.minElevationMm ?? null) : null;
    }),
    derivedQuantity("civil.surface_max_elevation", "Max elevation", [CIVIL_CLASS.gradingSurface], "length", "mm", "Grading", (el) => {
      const d = decodeGradingRecord(el);
      return d.ok ? (gradingSurfaceStats(d.surface)?.maxElevationMm ?? null) : null;
    }),
  ],
};
