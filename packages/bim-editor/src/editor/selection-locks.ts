import { useSyncExternalStore } from 'react'
import { lockOf, type BimElement } from '@permitzip/bim-kernel'

/**
 * Revit-style selection locks shared across live plan, 3D, and printed drawings.
 *
 * - `rooms`: when false (default), room and space polygons stay out of the way
 *   so clicking or dragging devices, walls, and tags never accidentally selects
 *   the room underneath.
 * - `locked`: when false (default), pinned/locked elements (`el.locked === true`)
 *   cannot be selected or dragged.
 * - `links`: when false, linked reference models cannot be selected.
 */
export interface SelectionLocks {
  readonly rooms: boolean
  readonly locked: boolean
  readonly links: boolean
}

let state: SelectionLocks = {
  rooms: false,
  locked: false,
  links: true,
}

const listeners = new Set<() => void>()

export function getSelectionLocks(): SelectionLocks {
  return state
}

export function setSelectionLocks(patch: Partial<SelectionLocks>): void {
  const next: SelectionLocks = { ...state, ...patch }
  if (next.rooms === state.rooms && next.locked === state.locked && next.links === state.links) return
  state = next
  for (const fn of listeners) fn()
}

export function toggleSelectionLock(key: keyof SelectionLocks): void {
  setSelectionLocks({ [key]: !state[key] })
}

export function useSelectionLocks(): SelectionLocks {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    getSelectionLocks,
    getSelectionLocks,
  )
}

/** True when `el` is selectable under the active selection locks. */
export function isSelectableUnderLocks(el: BimElement | undefined, locks: SelectionLocks): boolean {
  if (!el) return false
  if (!locks.rooms && (el.kind === 'room' || el.kind === 'space')) return false
  if (!locks.locked && lockOf(el) !== null) return false
  return true
}
