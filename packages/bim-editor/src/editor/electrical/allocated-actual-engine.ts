import {
  CATALOG_TRADES,
  RequirementsEngine,
  allocationPolicyOf,
  elementsOfKind,
  modelSpaceLocator,
  progressLine,
  tradeProgressLine,
  type AllocationPolicy,
  type BimElement,
  type CatalogTrade,
  type ElementId,
  type LoadProgress,
  type LoadProgressScope,
  type ModelState,
  type QuantityTotals,
} from '@permitzip/bim-kernel'

/**
 * One loads engine per open model (k2-loads, the product owner's decision 4), kept up to
 * date from each edit's changed ids, which the session's model event carries.
 * When it can't say what changed (first model, reload, drag preview), the ids
 * come from the per-kind indexes of what a load reads (loads, the spaces and
 * zones they spread over, the parts and runs they sit on), compared record by
 * record. Never a scan of every element.
 */

type Elements = ModelState['elements']

const LOAD_INPUT_KINDS = ['load_point', 'space', 'zone', 'part', 'run_segment', 'run_fitting'] as const satisfies readonly BimElement['kind'][]
const LOAD_INPUT_KIND_SET: ReadonlySet<string> = new Set(LOAD_INPUT_KINDS)

/** The load inputs of one record, by id. Taken from the newest record only: an older record is never indexed again. */
export type LoadInputs = ReadonlyMap<string, BimElement>

export function loadInputsOf(elements: Elements): LoadInputs {
  const out = new Map<string, BimElement>()
  for (const el of elementsOfKind(elements, ...LOAD_INPUT_KINDS)) out.set(el.id, el)
  return out
}

/** Ids of load inputs added, changed or removed since `previous`, and the inputs of `next`. */
export function changedLoadInputs(previous: LoadInputs, next: Elements): { readonly changed: string[]; readonly inputs: LoadInputs } {
  const inputs = loadInputsOf(next)
  const changed: string[] = []
  for (const [id, el] of inputs) if (previous.get(id) !== el) changed.push(id)
  for (const id of previous.keys()) if (!inputs.has(id)) changed.push(id)
  return { changed, inputs }
}

/**
 * Sum the session's changed ids over model events React batches into one render: any unknown (null) makes the
 * whole stretch unknown until the loads layer next advances.
 */
export function addChangedIds(since: readonly string[] | null, changedIds: readonly string[] | null): string[] | null {
  return since === null || changedIds === null ? null : [...since, ...changedIds]
}

/** The trades the header chip counts on each ribbon tab; any other tab shows every trade that has loads. */
const TAB_TRADES: Readonly<Record<string, readonly CatalogTrade[]>> = {
  electrical: ['electrical'],
  plumbing: ['plumbing', 'gas'],
  mechanical: ['mechanical'],
}

/**
 * The header chip, per trade (k2's trade scope, never a UI count): on 7329's
 * Plumbing tab "Water and drainage: 0 of 35 piped · Gas: 0 of 5 piped". A
 * trade with no loads is left out; null when the model has no loads at all.
 * Loads that fill no trade (no values yet) still show in the project line.
 */
export function loadsChipLine(progress: (scope: LoadProgressScope) => LoadProgress, tab: string): string | null {
  const all = progress({ kind: 'project' })
  if (all.total === 0) return null
  const lines: string[] = []
  for (const trade of TAB_TRADES[tab] ?? CATALOG_TRADES) {
    const p = progress({ kind: 'trade', trade })
    if (p.total > 0) lines.push(tradeProgressLine(p, trade))
  }
  return lines.length > 0 ? lines.join(' · ') : progressLine(all)
}

/** A space's estimates against the devices inside them, summed over every estimate spread on it. */
export interface SpaceLoads {
  readonly allocated: QuantityTotals
  readonly actual: QuantityTotals
}

export class LoadsLayer {
  private engine: RequirementsEngine | null = null
  private elements: Elements | null = null
  private inputs = new Map<string, BimElement>()
  private policy: AllocationPolicy | null = null
  private estimatesBySpace = new Map<string, ElementId[]>()
  /** Ids from model events since the last advance; null until the first model, or whenever one event couldn't say. */
  private pending: string[] | null = null

  /** The session's model event (`onModel`'s changed ids). React may batch several into one render, so they add up. */
  noteChanged(changedIds: readonly string[] | null): void {
    this.pending = addChangedIds(this.pending, changedIds)
  }

  /** Advance to this model from what was noted since the last advance (a full compare when that is unknown). */
  advanceNoted(model: ModelState): RequirementsEngine {
    if (this.elements === model.elements) return this.update(model, [])
    const ids = this.pending
    this.pending = []
    return this.update(model, ids)
  }

  /**
   * Bring the engine up to this model; rebuilt only when the model's allocation policy changes.
   * `changedIds`: what changed since the last call (the session's model event, summed between renders); null or
   * absent = unknown, so the load inputs are compared record by record.
   */
  update(model: ModelState, changedIds: readonly string[] | null = null): RequirementsEngine {
    const policy = allocationPolicyOf(model.elements)
    if (!this.engine || policy !== this.policy || !this.elements) {
      this.engine = new RequirementsEngine({ locator: modelSpaceLocator, policy })
      this.policy = policy
      this.engine.advance(model, [])
      this.inputs = new Map(loadInputsOf(model.elements))
    } else if (this.elements !== model.elements) {
      if (changedIds === null) {
        const { changed, inputs } = changedLoadInputs(this.inputs, model.elements)
        this.engine.advance(model, changed)
        this.inputs = new Map(inputs)
      } else {
        this.engine.advance(model, this.takeInputs(model.elements, changedIds))
      }
    }
    if (this.elements !== model.elements) {
      const bySpace = new Map<string, ElementId[]>()
      for (const lp of elementsOfKind(model.elements, 'load_point')) {
        const anchor = lp.anchor
        if (anchor?.kind !== 'space' && anchor?.kind !== 'zone') continue
        const ids = bySpace.get(anchor.id) ?? []
        ids.push(lp.id)
        bySpace.set(anchor.id, ids)
      }
      this.estimatesBySpace = bySpace
      this.elements = model.elements
    }
    return this.engine
  }

  /** The changed ids that are load inputs (now, or before they were removed), with the input index brought up to date. */
  private takeInputs(elements: Elements, changedIds: readonly string[]): string[] {
    const out: string[] = []
    for (const id of new Set(changedIds)) {
      const el = elements[id]
      if (el && LOAD_INPUT_KIND_SET.has(el.kind)) {
        this.inputs.set(id, el)
        out.push(id)
      } else if (this.inputs.delete(id)) out.push(id)
    }
    return out
  }

  /** The header chip's words for this ribbon tab; null when the model has no loads. */
  chipLine(model: ModelState, tab: string): string | null {
    const engine = this.advanceNoted(model)
    return loadsChipLine((scope) => engine.progress(model, scope), tab)
  }

  /** The Spaces panel's "VA: 900 allocated, 0 actual"; null when nothing is estimated on the space. Every estimate on a space is one group, so any of them answers for the whole space. */
  spaceLoads(model: ModelState, spaceId: string): SpaceLoads | null {
    const engine = this.advanceNoted(model)
    for (const id of this.estimatesBySpace.get(spaceId) ?? []) {
      const figures = engine.allocatedActual(model, id)
      if (figures) return { allocated: figures.allocated, actual: figures.actual }
    }
    return null
  }
}
