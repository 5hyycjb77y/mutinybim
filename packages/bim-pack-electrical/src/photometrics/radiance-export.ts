import {
  elementsOfKind,
  findLevelByName,
  parseHexColor,
  resolveElementMaterial,
  type BimElement,
  type Ceiling,
  type Column,
  type Level,
  type MaterialDef,
  type ModelState,
  type Opening,
  type Slab,
  type Vec2,
  type Wall,
} from "@permitzip/bim-kernel";
import { collectLuminaires, collectModelSpaces } from "./calc";
import { isGlazingMaterial, materialReflectance, materialTransmittance } from "./materials";
import { DEFAULT_BATTERY_90MIN_DERATE } from "./parameters";
import { extractStairs3D } from "./stairs";
import type { DaylightSkyModel } from "./daylight";

/**
 * Pure-text LBNL Radiance (`.rad` + `.ies` + `.pts`) scene exporter.
 *
 * Translates a live MutinyBIM model into standard Radiance scene files so lighting
 * and daylighting engineers can run full backward raytracing (`oconv`, `rtrace`,
 * `rpict`, `evalglare`, BSDF blinds, annual sDA/ASE) with zero runtime dependency
 * or license coupling in MutinyBIM.
 */

const M_PER_MM = 0.001;

export interface RadianceExportOptions {
  /** Sky model for `sky.rad` `!gensky` header (default `"cie_overcast"`). */
  readonly skyModel?: DaylightSkyModel;
  /** Solar azimuth in degrees clockwise from +Y North (default 180°). */
  readonly sunAzimuthDeg?: number;
  /** Solar altitude above horizon in degrees (default 45°). */
  readonly sunElevationDeg?: number;
  /** Include electric luminaires & `.ies` files (default true). */
  readonly includeLuminaires?: boolean;
  /** Sensor grid spacing in feet for `sensors.pts` (default 2 ft). */
  readonly gridSpacingFt?: number;
  /** Workplane elevation AFF in inches for `sensors.pts` (default 30 in). */
  readonly workplaneHeightIn?: number;
}

export interface RadianceSceneExport {
  /** Radiance material definitions (`plastic` & `glass` primitives from `kernel.material`). */
  readonly materialsRad: string;
  /** 3D architectural polygons in meters (walls with openings punched, glazing panes, slabs, ceilings, columns, stairs). */
  readonly geometryRad: string;
  /** Luminaires file referencing exported `.ies` files via `!ies2rad` / `!xform`. */
  readonly luminairesRad: string;
  /** Sky + ground definition (`!gensky` + `skyfunc`). */
  readonly skyRad: string;
  /** `rtrace -I` horizontal workplane sensor grid (`x y z nx ny nz` in meters). */
  readonly sensorGridPts: string;
  /** Deduplicated ANSI/IES LM-63 `.ies` file contents keyed by filename (e.g. `troffer_2x4_led.ies`). */
  readonly iesFiles: Readonly<Record<string, string>>;
  /** Summary counts for quick verification. */
  readonly summary: {
    readonly materialCount: number;
    readonly wallCount: number;
    readonly openingCount: number;
    readonly slabCount: number;
    readonly luminaireCount: number;
    readonly iesFileCount: number;
    readonly sensorCount: number;
  };
  /** Copy-paste Radiance CLI commands (`oconv`, `rtrace`, `rpict`, `evalglare`). */
  readonly commands: readonly string[];
}

function fmt(n: number): string {
  return Number.isFinite(n) ? n.toFixed(4) : "0.0000";
}

