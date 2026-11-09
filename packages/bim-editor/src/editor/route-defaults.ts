import type { RouteDefaultDomain, RouteDefaults } from '../contracts/building-model/route-defaults'
import type { RouteChoices } from './RoutePanel'

/**
 * Between the Route panel's typed choices and a person's saved defaults
 * (`lib/building-model/route-defaults.ts`). Airflow, system, level and
 * height are per route, never saved.
 */

const num = (s: string): number | undefined => {
  const v = Number(s)
  return s.trim() !== '' && Number.isFinite(v) && v > 0 ? v : undefined
}
const str = (v: number | undefined, fallback: string) => (v === undefined ? fallback : String(v))

export function defaultsFromChoices(c: RouteChoices): { domain: RouteDefaultDomain; settings: RouteDefaults } {
  if (c.kind === 'pipe') {
    const nominalIn = num(c.nominalIn)
    return { domain: 'pipe', settings: { ...(nominalIn ? { nominalIn } : {}), material: c.material, riseStyle: c.riseStyle } }
  }
  const sizes =
    c.shape === 'round'
      ? { ...(num(c.diameterIn) ? { diameterIn: num(c.diameterIn) } : {}) }
      : { ...(num(c.widthIn) ? { widthIn: num(c.widthIn) } : {}), ...(num(c.heightIn) ? { heightIn: num(c.heightIn) } : {}) }
  const thick = num(c.insulationIn)
  return {
    domain: 'duct',
    settings: {
      shape: c.shape,
      ...sizes,
      insulation: c.insulation,
      ...((c.insulation === 'wrap' || c.insulation === 'liner') && thick ? { insulationIn: thick } : {}),
      ...(c.insulation === 'liner' ? { linerSurface: c.linerSurface } : {}),
      ...(c.elbowFamily ? { elbowFamily: c.elbowFamily } : {}),
      ...(c.takeoffFamily ? { takeoffFamily: c.takeoffFamily } : {}),
      riseStyle: c.riseStyle,
    },
  }
}

/** The choices with a domain's saved defaults filled in; the route's system, level, height and airflow stay. */
export function choicesWithDefaults(c: RouteChoices, domain: RouteDefaultDomain, d: RouteDefaults): RouteChoices {
  const rise = c.kind === domain && d.riseStyle ? { riseStyle: d.riseStyle } : {}
  if (domain === 'pipe') return { ...c, ...rise, nominalIn: str(d.nominalIn, c.nominalIn), material: d.material ?? c.material }
  return {
    ...c,
    ...rise,
    shape: d.shape ?? c.shape,
    widthIn: str(d.widthIn, c.widthIn),
    heightIn: str(d.heightIn, c.heightIn),
    diameterIn: str(d.diameterIn, c.diameterIn),
    insulation: d.insulation ?? c.insulation,
    insulationIn: str(d.insulationIn, c.insulationIn),
    linerSurface: d.linerSurface ?? c.linerSurface,
    elbowFamily: d.elbowFamily ?? '',
    takeoffFamily: d.takeoffFamily ?? '',
  }
}
