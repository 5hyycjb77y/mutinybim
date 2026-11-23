import {
  partToWorld,
  placedGeometry,
  type ModelState,
  type PartInstance,
  type PartTypeElement,
} from '@permitzip/bim-kernel'
import {
  collectPlacedLuminaires,
  evaluateEgressPhotometrics,
  evaluateNormalPhotometrics,
  sampleCandela,
  type PlacedLuminaire,
} from '@permitzip/bim-pack-electrical'
import type { ScalarHeatmapCell, ScalarHeatmapOverlay, SceneLightEmitter } from '@permitzip/bim-viewer-3d'

export type PhotometricsHeatmapMode = 'off' | 'normal' | 'normal_simplified' | 'surfaces' | 'egress'

const MM_PER_FT = 304.8

export interface BuiltPhotometricsHeatmap {
  readonly overlay: ScalarHeatmapOverlay | null
  readonly summary: string
  readonly pass: boolean
}

/**
 * Convert live photometric calc results (`electrical.photometrics_normal` /
 * `electrical.photometrics_egress`) into a trade-agnostic 3D `ScalarHeatmapOverlay`
 * for `ModelViewer3D.setScalarHeatmap(...)`.
 *
 * - `'normal'`: Detailed mode (Materials Library reflectances, glazing transmittance,
 *   furniture & stair occlusion) across room workplanes + 3D stair treads.
 * - `'normal_simplified'`: Clean empty-room space plane (standard 80/50/20, ignores furniture).
 * - `'surfaces'`: Fine-grid illuminance directly on actual kitchen counters, islands,
 *   worktables, conference tables, vanities, and 3D multi-flight stair treads.
 * - `'egress'`: NFPA 101 §7.9.2.1 floor-plane + 3D rising stair tread pass/fail map.
 */
