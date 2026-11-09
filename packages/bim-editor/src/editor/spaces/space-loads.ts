import { findUnit, fromSI, QUANTITY_BINDINGS, toSI, type UnitCode } from '@permitzip/bim-units'
import {
  allocatedActualLine,
  allocationPolicyOf,
  bagFromTotals,
  formatQuantity,
  loadIndexOf,
  loadValueOf,
  modelSpaceLocator,
  requirementsEngineOf,
  type AllocatedActual,
  type AllocationPolicy,
  type Command,
  type ElementId,
  type LoadPointElement,
  type LoadService,
  type ModelState,
  type QuantityBag,
  type QuantityKey,
  ZERO_TOTALS,
} from '@permitzip/bim-kernel'
import { SPACE_USES } from './space-rows'

/**
 * Loads typed on a space or zone (the product owner's decision 4, NEXT-BATCH §5 step 2):
 * "Kitchen: lighting 5 kW, receptacles 2 kW", or a density from the space-use
 * library. They are k2's loads (`create_load` anchored on the space or zone),
 * not a second concept: the same records move to a point and then to a device
 * later, and every total reads them through the requirements engine.
 *
 * Pure, so the panel, the dialog and their tests read the same rows. Units go
 * through bim-units; no figure is worked out here that the kernel owns.
 */

export interface LoadScope {
  readonly kind: 'space' | 'zone'
  readonly id: ElementId
  /** "101 Kitchen", "Kitchen zone". */
  readonly label: string
}

export type LoadQuantityId = 'power' | 'gas' | 'air' | 'hot_water'
export type LoadBasisChoice = 'lump' | 'density'

interface UnitChoice {
  readonly unit: UnitCode
  /** As the engineer types it. */
  readonly label: string
}

export interface LoadQuantity {
  readonly id: LoadQuantityId
  readonly key: QuantityKey
  readonly service: LoadService
  readonly label: string
  readonly lump: UnitChoice
  /** Absent: a density makes no sense for it (gas, hot water are per appliance). */
  readonly density?: UnitChoice
}

/**
 * The quantities an area load can carry, from the shared quantity bag. Power
 * is VA in the kernel; people type kW, counted at unity power factor (kVA).
 */
const POWER: LoadQuantity = { id: 'power', key: 'va', service: 'power', label: 'Electrical', lump: { unit: 'kVA', label: 'kW' }, density: { unit: 'VA/ft2', label: 'W/ft²' } }

export const LOAD_QUANTITIES: readonly LoadQuantity[] = [
  POWER,
  { id: 'air', key: 'cfm', service: 'supply_air', label: 'Airflow', lump: { unit: 'cfm', label: 'CFM' }, density: { unit: 'cfm/ft2', label: 'CFM/ft²' } },
  { id: 'gas', key: 'mbh', service: 'gas', label: 'Gas', lump: { unit: 'MBH', label: 'MBH' } },
  { id: 'hot_water', key: 'gph_demand', service: 'hot_water', label: 'Hot water', lump: { unit: 'gph', label: 'gal/h' } },
]

export function loadQuantity(id: LoadQuantityId): LoadQuantity {
  return LOAD_QUANTITIES.find((q) => q.id === id) ?? POWER
}

const bagUnit = (key: QuantityKey): UnitCode => QUANTITY_BINDINGS[key].unit

/** What the engineer typed (5 kW) as the bag's value (5,000 VA). */
export function lumpToBag(q: LoadQuantity, typed: number): number {
  return fromSI(toSI(typed, q.lump.unit), bagUnit(q.key))
}
/** The bag's value as the engineer types it. */
export function bagToLump(q: LoadQuantity, value: number): number {
  return fromSI(toSI(value, bagUnit(q.key)), q.lump.unit)
}
/** 1.5 W/ft² as the kernel's density rate: bag units per square metre. */
export function densityToRate(q: LoadQuantity, typed: number): number {
  if (!q.density) return 0
  return toSI(typed, q.density.unit) / toSI(1, bagUnit(q.key))
}
export function rateToDensity(q: LoadQuantity, rate: number): number {
  if (!q.density) return 0
  return fromSI(rate * toSI(1, bagUnit(q.key)), q.density.unit)
}

function bagOf(key: QuantityKey, value: number): QuantityBag {
  const t: Record<QuantityKey, number> = { ...ZERO_TOTALS }
  t[key] = value
  return bagFromTotals(t)
}

const round = (v: number, digits = 2) => (Math.round(v * 10 ** digits) / 10 ** digits).toLocaleString('en-US', { maximumFractionDigits: digits })

