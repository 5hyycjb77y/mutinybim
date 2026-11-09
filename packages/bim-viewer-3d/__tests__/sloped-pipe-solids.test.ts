/**
 * @jest-environment node
 *
 * Sloped drains in 3D (the 7303 sanitary review: "it worked except for when I
 * looked at it in this angle… they look like they're connected but not").
 * Before, a pipe sloped less than 10% drew as a level cylinder at its
 * mid-height, and at the pipe's nominal size, while its bend drew at the true
 * sloped ends and the real outside diameter. From a low angle the hub and the
 * level cylinder cut through each other. Each pipe must now end exactly on
 * its fitting's face, square to it, at the same diameter.
 */
import * as THREE from "three";
import { DEFAULT_SETTINGS, fittingBody, pipeDims, planCommit, type Command, type ModelState, type RunFitting, type RunPoint, type RunSegment, type RunSize } from "@permitzip/bim-kernel";
import { kernelToScene, MM } from "../src/coords";
import { elementSolids, type Solid } from "../src/native-geometry";
import { solidRotation } from "../src/solid-pose";

const FT = 304.8;
const IN = 25.4;
const PVC4: RunSize = { shape: "pipe", nominalMm: 4 * IN, material: "pvc" };

function commit(model: ModelState, command: Command): ModelState {
  const d = planCommit(model, [], { idempotencyKey: `sp-${model.revision}-key`, baseRevision: model.revision, actor: { id: "s", name: "S", kind: "human" }, command });
  if (!d.ok) throw new Error(d.error.message);
  return d.model;
}

/** 4" PVC sanitary at the system minimum (1/8" per ft), turning 45° on a 1/8 bend, then turning back. */
function sanitary(): ModelState {
  let m: ModelState = { modelId: "v", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  m = commit(m, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  return commit(m, {
    type: "route_run",
    idPrefix: "san",
    levelId: "lvl-1",
    domain: "pipe",
    size: PVC4,
    elevationMm: -2 * FT,
    system: { id: "sys-san", kind: "sanitary", name: "Sanitary 1" },
    points: [{ x: 0, y: 0 }, { x: 10 * FT, y: 0 }, { x: 20 * FT, y: 10 * FT }, { x: 30 * FT, y: 10 * FT }],
  });
}

/** A lying cylinder's two end centres and its axis, in scene metres, from what the viewer would draw. */
function cylinderEnds(s: Solid): { a: THREE.Vector3; b: THREE.Vector3; axis: THREE.Vector3 } {
  const [rx, ry, rz] = solidRotation(s);
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, "YXZ"));
  const axis = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
  const c = new THREE.Vector3(...s.center);
  return { a: c.clone().addScaledVector(axis, -s.size[0] / 2), b: c.clone().addScaledVector(axis, s.size[0] / 2), axis };
}

const scene = (p: RunPoint) => new THREE.Vector3(...kernelToScene(p.x, p.y, p.z));

describe("a sloped drain meets its bends in 3D", () => {
  const m = sanitary();
  const segments = Object.values(m.elements).filter((e): e is RunSegment => e.kind === "run_segment");
  const bends = Object.values(m.elements).filter((e): e is RunFitting => e.kind === "run_fitting" && e.fittingType === "elbow");

  it("the run really falls at 1/8\" per ft and turns on 1/8 bends", () => {
    expect(segments).toHaveLength(3);
    expect(bends.map((b) => b.family)).toEqual(["dwv.eighth_bend", "dwv.eighth_bend"]);
    for (const s of segments) expect(s.end.z).toBeLessThan(s.start.z);
  });

  it("each pipe draws at its real outside diameter (4\" PVC: 4.5\", not the 4\" nominal)", () => {
    for (const seg of segments) expect(elementSolids(seg, undefined, m)[0]?.size[1]).toBeCloseTo(pipeDims(PVC4).odMm * MM, 6);
  });

  it("each pipe ends on its bend's face, square to it", () => {
    for (const bend of bends) {
      const body = fittingBody(m.elements, bend);
      for (const port of bend.ports) {
        const face = body.faces[port.id];
        const seg = port.link ? m.elements[port.link.elementId] : undefined;
        if (!face || seg?.kind !== "run_segment") throw new Error("fixture");
        const [solid, ...rest] = elementSolids(seg, undefined, m);
        expect(rest).toEqual([]);
        if (!solid) throw new Error("no solid");
        expect(solid.shape).toBe("cylinder");
        const ends = cylinderEnds(solid);
        const target = scene(face.center);
        const end = ends.a.distanceTo(target) < ends.b.distanceTo(target) ? ends.a : ends.b;
        // Within 0.1 mm: before, the miss was half the fall (≈ 16 mm on a 10 ft piece).
        expect(end.distanceTo(target)).toBeLessThan(0.1 * MM);
        // Square to the face (cylinder axis parallel to its normal).
        const n = scene({ x: face.normal.x, y: face.normal.y, z: face.normal.z }).sub(scene({ x: 0, y: 0, z: 0 })).normalize();
        expect(Math.abs(ends.axis.dot(n))).toBeGreaterThan(1 - 1e-9);
      }
    }
  });

  it("the bend's arc is the same diameter as the pipe it meets", () => {
    const od = pipeDims(PVC4).odMm;
    for (const bend of bends) {
      const arc = fittingBody(m.elements, bend).tubes[0];
      for (const r of arc?.rings ?? []) expect(Math.hypot(r.a.x, r.a.y, r.a.z) * 2).toBeCloseTo(od, 6);
    }
  });

  it("a level pipe stays an unpitched cylinder", () => {
    let level = sanitary();
    level = commit(level, { type: "set_system_design", systemId: "sys-san", design: { pipe: { slopes: [{ maxNominalIn: 1000, inPerFt: 0 }] } } });
    level = commit(level, { type: "route_run", idPrefix: "lv", levelId: "lvl-1", domain: "pipe", size: PVC4, elevationMm: -4 * FT, system: { id: "sys-san", kind: "sanitary", name: "Sanitary 1" }, points: [{ x: 0, y: 20 * FT }, { x: 10 * FT, y: 20 * FT }] });
    const [solid] = elementSolids(level.elements["lv-s1"] as RunSegment, undefined, level);
    expect(solid?.pitch).toBeUndefined();
    expect(solidRotation(solid ?? { shape: "box", yaw: 0 })).toEqual([0, 0, Math.PI / 2]);
  });
});
