import { asElementId, modelToPaperPoint, portInfo, runLabel, serviceOf, type ModelState, type Vec2, type ViewOnPaper } from '@permitzip/bim-kernel'
import { plusSpots, type PlusSpot, type PlusSpotKernel } from '../plus-tee'

/** How far past its piece a "+" sits, and how big it is (screen px; turned into paper mm at the current zoom). */
const OUT_PX = 22
export const PLUS_RADIUS_PX = 9

const KERNEL: PlusSpotKernel = {
  runLabel,
  serviceOf,
  portInfo: (elements, ref) => portInfo(elements, { elementId: asElementId(ref.elementId), port: ref.port }),
}

export interface PlusOnPaper {
  readonly spot: PlusSpot
  readonly paper: Vec2
}

/**
 * The selected piece's "+" (continue from an open end, make an elbow a tee)
 * on a printed plan, section or elevation: the same spots the 3D view shows,
 * placed a few screen pixels out from the piece the way each one points. A
 * "+" pointing straight at the viewer (a riser's, in plan) sits to its right.
 */
export function plusOnPaper(model: ModelState, view: ViewOnPaper, selectedIds: readonly string[], serverFeatures: readonly string[], paperMmPerPx: number): PlusOnPaper[] {
  if (selectedIds.length !== 1) return []
  const el = model.elements[selectedIds[0] ?? '']
  if (el?.kind !== 'run_segment' && el?.kind !== 'run_fitting') return []
  const level = model.elements[el.levelId]
  const floor = level?.kind === 'level' ? level.elevationMm : 0
  const out = OUT_PX * paperMmPerPx
  return plusSpots(model.elements, el, KERNEL, serverFeatures).map((spot) => {
    const a = modelToPaperPoint(view, { x: spot.at.x, y: spot.at.y, z: spot.at.z + floor })
    const b = modelToPaperPoint(view, { x: spot.at.x + spot.toward.x * 600, y: spot.at.y + spot.toward.y * 600, z: spot.at.z + floor + spot.toward.z * 600 })
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    const paper = len < 1e-6 ? { x: a.x + out, y: a.y } : { x: a.x + ((b.x - a.x) / len) * out, y: a.y + ((b.y - a.y) / len) * out }
    return { spot, paper }
  })
}