function sanitizeId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function srgbToLinear(c8: number): number {
  const c = Math.max(0, Math.min(1, c8 / 255));
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * Canonical Greg Ward Radiance glass transmissivity `tn` from visible transmittance `T_vis`:
 * `tn = (sqrt(0.8402528435 + 0.0072522239 * T^2) - 0.9166530661) / (0.0036261119 * T)`.
 */
export function radianceGlassTransmissivity(tVis: number): number {
  const t = Math.max(0.01, Math.min(0.96, tVis));
  return (Math.sqrt(0.8402528435 + 0.0072522239 * t * t) - 0.9166530661) / (0.0036261119 * t);
}

function rgbReflectanceFromMaterial(mat: MaterialDef | null, fallbackRho: number): readonly [number, number, number] {
  const targetRho = materialReflectance(mat, fallbackRho);
  const rgb = mat ? parseHexColor(mat.color) : null;
  if (rgb === null) return [targetRho, targetRho, targetRho];
  const r = srgbToLinear((rgb >> 16) & 0xff);
  const g = srgbToLinear((rgb >> 8) & 0xff);
  const b = srgbToLinear(rgb & 0xff);
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (luma < 1e-4) return [targetRho, targetRho, targetRho];
  const scale = targetRho / luma;
  return [
    Math.max(0.01, Math.min(0.95, r * scale)),
    Math.max(0.01, Math.min(0.95, g * scale)),
    Math.max(0.01, Math.min(0.95, b * scale)),
  ];
}

function emitPolygon(matId: string, name: string, pts: readonly (readonly [number, number, number])[]): string {
  const lines = [`${matId} polygon ${sanitizeId(name)}`, "0", "0", String(pts.length * 3)];
  for (const [x, y, z] of pts) {
    lines.push(`  ${fmt(x * M_PER_MM)} ${fmt(y * M_PER_MM)} ${fmt(z * M_PER_MM)}`);
  }
  return lines.join("\n") + "\n\n";
}

function levelElevationMap(model: ModelState): ReadonlyMap<string, number> {
  const map = new Map<string, number>();
  for (const l of elementsOfKind(model.elements, "level")) map.set(l.id, l.elevationMm);
  return map;
}

function resolveBaseZ(el: BimElement, levels: ReadonlyMap<string, number>, sortedLevels: readonly Level[]): number {
  if ("placement" in el && el.placement && "levelId" in el.placement) {
    const base = levels.get(el.placement.levelId) ?? 0;
    const off = "startOffsetMm" in el.placement ? el.placement.startOffsetMm : "offsetMm" in el.placement ? el.placement.offsetMm : 0;
    return base + off;
  }
  if (el.partition?.level) {
    const lvl = findLevelByName(sortedLevels, el.partition.level);
    if (lvl) return lvl.elevationMm;
  }
  return 0;
}

function opKindIsWindow(op: Opening): boolean {
  return op.openingType === "window";
}

function pointInPolygon2D(px: number, py: number, poly: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i]!.x;
    const yi = poly[i]!.y;
    const xj = poly[j]!.x;
    const yj = poly[j]!.y;
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Export a MutinyBIM `ModelState` into standard LBNL Radiance `.rad`, `.ies`, and `.pts` text files.
 */
export function exportRadianceScene(
  model: ModelState,
  options: RadianceExportOptions = {},
): RadianceSceneExport {
  const levels = levelElevationMap(model);
  const sortedLevels = [...elementsOfKind(model.elements, "level")].sort((a, b) => a.elevationMm - b.elevationMm);

  // Material registry collector
  const emittedMaterials = new Map<string, string>();
  const registerMaterial = (mat: MaterialDef | null, fallbackId: string, fallbackRho: number, forceGlazingTVis?: number): string => {
    const id = sanitizeId(mat?.id ?? fallbackId);
    if (emittedMaterials.has(id)) return id;

    if (forceGlazingTVis !== undefined || (mat && isGlazingMaterial(mat))) {
      const tVis = forceGlazingTVis ?? materialTransmittance(mat);
      const tn = radianceGlassTransmissivity(tVis > 0 ? tVis : 0.78);
      emittedMaterials.set(
        id,
        `void glass ${id}\n0\n0\n3 ${fmt(tn)} ${fmt(tn)} ${fmt(tn)}\n\n`,
      );
      return id;
    }

    const [r, g, b] = rgbReflectanceFromMaterial(mat, fallbackRho);
    const rough = mat?.roughness !== undefined ? Math.max(0.02, Math.min(0.95, mat.roughness * 0.25)) : 0.12;
    const spec = mat?.metalness !== undefined && mat.metalness > 0.4 ? 0.15 : 0.02;
    emittedMaterials.set(
      id,
      `void plastic ${id}\n0\n0\n5 ${fmt(r)} ${fmt(g)} ${fmt(b)} ${fmt(spec)} ${fmt(rough)}\n\n`,
    );
    return id;
  };

  const defaultGlazingMat = registerMaterial(null, "default_window_glass", 0.08, 0.78);

  // Group openings by wall
  const openingsByWall = new Map<string, Opening[]>();
  let openingCount = 0;
  for (const op of elementsOfKind(model.elements, "opening") as Iterable<Opening>) {
    if (!op.hostId) continue;
    openingCount++;
    const arr = openingsByWall.get(op.hostId);
    if (arr) arr.push(op);
    else openingsByWall.set(op.hostId, [op]);
  }

  let geometryRad = "# MutinyBIM -> LBNL Radiance 3D scene geometry (units: meters)\n\n";
  let wallCount = 0;

  // 1. Walls with punched window/door openings + glazed window panes
  for (const wall of elementsOfKind(model.elements, "wall") as Iterable<Wall>) {
    const dx = wall.end.x - wall.start.x;
    const dy = wall.end.y - wall.start.y;
    const len = Math.hypot(dx, dy);
    if (len < 10) continue;
    wallCount++;
    const ux = dx / len;
    const uy = dy / len;
    const z0 = resolveBaseZ(wall, levels, sortedLevels);
    const z1 = z0 + Math.max(100, wall.height);
    const wallMat = registerMaterial(resolveElementMaterial(model, wall) ?? null, "default_wall", 0.5);

    const ops = (openingsByWall.get(wall.id) ?? [])
      .map((op) => {
        const halfW = Math.max(100, op.width * 0.5);
        const s0 = Math.max(0, op.offset - halfW);
        const s1 = Math.min(len, op.offset + halfW);
        const sillVal = op.values?.["opening.sill_mm"] ?? op.values?.["arch.sill_height"] ?? op.values?.sill_height;
        const sillMm = typeof sillVal === "number" && Number.isFinite(sillVal) ? sillVal : op.openingType === "window" ? 900 : 0;
        const oz0 = z0 + sillMm;
        const oz1 = Math.min(z1, oz0 + Math.max(100, op.height));
        return { op, s0, s1, oz0, oz1 };
      })
      .filter((o) => o.s1 > o.s0 + 10)
      .sort((a, b) => a.s0 - b.s0);

    const ptAt = (s: number, z: number): readonly [number, number, number] => [
      wall.start.x + ux * s,
      wall.start.y + uy * s,
      z,
    ];

    if (ops.length === 0) {
      geometryRad += emitPolygon(wallMat, `wall_${wall.id}`, [
        ptAt(0, z0),
        ptAt(len, z0),
        ptAt(len, z1),
        ptAt(0, z1),
      ]);
    } else {
      let cursor = 0;
      for (let oi = 0; oi < ops.length; oi++) {
        const o = ops[oi]!;
        if (o.s0 > cursor + 10) {
          geometryRad += emitPolygon(wallMat, `wall_${wall.id}_seg${oi}`, [
            ptAt(cursor, z0),
            ptAt(o.s0, z0),
            ptAt(o.s0, z1),
            ptAt(cursor, z1),
          ]);
        }
        // Sill strip below opening
        if (o.oz0 > z0 + 10) {
          geometryRad += emitPolygon(wallMat, `wall_${wall.id}_sill${oi}`, [
            ptAt(o.s0, z0),
            ptAt(o.s1, z0),
            ptAt(o.s1, o.oz0),
            ptAt(o.s0, o.oz0),
          ]);
        }
        // Header strip above opening
        if (z1 > o.oz1 + 10) {
          geometryRad += emitPolygon(wallMat, `wall_${wall.id}_hdr${oi}`, [
            ptAt(o.s0, o.oz1),
            ptAt(o.s1, o.oz1),
            ptAt(o.s1, z1),
            ptAt(o.s0, z1),
          ]);
        }
        // Window glazing pane (doors stay open/transparent or glazed if explicitly assigned glass)
        const isWindow = opKindIsWindow(o.op);
        if (isWindow) {
          const opMat = resolveElementMaterial(model, o.op);
          const paneMat = opMat ? registerMaterial(opMat, defaultGlazingMat, 0.08, materialTransmittance(opMat) || 0.78) : defaultGlazingMat;
          geometryRad += emitPolygon(paneMat, `glass_${o.op.id}`, [
            ptAt(o.s0, o.oz0),
            ptAt(o.s1, o.oz0),
            ptAt(o.s1, o.oz1),
            ptAt(o.s0, o.oz1),
          ]);
        }
        cursor = Math.max(cursor, o.s1);
      }
      if (len > cursor + 10) {
        geometryRad += emitPolygon(wallMat, `wall_${wall.id}_tail`, [
          ptAt(cursor, z0),
          ptAt(len, z0),
          ptAt(len, z1),
          ptAt(cursor, z1),
        ]);
      }
    }
  }

  // 2. Floor & roof slabs (plus architectural roofs `architecture.roof`)
  let slabCount = 0;
  for (const slab of elementsOfKind(model.elements, "slab") as Iterable<Slab>) {
    if (slab.outline.length < 3) continue;
    slabCount++;
    const zTop = resolveBaseZ(slab, levels, sortedLevels);
    const mat = registerMaterial(resolveElementMaterial(model, slab) ?? null, "default_slab", 0.35);
    geometryRad += emitPolygon(
      mat,
      `slab_${slab.id}`,
      slab.outline.map((p) => [p.x, p.y, zTop] as const),
    );
  }
  for (const el of Object.values(model.elements)) {
    const raw = el as unknown as {
      kind?: string;
      id?: string;
      levelId?: string;
      outline?: readonly Vec2[];
      baseOffsetMm?: number;
    };
    if (raw.kind !== "architecture.roof" || !Array.isArray(raw.outline) || raw.outline.length < 3) continue;
    slabCount++;
    const baseZ = (raw.levelId ? levels.get(raw.levelId) : undefined) ?? resolveBaseZ(el, levels, sortedLevels);
    const zTop = baseZ + (typeof raw.baseOffsetMm === "number" ? raw.baseOffsetMm : 0);
    const mat = registerMaterial(resolveElementMaterial(model, el) ?? null, "default_roof", 0.25);
    geometryRad += emitPolygon(
      mat,
      `roof_${raw.id ?? el.id}`,
      [...raw.outline].reverse().map((p) => [p.x, p.y, zTop] as const),
    );
  }

  // 3. Ceilings
  for (const ceil of elementsOfKind(model.elements, "ceiling") as Iterable<Ceiling>) {
    if (ceil.outline.length < 3 || ceil.role === "open_to_structure" || ceil.form === "open_to_structure") continue;
    const z = (levels.get(ceil.levelId) ?? 0) + ceil.heightMm;
    const mat = registerMaterial(resolveElementMaterial(model, ceil) ?? null, "default_ceiling", 0.8);
    // Reverse winding so ceiling normal faces downward (-Z)
    geometryRad += emitPolygon(
      mat,
      `ceiling_${ceil.id}`,
      [...ceil.outline].reverse().map((p) => [p.x, p.y, z] as const),
    );
  }

  // 4. Structural columns (4 vertical faces)
  for (const col of elementsOfKind(model.elements, "column") as Iterable<Column>) {
    const z0 = resolveBaseZ(col, levels, sortedLevels);
    const nextLvl = sortedLevels.find((l) => l.elevationMm > z0 + 500);
    const z1 = nextLvl ? nextLvl.elevationMm : z0 + 3600;
    const hw = Math.max(50, col.size.x * 0.5);
    const hd = Math.max(50, col.size.y * 0.5);
    const cx = col.position.x;
    const cy = col.position.y;
    const mat = registerMaterial(resolveElementMaterial(model, col) ?? null, "default_column", 0.4);
    const corners: readonly [number, number][] = [
      [cx - hw, cy - hd],
      [cx + hw, cy - hd],
      [cx + hw, cy + hd],
      [cx - hw, cy + hd],
    ];
    for (let f = 0; f < 4; f++) {
      const a = corners[f]!;
      const b = corners[(f + 1) % 4]!;
      geometryRad += emitPolygon(mat, `col_${col.id}_f${f}`, [
        [a[0], a[1], z0],
        [b[0], b[1], z0],
        [b[0], b[1], z1],
        [a[0], a[1], z1],
      ]);
    }
  }

  // 5. Stair flights & mid-landings
  const stairMat = registerMaterial(null, "default_stair", 0.42);
  for (const st of extractStairs3D(model)) {
    for (const fl of st.flights) {
      const hw = fl.widthMm * 0.5;
      const a0: readonly [number, number, number] = [fl.start.x - fl.n.x * hw, fl.start.y - fl.n.y * hw, fl.z0];
      const a1: readonly [number, number, number] = [fl.start.x + fl.n.x * hw, fl.start.y + fl.n.y * hw, fl.z0];
      const b1: readonly [number, number, number] = [fl.end.x + fl.n.x * hw, fl.end.y + fl.n.y * hw, fl.z1];
      const b0: readonly [number, number, number] = [fl.end.x - fl.n.x * hw, fl.end.y - fl.n.y * hw, fl.z1];
      geometryRad += emitPolygon(stairMat, `stair_${st.stairId}_f${fl.index}`, [a0, a1, b1, b0]);
    }
    for (const lnd of st.landings) {
      geometryRad += emitPolygon(
        stairMat,
        `stair_${st.stairId}_l${lnd.index}`,
        lnd.outline.map((p) => [p.x, p.y, lnd.zTop] as const),
      );
    }
  }

  // 6. Luminaires + ANSI/IES LM-63 files
  const iesFiles: Record<string, string> = {};
  let luminairesRad = "# MutinyBIM electric luminaires (run ies2rad on exported ies/*.ies files)\n\n";
  let luminaireCount = 0;
  if (options.includeLuminaires !== false) {
    const lums = collectLuminaires(model, DEFAULT_BATTERY_90MIN_DERATE);
    for (const lum of lums) {
      luminaireCount++;
      const profileKey = sanitizeId(lum.photo.profileId || lum.id);
      const iesFilename = `${profileKey}.ies`;
      if (!iesFiles[iesFilename]) {
        const scaledCandela = lum.photo.web.candela.map((row) => row.map((cd) => cd * lum.photo.web.candelaScale * lum.photo.lumenScale));
        iesFiles[iesFilename] = synthesizeIesTextFromWeb(
          profileKey,
          lum.photo.web.verticalAngles,
          lum.photo.web.horizontalAngles,
          scaledCandela,
          lum.photo.watts,
          lum.photo.web.totalLumens * lum.photo.lumenScale,
        );
      }
      luminairesRad += `!ies2rad -m ${fmt(lum.photo.llf)} -o lum_${sanitizeId(lum.id)} -d m ies/${iesFilename} | xform -rz ${fmt(lum.rotationDeg)} -t ${fmt(lum.xMm * M_PER_MM)} ${fmt(lum.yMm * M_PER_MM)} ${fmt(lum.zMm * M_PER_MM)}\n`;
    }
  }

  // 7. Sky definition (`sky.rad`)
  const skyModel: DaylightSkyModel = options.skyModel ?? "cie_overcast";
  const sunAz = options.sunAzimuthDeg ?? 180;
  const sunEl = options.sunElevationDeg ?? 45;
  // Radiance gensky azimuth: degrees West of South (`az_rad = sunAz - 180`)
  const genskyAz = sunAz - 180;
  const skyFlag = skyModel === "cie_overcast" ? "-c" : skyModel === "cie_clear" ? "+s" : "+i";
  const skyRad = [
    `# MutinyBIM sky (${skyModel}, sun alt=${sunEl} deg, az=${sunAz} deg CW from North)`,
    `!gensky -ang ${fmt(sunEl)} ${fmt(genskyAz)} ${skyFlag}`,
    "",
    "skyfunc glow sky_glow",
    "0",
    "0",
    "4 1 1 1 0",
    "",
    "sky_glow source sky",
    "0",
    "0",
    "4 0 0 1 180",
    "",
    "skyfunc glow ground_glow",
    "0",
    "0",
    "4 0.2 0.2 0.2 0",
    "",
    "ground_glow source ground",
    "0",
    "0",
    "4 0 0 -1 180",
    "",
  ].join("\n");

  // 8. Workplane sensor grid (`sensors.pts`) across all spaces and rooms
  const spacingMm = Math.max(304.8, (options.gridSpacingFt ?? 2) * 304.8);
  const wpMm = (options.workplaneHeightIn ?? 30) * 25.4;
  const sensorLines: string[] = [];
  for (const poly of collectModelSpaces(model)) {
    if (poly.outline.length < 3) continue;
    const zMm = poly.levelElevationMm + wpMm;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of poly.outline) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    for (let y = minY + spacingMm * 0.5; y < maxY; y += spacingMm) {
      for (let x = minX + spacingMm * 0.5; x < maxX; x += spacingMm) {
        if (!pointInPolygon2D(x, y, poly.outline)) continue;
        sensorLines.push(`${fmt(x * M_PER_MM)} ${fmt(y * M_PER_MM)} ${fmt(zMm * M_PER_MM)} 0 0 1`);
      }
    }
  }

  let materialsRad = "# MutinyBIM -> LBNL Radiance materials (derived from kernel.material)\n\n";
  for (const def of emittedMaterials.values()) materialsRad += def;

  return {
    materialsRad,
    geometryRad,
    luminairesRad,
    skyRad,
    sensorGridPts: sensorLines.join("\n") + (sensorLines.length > 0 ? "\n" : ""),
    iesFiles,
    summary: {
      materialCount: emittedMaterials.size,
      wallCount,
      openingCount,
      slabCount,
      luminaireCount,
      iesFileCount: Object.keys(iesFiles).length,
      sensorCount: sensorLines.length,
    },
    commands: [
      "oconv sky.rad materials.rad geometry.rad luminaires.rad > scene.oct",
      "rtrace -I -ab 4 -ad 1024 -aa 0.1 -h scene.oct < sensors.pts | rcalc -e '$1=(0.265*$1+0.670*$2+0.065*$3)*179/10.7639' > workplane_fc.txt",
      "rpict -vta -vv 180 -vh 180 -ab 4 -x 1024 -y 1024 scene.oct > fisheye.hdr && evalglare fisheye.hdr",
    ],
  };
}

/** Serialize an internal candela web back to canonical ANSI/IES LM-63-2002 text for `ies2rad`. */
function synthesizeIesTextFromWeb(
  name: string,
  vAngles: readonly number[],
  hAngles: readonly number[],
  candela: readonly (readonly number[])[],
  watts: number,
  totalLumens: number,
): string {
  const lines = [
    "IESNA:LM-63-2002",
    `[TEST] MutinyBIM Export (${name})`,
    `[LUMCAT] ${name}`,
    "TILT=NONE",
    `1 ${totalLumens.toFixed(1)} 1.0 ${vAngles.length} ${hAngles.length} 1 2 0.30 0.60 0.08`,
    `1.0 1.0 ${Math.max(1, watts).toFixed(1)}`,
    vAngles.map((a) => a.toFixed(1)).join(" "),
    hAngles.map((a) => a.toFixed(1)).join(" "),
  ];
  for (const row of candela) {
    lines.push(row.map((cd) => Math.max(0, cd).toFixed(1)).join(" "));
  }
  return lines.join("\n") + "\n";
}
