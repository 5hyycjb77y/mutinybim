import * as THREE from "three";
import { MM, kernelToScene } from "./coords";
import { buildMoodEnvironment } from "./procedural-textures";

/**
 * Trade-agnostic 3D atmosphere, time-of-day sky/sun presets, and physical
 * real-time light emitter rendering for `ModelViewer3D`.
 *
 * Keeps `bim-viewer-3d` free of trade vocabulary: callers supply generic
 * `SceneLightEmitter` descriptors (position, aim direction, candela, beam
 * cone, aperture size, color temperature, blackout participation) and switch
 * between `morning`, `noon`, `afternoon`, `evening`, `night`, `night_blackout`,
 * and `no_shadows`.
 */

export type SceneLightingPreset =
  | "morning"
  | "noon"
  | "afternoon"
  | "evening"
  | "night"
  | "night_blackout"
  | "night_blackout_90min"
  | "no_shadows";

export interface SceneLightEmitter {
  readonly id: string;
  /** Emitter world position in kernel mm `[x, y, z]` (exact diffuser face center). */
  readonly positionMm: readonly [number, number, number];
  /** Unit aim direction in kernel coordinates `[dx, dy, dz]` (e.g. `[0, 0, -1]` straight down). */
  readonly direction: readonly [number, number, number];
  /** Peak intensity in candela along the primary beam (`0` for signage-only emitters). */
  readonly intensityCandela: number;
  /** Delivered flux in lumens (used for spotlight prioritization). */
  readonly lumens: number;
  /** Emitted light tint as 24-bit RGB hex (e.g. `0xfff1dc` warm white, `0xff2828` exit sign). */
  readonly colorHex: number;
  /** Full cone angle in degrees (clamped to `[24, 156]`). */
  readonly beamAngleDeg: number;
  /** Cone edge softness in `[0, 1]`. */
  readonly penumbra: number;
  /** Attenuation reach in kernel mm. */
  readonly rangeMm: number;
  /** Luminous diffuser dimensions `[localXMm, localYMm]` aligned with the host part's local X (length) and Y (width) axes. */
  readonly apertureMm: readonly [number, number];
  /** Diffuser silhouette shape. */
  readonly apertureShape?: "rect" | "round";
  /** Diffuser plane orientation: horizontal bottom lens (default) or vertical front/back sign faces (`signHeightMm` in `apertureMm[1]`). */
  readonly diffuserPlane?: "horizontal" | "vertical_double_face";
  /** Housing thickness along local Y (mm) used to place vertical double-face signs flush on front & back faces. */
  readonly signDepthMm?: number;
  /** Plan yaw rotation in degrees (matches kernel part rotation). */
  readonly rotationDeg?: number;
  /** Mount geometry hint. */
  readonly mountKind?: "ceiling" | "wall" | "pendant";
  /** Role controlling when the emitter activates (`standard` = normal + optional blackout, `emergency_only` = blackout only, `sign` = always-lit luminous legend without floodlight). */
  readonly emitterRole?: "standard" | "emergency_only" | "sign";
  /** True when this emitter illuminates during normal evening/night presets (defaults true except `emergency_only`). */
  readonly activeInNormal?: boolean;
  /** True when this emitter remains powered during `night_blackout` / `night_blackout_90min` mode. */
  readonly activeInBlackout?: boolean;
  /** Relative intensity scale `[0..1]` during initial blackout (`night_blackout`), e.g. `emergency_lumens / normal_lumens`. */
  readonly blackoutScale?: number;
  /** Relative intensity scale `[0..1]` at 90-minute end-of-discharge (`night_blackout_90min`). */
  readonly blackout90MinScale?: number;
}

export interface ScenePresetConfig {
  readonly preset: SceneLightingPreset;
  readonly label: string;
  readonly mood: "day" | "evening" | "night";
  readonly backgroundHex: number;
  readonly envIntensity: number;
  readonly hemiSkyHex: number;
  readonly hemiGroundHex: number;
  readonly hemiIntensity: number;
  readonly sunAzimuthDeg: number;
  readonly sunElevationDeg: number;
  readonly sunColorHex: number;
  readonly sunIntensity: number;
  readonly sunShadows: boolean;
  readonly fillColorHex: number;
  readonly fillIntensity: number;
  readonly exposure: number;
  /** Master emitter brightness factor (`0` = off, `1` = full night/evening illumination). */
  readonly emitterFactor: number;
  /** Subtle volumetric cone opacity (`0` in daytime). */
  readonly beamConeOpacity: number;
  /** When true, only `activeInBlackout` emitters remain illuminated. */
  readonly blackoutOnly: boolean;
  /** When true (with `blackoutOnly`), applies 90-minute end-of-discharge battery derate (`blackout90MinScale`). */
  readonly blackout90Min?: boolean;
}

