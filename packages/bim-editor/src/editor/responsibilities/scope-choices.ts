import { elementsOfKind, listDisciplines, organizationOf, type ModelState } from '@permitzip/bim-kernel'
import { withModelStatePacks } from '@permitzip/bim-kernel/packs'

/**
 * What Manage › Responsibilities offers: the model's registered disciplines
 * (children under their parent) and the parts a responsibility can be
 * narrowed to, all from the model's own selectors (levels, systems, groups,
 * sheets: what the views placed on a sheet show).
 * Read once when the dialog opens.
 */

export type ScopeKind = 'whole' | 'levels' | 'systems' | 'groups' | 'sheets'

export interface Choice {
  readonly value: string
  readonly label: string
}

export interface ScopeChoices {
  readonly disciplines: readonly Choice[]
  readonly levels: readonly Choice[]
  readonly systems: readonly Choice[]
  readonly groups: readonly Choice[]
  readonly sheets: readonly Choice[]
}

export function scopeChoices(model: ModelState): ScopeChoices {
  return withModelStatePacks(model, () => {
    const defs = listDisciplines()
    const byParent = new Map<string, string[]>()
    for (const d of defs) if (d.parent) byParent.set(d.parent, [...(byParent.get(d.parent) ?? []), d.id])
    const label = new Map(defs.map((d) => [d.id, d.label]))
    const disciplines: Choice[] = []
    for (const d of defs) {
      if (d.parent) continue
      disciplines.push({ value: d.id, label: d.label })
      for (const child of byParent.get(d.id) ?? []) disciplines.push({ value: child, label: `${d.label} › ${label.get(child) ?? child}` })
    }
    const levels = elementsOfKind(model.elements, 'level')
      .slice()
      .sort((a, b) => a.elevationMm - b.elevationMm)
      .map((l) => ({ value: l.name, label: l.name }))
    const systems = elementsOfKind(model.elements, 'mep_system')
      .map((s) => ({ value: s.id, label: s.name }))
      .sort((a, b) => a.label.localeCompare(b.label))
    const groups = organizationOf(model).groups.map((g) => ({ value: g.id, label: g.entry.name }))
    const sheets = elementsOfKind(model.elements, 'sheet')
      .filter((sh) => !sh.deleted)
      .map((sh) => ({ value: sh.id, label: sh.title ? `${sh.number} ${sh.title}` : sh.number }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))
    return { disciplines, levels, systems, groups, sheets }
  })
}

export const SCOPE_KINDS: readonly ScopeKind[] = ['whole', 'levels', 'systems', 'groups', 'sheets']

export const SCOPE_KIND_LABELS: Readonly<Record<ScopeKind, string>> = {
  whole: 'All of it',
  levels: 'Some levels',
  systems: 'Some systems',
  groups: 'Some groups',
  sheets: 'Some sheets',
}

/** Under the Sheets choice: what a sheet scope covers, in words. */
export const SHEET_SCOPE_HINT = 'Covers what the views placed on these sheets show (their levels, inside a plan’s crop).'
