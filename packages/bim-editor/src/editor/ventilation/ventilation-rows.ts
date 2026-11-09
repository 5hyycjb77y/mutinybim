import { convert, to, type Quantity } from '@permitzip/bim-units'
import type { ElementId } from '@permitzip/bim-kernel'
import { VENTILATION_STANDARD_IDS, VENTILATION_STANDARDS, type SpaceVentilation, type VentilationStandardId, type VentilationTable, type ZoneVentilation } from './pack'

/** What the Ventilation panel prints for one space: every number as text, "—" when there is none. */
export interface VentilationRow {
  readonly spaceId: ElementId
  readonly label: string
  readonly use: string
  readonly people: string
  /** "typed" or "from the use's density". */
  readonly peopleFrom: string
  readonly area: string
  readonly rp: string
  readonly ra: string
  readonly vbz: string
  readonly ez: string
  readonly voz: string
  readonly exhaust: string
  /** Voz under each standard, governing first: "IMC 2021 705 cfm". */
  readonly byStandard: readonly { readonly id: VentilationStandardId; readonly label: string; readonly voz: string; readonly governing: boolean }[]
  /** Null when it calculates; otherwise why not, in words. */
  readonly problem: string | null
  readonly arithmetic: string | null
  readonly exhaustNote: string | null
  readonly cites: readonly string[]
  readonly inputs: readonly string[]
}

export interface VentilationZoneRow {
  readonly zoneId: ElementId
  readonly name: string
  readonly voz: string
  readonly byStandard: readonly { readonly id: VentilationStandardId; readonly label: string; readonly voz: string; readonly governing: boolean }[]
  readonly unit: string | null
  readonly unitOa: string
  readonly verdict: 'meets' | 'short' | 'unknown' | 'no_unit'
  readonly note: string
  readonly problem: string | null
}

const FORMATS = [0, 1, 2].map((d) => new Intl.NumberFormat('en-US', { maximumFractionDigits: d }))
const num = (v: number | null, digits: 0 | 1 | 2 = 0): string => (v === null ? '—' : (FORMATS[digits] as Intl.NumberFormat).format(v))
export const cfmText = (v: Quantity<'flow_air'> | null | undefined): string => (v === null || v === undefined ? '—' : `${num(to(v, 'cfm'))} cfm`)

function standardsOf(governing: VentilationStandardId, voz: (id: VentilationStandardId) => Quantity<'flow_air'> | null) {
  const order = [governing, ...VENTILATION_STANDARD_IDS.filter((id) => id !== governing)]
  return order.map((id) => ({ id, label: VENTILATION_STANDARDS[id].label, voz: cfmText(voz(id)), governing: id === governing }))
}

export function ventilationRow(r: SpaceVentilation): VentilationRow {
  const g = r.standards[r.governing.standard]
  return {
    spaceId: r.spaceId,
    label: r.label,
    use: r.useName ?? 'No use',
    people: num(r.occupants),
    peopleFrom: r.occupantsBasis === 'typed' ? 'typed' : r.occupantsBasis === 'use_default' ? "from the use's density" : '',
    area: r.areaM2 === null ? '—' : `${num(convert(r.areaM2, 'm2', 'ft2'))} ft²`,
    rp: g.rp ? `${num(to(g.rp.value, 'cfm/occ'), 2)} cfm/person` : '—',
    ra: g.ra ? `${num(to(g.ra.value, 'cfm/ft2'), 2)} cfm/ft²` : '—',
    vbz: cfmText(g.vbz),
    ez: `${num(to(g.ez.value, '1'), 2)}${g.ez.from === 'override' ? ` (override: ${g.ez.reason ?? ''})` : ''}`,
    voz: cfmText(g.voz),
    exhaust: cfmText(g.exhaust),
    byStandard: standardsOf(r.governing.standard, (id) => r.standards[id].voz),
    problem: g.status === 'missing' ? g.reasons.join(' ') : g.status === 'not_required' ? g.reasons.join(' ') : null,
    arithmetic: g.arithmetic,
    exhaustNote: g.exhaust === null ? g.exhaustReason : null,
    cites: [...new Set(g.cites.map((c) => c.text))],
    inputs: r.inputs,
  }
}

export function ventilationZoneRow(z: ZoneVentilation): VentilationZoneRow {
  const g = z.standards[z.governing.standard]
  return {
    zoneId: z.zoneId,
    name: z.name,
    voz: cfmText(g.voz),
    byStandard: standardsOf(z.governing.standard, (id) => z.standards[id].voz),
    unit: z.servedBy?.mark ?? null,
    unitOa: z.servedBy ? (z.servedBy.outdoorAir === null ? 'not typed on the unit' : cfmText(z.servedBy.outdoorAir)) : '—',
    verdict: z.servedBy ? z.servedBy.comparison : 'no_unit',
    note: z.systemNote,
    problem: g.missing.length > 0 ? `${g.missing.length} of ${z.spaceIds.length} spaces can't be calculated: ${g.missing.map((m) => m.label).join(', ')}.` : z.spaceIds.length === 0 ? 'No spaces in this zone. Outdoor air is figured from the spaces a zone is made of; add spaces to see it.' : null,
  }
}

export interface VentilationView {
  readonly rows: readonly VentilationRow[]
  readonly zones: readonly VentilationZoneRow[]
  readonly total: string
  readonly governingText: string
  readonly empty: string | null
  readonly missing: number
}

export function ventilationView(table: VentilationTable): VentilationView {
  const g = table.governing?.standard ?? 'imc'
  const t = table.totals[g]
  return {
    rows: table.spaces.map(ventilationRow),
    zones: table.zones.map(ventilationZoneRow),
    total: t.voz === null ? `No total yet: ${t.missing} space${t.missing === 1 ? '' : 's'} can't be calculated` : cfmText(t.voz),
    governingText: table.governing?.text ?? '',
    empty: table.empty,
    missing: t.missing,
  }
}