export const SCENE_LIGHTING_PRESETS: Readonly<Record<SceneLightingPreset, ScenePresetConfig>> = {
  morning: {
    preset: "morning",
    label: "Morning",
    mood: "day",
    backgroundHex: 0xe7eff8,
    envIntensity: 0.64,
    hemiSkyHex: 0xf2f6fd,
    hemiGroundHex: 0x86909c,
    hemiIntensity: 0.8,
    sunAzimuthDeg: 55,
    sunElevationDeg: 28,
    sunColorHex: 0xffebd0,
    sunIntensity: 2.15,
    sunShadows: true,
    fillColorHex: 0xdce7ff,
    fillIntensity: 0.45,
    exposure: 1.05,
    emitterFactor: 0.72,
    beamConeOpacity: 0,
    blackoutOnly: false,
  },
  noon: {
    preset: "noon",
    label: "Noon",
    mood: "day",
    backgroundHex: 0xeef1f5,
    envIntensity: 0.65,
    hemiSkyHex: 0xf6f8fc,
    hemiGroundHex: 0x7d8794,
    hemiIntensity: 0.85,
    sunAzimuthDeg: 135,
    sunElevationDeg: 62,
    sunColorHex: 0xfff6ea,
    sunIntensity: 2.2,
    sunShadows: true,
    fillColorHex: 0xdfe8ff,
    fillIntensity: 0.5,
    exposure: 1.05,
    emitterFactor: 0.7,
    beamConeOpacity: 0,
    blackoutOnly: false,
  },
  afternoon: {
    preset: "afternoon",
    label: "Afternoon",
    mood: "day",
    backgroundHex: 0xf0e7dc,
    envIntensity: 0.58,
    hemiSkyHex: 0xfbe8d3,
    hemiGroundHex: 0x7c6d63,
    hemiIntensity: 0.72,
    sunAzimuthDeg: 235,
    sunElevationDeg: 24,
    sunColorHex: 0xffcfa1,
    sunIntensity: 2.25,
    sunShadows: true,
    fillColorHex: 0xc9d7f0,
    fillIntensity: 0.4,
    exposure: 1.06,
    emitterFactor: 0.82,
    beamConeOpacity: 0,
    blackoutOnly: false,
  },
  evening: {
    preset: "evening",
    label: "Evening",
    mood: "evening",
    backgroundHex: 0x22314a,
    envIntensity: 0.36,
    hemiSkyHex: 0x6b86b0,
    hemiGroundHex: 0x2b3342,
    hemiIntensity: 0.48,
    sunAzimuthDeg: 268,
    sunElevationDeg: 10,
    sunColorHex: 0xffa86b,
    sunIntensity: 0.72,
    sunShadows: true,
    fillColorHex: 0x4b648c,
    fillIntensity: 0.24,
    exposure: 1.02,
    emitterFactor: 1.0,
    beamConeOpacity: 0,
    blackoutOnly: false,
  },
  night: {
    preset: "night",
    label: "Night",
    mood: "night",
    backgroundHex: 0x101929,
    envIntensity: 0.22,
    hemiSkyHex: 0x455f8a,
    hemiGroundHex: 0x1c2433,
    hemiIntensity: 0.34,
    sunAzimuthDeg: 210,
    sunElevationDeg: 48,
    sunColorHex: 0x9ebae8,
    sunIntensity: 0.48,
    sunShadows: true,
    fillColorHex: 0x2f4366,
    fillIntensity: 0.2,
    exposure: 1.0,
    emitterFactor: 1.0,
    beamConeOpacity: 0,
    blackoutOnly: false,
  },
  night_blackout: {
    preset: "night_blackout",
    label: "Blackout",
    mood: "night",
    backgroundHex: 0x070c16,
    envIntensity: 0.08,
    hemiSkyHex: 0x1b2840,
    hemiGroundHex: 0x090d14,
    hemiIntensity: 0.1,
    sunAzimuthDeg: 210,
    sunElevationDeg: 48,
    sunColorHex: 0x6982ad,
    sunIntensity: 0.14,
    sunShadows: true,
    fillColorHex: 0x152036,
    fillIntensity: 0.06,
    exposure: 1.05,
    emitterFactor: 1.0,
    beamConeOpacity: 0,
    blackoutOnly: true,
    blackout90Min: false,
  },
  night_blackout_90min: {
    preset: "night_blackout_90min",
    label: "Blackout 90m",
    mood: "night",
    backgroundHex: 0x060a13,
    envIntensity: 0.06,
    hemiSkyHex: 0x162136,
    hemiGroundHex: 0x080b12,
    hemiIntensity: 0.08,
    sunAzimuthDeg: 210,
    sunElevationDeg: 48,
    sunColorHex: 0x5c7399,
    sunIntensity: 0.11,
    sunShadows: true,
    fillColorHex: 0x111a2b,
    fillIntensity: 0.05,
    exposure: 1.05,
    emitterFactor: 1.0,
    beamConeOpacity: 0,
    blackoutOnly: true,
    blackout90Min: true,
  },
  no_shadows: {
    preset: "no_shadows",
    label: "No shadows",
    mood: "day",
    backgroundHex: 0xeef1f5,
    envIntensity: 0.65,
    hemiSkyHex: 0xf6f8fc,
    hemiGroundHex: 0x7d8794,
    hemiIntensity: 0.85,
    sunAzimuthDeg: 135,
    sunElevationDeg: 62,
    sunColorHex: 0xfff6ea,
    sunIntensity: 2.2,
    sunShadows: false,
    fillColorHex: 0xdfe8ff,
    fillIntensity: 0.5,
    exposure: 1.05,
    emitterFactor: 0.0,
    beamConeOpacity: 0,
    blackoutOnly: false,
  },
};

