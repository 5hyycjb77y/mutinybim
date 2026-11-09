import {
  CATALOG_TRADES,
  LOAD_TRADE_PROGRESS,
  QUANTITIES,
  QUANTITY_KEYS,
  anchorWords,
  elementsOfKind,
  estimateVsDevicesText,
  formatQuantity,
  loadPointLabel,
  type CatalogTrade,
  type ElementId,
  type LoadProgress,
  type LoadStage,
  type LoadStatus,
  type ModelState,
  type RequirementsEngine,
} from '@permitzip/bim-kernel'

/**
 * What the header's Loads chip opens (round-1 gap): per trade, how far its
 * loads have got; per space and zone, the estimate beside the devices placed
 * so far; what the project counts; and the loads that need someone. Every
 * figure is a read of the kernel's requirements engine (the one the chip, the
 * schedules and the Coordination checks read); nothing is added up here.
 */

/** The engine reads the breakdown uses (the open model's `LoadsLayer` engine). */
export type LoadsEngineReads = Pick<RequirementsEngine, 'progress' | 'statusOf' | 'scopeFigures' | 'counted'>

export interface TradeBreakdown {
  readonly trade: CatalogTrade
  readonly label: string
  readonly total: number
  /** "3 of 12 piped": the chip's words for this trade. */
  readonly done: string
  /** "12 estimates · 3 load points · 5 devices", only the stages that have loads. */
  readonly stages: string
  /** Statuses with loads, in lifecycle order, in operator words. */
  readonly statuses: readonly { readonly status: LoadStatus; readonly label: string; readonly count: number }[]
}

export interface EstimateRow {
  readonly id: ElementId
  readonly kind: 'space' | 'zone'
  readonly name: string
  /** "estimate 2,000 VA, devices so far 800 VA" (the kernel's words). */
  readonly text: string
}

export interface AttentionRow {
  readonly id: ElementId
  /** Elements to select: the load and what it reads that still exists. */
  readonly selectIds: readonly ElementId[]
  readonly reason: 'mismatch' | 'no_source'
  readonly label: string
  readonly why: string
}

export interface LoadsBreakdown {
  readonly total: number
  readonly trades: readonly TradeBreakdown[]
  /** "Counted: 12,000 VA · 25 WSFU"; null when nothing counts yet. */
  readonly counted: string | null
  readonly estimates: readonly EstimateRow[]
  readonly attention: readonly AttentionRow[]
}

export const LOAD_STATUS_WORDS: Readonly<Record<LoadStatus, string>> = {
  open: 'No source yet',
  assigned: 'Source named, not drawn',
  placed: 'Placed',
  connected: 'On a pipe, duct or circuit',
  attached: 'A device stands for it',
  mismatch: 'Needs attention',
}

const STATUS_ORDER: readonly LoadStatus[] = ['mismatch', 'open', 'assigned', 'placed', 'connected', 'attached']
const STAGE_WORDS: Readonly<Record<LoadStage, readonly [string, string]>> = {
  estimate: ['estimate', 'estimates'],
  concentrated: ['load point', 'load points'],
  device: ['device', 'devices'],
}

function stagesLine(p: LoadProgress): string {
  return (['estimate', 'concentrated', 'device'] as const)
    .filter((s) => p.byStage[s] > 0)
    .map((s) => `${p.byStage[s]} ${STAGE_WORDS[s][p.byStage[s] === 1 ? 0 : 1]}`)
    .join(' · ')
}

function nameOf(model: ModelState, id: ElementId): string {
  const el = model.elements[id]
  if (!el) return id
  if (el.kind === 'space') return [el.number, el.name].filter((s) => s.trim() !== '').join(' ') || id
  if (el.kind === 'zone') return el.name || id
  if (el.kind === 'part') return el.mark || id
  return 'name' in el && typeof el.name === 'string' && el.name ? el.name : id
}

export function loadsBreakdown(model: ModelState, engine: LoadsEngineReads): LoadsBreakdown {
  const all = engine.progress(model, { kind: 'project' })
  const trades: TradeBreakdown[] = []
  for (const trade of CATALOG_TRADES) {
    const p = engine.progress(model, { kind: 'trade', trade })
    if (p.total === 0) continue
    const words = LOAD_TRADE_PROGRESS[trade]
    trades.push({
      trade,
      label: words.label,
      total: p.total,
      done: `${p.byStatus.connected} of ${p.total} ${words.done}`,
      stages: stagesLine(p),
      statuses: STATUS_ORDER.filter((s) => p.byStatus[s] > 0).map((s) => ({ status: s, label: LOAD_STATUS_WORDS[s], count: p.byStatus[s] })),
    })
  }

  const totals = engine.counted(model)
  const countedParts = QUANTITY_KEYS.filter((k) => QUANTITIES[k].add === 'sum' && totals[k] !== 0).map((k) => formatQuantity(k, totals[k]))
  const counted = countedParts.length > 0 ? `Counted: ${countedParts.join(' · ')}` : null

  const estimates: EstimateRow[] = []
  for (const el of elementsOfKind(model.elements, 'space', 'zone')) {
    const figures = engine.scopeFigures(model, { kind: el.kind, id: el.id })
    if (figures.estimateIds.length === 0) continue
    const text = estimateVsDevicesText(figures)
    if (text) estimates.push({ id: el.id, kind: el.kind, name: nameOf(model, el.id), text })
  }
  estimates.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))

  const attention: AttentionRow[] = []
  for (const lp of elementsOfKind(model.elements, 'load_point')) {
    const s = engine.statusOf(model, lp.id)
    const label = loadPointLabel(model.elements, lp)
    if (s?.status === 'mismatch') {
      attention.push({ id: lp.id, selectIds: [lp.id], reason: 'mismatch', label, why: s.why ?? LOAD_STATUS_WORDS.mismatch })
    } else if (lp.anchor && lp.anchor.kind !== 'run_end' && !lp.servedBy) {
      // The Coordination check "load-unserved"'s test: typed before it is drawn, naming no source.
      attention.push({ id: lp.id, selectIds: [lp.id], reason: 'no_source', label, why: `${anchorWords(lp.anchor, (id) => nameOf(model, id))}; no panel, meter or heater counts it yet` })
    }
  }
  attention.sort((a, b) => (a.reason === b.reason ? a.label.localeCompare(b.label, undefined, { numeric: true }) : a.reason === 'mismatch' ? -1 : 1))

  return { total: all.total, trades, counted, estimates, attention }
}