/** "7 kW", "450 CFM", "180 MBH". Power reads in kW, the unit people typed. */
export function formatLoadAmount(key: QuantityKey, value: number): string {
  const q = LOAD_QUANTITIES.find((x) => x.key === key)
  if (q?.id === 'power') return `${round(bagToLump(q, value))} kW`
  return formatQuantity(key, value)
}

export interface ScopeLoadRow {
  readonly id: ElementId
  readonly name: string
  readonly quantity: LoadQuantity
  readonly basis: LoadBasisChoice
  /** The number in the form, in the unit the basis types (kW, or W/ft²). */
  readonly typed: number
  /** "5 kW", or "1.5 W/ft² over the space: 1.8 kW". */
  readonly text: string
}

function quantityOf(lp: LoadPointElement): LoadQuantity {
  const byService = LOAD_QUANTITIES.find((q) => q.service === lp.service)
  if (byService) return byService
  const keys = new Set<QuantityKey>([...(lp.rates ?? []).map((r) => r.key), ...LOAD_QUANTITIES.map((q) => q.key).filter((k) => (lp.values[k] ?? 0) > 0)])
  return LOAD_QUANTITIES.find((q) => keys.has(q.key)) ?? POWER
}

/** The loads spread over this space or zone, from the per-record load index (never a pass over the model). */
export function scopeLoads(model: ModelState, scope: Pick<LoadScope, 'kind' | 'id'>): ScopeLoadRow[] {
  const index = loadIndexOf(model.elements)
  const ids = scope.kind === 'space' ? index.inSpace(scope.id) : index.inZone(scope.id)
  const locator = modelSpaceLocator(model.elements)
  const out: ScopeLoadRow[] = []
  for (const id of ids) {
    const lp = model.elements[id]
    if (lp?.kind !== 'load_point') continue
    const q = quantityOf(lp)
    const value = loadValueOf(model.elements, lp, locator)[q.key]
    const name = lp.mark || lp.connectionType || 'Load'
    if (lp.basis === 'density' && q.density) {
      const rate = lp.rates?.find((r) => r.key === q.key && r.per === 'area')?.value ?? 0
      const typed = rateToDensity(q, rate)
      out.push({ id: lp.id, name, quantity: q, basis: 'density', typed, text: `${round(typed)} ${q.density.label} over the ${scope.kind}: ${formatLoadAmount(q.key, value)}` })
    } else out.push({ id: lp.id, name, quantity: q, basis: 'lump', typed: bagToLump(q, lp.values[q.key] ?? value), text: formatLoadAmount(q.key, value) })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Estimate vs devices for the whole space or zone (the engine's scope figures:
 * a zone's own estimates and its spaces', and every real load standing in it).
 * Null when nothing is estimated or placed there.
 */
export function scopeFigures(model: ModelState, scope: Pick<LoadScope, 'kind' | 'id'>): AllocatedActual | null {
  const figures = requirementsEngineOf(model.elements).scopeFigures(model, scope)
  return figures.estimateIds.length === 0 && figures.actualIds.length === 0 ? null : figures
}

/** "Electrical: estimate 7 kW, devices so far 0 kW · Airflow: …", only the quantities that are set. */
export function figuresLine(figures: AllocatedActual): string {
  const parts = LOAD_QUANTITIES.flatMap((q) => {
    const a = figures.allocated[q.key]
    const b = figures.actual[q.key]
    if (a === 0 && b === 0) return []
    return [`${q.label}: ${a === 0 ? `no estimate, devices so far ${formatLoadAmount(q.key, b)}` : allocatedActualLine(figures, q.key, formatLoadAmount)}`]
  })
  return parts.join(' · ')
}

export const POLICY_WORDS: Readonly<Record<AllocationPolicy, string>> = {
  max: 'Devices placed inside count against these estimates; the larger of the two counts.',
  actual_only: 'Once any device is placed inside, the devices count and the estimate stops counting.',
  allocation_only: 'Only the estimate counts (study mode); devices placed inside are shown, not added.',
}

export function policyWords(model: ModelState): string {
  return POLICY_WORDS[allocationPolicyOf(model.elements)]
}

const LIBRARY_RATE_OF: ReadonlyArray<readonly [RegExp, 'lighting' | 'receptacles']> = [
  [/light/i, 'lighting'],
  [/recep|outlet|plug/i, 'receptacles'],
]

/**
 * The space-use library's density for a lighting or receptacle load on this
 * space ("1.5 W/ft², Restaurant dining, NEC 2020 Table 220.12"), or why there
 * isn't one, in words.
 */
export function libraryDensity(model: ModelState, scope: Pick<LoadScope, 'kind' | 'id'>, q: LoadQuantity, name: string): { readonly typed: number; readonly source: string } | string {
  if (q.id !== 'power' || !q.density) return 'The space-use library has densities for lighting and receptacles only.'
  if (scope.kind !== 'space') return 'A zone has no use of its own; type the density, or add it on each space.'
  const space = model.elements[scope.id]
  if (space?.kind !== 'space') return 'This space isn’t in the model any more.'
  const useId = space.use?.useId
  if (!useId) return 'Pick the space’s use first; the library density comes from it.'
  const row = SPACE_USES.find((u) => u.id === useId)
  if (!row) return `The use ${useId} isn’t in the library any more; type the density.`
  const which = LIBRARY_RATE_OF.find(([re]) => re.test(name))?.[1]
  if (!which) return 'Name the load “Lighting” or “Receptacles” to use the library density, or type one.'
  const rate = row.rates.find((r) => r.key === which)
  if (!rate) return `${row.name} has no ${which} density in the library; type one.`
  const unit = findUnit(rate.unit, 'power_per_area')
  if (!unit) return `${row.name}’s ${which} density is in ${rate.unit}, which isn’t a power density unit.`
  const typed = fromSI(toSI(rate.value, unit), q.density.unit)
  return { typed, source: `${row.name}, ${rate.cite.code}${rate.cite.edition ? ` ${rate.cite.edition}` : ''} ${rate.cite.clause}${rate.cite.verified ? '' : ' (not verified)'}` }
}

export interface LoadDraft {
  readonly name: string
  readonly quantityId: LoadQuantityId
  readonly basis: LoadBasisChoice
  /** As typed. */
  readonly amount: string
}

/** The typed amount, or why it can't be used, in words. */
function amountOf(draft: LoadDraft, q: LoadQuantity): number | string {
  const n = Number(draft.amount.replace(/,/g, '').trim())
  const unit = draft.basis === 'density' ? q.density?.label : q.lump.label
  if (draft.amount.trim() === '' || !Number.isFinite(n) || n <= 0) return `Type the load as a number above 0${unit ? ` (${unit})` : ''}.`
  return n
}

function nameOf(draft: LoadDraft): string | { readonly error: string } {
  const name = draft.name.trim()
  if (name === '') return { error: 'Give the load a name, like Lighting or Receptacles.' }
  if (name.length > 40) return { error: 'Keep the name to 40 characters.' }
  return name
}

/** A new load spread over the space or zone, through k2's `create_load`; or why not, in words. */
export function addLoadCommand(scope: Pick<LoadScope, 'kind' | 'id'>, draft: LoadDraft, id: string): Command | string {
  const q = loadQuantity(draft.quantityId)
  const name = nameOf(draft)
  if (typeof name !== 'string') return name.error
  const amount = amountOf(draft, q)
  if (typeof amount === 'string') return amount
  const anchor = { kind: scope.kind, id: scope.id }
  if (draft.basis === 'density') {
    if (!q.density) return `${q.label} loads are typed as a total, not per square foot.`
    return { type: 'create_load', loads: [{ id, anchor, mark: name, service: q.service, basis: 'density', rates: [{ key: q.key, per: 'area', value: densityToRate(q, amount) }] }] }
  }
  return { type: 'create_load', loads: [{ id, anchor, mark: name, service: q.service, values: bagOf(q.key, lumpToBag(q, amount)) }] }
}

/**
 * The change to one load through k2's `edit_load_point`: name, total or
 * density, and the amount (the quantity stays; remove and add to change it).
 * Null when nothing would change.
 */
export function editLoadCommand(row: ScopeLoadRow, draft: LoadDraft): Command | string | null {
  const q = row.quantity
  const name = nameOf(draft)
  if (typeof name !== 'string') return name.error
  const amount = amountOf(draft, q)
  if (typeof amount === 'string') return amount
  if (name === row.name && draft.basis === row.basis && Math.abs(amount - row.typed) < 1e-9) return null
  const mark = name === row.name ? {} : { mark: name }
  if (draft.basis === 'density') {
    if (!q.density) return `${q.label} loads are typed as a total, not per square foot.`
    return { type: 'edit_load_point', loadId: row.id, ...mark, basis: 'density', rates: [{ key: q.key, per: 'area', value: densityToRate(q, amount) }], ...(row.basis === 'lump' ? { reset: [q.key] } : {}) }
  }
  return { type: 'edit_load_point', loadId: row.id, ...mark, basis: 'lump', values: bagOf(q.key, lumpToBag(q, amount)) }
}

export function removeLoadCommand(row: Pick<ScopeLoadRow, 'id'>): Command {
  return { type: 'delete_load_points', loadPointIds: [row.id] }
}