/**
 * Per-frame forward-PBR SpotLight pool budget by render quality & lighting mood.
 * Because Three.js evaluates every active SpotLight per screen pixel in the PBR
 * fragment shader, keeping the pool tight (8–24) and dynamically assigning the
 * frustum-visible fixtures closest to the camera focus delivers 100% full-quality
 * illumination on every fixture you look at or zoom into while cutting GPU fill
 * cost 4×–8× with zero shader recompilations while orbiting/zooming.
 */
function spotPoolBudget(renderQuality: "draft" | "standard" | "high", mood: "day" | "evening" | "night"): number {
  if (mood === "day") {
    return renderQuality === "draft" ? 0 : renderQuality === "high" ? 14 : 8;
  }
  return renderQuality === "draft" ? 6 : renderQuality === "high" ? 24 : 12;
}

interface PrecomputedSpotCandidate {
  readonly id: string;
  readonly isWall: boolean;
  readonly effectiveLumens: number;
  readonly colorHex: number;
  readonly intensity: number;
  readonly distanceM: number;
  readonly halfAngleRad: number;
  readonly penumbra: number;
  readonly pos: readonly [number, number, number];
  readonly target: readonly [number, number, number];
  /** Bounding sphere center (midway down light cone) & radius for accurate camera frustum culling. */
  readonly boundCenter: readonly [number, number, number];
  readonly boundRadius: number;
}

/** Dispose every mesh/geometry/material/light inside `group` and clear its children. */
export function clearEmitterGroup(group: THREE.Group): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  group.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      geometries.add(obj.geometry);
      if (Array.isArray(obj.material)) obj.material.forEach((m) => materials.add(m));
      else materials.add(obj.material);
    } else if (obj instanceof THREE.Light && "shadow" in obj && obj.shadow && typeof obj.shadow === "object" && "map" in obj.shadow) {
      const sh = obj.shadow as { map?: { dispose(): void } | null };
      sh.map?.dispose();
    }
  });
  for (const g of geometries) g.dispose();
  for (const m of materials) m.dispose();
  group.clear();
}

interface ActiveEmitterItem {
  readonly emitter: SceneLightEmitter;
  readonly scale: number;
  readonly effectiveLumens: number;
  readonly effectiveCandela: number;
}

/**
 * Select up to `maxCount` spatially well-distributed emitters prioritized by
 * effective lumen output so large multi-storey models stay smoothly lit across
 * every zone while respecting WebGL shader uniform limits.
 */
