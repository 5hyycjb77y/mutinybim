import {
  siblingDuctDesign,
  SYSTEM_KINDS,
  type DuctInsulation,
  type LinerSurface,
  type SystemDesign,
  type SystemKind,
} from '@permitzip/bim-kernel'
import { MM_PER_IN } from './placement'
import type { ExistingSystem } from './RoutePanel'

/**
 * The Route tool's run-design state (insulation, liner surface, the flow to
 * size from) and what it asks the kernel for. Read by the Route panel and the
 * surface; the form that edits it is the add-on's section (`route-section`).
 */

/** The Route tool's duct design choices, as typed. */
export interface RouteDuctDesign {
  /** 'default' follows the system's default insulation. */
  readonly insulation: 'default' | 'none' | 'wrap' | 'liner'
  readonly insulationIn: string
  /** Liner only: what the air runs over. */
  readonly linerSurface: LinerSurface
  /** Airflow to size from; never saved to the model. */
  readonly airflowCfm: string
  /** Finishing on a device's connector: the last stretch, from the last point clicked, is flex. */
  readonly lastStretchFlex?: boolean
}

export const DEFAULT_ROUTE_DUCT_DESIGN: RouteDuctDesign = { insulation: 'default', insulationIn: '1', linerSurface: 'faced', airflowCfm: '' }

export const inches = (mm: number) => String(Math.round((mm / MM_PER_IN) * 1000) / 1000)
export const mm = (inchesValue: number) => Math.round(inchesValue * MM_PER_IN * 1000) / 1000

/** What the route's system gives: its kind and design (a new system starts like another of its kind). */
export function routeSystemDesign(system: string, systems: readonly ExistingSystem[]): { kind: SystemKind | null; name: string | null; design: SystemDesign | undefined; isNew: boolean } {
  const existing = systems.find((s) => s.id === system)
  if (existing) return { kind: existing.kind, name: existing.name, design: existing.design, isNew: false }
  const kind = system.startsWith('new:') ? (SYSTEM_KINDS.find((k) => k === system.slice(4)) ?? null) : null
  if (!kind) return { kind: null, name: null, design: undefined, isNew: true }
  const inherited = siblingDuctDesign(
    systems.map((s) => ({ id: s.id, systemKind: s.kind, domain: s.domain === 'duct' ? 'duct' : 'pipe', ...(s.design ? { design: s.design } : {}) })),
    kind,
  )
  return { kind, name: null, design: inherited, isNew: true }
}

/** What the route asks the kernel for: absent (the system's default), null (bare), or a wrap / liner. */
export function routeInsulationChoice(c: RouteDuctDesign): DuctInsulation | null | undefined {
  if (c.insulation === 'default') return undefined
  if (c.insulation === 'none') return null
  const t = Number(c.insulationIn)
  if (!(Number.isFinite(t) && t > 0)) return undefined
  return { kind: c.insulation, thicknessMm: mm(t), ...(c.insulation === 'liner' && c.linerSurface === 'spray_coated' ? { surface: 'spray_coated' as const } : {}) }
}

