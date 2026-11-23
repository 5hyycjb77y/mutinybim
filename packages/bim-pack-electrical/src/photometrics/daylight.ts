import type { OcclusionIndex, RayQueryOptions } from "./occlusion";

/**
 * Native CIE Sky Dome + Direct Solar Beam daylighting solver.
 *
 * Uses the existing 3D occlusion & glazing `T_vis` index (`includeCeilings: true`)
 * to compute physically grounded Daylight Factor (`DF%`), diffuse sky illuminance,
 * and direct solar beam illuminance on workplanes, task surfaces, stairs, and
 * interior radiosity patches — zero external binaries or runtime dependencies.
 */

export type DaylightSkyModel = "cie_overcast" | "cie_clear" | "cie_intermediate";

export interface DaylightOptions {
  /** Enable daylight contribution (default false so electric-only / nighttime calculations remain unchanged). */
  readonly enabled?: boolean;
  /** CIE sky luminance distribution model (default `"cie_overcast"`, canonical for LEED / EN 17037 Daylight Factor). */
  readonly skyModel?: DaylightSkyModel;
  /** Unobstructed outdoor horizontal diffuse sky illuminance in footcandles (default 1000 fc ≈ 10,764 lux). */
  readonly outdoorHorizontalFc?: number;
  /** Solar azimuth in degrees clockwise from +Y North (default 180° = due South). */
  readonly sunAzimuthDeg?: number;
  /** Solar altitude above the horizon in degrees (default 45°). */
  readonly sunElevationDeg?: number;
  /** Direct normal solar beam illuminance in footcandles for clear/intermediate skies (default 5500 fc clear, 2200 fc intermediate). */
  readonly directSunNormalFc?: number;
  /** Include electric luminaires alongside daylight (default true for `evaluateNormalPhotometrics`; false for pure daylight factor). */
  readonly includeElectric?: boolean;
}

export interface SkyPatch {
  /** Unit direction vector toward the sky patch `(ux, uy, uz)` with `uz > 0`. */
  readonly ux: number;
  readonly uy: number;
  readonly uz: number;
  /** Pre-integrated horizontal illuminance contribution `L(patch) * dOmega` (fc / cos_theta_surface), normalized to `outdoorHorizontalFc`. */
  readonly fluxFc: number;
}

export interface ResolvedSkyDome {
  readonly skyModel: DaylightSkyModel;
  readonly outdoorHorizontalFc: number;
  readonly sunDir: readonly [number, number, number];
  readonly directSunNormalFc: number;
  readonly patches: readonly SkyPatch[];
}

const SKY_RAY_DIST_MM = 120_000; // 120 m sky dome ray reach (well beyond any building envelope)

function sunVector(azimuthDeg: number, elevationDeg: number): readonly [number, number, number] {
  const azRad = (azimuthDeg * Math.PI) / 180;
  const elRad = (Math.max(1, Math.min(89, elevationDeg)) * Math.PI) / 180;
  const cosEl = Math.cos(elRad);
  return [Math.sin(azRad) * cosEl, Math.cos(azRad) * cosEl, Math.sin(elRad)];
}

/** Relative CIE sky luminance at patch direction `(ux, uy, uz)` given sky model & sun vector. */
function relativeSkyLuminance(
  skyModel: DaylightSkyModel,
  ux: number,
  uy: number,
  uz: number,
  sun: readonly [number, number, number],
): number {
  const sinGamma = Math.max(0.02, Math.min(1, uz));
  if (skyModel === "cie_overcast") {
    // CIE Standard Overcast Sky: L(gamma) = Lz * (1 + 2 * sin(gamma)) / 3
    return (1 + 2 * sinGamma) / 3;
  }
  const cosChi = Math.max(-1, Math.min(1, ux * sun[0] + uy * sun[1] + uz * sun[2]));
  const chi = Math.acos(cosChi);
  // CIE Standard Clear Sky (Kittler 1967): gradation * indicatrix
  const gradation = 1 - Math.exp(-0.32 / sinGamma);
  const indicatrix = 0.91 + 10 * Math.exp(-3 * chi) + 0.45 * cosChi * cosChi;
  const clearL = Math.max(0.05, gradation * indicatrix);
  if (skyModel === "cie_clear") return clearL;
  // CIE Intermediate sky blends clear & overcast distributions
  const overcastL = (1 + 2 * sinGamma) / 3;
  return 0.55 * clearL + 0.45 * overcastL * 3.0;
}

/**
 * Build a 48-patch stratified hemispherical CIE sky dome (4 altitude rings × 12 azimuths)
 * normalized so an unobstructed outdoor horizontal sensor receives exactly `outdoorHorizontalFc`.
 */