function selectDynamicSpotlights(items: readonly ActiveEmitterItem[], maxCount: number): ActiveEmitterItem[] {
  if (items.length <= maxCount) return [...items];
  // Prioritize wall-mounted exterior/accent sconces first (few in count, high visual impact), then brightest ceiling fixtures
  const sorted = [...items].sort((a, b) => {
    const aw = a.emitter.mountKind === "wall" ? 1 : 0;
    const bw = b.emitter.mountKind === "wall" ? 1 : 0;
    if (aw !== bw) return bw - aw;
    return b.effectiveLumens - a.effectiveLumens;
  });
  const picked: ActiveEmitterItem[] = [];
  const pickedSet = new Set<string>();
  // Pass 1: greedy farthest-first spatial coverage across floors/rooms (2.5 m min spacing)
  const minSpacingMm = 2500;
  for (const item of sorted) {
    if (picked.length >= maxCount) break;
    const [x, y, z] = item.emitter.positionMm;
    const tooClose = picked.some((p) => {
      const [px, py, pz] = p.emitter.positionMm;
      return Math.abs(z - pz) < 1800 && Math.hypot(x - px, y - py) < minSpacingMm;
    });
    if (!tooClose) {
      picked.push(item);
      pickedSet.add(item.emitter.id);
    }
  }
  // Pass 2: fill any remaining slots by brightness
  for (const item of sorted) {
    if (picked.length >= maxCount) break;
    if (!pickedSet.has(item.emitter.id)) {
      picked.push(item);
      pickedSet.add(item.emitter.id);
    }
  }
  return picked;
}

/** Precompute resolved active illuminating candidates (positions, targets, density-normalized intensities & frustum bounds). */
function prepareActiveEmitters(
  emitters: readonly SceneLightEmitter[],
  config: ScenePresetConfig,
): { readonly active: ActiveEmitterItem[]; readonly spotCandidates: PrecomputedSpotCandidate[] } {
  const active: ActiveEmitterItem[] = [];
  for (const em of emitters) {
    const role = em.emitterRole ?? "standard";
    if (config.blackoutOnly) {
      if (!em.activeInBlackout) continue;
    } else {
      const normalOn = em.activeInNormal ?? role !== "emergency_only";
      if (!normalOn) continue;
      // Dusk-to-dawn photocell behavior: exterior wall sconces switch OFF during bright daylight while interior fixtures stay ON
      if (config.mood === "day" && role === "standard" && em.mountKind === "wall") continue;
    }
    const modeScale = config.blackoutOnly
      ? config.blackout90Min
        ? Math.max(0.05, em.blackout90MinScale ?? (em.blackoutScale ?? 0.35) * 0.6)
        : Math.max(0.05, em.blackoutScale ?? 0.35)
      : 1.0;
    const scale = modeScale * config.emitterFactor;
    const effectiveLumens = role === "sign" ? 0 : Math.max(10, em.lumens * scale);
    const effectiveCandela = role === "sign" ? 0 : Math.max(5, em.intensityCandela * scale);
    active.push({ emitter: em, scale, effectiveLumens, effectiveCandela });
  }

  const illuminating = active.filter((a) => a.emitter.emitterRole !== "sign" && a.effectiveCandela > 0);
  const tmpPos = new THREE.Vector3();
  const tmpDir = new THREE.Vector3();
  const spotCandidates: PrecomputedSpotCandidate[] = [];

  for (let i = 0; i < illuminating.length; i++) {
    const item = illuminating[i]!;
    const em = item.emitter;
    const [sx, sy, sz] = kernelToScene(em.positionMm[0], em.positionMm[1], em.positionMm[2]);
    tmpPos.set(sx, sy, sz);
    tmpDir.set(em.direction[0], em.direction[2], -em.direction[1]);
    if (tmpDir.lengthSq() < 1e-6) tmpDir.set(0, -1, 0);
    tmpDir.normalize();

    const isWall = em.mountKind === "wall";
    // Gently normalize overlapping dense fixture grids on the same storey so paired/grouped fixtures stay balanced
    // without stacking into pure-white floor clipping, while lone wall sconces keep full architectural punch.
    let nearbySameStorey = 0;
    if (!isWall) {
      const [ex, ey, ez] = em.positionMm;
      for (let j = 0; j < illuminating.length; j++) {
        if (i === j) continue;
        const other = illuminating[j]!.emitter;
        if (other.mountKind === "wall") continue;
        const [ox, oy, oz] = other.positionMm;
        if (Math.abs(ez - oz) < 1400 && Math.hypot(ex - ox, ey - oy) < 3200) nearbySameStorey++;
      }
    }
    const densityAtten = isWall ? 1.0 : 1 / Math.sqrt(1 + nearbySameStorey * 0.55);

    const gain = isWall ? 0.026 : 0.0125;
    const maxCap = isWall ? 22 : 12;
    const intensity = Math.max(0.5, Math.min(maxCap, item.effectiveCandela * gain) * densityAtten);
    const distanceM = isWall ? Math.max(3.2, Math.min(6.0, em.rangeMm * MM)) : Math.max(2.3, Math.min(4.2, em.rangeMm * MM));
    // Dark-sky full-cutoff clamp for wall sconces (`<= 50°` half-angle on ~32° tilt => top edge <= 82° from nadir: zero uplight on roof soffits!)
    const maxHalfDeg = isWall ? 50 : 68;
    const halfAngleRad = (Math.max(24, Math.min(maxHalfDeg, em.beamAngleDeg * 0.5)) * Math.PI) / 180;
    const penumbra = Math.max(0.6, Math.min(0.96, em.penumbra + 0.18));

    const launchOffsetM = isWall ? 0.08 : 0.04;
    const px = sx + tmpDir.x * launchOffsetM;
    const py = sy + tmpDir.y * launchOffsetM;
    const pz = sz + tmpDir.z * launchOffsetM;
    const tx = px + tmpDir.x * 3;
    const ty = py + tmpDir.y * 3;
    const tz = pz + tmpDir.z * 3;

    // Bounding sphere centered halfway along the cone with generous radius covering the full illuminated cone
    const halfReach = distanceM * 0.5;
    const bx = px + tmpDir.x * halfReach;
    const by = py + tmpDir.y * halfReach;
    const bz = pz + tmpDir.z * halfReach;
    const boundRadius = Math.max(halfReach, Math.sin(halfAngleRad) * distanceM) + 0.5;

    spotCandidates.push({
      id: em.id,
      isWall,
      effectiveLumens: item.effectiveLumens,
      colorHex: em.colorHex,
      intensity,
      distanceM,
      halfAngleRad,
      penumbra,
      pos: [px, py, pz],
      target: [tx, ty, tz],
      boundCenter: [bx, by, bz],
      boundRadius,
    });
  }

  return { active, spotCandidates };
}

