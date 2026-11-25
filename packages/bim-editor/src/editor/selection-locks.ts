import { useSyncExternalStore } from 'react'
import { elementViewCategory, lockOf, organizationOf, type BimElement, type ModelState } from '@permitzip/bim-kernel'

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
  /** Highlight every locked/pinned element on 2D drawings with an amber lock overlay so frozen items are immediately visible. */
  readonly showLocked: boolean
}

let state: SelectionLocks = {
  rooms: false,
  locked: false,
  links: true,
  showLocked: false,
}

const listeners = new Set<() => void>()

export function getSelectionLocks(): SelectionLocks {
  return state
}

export function setSelectionLocks(patch: Partial<SelectionLocks>): void {
  const next: SelectionLocks = { ...state, ...patch }
  if (next.rooms === state.rooms && next.locked === state.locked && next.links === state.links && next.showLocked === state.showLocked) return
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

/**
 * True when `el` is locked by ANY kernel mechanism:
 * - per-element pin/lock (`lockOf(el)`),
 * - organization element lock (`org.lockedElementIds`),
 * - organization group lock (`org.groupById.get(groupId)?.entry.locked`), or
 * - organization category lock (`org.lockedCategories` matching `elementViewCategory`).
 */
export function isElementLockedInModel(model: ModelState, el: BimElement | undefined): boolean {
  if (!el) return false
  if (lockOf(el) !== null) return true
  const org = organizationOf(model)
  if (org.lockedElementIds.has(el.id)) return true
  const groupId = 'groupId' in el && typeof el.groupId === 'string' ? el.groupId : undefined
  if (groupId && org.groups.some((g) => g.id === groupId && g.entry.locked)) return true
  if (org.lockedCategories.size > 0) {
    const cat = elementViewCategory(model.elements, el)
    if (cat && org.lockedCategories.has(cat)) return true
  }
  return false
}

/** True when `el` is selectable under the active selection locks. */
export function isSelectableUnderLocks(el: BimElement | undefined, locks: SelectionLocks, model?: ModelState): boolean {
  if (!el) return false
  if (!locks.rooms && (el.kind === 'room' || el.kind === 'space')) return false
  if (!locks.locked && (model ? isElementLockedInModel(model, el) : lockOf(el) !== null)) return false
  return true
}
