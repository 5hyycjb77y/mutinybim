/**
 * @jest-environment node
 *
 * Pipe drawn at its real size, and sloped pipe fittings in sections and print.
 * Review video (V1, 7:43): "make sure our piping represents real life dimensions,
 * inner and outer". Before, straight pipe drew at its nominal size (4" PVC as
 * 4.0") while its fittings drew at the spec's outside diameter (4.5"), and in
 * sections and printed views a pipe fitting drew nothing and the straights ran
 * on through it to the corner.
 */
import { DEFAULT_SETTINGS, isPipeMaterial, isStoredPipeSpec, pipeProducts, drawnWidth, fittingBody, planCommit, segmentRings, type Command, type ModelState, type RunFitting, type RunPoint, type RunSegment, type RunSize } from "../src";
import { elementSolid, type Piece } from "../src/drawing/solids";

const FT = 304.8;
const IN = 25.4;

function commit(model: ModelState, command: Command): ModelState {
  const d = planCommit(model, [], { idempotencyKey: `pd-${model.revision}-key`, baseRevision: model.revision, actor: { id: "p", name: "P", kind: "human" }, command }, () => "2026-10-23T00:00:00.000Z");
  if (!d.ok) throw new Error(`${command.type}: ${d.error.message}`);
  return d.model;
}

function empty(): ModelState {
  const m: ModelState = { modelId: "pd", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  return commit(m, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
}

const centroid = (pts: readonly RunPoint[]): RunPoint => ({
  x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
  y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
  z: pts.reduce((s, p) => s + p.z, 0) / pts.length,
});
const dist = (a: RunPoint, b: RunPoint) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const across = (pts: readonly RunPoint[]) => Math.max(...pts.map((p) => dist(p, centroid(pts)))) * 2;

describe("pipe draws at the outside diameter of its product standard", () => {
  it.each(pipeProducts().map((s) => [s.name, s] as const))("%s: every size draws at the listed OD", (_name, spec) => {
    for (const row of spec.sizes) {
      if (!isStoredPipeSpec(spec.spec) || !isPipeMaterial(spec.materialId)) throw new Error(`${spec.id} is not a stored built-in product`);
      const size: RunSize = { shape: "pipe", nominalMm: row.nominalIn * IN, material: spec.materialId, spec: spec.spec };
      expect(drawnWidth(size)).toBeCloseTo(row.odMm, 6);
    }
  });

  it.each([
    ["4\" PVC DWV sanitary", { shape: "pipe", nominalMm: 4 * IN, material: "pvc" }, "sanitary", 4.5 * IN],
    ["1\" PEX cold water", { shape: "pipe", nominalMm: 1 * IN, material: "pex" }, "domestic_cold_water", 1.125 * IN],
    ["2\" black steel gas", { shape: "pipe", nominalMm: 2 * IN, material: "black_steel" }, "natural_gas", 2.375 * IN],
    ["4\" cast iron no-hub", { shape: "pipe", nominalMm: 4 * IN, material: "cast_iron" }, "sanitary", 4.38 * IN],
  ] as const)("a routed %s draws at its OD in 3D rings, sections and print", (_label, size, kind, odMm) => {
    let m = empty();
    m = commit(m, { type: "route_run", idPrefix: "p", levelId: "lvl-1", domain: "pipe", size, elevationMm: -2 * FT, system: { id: "sys", kind, name: "S" }, points: [{ x: 0, y: 0 }, { x: 10 * FT, y: 0 }] });
    const seg = m.elements["p-s1"] as RunSegment;
    const rings = segmentRings(m.elements, seg);
    expect(Math.hypot(rings.start.a.x, rings.start.a.y, rings.start.a.z) * 2).toBeCloseTo(odMm, 0);
    const piece = elementSolid(m, seg, 0)?.pieces[0];
    expect(across(piece?.r0 ?? [])).toBeCloseTo(odMm, 0);
  });
});

describe("a sloped drain's bends in sections and printed views", () => {
  let m = empty();
  m = commit(m, {
    type: "route_run",
    idPrefix: "san",
    levelId: "lvl-1",
    domain: "pipe",
    size: { shape: "pipe", nominalMm: 4 * IN, material: "pvc" },
    elevationMm: -2 * FT,
    system: { id: "sys-san", kind: "sanitary", name: "Sanitary 1" },
    points: [{ x: 0, y: 0 }, { x: 10 * FT, y: 0 }, { x: 20 * FT, y: 10 * FT }],
  });
  const bend = Object.values(m.elements).find((e): e is RunFitting => e.kind === "run_fitting" && e.fittingType === "elbow");
  if (!bend) throw new Error("fixture");

  it("the 1/8 bend draws its own body (arc and hubs), not nothing", () => {
    expect(bend.family).toBe("dwv.eighth_bend");
    const pieces = elementSolid(m, bend, 0)?.pieces ?? [];
    expect(pieces.length).toBeGreaterThan(4);
  });

  it("each sloped straight stops on the bend's face instead of running on to the corner", () => {
    const body = fittingBody(m.elements, bend);
    for (const port of bend.ports) {
      const seg = port.link ? m.elements[port.link.elementId] : undefined;
      const face = body.faces[port.id];
      if (seg?.kind !== "run_segment" || !face) throw new Error("fixture");
      const piece: Piece | undefined = elementSolid(m, seg, 0)?.pieces[0];
      const end = port.link?.port === "end" ? piece?.r1 : piece?.r0;
      expect(dist(centroid(end ?? []), face.center)).toBeLessThan(0.01);
    }
  });
});
