import { defaultPipeSpec, slopeInPerFt, type RunFitting, type RunSegment, type RunSize } from '@permitzip/bim-kernel'
import { MM_PER_FT, MM_PER_IN } from './placement'
import type { RouteChoices } from './RoutePanel'
import { slopeChoiceOf } from './route-slope'

const inches = (mm: number) => String(Math.round((mm / MM_PER_IN) * 1000) / 1000)
const feet = (mm: number) => String(Math.round((mm / MM_PER_FT) * 10000) / 10000)

/** The size a piece carries: a straight piece's own, or an in-line fitting's first opening. */
function sizeOf(el: RunSegment | RunFitting): RunSize | null {
  return el.kind === 'run_segment' ? el.size : (el.ports[0]?.size ?? null)
}

/**
 * Route panel choices for "Route another like this": the piece's kind, system,
 * shape and size, insulation, height and (a sloped pipe) slope, keeping everything else the person
 * had chosen. A string is why it can't (a conduit run, or no size to copy).
 */
export function routeChoicesLike(el: RunSegment | RunFitting, current: RouteChoices): RouteChoices | string {
  const size = sizeOf(el)
  if (!size) return 'This piece has no size to copy.'
  if (el.domain === 'conduit') return "Conduit routing isn't available yet; duct and pipe are."
  const z = el.kind === 'run_segment' ? Math.min(el.start.z, el.end.z) : el.position.z
  const base: RouteChoices = { ...current, kind: el.domain, system: el.systemId, elevationFt: feet(z), elbowFamily: '', takeoffFamily: '' }
  switch (size.shape) {
    case 'rect':
      return { ...base, shape: 'rect', widthIn: inches(size.width), heightIn: inches(size.height), ...insulationOf(el) }
    case 'round':
      return { ...base, shape: 'round', diameterIn: inches(size.diameter), ...insulationOf(el) }
    case 'pipe':
      return { ...base, nominalIn: inches(size.nominalMm), material: size.material, pipeSpec: size.spec && size.spec !== defaultPipeSpec(size.material) ? size.spec : '', pipeType: '', slopeInPerFt: el.kind === 'run_segment' ? slopeChoiceOf(slopeInPerFt(el)) : '' }
    default:
      return `${size.shape === 'oval' ? 'Flat oval' : 'This'} duct can't be routed from the Route panel yet.`
  }
}

/** The piece's wrap or liner as the Route panel shows it; bare duct says so (not "the system's default"). */
function insulationOf(el: RunSegment | RunFitting): Pick<RouteChoices, 'insulation' | 'insulationIn' | 'linerSurface'> {
  const ins = el.insulation
  if (!ins) return { insulation: 'none', insulationIn: '1', linerSurface: 'faced' }
  return { insulation: ins.kind, insulationIn: inches(ins.thicknessMm), linerSurface: ins.surface ?? 'faced' }
}