export function buildSkyDome(options?: DaylightOptions): ResolvedSkyDome {
  const skyModel: DaylightSkyModel = options?.skyModel ?? "cie_overcast";
  const outdoorHorizontalFc = Math.max(50, options?.outdoorHorizontalFc ?? 1000);
  const sunAz = options?.sunAzimuthDeg ?? 180;
  const sunEl = options?.sunElevationDeg ?? 45;
  const sunDir = sunVector(sunAz, sunEl);

  const defaultDirectSun =
    skyModel === "cie_clear" ? 5500 : skyModel === "cie_intermediate" ? 2200 : 0;
  const directSunNormalFc =
    skyModel === "cie_overcast" ? 0 : Math.max(0, options?.directSunNormalFc ?? defaultDirectSun);

  const rings = 4;
  const azCount = 12;
  const dAz = (2 * Math.PI) / azCount;
  const dEl = (Math.PI * 0.5) / rings;

  const raw: { ux: number; uy: number; uz: number; weight: number }[] = [];
  let horizIntegral = 0;

  for (let r = 0; r < rings; r++) {
    const el0 = r * dEl;
    const el1 = (r + 1) * dEl;
    const elMid = 0.5 * (el0 + el1);
    const dOmega = dAz * (Math.sin(el1) - Math.sin(el0));
    const cosEl = Math.cos(elMid);
    const sinEl = Math.sin(elMid);
    // Stagger alternate rings by half an azimuth bin for smoother window sampling
    const azOffset = (r % 2) * (dAz * 0.5);
    for (let a = 0; a < azCount; a++) {
      const az = a * dAz + azOffset;
      const ux = Math.sin(az) * cosEl;
      const uy = Math.cos(az) * cosEl;
      const uz = sinEl;
      const lum = relativeSkyLuminance(skyModel, ux, uy, uz, sunDir);
      const weight = lum * dOmega;
      raw.push({ ux, uy, uz, weight });
      horizIntegral += weight * uz;
    }
  }

  const scale = horizIntegral > 1e-9 ? outdoorHorizontalFc / horizIntegral : 0;
  const patches: SkyPatch[] = raw.map((p) => ({
    ux: p.ux,
    uy: p.uy,
    uz: p.uz,
    fluxFc: p.weight * scale,
  }));

  return {
    skyModel,
    outdoorHorizontalFc,
    sunDir,
    directSunNormalFc,
    patches,
  };
}

/**
 * Evaluate direct sky-dome + direct solar beam illuminance (fc) at a 3D surface point
 * `(pxMm, pyMm, pzMm)` with unit surface normal `(nx, ny, nz)`.
 *
 * Traces rays with `includeCeilings: true` so opaque roofs/ceilings block the sky while
 * windows, glazed curtain walls, and skylight wells transmit exact `T_vis` daylight.
 */
export function evaluateDaylightAtPoint(
  sky: ResolvedSkyDome,
  pxMm: number,
  pyMm: number,
  pzMm: number,
  nx: number,
  ny: number,
  nz: number,
  occlusion: OcclusionIndex,
  rayOpts?: RayQueryOptions,
): number {
  const skyRayOpts: RayQueryOptions = {
    includeFurniture: rayOpts?.includeFurniture ?? false,
    includeStairs: rayOpts?.includeStairs ?? true,
    includeCeilings: true,
    ...(rayOpts?.ignorePartId ? { ignorePartId: rayOpts.ignorePartId } : {}),
  };

  let fc = 0;

  // 1. Stratified diffuse sky dome
  for (let i = 0; i < sky.patches.length; i++) {
    const p = sky.patches[i]!;
    const cosInc = p.ux * nx + p.uy * ny + p.uz * nz;
    if (cosInc <= 1e-4) continue;
    const t = occlusion.rayTransmittance(
      pxMm,
      pyMm,
      pzMm,
      pxMm + p.ux * SKY_RAY_DIST_MM,
      pyMm + p.uy * SKY_RAY_DIST_MM,
      pzMm + p.uz * SKY_RAY_DIST_MM,
      skyRayOpts,
    );
    if (t > 0.01) {
      fc += p.fluxFc * cosInc * t;
    }
  }

  // 2. Direct solar beam (clear / intermediate sky models)
  if (sky.directSunNormalFc > 1e-3 && sky.sunDir[2] > 0.02) {
    const [sx, sy, sz] = sky.sunDir;
    const cosSun = sx * nx + sy * ny + sz * nz;
    if (cosSun > 1e-4) {
      const t = occlusion.rayTransmittance(
        pxMm,
        pyMm,
        pzMm,
        pxMm + sx * SKY_RAY_DIST_MM,
        pyMm + sy * SKY_RAY_DIST_MM,
        pzMm + sz * SKY_RAY_DIST_MM,
        skyRayOpts,
      );
      if (t > 0.01) {
        fc += sky.directSunNormalFc * cosSun * t;
      }
    }
  }

  return fc;
}
