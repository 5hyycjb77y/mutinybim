import { to } from "@permitzip/bim-units";
import type { ModelState, PackReadDef } from "@permitzip/bim-pack/runtime";
import { inletOverloadFindings, slopeFindings } from "./checks";
import { solveStormNetwork } from "./network";
import { gradingSurfaceStats, readGradingSurfaces } from "./surfaces";

/**
 * Pure model reads contributed by the Civil add-on (`PACK_READ_POINT`),
 * callable from any bim-script via `ctx.read("civil.storm_network", ...)`
 * or `ctx.read("civil.grading_surfaces")`.
 */

function readOptionalId(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const id = (input as { elementId?: unknown }).elementId;
  return typeof id === "string" && id.trim() !== "" ? id.trim() : null;
}

function round(n: number, digits = 3): number {
  const k = 10 ** digits;
  return Math.round(n * k) / k;
}

function traceDownstream(startId: string, downstream: ReadonlyMap<string, string | null>): readonly string[] {
  const path: string[] = [];
  const seen = new Set<string>();
  let cur: string | null | undefined = startId;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    path.push(cur);
    cur = downstream.get(cur);
  }
  return path;
}

function collectUpstream(startId: string, upstream: ReadonlyMap<string, readonly string[]>): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>([startId]);
  const queue = [...(upstream.get(startId) ?? [])];
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i];
    if (!cur || seen.has(cur)) continue;
    seen.add(cur);
    out.push(cur);
    for (const next of upstream.get(cur) ?? []) queue.push(next);
  }
  return out;
}

export const CIVIL_STORM_NETWORK_READ: PackReadDef = {
  id: "civil.storm_network",
  label: "Civil storm network (follow the water: structures, catchments, pipes, runoff & findings)",
  run(model: ModelState, input: unknown) {
    const solved = solveStormNetwork(model.elements);
    const findings = [...inletOverloadFindings(solved), ...slopeFindings(solved)];
    const structureNames = new Map(solved.site.structures.map((s) => [s.id, s.name] as const));
    const focusId = readOptionalId(input);

    const structures = solved.site.structures.map((s) => {
      const surfaceCfs = solved.surfaceRunoff.get(s.id);
      const totalCfs = solved.totalRunoff.get(s.id);
      const next = solved.downstream.get(s.id);
      return {
        id: s.id,
        name: s.name,
        classId: s.classId,
        rim_ft: s.rim === null ? null : round(to(s.rim, "ft"), 2),
        invert_ft: s.invert === null ? null : round(to(s.invert, "ft"), 2),
        inlet_capacity_cfs: s.capacity === null ? null : round(to(s.capacity, "cfs"), 2),
        surface_runoff_cfs: surfaceCfs === undefined ? null : round(to(surfaceCfs, "cfs"), 3),
        total_runoff_cfs: totalCfs === undefined ? null : round(to(totalCfs, "cfs"), 3),
        downstreamId: next ?? null,
        downstreamName: next ? (structureNames.get(next) ?? next) : null,
      };
    });

    const catchments = solved.site.catchments.map((c) => {
      const q = solved.catchmentRunoff.get(c.id);
      return {
        id: c.id,
        name: c.name,
        area_ft2: round(to(c.area, "ft2"), 1),
        area_ac: round(to(c.area, "acre"), 4),
        c: c.c,
        cFrom: c.cFrom,
        drainsToId: c.drainsTo,
        drainsToName: c.drainsTo ? (structureNames.get(c.drainsTo) ?? c.drainsTo) : null,
        runoff_cfs: q === undefined ? null : round(to(q, "cfs"), 3),
      };
    });

    const pipes = solved.pipes.map((p) => {
      const rawPipe = solved.site.pipes.find((sp) => sp.id === (solved.runs.segmentOf.get(p.id) ?? p.id));
      return {
        id: p.id,
        fromId: p.from,
        fromName: structureNames.get(p.from) ?? p.from,
        toId: p.to,
        toName: structureNames.get(p.to) ?? p.to,
        diameter_in: rawPipe?.diameter ? round(to(rawPipe.diameter, "in"), 1) : null,
        material: rawPipe?.material ?? null,
        length_ft: round(to(p.length, "ft"), 2),
        slope_pct: p.gravity?.slope === null || p.gravity?.slope === undefined ? null : round(p.gravity.slope * 100, 3),
        meetsMinSlope: p.gravity ? p.gravity.status !== "too_flat" : null,
        flow_cfs: p.flow === null ? null : round(to(p.flow, "cfs"), 3),
        capacity_cfs: p.capacity === null ? null : round(to(p.capacity, "cfs"), 3),
      };
    });

    const focus = focusId
      ? (() => {
          const catchment = solved.site.catchments.find((c) => c.id === focusId);
          const startNode = catchment?.drainsTo ?? (solved.downstream.has(focusId) ? focusId : null);
          const downstreamIds = startNode ? traceDownstream(startNode, solved.downstream) : [];
          const upstreamIds = startNode ? collectUpstream(startNode, solved.upstream) : [];
          const upstreamSet = new Set([startNode, ...upstreamIds].filter((v): v is string => v !== null));
          const contributingCatchmentIds = solved.site.catchments
            .filter((c) => c.drainsTo !== null && upstreamSet.has(c.drainsTo))
            .map((c) => c.id);
          return {
            elementId: focusId,
            upstreamStructureIds: upstreamIds,
            downstreamPathIds: downstreamIds,
            contributingCatchmentIds,
          };
        })()
      : null;

    return {
      design_intensity_in_per_h: solved.intensity === null ? null : round(to(solved.intensity, "in/h"), 2),
      min_slope_pct: round(to(solved.minSlope, "%"), 2),
      outfallIds: solved.outfalls,
      structures,
      catchments,
      pipes,
      findings: findings.map((f) => ({ rule: f.rule, severity: f.severity, elementIds: f.elementIds, message: f.message })),
      problems: solved.problems,
      ...(focus ? { focus } : {}),
    };
  },
};

export const CIVIL_GRADING_SURFACES_READ: PackReadDef = {
  id: "civil.grading_surfaces",
  label: "Civil LandXML grading TIN surfaces (metadata, bounds, plan area)",
  run(model: ModelState) {
    const { surfaces, problems } = readGradingSurfaces(model.elements);
    return {
      surfaces: surfaces.map((s) => {
        const stats = gradingSurfaceStats(s);
        return {
          id: s.id,
          name: s.name,
          role: s.role,
          linearUnit: s.linearUnit,
          sourceLinearUnit: s.sourceLinearUnit,
          points: s.points.length,
          faces: s.faces.length,
          plan_area_ft2: stats ? round(stats.planAreaM2 * 10.763910416709722, 1) : 0,
          min_elevation_ft: stats ? round(stats.minElevationMm / 304.8, 2) : null,
          max_elevation_ft: stats ? round(stats.maxElevationMm / 304.8, 2) : null,
        };
      }),
      problems,
    };
  },
};

export const CIVIL_PACK_READS: readonly PackReadDef[] = [CIVIL_STORM_NETWORK_READ, CIVIL_GRADING_SURFACES_READ];