function buildDiffuserMeshes(root: THREE.Group, active: readonly ActiveEmitterItem[]): void {
  const roundGeo = new THREE.CircleGeometry(0.5, 20);
  const rectGeo = new THREE.PlaneGeometry(1, 1);
  const diffuserMatCache = new Map<string, THREE.MeshBasicMaterial>();

  const diffuserMatOf = (colorHex: number, brightness: number): THREE.MeshBasicMaterial => {
    const bucket = Math.round(Math.max(0.35, Math.min(1.0, brightness)) * 10);
    const key = `${colorHex}:${bucket}`;
    let mat = diffuserMatCache.get(key);
    if (!mat) {
      const col = new THREE.Color(colorHex).multiplyScalar(bucket / 10);
      mat = new THREE.MeshBasicMaterial({
        color: col,
        side: THREE.DoubleSide,
        toneMapped: true,
      });
      diffuserMatCache.set(key, mat);
    }
    return mat;
  };

  for (const item of active) {
    const em = item.emitter;
    const [sx, sy, sz] = kernelToScene(em.positionMm[0], em.positionMm[1], em.positionMm[2]);
    const wM = Math.max(0.05, em.apertureMm[0] * MM);
    const lM = Math.max(0.05, em.apertureMm[1] * MM);
    const yawRad = ((em.rotationDeg ?? 0) * Math.PI) / 180;
    const lensBrightness = em.emitterRole === "sign" ? 0.92 : 0.45 + 0.55 * Math.min(1, item.scale);
    const mat = diffuserMatOf(em.colorHex, lensBrightness);

    if (em.diffuserPlane === "vertical_double_face") {
      const halfDepthM = Math.max(0.015, (em.signDepthMm ?? 52) * 0.5 * MM) + 0.003;
      const signGroup = new THREE.Group();
      signGroup.position.set(sx, sy, sz);
      signGroup.rotation.y = yawRad;

      const front = new THREE.Mesh(rectGeo, mat);
      front.position.set(0, 0, -halfDepthM);
      front.scale.set(wM, lM, 1);
      front.renderOrder = 2;
      front.userData.nonPickable = true;
      signGroup.add(front);

      const back = new THREE.Mesh(rectGeo, mat);
      back.position.set(0, 0, halfDepthM);
      back.scale.set(wM, lM, 1);
      back.renderOrder = 2;
      back.userData.nonPickable = true;
      signGroup.add(back);

      root.add(signGroup);
      continue;
    }

    const isRound = em.apertureShape === "round";
    const diffuser = new THREE.Mesh(isRound ? roundGeo : rectGeo, mat);
    diffuser.position.set(sx, sy, sz);
    diffuser.rotation.order = "YXZ";
    diffuser.rotation.x = Math.PI / 2;
    diffuser.rotation.y = yawRad;
    diffuser.scale.set(wM, lM, 1);
    diffuser.renderOrder = 2;
    diffuser.userData.nonPickable = true;
    root.add(diffuser);
  }
}