export function buildPhotometricsHeatmap(
  model: ModelState,
  mode: PhotometricsHeatmapMode,
  levelId?: string | null,
): BuiltPhotometricsHeatmap {
  if (mode === 'off') {
    return { overlay: null, summary: '3D photometric heatmap off.', pass: true }
  }

  if (mode === 'egress') {
    const res = evaluateEgressPhotometrics(model, {
      ...(levelId ? { level: levelId } : {}),
      gridSpacingFt: 2,
      workplaneHeightIn: 0,
      calculationMode: 'detailed',
    })
    const defaultCellMm = res.gridSpacingFt * MM_PER_FT
    const cells: ScalarHeatmapCell[] = res.gridPoints.map((pt) => {
      const sz = pt.cellSizeMm ?? defaultCellMm * 0.96
      return {
        xMm: pt.xMm,
        yMm: pt.yMm,
        zMm: pt.zMm,
        widthMm: sz,
        depthMm: sz,
        ...(pt.rotationDeg !== undefined ? { rotationDeg: pt.rotationDeg } : {}),
        value: pt.fc,
        fail: pt.fail,
      }
    })
    const overlay: ScalarHeatmapOverlay | null =
      cells.length > 0
        ? {
            cells,
            minValue: 0,
            maxValue: Math.max(2.5, res.overallMaxFc),
            threshold: res.thresholds.initialMinFc,
            palette: 'pass_fail',
            opacity: 0.76,
          }
        : null
    const summary =
      res.paths.length === 0
        ? 'Egress 3D heatmap: no corridor, stair, or exit discharge paths found on this level.'
        : `Egress 3D heatmap (${res.pass ? 'PASS' : 'FAIL'}): ${res.passingPaths}/${res.paths.length} paths pass (incl. 3D stair treads) — init ${res.overallAvgFc.toFixed(1)} avg / ${res.overallMinFc.toFixed(2)} min fc, 90-min ${res.overallAvgFc90Min.toFixed(1)} / ${res.overallMinFc90Min.toFixed(2)} fc.`
    return { overlay, summary, pass: res.pass }
  }

  if (mode === 'surfaces') {
    const res = evaluateNormalPhotometrics(model, {
      ...(levelId ? { level: levelId } : {}),
      gridSpacingFt: 2,
      calculationMode: 'surfaces',
      includeTaskSurfaces: true,
      interReflectance: true,
    })
    const cells: ScalarHeatmapCell[] = []
    let maxFc = 50
    for (const sf of res.surfaceSummaries) {
      if (sf.maxFc > maxFc) maxFc = sf.maxFc
      for (const pt of sf.gridPoints) {
        const sz = pt.cellSizeMm ?? 290
        cells.push({
          xMm: pt.xMm,
          yMm: pt.yMm,
          zMm: pt.zMm,
          widthMm: sz,
          depthMm: sz,
          ...(pt.rotationDeg !== undefined ? { rotationDeg: pt.rotationDeg } : {}),
          value: pt.fc,
          fail: pt.fail,
        })
      }
    }
    for (const st of res.stairSummaries) {
      if (st.maxFc > maxFc) maxFc = st.maxFc
      for (const pt of st.gridPoints) {
        const sz = pt.cellSizeMm ?? 340
        cells.push({
          xMm: pt.xMm,
          yMm: pt.yMm,
          zMm: pt.zMm,
          widthMm: sz,
          depthMm: sz,
          ...(pt.rotationDeg !== undefined ? { rotationDeg: pt.rotationDeg } : {}),
          value: pt.fc,
          fail: pt.fail,
        })
      }
    }
    const overlay: ScalarHeatmapOverlay | null =
      cells.length > 0
        ? {
            cells,
            minValue: 0,
            maxValue: maxFc,
            palette: 'viridis',
            opacity: 0.84,
          }
        : null
    const surfPass = res.surfaceSummaries.filter((s) => s.pass).length
    const stairPass = res.stairSummaries.filter((s) => s.pass).length
    const totalCount = res.surfaceSummaries.length + res.stairSummaries.length
    const allPass = surfPass === res.surfaceSummaries.length && stairPass === res.stairSummaries.length
    const summary =
      totalCount === 0
        ? 'Task surfaces 3D heatmap: no counters, worktables, vanities, or stairs found on this level.'
        : `Task surfaces & 3D stairs (${allPass ? 'PASS' : 'FAIL'}): ${surfPass}/${res.surfaceSummaries.length} surfaces & ${stairPass}/${res.stairSummaries.length} stairs pass.`
    return { overlay, summary, pass: allPass }
  }

  const isSimplified = mode === 'normal_simplified'
  const res = evaluateNormalPhotometrics(model, {
    ...(levelId ? { level: levelId } : {}),
    gridSpacingFt: 2,
    calculationMode: isSimplified ? 'simplified' : 'detailed',
    includeTaskSurfaces: !isSimplified,
    interReflectance: true,
  })
  const defaultCellMm = res.gridSpacingFt * MM_PER_FT
  const allPts = isSimplified
    ? res.gridPoints
    : [...res.gridPoints, ...res.stairSummaries.flatMap((st) => st.gridPoints)]
  const cells: ScalarHeatmapCell[] = allPts.map((pt) => {
    const sz = pt.cellSizeMm ?? defaultCellMm * 0.96
    return {
      xMm: pt.xMm,
      yMm: pt.yMm,
      zMm: pt.zMm,
      widthMm: sz,
      depthMm: sz,
      ...(pt.rotationDeg !== undefined ? { rotationDeg: pt.rotationDeg } : {}),
      value: pt.fc,
      fail: pt.fail,
    }
  })
  const overlay: ScalarHeatmapOverlay | null =
    cells.length > 0
      ? {
          cells,
          minValue: 0,
          maxValue: Math.max(50, res.overallMaxFc),
          palette: 'viridis',
          opacity: 0.72,
        }
      : null
  const modeLabel = isSimplified ? 'Simplified space plane' : 'Detailed (materials + furniture + 3D stairs)'
  const summary =
    res.spaces.length === 0
      ? `Normal 3D heatmap (${modeLabel}): no active rooms or spaces on this level.`
      : `Normal 3D heatmap — ${modeLabel} (${res.pass ? 'PASS' : 'FAIL'}): ${res.passingSpaces}/${res.spaces.length} spaces pass — avg ${res.overallAvgFc.toFixed(1)} fc, min ${res.overallMinFc.toFixed(1)} fc, LPD ${res.overallLpdWPerSqFt.toFixed(2)} W/sf.`
  return { overlay, summary, pass: res.pass }
}

