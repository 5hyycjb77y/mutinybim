import { disciplineChildren, type Discipline, type KnownDiscipline, type ViewOnPaper } from '@permitzip/bim-kernel'

/**
 * Where a Place from the "Not placed yet" list (or any part placement) would
 * happen: always the view the person is on. Placing never switches view; when
 * the current view can't take a part, the reason says what to open instead.
 */
export interface PlaceSurface {
  readonly canPlace: boolean
  /** The view, in words: "Level 1 plan", "Section A on E-101". */
  readonly label: string
  /** Why it can't be placed here, when it can't. */
  readonly reason: string | null
}

/** What the person is looking at, as the surface knows it. */
export type ActiveView =
  /** The live 3D model or a plan's live (top-down) model. */
  | { readonly kind: 'live'; readonly label: string }
  /** A plan, section or elevation drawing by itself, or the viewport opened on a sheet. */
  | { readonly kind: 'drawing'; readonly view: ViewOnPaper; readonly sheetLabel?: string }
  /** A sheet with no viewport opened. */
  | { readonly kind: 'sheet'; readonly label: string }
  /** A detail, schedule or diagram view: nothing in it is a model point. */
  | { readonly kind: 'other'; readonly label: string }
  | { readonly kind: 'none' }

export function placeSurfaceFor(active: ActiveView): PlaceSurface {
  switch (active.kind) {
    case 'live':
      return { canPlace: true, label: active.label, reason: null }
    case 'drawing': {
      const name = active.view.view.name
      const label = active.sheetLabel ? `${name} on ${active.sheetLabel}` : name
      const m = active.view.mapping
      if (m.modelReason) return { canPlace: false, label, reason: m.modelReason }
      if (m.kind !== 'plan' && m.kind !== 'section') return { canPlace: false, label, reason: `${label} has no model point under the pointer; open a plan or section to place parts.` }
      return { canPlace: true, label, reason: null }
    }
    case 'sheet':
      return { canPlace: false, label: active.label, reason: `Double-click a plan or section on ${active.label} to place parts in it, or open a plan.` }
    case 'other':
      return { canPlace: false, label: active.label, reason: `${active.label} isn't a plan or section; open one (or the 3D model) to place parts.` }
    case 'none':
      return { canPlace: false, label: 'no view', reason: 'Open a plan, a section or the 3D model to place parts.' }
  }
}

export const DISCIPLINE_WORDS: Readonly<Record<KnownDiscipline, string>> = {
  electrical: 'Electrical',
  mechanical: 'Mechanical',
  plumbing: 'Plumbing',
  fire_protection: 'Fire protection',
  architecture: 'Architecture',
  structure: 'Structure',
}

/**
 * Each tab's root disciplines. A registered child shows on its parent's tab
 * unless another tab names it as a root (a child laid out by another
 * trade's designer is a root of that trade's tab).
 */
const TAB_DISCIPLINES: Readonly<Record<string, readonly Discipline[]>> = {
  electrical: ['electrical', 'fire_alarm'],
  mechanical: ['mechanical'],
  plumbing: ['plumbing', 'fire_protection'],
}

/** A discipline and every registered discipline under it (a built-in child, or a firm's own under it), less those another tab claims. */
function withDescendants(roots: readonly Discipline[], claimedElsewhere: ReadonlySet<string>): readonly Discipline[] {
  const out: Discipline[] = []
  const seen = new Set<string>()
  const visit = (id: Discipline) => {
    if (seen.has(id)) return
    seen.add(id)
    out.push(id)
    for (const child of disciplineChildren(id)) if (!claimedElsewhere.has(child)) visit(child)
  }
  for (const root of roots) visit(root)
  return out
}

/** The trades a ribbon tab's "Not placed yet" shows: the tab's disciplines and the registered ones under them. */
export function disciplinesForTab(tab: string): readonly Discipline[] | undefined {
  const roots = TAB_DISCIPLINES[tab]
  if (!roots) return undefined
  const claimedElsewhere = new Set(Object.entries(TAB_DISCIPLINES).flatMap(([other, ids]) => (other === tab ? [] : ids)))
  return withDescendants(roots, claimedElsewhere)
}