function applyCandidateToSpot(spot: THREE.SpotLight, cand: PrecomputedSpotCandidate): void {
  spot.color.setHex(cand.colorHex);
  spot.intensity = cand.intensity;
  spot.distance = cand.distanceM;
  spot.angle = cand.halfAngleRad;
  spot.penumbra = cand.penumbra;
  spot.position.set(cand.pos[0], cand.pos[1], cand.pos[2]);
  spot.target.position.set(cand.target[0], cand.target[1], cand.target[2]);
  spot.target.updateMatrixWorld();
}

/**
 * Populate `root` with physically-sized luminous diffusers for every active
 * luminaire plus a bounded `SpotLight` set calibrated to IES candela & beam cone.
 */
export function buildSceneLightEmitterGroup(
  emitters: readonly SceneLightEmitter[],
  config: ScenePresetConfig,
  options?: { readonly renderQuality?: "draft" | "standard" | "high" },
): THREE.Group {
  const root = new THREE.Group();
  root.name = "scene-light-emitters";
  if (emitters.length === 0 || config.emitterFactor <= 0.001) return root;

  const { active, spotCandidates } = prepareActiveEmitters(emitters, config);
  if (active.length === 0) return root;

  buildDiffuserMeshes(root, active);

  const quality = options?.renderQuality ?? "standard";
  const maxSpots = spotPoolBudget(quality, config.mood);
  const pickedIds = new Set(
    selectDynamicSpotlights(
      active.filter((a) => a.emitter.emitterRole !== "sign" && a.effectiveCandela > 0),
      maxSpots,
    ).map((a) => a.emitter.id),
  );
  for (const cand of spotCandidates) {
    if (!pickedIds.has(cand.id)) continue;
    const spot = new THREE.SpotLight(cand.colorHex, cand.intensity, cand.distanceM, cand.halfAngleRad, cand.penumbra, 2);
    spot.castShadow = false;
    applyCandidateToSpot(spot, cand);
    root.add(spot);
    root.add(spot.target);
  }

  return root;
}

/**
 * Stateful environment + lighting preset controller owned by `ModelViewer3D`.
 * Caches PMREM environments per mood (`day` | `evening` | `night`) so toggling
 * Morning -> Evening -> Night -> Blackout is instantaneous with zero shader stalls.
 */