/** Estimate the IES half-maximum beam cone angle (full angle in degrees) & penumbra softness from a luminaire's candela web. */
function deriveBeamFromWeb(lum: PlacedLuminaire): { readonly beamAngleDeg: number; readonly penumbra: number; readonly peakCd: number } {
  const web = lum.photo.web
  const scale = lum.photo.lumenScale * lum.photo.llf * lum.tiltFactor
  let peakCd = 0
  let peakTheta = 0
  for (let th = 0; th <= 85; th += 5) {
    const cd = sampleCandela(web, th, 0) * scale
    if (cd > peakCd) {
      peakCd = cd
      peakTheta = th
    }
  }
  if (peakCd <= 1) return { beamAngleDeg: 110, penumbra: 0.7, peakCd: Math.max(100, lum.photo.web.totalLumens * lum.photo.lumenScale * lum.photo.llf * 0.32) }
  let halfMaxTheta = 55
  let fieldTheta = 75
  for (let th = peakTheta; th <= 90; th += 5) {
    const cd = sampleCandela(web, th, 0) * scale
    if (cd <= peakCd * 0.5 && halfMaxTheta === 55) halfMaxTheta = th
    if (cd <= peakCd * 0.1) {
      fieldTheta = th
      break
    }
  }
  const beamAngleDeg = Math.max(36, Math.min(150, halfMaxTheta * 2))
  const spreadRatio = Math.max(0.35, Math.min(0.92, (fieldTheta - halfMaxTheta) / Math.max(15, fieldTheta) + 0.45))
  return { beamAngleDeg, penumbra: spreadRatio, peakCd }
}

interface LocalFixtureBox {
  readonly minX: number
  readonly maxX: number
  readonly minY: number
  readonly maxY: number
  readonly minZ: number
  readonly maxZ: number
  /** Tightest lens footprint on the lowest optical surface of the housing. */
  readonly lensCenter: readonly [number, number, number]
  readonly lensSizeXY: readonly [number, number]
  readonly isRound: boolean
}

/** Derive exact physical diffuser placement and local X/Y aperture from a luminaire's actual 3D part geometry. */
function resolveFixtureLocalBounds(
  model: ModelState,
  lum: PlacedLuminaire,
): { readonly part: PartInstance | null; readonly box: LocalFixtureBox | null } {
  const el = model.elements[lum.id]
  if (!el || el.kind !== 'part') return { part: null, box: null }
  const pt = model.elements[el.typeId]
  if (!pt || pt.kind !== 'part_type') return { part: el, box: null }
  const prims = placedGeometry(pt as PartTypeElement, el)
  if (prims.length === 0) return { part: el, box: null }

  const boxes: Array<{ minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number; isCylinderZ: boolean }> = []
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (const pr of prims) {
    let bx0: number, bx1: number, by0: number, by1: number, bz0: number, bz1: number
    let isCylinderZ = false
    if (pr.kind === 'box') {
      bx0 = pr.center[0] - pr.size[0] * 0.5
      bx1 = pr.center[0] + pr.size[0] * 0.5
      by0 = pr.center[1] - pr.size[1] * 0.5
      by1 = pr.center[1] + pr.size[1] * 0.5
      bz0 = pr.center[2] - pr.size[2] * 0.5
      bz1 = pr.center[2] + pr.size[2] * 0.5
    } else if (pr.kind === 'cylinder') {
      bx0 = pr.center[0] - pr.radius
      bx1 = pr.center[0] + pr.radius
      by0 = pr.center[1] - pr.radius
      by1 = pr.center[1] + pr.radius
      bz0 = pr.center[2] - pr.height * 0.5
      bz1 = pr.center[2] + pr.height * 0.5
      isCylinderZ = pr.axis === 'z'
    } else {
      const xs = pr.profile.map((q) => q.x)
      const ys = pr.profile.map((q) => q.y)
      if (xs.length === 0) continue
      bx0 = Math.min(...xs)
      bx1 = Math.max(...xs)
      by0 = Math.min(...ys)
      by1 = Math.max(...ys)
      bz0 = pr.z
      bz1 = pr.z + pr.height
    }
    boxes.push({ minX: bx0, maxX: bx1, minY: by0, maxY: by1, minZ: bz0, maxZ: bz1, isCylinderZ })
    if (bx0 < minX) minX = bx0
    if (bx1 > maxX) maxX = bx1
    if (by0 < minY) minY = by0
    if (by1 > maxY) maxY = by1
    if (bz0 < minZ) minZ = bz0
    if (bz1 > maxZ) maxZ = bz1
  }
  if (!Number.isFinite(minX)) return { part: el, box: null }

  // Choose the optical bottom lens primitive:
  // - For wall sconces, pick the projecting luminaire body (largest maxY projection off the wall) so the lens hugs the sconce bottom, not the thin backplate.
  // - For ceiling/pendant fixtures, pick the lowest Z primitive (e.g., troffer's central volumetric diffuser strip, downlight bezel, or linear pendant bar).
  let lensPrim = boxes[0]!
  if (lum.mountKind === 'wall') {
    const projecting = boxes.filter((b) => b.maxY - b.minY >= 50)
    const pool = projecting.length > 0 ? projecting : boxes
    lensPrim = pool.reduce((best, cur) => (cur.minZ < best.minZ ? cur : best), pool[0]!)
  } else {
    lensPrim = boxes.reduce((best, cur) => (cur.minZ < best.minZ ? cur : best), boxes[0]!)
  }

  const inset = 14
  const lx = Math.max(48, lensPrim.maxX - lensPrim.minX - inset)
  const ly = Math.max(48, lensPrim.maxY - lensPrim.minY - inset)
  return {
    part: el,
    box: {
      minX,
      maxX,
      minY,
      maxY,
      minZ,
      maxZ,
      lensCenter: [(lensPrim.minX + lensPrim.maxX) * 0.5, (lensPrim.minY + lensPrim.maxY) * 0.5, lensPrim.minZ - 2],
      lensSizeXY: [lx, ly],
      isRound: lensPrim.isCylinderZ || (lum.mountKind === 'ceiling' && Math.abs(lx - ly) < 30 && lx < 300),
    },
  }
}

