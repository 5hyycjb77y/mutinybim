import type { ModelViewer3D } from '@permitzip/bim-viewer-3d'

/**
 * What clicking a surface tells a level: where the pointer met the nearest
 * visible surface (a roof, a floor slab, linked or authored), in kernel mm.
 *
 * The 3D view's own surface pick (`viewer.pickSurfaceAsync`, the shared
 * placement method in an internal design note) is the one source, so a level
 * lands on the same surface Place and Route would.
 */
export interface SurfaceHit {
  /** Kernel millimetres: x east, y plan north, z up. */
  readonly point: { readonly x: number; readonly y: number; readonly z: number }
  /** linked: the architect's (or another linked) model. model: something authored here. */
  readonly source: 'linked' | 'model'
}

export interface SurfacePicker {
  pickSurface(clientX: number, clientY: number): Promise<SurfaceHit | null>
}

export function viewerSurfacePicker(viewer: Pick<ModelViewer3D, 'pickSurfaceAsync'>): SurfacePicker {
  return {
    async pickSurface(clientX, clientY) {
      const hit = await viewer.pickSurfaceAsync(clientX, clientY)
      if (!hit) return null
      return { point: hit.point, source: hit.linked ? 'linked' : 'model' }
    },
  }
}

/** 1/8" in mm: a picked floor height is kept to the nearest eighth of an inch. */
const EIGHTH_INCH_MM = 25.4 / 8
/** How near the top of everything a hit must be for "Roof" to be the suggested name. */
const ROOF_BAND_MM = 3000

export function snapLevelHeight(mm: number): number {
  return Math.round(Math.round(mm / EIGHTH_INCH_MM) * EIGHTH_INCH_MM * 1000) / 1000
}

/**
 * The name to offer for a level at a picked height: "Roof" when it is above
 * every level there is and near the top of the building (and no level is
 * called Roof yet), else the next "Level N".
 */
export function suggestLevelName(elevationMm: number, levels: readonly { readonly name: string; readonly elevationMm: number }[], topMm: number | null): string {
  const taken = new Set(levels.map((l) => l.name.toLowerCase()))
  const aboveAll = levels.every((l) => l.elevationMm < elevationMm - 1)
  if (aboveAll && topMm !== null && topMm - elevationMm <= ROOF_BAND_MM && !taken.has('roof')) return 'Roof'
  for (let n = levels.length + 1; ; n++) if (!taken.has(`level ${n}`)) return `Level ${n}`
}
