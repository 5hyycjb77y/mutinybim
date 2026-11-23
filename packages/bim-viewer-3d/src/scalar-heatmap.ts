import * as THREE from "three";
import { MM, kernelToScene } from "./coords";

/**
 * Trade-agnostic 3D scalar-field heatmap mesh builder.
 *
 * Accepts a grid of horizontal cells in kernel millimetres (e.g. room workplane
 * illuminance, egress floor luminance, acoustic NC levels, thermal comfort or
 * coverage intensity) and produces a vertex-colored Three.js group slightly
 * lifted above its plane so it sits crisply on floors/workplanes without z-fighting.
 */

export type ScalarHeatmapPalette = "viridis" | "pass_fail" | "thermal";

export interface ScalarHeatmapCell {
  /** Cell centre in kernel plan mm. */
  readonly xMm: number;
  readonly yMm: number;
  /** Evaluation plane elevation in kernel mm (absolute Z). */
  readonly zMm: number;
  /** Cell footprint in kernel mm. */
  readonly widthMm: number;
  readonly depthMm: number;
  /** Optional cell plan yaw rotation in degrees (for rotated stair flights & surfaces). */
  readonly rotationDeg?: number;
  /** Numeric scalar value for false-color mapping. */
  readonly value: number;
  /** Optional threshold breach marker (renders a crisp high-contrast border). */
  readonly fail?: boolean;
}

export interface ScalarHeatmapOverlay {
  readonly cells: readonly ScalarHeatmapCell[];
  readonly minValue: number;
  readonly maxValue: number;
  /** Optional minimum passing threshold used by `pass_fail` palette. */
  readonly threshold?: number;
  readonly palette?: ScalarHeatmapPalette;
  /** Mesh opacity in (0, 1]; default 0.72. */
  readonly opacity?: number;
}

const HEATMAP_Z_LIFT_MM = 12;

type Rgb = readonly [number, number, number];

const VIRIDIS_STOPS: readonly Rgb[] = [
  [0.12, 0.14, 0.42], // deep indigo (very low)
  [0.13, 0.44, 0.62], // cool blue
  [0.16, 0.67, 0.56], // teal-green
  [0.58, 0.82, 0.28], // bright lime
  [0.98, 0.86, 0.19], // warm gold (high)
];

const THERMAL_STOPS: readonly Rgb[] = [
  [0.12, 0.25, 0.68],
  [0.15, 0.65, 0.78],
  [0.95, 0.82, 0.22],
  [0.92, 0.38, 0.14],
  [0.78, 0.08, 0.14],
];

function lerpStops(stops: readonly Rgb[], tRaw: number): Rgb {
  const t = Math.max(0, Math.min(1, Number.isFinite(tRaw) ? tRaw : 0));
  const scaled = t * (stops.length - 1);
  const idx = Math.min(stops.length - 2, Math.floor(scaled));
  const f = scaled - idx;
  const a = stops[idx]!;
  const b = stops[idx + 1]!;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/** Map a scalar value to an sRGB triple in [0, 1]. Exported for unit tests and legend UIs. */
export function sampleHeatmapColor(
  value: number,
  minValue: number,
  maxValue: number,
  palette: ScalarHeatmapPalette = "viridis",
  threshold?: number,
  fail?: boolean,
): Rgb {
  if (palette === "pass_fail") {
    if (fail || (threshold !== undefined && value < threshold)) {
      return [0.86, 0.15, 0.15]; // crisp red fail
    }
    const lo = threshold !== undefined ? threshold : minValue;
    const span = Math.max(1e-6, maxValue - lo);
    const t = Math.max(0, Math.min(1, (value - lo) / span));
    // Amber-yellow near threshold -> emerald green well above threshold
    return lerpStops(
      [
        [0.95, 0.72, 0.14],
        [0.34, 0.78, 0.36],
        [0.08, 0.64, 0.45],
      ],
      t,
    );
  }
  const span = Math.max(1e-6, maxValue - minValue);
  const t = (value - minValue) / span;
  return palette === "thermal" ? lerpStops(THERMAL_STOPS, t) : lerpStops(VIRIDIS_STOPS, t);
}

/** Build a Three.js Group containing the vertex-colored scalar heatmap and optional fail outlines. */
export function buildScalarHeatmapGroup(overlay: ScalarHeatmapOverlay): THREE.Group {
  const group = new THREE.Group();
  group.name = "scalar-heatmap";
  const cells = overlay.cells;
  if (cells.length === 0) return group;

  const palette = overlay.palette ?? "viridis";
  const opacity = Math.max(0.05, Math.min(1, overlay.opacity ?? 0.72));

  // 2 triangles (6 vertices) per cell
  const positions = new Float32Array(cells.length * 6 * 3);
  const colors = new Float32Array(cells.length * 6 * 3);
  const failSegments: number[] = [];

  let pIdx = 0;
  let cIdx = 0;

  for (const cell of cells) {
    const hw = Math.max(1, cell.widthMm) * 0.5;
    const hd = Math.max(1, cell.depthMm) * 0.5;
    const z = cell.zMm + HEATMAP_Z_LIFT_MM;
    const rotRad = ((cell.rotationDeg ?? 0) * Math.PI) / 180;
    const cosR = Math.cos(rotRad);
    const sinR = Math.sin(rotRad);
    const corner = (lx: number, ly: number): readonly [number, number, number] => {
      const wx = cell.xMm + lx * cosR - ly * sinR;
      const wy = cell.yMm + lx * sinR + ly * cosR;
      return kernelToScene(wx, wy, z);
    };
    const p0 = corner(-hw, -hd);
    const p1 = corner(hw, -hd);
    const p2 = corner(hw, hd);
    const p3 = corner(-hw, hd);

    const [r, g, b] = sampleHeatmapColor(cell.value, overlay.minValue, overlay.maxValue, palette, overlay.threshold, cell.fail);

    const verts: readonly (readonly [number, number, number])[] = [p0, p1, p2, p0, p2, p3];
    for (const [vx, vy, vz] of verts) {
      positions[pIdx++] = vx;
      positions[pIdx++] = vy;
      positions[pIdx++] = vz;
      colors[cIdx++] = r;
      colors[cIdx++] = g;
      colors[cIdx++] = b;
    }

    if (cell.fail) {
      const yLine = p0[1] + 4 * MM;
      failSegments.push(
        p0[0], yLine, p0[2], p1[0], yLine, p1[2],
        p1[0], yLine, p1[2], p2[0], yLine, p2[2],
        p2[0], yLine, p2[2], p3[0], yLine, p3[2],
        p3[0], yLine, p3[2], p0[0], yLine, p0[2],
      );
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.computeBoundingSphere();

  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: opacity < 1,
    opacity,
    side: THREE.DoubleSide,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -2,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "scalar-heatmap-surface";
  mesh.renderOrder = 8;
  group.add(mesh);

  if (failSegments.length > 0) {
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute("position", new THREE.Float32BufferAttribute(failSegments, 3));
    const lineMat = new THREE.LineBasicMaterial({ color: 0xb91c1c, depthTest: true });
    const lines = new THREE.LineSegments(lineGeo, lineMat);
    lines.name = "scalar-heatmap-fails";
    lines.renderOrder = 9;
    group.add(lines);
  }

  return group;
}