/**
 * Convert every placed electrical luminaire in `model` into trade-agnostic 3D
 * `SceneLightEmitter` records driven directly by its resolved IES LM-63
 * photometric web, actual 3D fixture housing geometry, dual-level normal vs.
 * emergency lumens (`electrical.emergency_lumens`), and 90-min battery derate.
 */
export function buildSceneLightEmitters(model: ModelState): readonly SceneLightEmitter[] {
  const luminaires = collectPlacedLuminaires(model)
  const out: SceneLightEmitter[] = []

  for (const lum of luminaires) {
    const { part, box } = resolveFixtureLocalBounds(model, lum)
    const { beamAngleDeg, penumbra, peakCd } = deriveBeamFromWeb(lum)
    const web = lum.photo.web

    const toWorldPos = (lx: number, ly: number, lz: number): readonly [number, number, number] => {
      if (part) {
        const w = partToWorld(part, { x: lx, y: ly })
        return [w.x, w.y, lum.levelElevationMm + (part.offsetMm ?? 0) + lz]
      }
      return [lum.xMm, lum.yMm, lum.zMm]
    }

    // 1. Pure exit signs & exit/emergency combo sign housings always display a flush red LED EXIT face (never a floating white tilted plane!)
    const isExitUnit = lum.photo.isExitSignOnly || lum.photo.isEmergencyOnly
    if (isExitUnit) {
      const signW = box ? Math.max(160, box.maxX - box.minX - 24) : 280
      const signH = box ? Math.max(70, box.maxZ - box.minZ - 24) : 96
      const signD = box ? Math.max(40, box.maxY - box.minY) : 54
      const signCenter = box
        ? toWorldPos((box.minX + box.maxX) * 0.5, (box.minY + box.maxY) * 0.5, (box.minZ + box.maxZ) * 0.5)
        : ([lum.xMm, lum.yMm, lum.zMm + 60] as const)

      out.push({
        id: `${lum.id}:sign`,
        positionMm: signCenter,
        direction: [0, 0, -1],
        intensityCandela: 0,
        lumens: 0,
        colorHex: 0xff2b2b, // crisp LED red EXIT legend face
        beamAngleDeg: 120,
        penumbra: 0.8,
        rangeMm: 500,
        apertureMm: [signW, signH],
        apertureShape: 'rect',
        diffuserPlane: 'vertical_double_face',
        signDepthMm: signD,
        rotationDeg: lum.rotationDeg,
        mountKind: 'wall',
        emitterRole: 'sign',
        activeInNormal: true,
        activeInBlackout: true,
        blackoutScale: 1,
        blackout90MinScale: 1,
      })

      // Pure exit signs (EX-1) emit signage glow only — no floor floodlight in either normal or blackout mode
      if (lum.photo.isExitSignOnly) continue

      // Exit/Emergency combo unit (EX-2): emergency flood heads stay OFF in normal mode, snap ON at emergency_lumens in Blackout!
      const floodPos = box ? toWorldPos(box.lensCenter[0], box.lensCenter[1], box.minZ - 4) : ([lum.xMm, lum.yMm, lum.zMm - 4] as const)
      const emScale = Math.max(0.1, lum.photo.emergencyScale)
      out.push({
        id: `${lum.id}:em-heads`,
        positionMm: floodPos,
        direction: [0, 0, -1],
        intensityCandela: peakCd,
        lumens: lum.photo.web.totalLumens * lum.photo.lumenScale * lum.photo.llf,
        colorHex: 0xfff3d4,
        beamAngleDeg,
        penumbra,
        rangeMm: Math.max(4000, Math.min(5800, Math.max(2000, lum.zMm - lum.levelElevationMm) * 1.55)),
        floorElevationMm: lum.levelElevationMm,
        apertureMm: [Math.min(260, signW * 0.7), 64],
        apertureShape: 'rect',
        diffuserPlane: 'horizontal',
        rotationDeg: lum.rotationDeg,
        mountKind: 'ceiling',
        emitterRole: 'emergency_only',
        activeInNormal: false,
        activeInBlackout: lum.photo.isEmergency && emScale > 0,
        blackoutScale: emScale,
        blackout90MinScale: emScale * lum.photo.endOfDischargeFactor,
      })
      continue
    }

    // 2. Standard ceiling, pendant & architectural wall sconce luminaires
    //    Aperture uses exact housing local X (length) & local Y (width) — matches native-geometry.ts part boxes at every rotation!
    const fallbackLengthMm = web.lengthM > 0.02 ? web.lengthM * 1000 : 300
    const fallbackWidthMm = web.widthM > 0.02 ? web.widthM * 1000 : fallbackLengthMm
    const apertureMm: readonly [number, number] = box ? box.lensSizeXY : [fallbackLengthMm, fallbackWidthMm]
    const isRound = box ? box.isRound : lum.mountKind === 'ceiling' && Math.abs(fallbackLengthMm - fallbackWidthMm) < 40 && fallbackLengthMm < 350
    const emitterPos = box ? toWorldPos(box.lensCenter[0], box.lensCenter[1], box.lensCenter[2]) : ([lum.xMm, lum.yMm, lum.zMm - 4] as const)

    // Aim direction in kernel coordinates:
    // Ceiling/pendant fixtures point straight down [0, 0, -1] (with optional tilt).
    // Wall-mounted sconces / exterior wall packs project forward along local +Y and down at ~52°.
    let dir: readonly [number, number, number]
    if (lum.mountKind === 'wall') {
      const outX = -lum.sinRot * 0.56
      const outY = lum.cosRot * 0.56
      dir = [outX, outY, -0.828]
    } else if (lum.sinTilt !== 0) {
      const tx = lum.sinTilt * lum.cosRot
      const ty = lum.sinTilt * lum.sinRot
      dir = [tx, ty, -lum.cosTilt]
    } else {
      dir = [0, 0, -1]
    }

    // Architectural CCT tints: 3500K warm architectural downlights/pendants, 4000K clean commercial troffers, 3000K exterior wall sconces
    const profileKey = lum.photo.profileId.toLowerCase()
    const colorHex =
      profileKey.includes('troffer')
        ? 0xfff8ee
        : profileKey.includes('exterior') || lum.mountKind === 'wall'
          ? 0xffe4b8
          : 0xfff0d9

    // Size ceiling SpotLight reach to ~1.65x mounting height so Three.js's `(1 - (d/D)^4)^2`
    // attenuation window keeps >=70% output at the finished floor (downward spotlights never light
    // the downward-facing slab underside because dot(N_underside, L) <= 0).
    const mountingHeightMm = Math.max(2000, lum.zMm - lum.levelElevationMm)
    const rangeMm =
      lum.mountKind === 'wall'
        ? Math.max(3600, Math.min(5800, mountingHeightMm * 1.8))
        : Math.max(4200, Math.min(6400, mountingHeightMm * 1.65))

    const emScale = lum.photo.isEmergency ? lum.photo.emergencyScale : 0
    out.push({
      id: lum.id,
      positionMm: emitterPos,
      direction: dir,
      intensityCandela: peakCd,
      lumens: lum.photo.web.totalLumens * lum.photo.lumenScale * lum.photo.llf,
      colorHex,
      beamAngleDeg,
      penumbra,
      rangeMm,
      floorElevationMm: lum.levelElevationMm,
      apertureMm,
      apertureShape: isRound ? 'round' : 'rect',
      diffuserPlane: 'horizontal',
      rotationDeg: lum.rotationDeg,
      mountKind: lum.mountKind,
      emitterRole: 'standard',
      activeInNormal: true,
      activeInBlackout: lum.photo.isEmergency && emScale > 0,
      blackoutScale: emScale,
      blackout90MinScale: emScale * lum.photo.endOfDischargeFactor,
    })
  }

  return out
}