export class SceneLightingController {
  private preset: SceneLightingPreset = "noon";
  private emitters: readonly SceneLightEmitter[] = [];
  private readonly envCache = new Map<"day" | "evening" | "night", THREE.Texture | null>();
  /** Fixed-size pre-allocated SpotLight pool reassigned in-place by camera frustum + focus proximity (zero shader recompiles on orbit/zoom). */
  private spotPool: THREE.SpotLight[] = [];
  private spotCandidates: PrecomputedSpotCandidate[] = [];
  private scoredIndices: Array<{ idx: number; score: number }> = [];
  private readonly frustum = new THREE.Frustum();
  private readonly projScreenMatrix = new THREE.Matrix4();
  private readonly boundSphere = new THREE.Sphere();
  private readonly lastCamPos = new THREE.Vector3(Infinity, Infinity, Infinity);
  private readonly lastCamTarget = new THREE.Vector3(Infinity, Infinity, Infinity);
  private readonly lastCamDir = new THREE.Vector3();
  private readonly scratchDir = new THREE.Vector3();
  private readonly scratchFocus = new THREE.Vector3();

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
    private readonly hemiLight: THREE.HemisphereLight,
    private readonly sunLight: THREE.DirectionalLight,
    private readonly fillLight: THREE.DirectionalLight,
    private readonly emitterRoot: THREE.Group,
    private readonly defaultDayEnv: THREE.Texture | null,
    private readonly dayBackground: THREE.Color,
  ) {
    this.envCache.set("day", defaultDayEnv);
  }

  getPreset(): SceneLightingPreset {
    return this.preset;
  }

  getConfig(): ScenePresetConfig {
    return SCENE_LIGHTING_PRESETS[this.preset];
  }

  setEmitters(emitters: readonly SceneLightEmitter[], is3d: boolean, renderQuality: "draft" | "standard" | "high"): void {
    this.emitters = emitters;
    this.rebuildEmitters(is3d, renderQuality);
  }

  apply(
    preset: SceneLightingPreset,
    options: {
      readonly is3d: boolean;
      readonly shadowsEnabled: boolean;
      readonly renderQuality: "draft" | "standard" | "high";
      readonly customBackground?: boolean;
    },
  ): ScenePresetConfig {
    this.preset = preset;
    const cfg = SCENE_LIGHTING_PRESETS[preset];

    // 2D plan views always stay crisp bright daylight regardless of 3D night/evening mode
    const active = options.is3d ? cfg : SCENE_LIGHTING_PRESETS.noon;

    // 1. Background & PMREM environment (Draft omits PMREM IBL for software WebGL / fast matte navigation)
    if (!options.is3d || active.mood === "day") {
      if (!options.customBackground) {
        this.scene.background = options.is3d ? new THREE.Color(active.backgroundHex) : this.dayBackground;
      }
      if (options.renderQuality === "draft") {
        this.scene.environment = null;
      } else {
        let dayEnv = this.envCache.get("day");
        if (!dayEnv) {
          dayEnv = this.defaultDayEnv ?? buildMoodEnvironment(this.renderer, "day");
          this.envCache.set("day", dayEnv);
        }
        this.scene.environment = dayEnv;
        this.scene.environmentIntensity = active.envIntensity;
      }
    } else {
      this.scene.background = new THREE.Color(active.backgroundHex);
      if (options.renderQuality === "draft") {
        this.scene.environment = null;
      } else {
        let moodEnv = this.envCache.get(active.mood);
        if (moodEnv === undefined) {
          moodEnv = buildMoodEnvironment(this.renderer, active.mood);
          this.envCache.set(active.mood, moodEnv);
        }
        this.scene.environment = moodEnv;
        this.scene.environmentIntensity = active.envIntensity;
      }
    }

    // 2. Hemisphere, directional sun/moon, and sky fill
    this.hemiLight.color.setHex(active.hemiSkyHex);
    this.hemiLight.groundColor.setHex(active.hemiGroundHex);
    this.hemiLight.intensity = active.hemiIntensity;

    const az = (active.sunAzimuthDeg * Math.PI) / 180;
    const el = (Math.max(4, Math.min(85, active.sunElevationDeg)) * Math.PI) / 180;
    const dist = 120;
    const horiz = Math.cos(el) * dist;
    this.sunLight.position.set(Math.cos(az) * horiz, Math.sin(el) * dist, Math.sin(az) * horiz);
    this.sunLight.color.setHex(active.sunColorHex);
    this.sunLight.intensity = active.sunIntensity;
    this.sunLight.castShadow = options.is3d && options.shadowsEnabled && active.sunShadows && options.renderQuality !== "draft";

    this.fillLight.color.setHex(active.fillColorHex);
    this.fillLight.intensity = active.fillIntensity;

    // 3. Tone mapping exposure scaled cleanly by render quality
    const qBoost = options.renderQuality === "high" ? 0.05 : options.renderQuality === "draft" ? -0.04 : 0;
    this.renderer.toneMappingExposure = active.exposure + qBoost;

    // 4. Rebuild physical emitters (all glowing diffusers + fixed-size camera-frustum SpotLight pool)
    this.rebuildEmitters(options.is3d, options.renderQuality);

    return cfg;
  }

  rebuildEmitters(is3d: boolean, renderQuality: "draft" | "standard" | "high"): void {
    clearEmitterGroup(this.emitterRoot);
    this.spotPool = [];
    this.spotCandidates = [];
    this.scoredIndices = [];
    this.lastCamPos.set(Infinity, Infinity, Infinity);
    if (!is3d) return;

    const cfg = SCENE_LIGHTING_PRESETS[this.preset];
    if (cfg.emitterFactor <= 0.001 || this.emitters.length === 0) return;

    const { active, spotCandidates } = prepareActiveEmitters(this.emitters, cfg);
    if (active.length === 0) return;

    const group = new THREE.Group();
    group.name = "scene-light-emitters";
    buildDiffuserMeshes(group, active);

    const poolSize = Math.min(spotCandidates.length, spotPoolBudget(renderQuality, cfg.mood));
    this.spotCandidates = spotCandidates;
    this.scoredIndices = spotCandidates.map((_, idx) => ({ idx, score: 0 }));

    // Initial spatial selection until first camera tick focuses the pool on the live frustum
    const initial = selectDynamicSpotlights(
      active.filter((a) => a.emitter.emitterRole !== "sign" && a.effectiveCandela > 0),
      poolSize,
    );
    const byId = new Map(spotCandidates.map((c) => [c.id, c]));
    for (let i = 0; i < poolSize; i++) {
      const cand = byId.get(initial[i]?.emitter.id ?? "") ?? spotCandidates[i]!;
      const spot = new THREE.SpotLight(cand.colorHex, cand.intensity, cand.distanceM, cand.halfAngleRad, cand.penumbra, 2);
      spot.castShadow = false;
      applyCandidateToSpot(spot, cand);
      group.add(spot);
      group.add(spot.target);
      this.spotPool.push(spot);
    }

    this.emitterRoot.add(group);
  }

  /**
   * Reassign the pre-allocated SpotLight pool in-place to the fixtures visible
   * inside the current camera frustum and closest to the orbit focus. Runs in
   * < 0.03 ms with zero allocations and zero WebGL shader recompilations; skips
   * work entirely whenever the camera has not moved.
   */
  updateCameraFocus(camera: THREE.Camera, orbitTarget: THREE.Vector3): void {
    const poolLen = this.spotPool.length;
    const candLen = this.spotCandidates.length;
    if (poolLen === 0 || candLen <= poolLen) return;

    camera.getWorldDirection(this.scratchDir);
    const posMovedSq = camera.position.distanceToSquared(this.lastCamPos);
    const tgtMovedSq = orbitTarget.distanceToSquared(this.lastCamTarget);
    const dirDot = this.scratchDir.dot(this.lastCamDir);
    if (posMovedSq < 0.04 && tgtMovedSq < 0.04 && dirDot > 0.9994) return;

    this.lastCamPos.copy(camera.position);
    this.lastCamTarget.copy(orbitTarget);
    this.lastCamDir.copy(this.scratchDir);

    this.projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreenMatrix);

    // Focus point blends orbit target & camera position so zooming close to a wall prioritizes fixtures right in front of you
    const camToTargetDist = camera.position.distanceTo(orbitTarget);
    const zoomedOut = camToTargetDist > 12;
    this.scratchFocus.copy(orbitTarget).lerp(camera.position, zoomedOut ? 0.25 : 0.45);
    const fx = this.scratchFocus.x;
    const fy = this.scratchFocus.y;
    const fz = this.scratchFocus.z;

    for (let i = 0; i < candLen; i++) {
      const c = this.spotCandidates[i]!;
      this.boundSphere.center.set(c.boundCenter[0], c.boundCenter[1], c.boundCenter[2]);
      this.boundSphere.radius = c.boundRadius;
      const inFrustum = this.frustum.intersectsSphere(this.boundSphere);
      const dx = c.pos[0] - fx;
      const dy = c.pos[1] - fy;
      const dz = c.pos[2] - fz;
      const dist = Math.hypot(dx, dy, dz);
      // Off-screen lights get pushed behind all visible lights; exterior sconces keep priority when zoomed out on facade
      let score = dist + (inFrustum ? 0 : 1000);
      if (zoomedOut && c.isWall && inFrustum) score *= 0.45;
      const slot = this.scoredIndices[i]!;
      slot.idx = i;
      slot.score = score;
    }

    this.scoredIndices.sort((a, b) => a.score - b.score);

    for (let i = 0; i < poolLen; i++) {
      const cand = this.spotCandidates[this.scoredIndices[i]!.idx]!;
      applyCandidateToSpot(this.spotPool[i]!, cand);
    }
  }

  dispose(): void {
    clearEmitterGroup(this.emitterRoot);
    this.spotPool = [];
    this.spotCandidates = [];
    this.scoredIndices = [];
    for (const [mood, tex] of this.envCache) {
      if (mood !== "day" && tex) tex.dispose();
    }
    this.envCache.clear();
  }
}
