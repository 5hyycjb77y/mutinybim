import { elementsOfKind, partitionOf, type BimElement, type ElementId, type ModelState } from '@permitzip/bim-kernel'

/**
 * The open model as an external store, published beside the surface's
 * `setModel` (expand step of MIGRATION-PLAN §6 "UI state"): panels read the
 * slice they show through `useModelSelector`, so an edit re-renders only the
 * panels whose slice changed. `setModel` goes once nothing reads the whole
 * model through props.
 */
export interface ModelSnapshot {
  readonly model: ModelState | null
  /** Ids that changed since the previous snapshot; null when unknown (treat as everything). */
  readonly changedIds: ReadonlySet<string> | null
  /** Bumps on every publish, so selectors can tell snapshots apart cheaply. */
  readonly version: number
}

export const EMPTY_SNAPSHOT: ModelSnapshot = { model: null, changedIds: null, version: 0 }

export class ModelStore {
  private snapshot: ModelSnapshot = EMPTY_SNAPSHOT
  private readonly listeners = new Set<() => void>()

  readonly getSnapshot = (): ModelSnapshot => this.snapshot

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** What `ModelSession.onModel` reports: the shown model and the ids that changed (null: unknown). */
  publish(model: ModelState | null, changedIds: readonly ElementId[] | readonly string[] | null): void {
    if (model === this.snapshot.model) return
    this.snapshot = { model, changedIds: changedIds ? new Set<string>(changedIds) : null, version: this.snapshot.version + 1 }
    for (const listener of [...this.listeners]) listener()
  }
}

/**
 * A slice of the model for one panel. `prev` is this selector's last result
 * (undefined the first time), so a selector can answer incrementally from
 * `snapshot.changedIds` instead of scanning the whole model.
 */
export type ModelSelector<T> = (snapshot: ModelSnapshot, prev: T | undefined) => T

export function shallowArrayEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false
  return true
}

/** One element by id; equal while the kernel keeps the same element object. */
export function selectElement(id: string | null): ModelSelector<BimElement | null> {
  return (s) => (id && s.model ? s.model.elements[id] ?? null : null)
}

/**
 * The elements whose kind is one of `kinds`, in model order. Incremental: when
 * the changed ids are known and none of them is (or was) such an element, the
 * previous array comes back as is, so the panel does not re-render. Pair with
 * `shallowArrayEqual`.
 */
export function selectElementsOfKinds(kinds: ReadonlySet<BimElement['kind']>): ModelSelector<readonly BimElement[]> {
  const kindList = [...kinds]
  const hasKind = (el: BimElement | undefined): boolean => el !== undefined && kinds.has(el.kind)
  let lastModel: ModelState | null = null
  let lastVersion = -1
  return (s, prev) => {
    const model = s.model
    const follows = s.version === lastVersion + 1
    lastVersion = s.version
    if (!model) return EMPTY_ELEMENTS
    // changedIds is relative to the previous snapshot only; after a skipped one, recompute.
    if (prev && lastModel && s.changedIds && follows) {
      let touched = false
      for (const id of s.changedIds) {
        if (hasKind(model.elements[id]) || hasKind(lastModel.elements[id])) {
          touched = true
          break
        }
      }
      if (!touched) {
        lastModel = model
        return prev
      }
    }
    lastModel = model
    return elementsOfKind(model.elements, ...kindList)
  }
}

const EMPTY_ELEMENTS: readonly BimElement[] = []

/** The whole model: a panel that shows live model data re-renders on every edit. */
export const selectModel: ModelSelector<ModelState | null> = (s) => s.model

export const selectNothing: ModelSelector<ModelState | null> = () => null

/**
 * The model, refreshed only when an element in one of `zones` changes (or the
 * change is unknown). For a reader that looks only inside those partition
 * zones (`documentIndex` reads the documents zone, `organizationOf` the
 * organization zone): it sees the same elements there, and does not re-render
 * when a duct moves. Never give it to a reader of other zones.
 */
export function selectModelForZones(zones: ReadonlySet<string>): ModelSelector<ModelState | null> {
  let lastVersion = -1
  return (s, prev) => {
    const follows = s.version === lastVersion + 1
    lastVersion = s.version
    const model = s.model
    if (!model || !prev || !s.changedIds || !follows) return model
    for (const id of s.changedIds) {
      const now = model.elements[id]
      const before = prev.elements[id]
      if ((now && zones.has(partitionOf(now).zone)) || (before && zones.has(partitionOf(before).zone))) return model
      if (!now && !before) return model
    }
    return prev
  }
}
