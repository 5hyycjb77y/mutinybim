'use client'

import { createContext, useCallback, useContext, useRef, useSyncExternalStore } from 'react'
import { EMPTY_SNAPSHOT, type ModelSelector, type ModelSnapshot, type ModelStore } from './model-store'

/** The open model's store; the surface's session host provides it. */
export const ModelStoreContext = createContext<ModelStore | null>(null)

export function useModelStore(): ModelStore {
  const store = useContext(ModelStoreContext)
  if (!store) throw new Error('useModelStore: no ModelStoreContext provider (render inside the Building Model surface)')
  return store
}

const NO_STORE_SUBSCRIBE = (): (() => void) => () => undefined
const NO_STORE_SNAPSHOT = (): ModelSnapshot => EMPTY_SNAPSHOT

/**
 * Read one slice of the open model. The component re-renders only when
 * `equals(previous, next)` is false, however often the model changes.
 * Keep `selector` stable (module scope or `useMemo`) when it is incremental.
 */
export function useModelSelector<T>(store: ModelStore | null, selector: ModelSelector<T>, equals: (a: T, b: T) => boolean = Object.is): T {
  const memo = useRef<{ snapshot: ModelSnapshot; value: T; selector: ModelSelector<T> } | null>(null)
  const select = useCallback(
    (snapshot: ModelSnapshot): T => {
      const last = memo.current
      if (last && last.snapshot === snapshot && last.selector === selector) return last.value
      const next = selector(snapshot, last?.value)
      const value = last && equals(last.value, next) ? last.value : next
      memo.current = { snapshot, value, selector }
      return value
    },
    [selector, equals],
  )
  const subscribe = store ? store.subscribe : NO_STORE_SUBSCRIBE
  const getSnapshot = store ? store.getSnapshot : NO_STORE_SNAPSHOT
  return useSyncExternalStore(
    subscribe,
    () => select(getSnapshot()),
    () => select(EMPTY_SNAPSHOT),
  )
}
