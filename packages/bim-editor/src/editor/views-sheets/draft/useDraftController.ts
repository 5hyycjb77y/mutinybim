'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import { DEFAULT_DRAFT_SETTINGS, DEFAULT_MODIFY_PARAMS, type DraftPending, type DraftSettings, type ModifyParams } from './draft-input'

/**
 * Draft state the ribbon and the drawing canvas share: tool settings (line
 * style, hatch, component, snaps, tracking, dimension kind), the modify
 * operation waiting for clicks and its typed values, and which drawn items
 * are selected (the canvas reports them; the ribbon says why Modify is off).
 * Tab-session UI state, not saved: what is drawn is saved, how you draw is not.
 */
/** What the ribbon can ask the open drawing to do with what is picked on it (Modify › Delete, Deselect). */
export type DraftRequest = 'delete' | 'deselect'
export type DraftSelectionActions = Readonly<Record<DraftRequest, () => void>>

export interface DraftController {
  readonly settings: DraftSettings
  readonly setSettings: (next: DraftSettings) => void
  readonly params: ModifyParams
  readonly setParams: (next: ModifyParams) => void
  readonly pending: DraftPending
  readonly setPending: (next: DraftPending) => void
  readonly selectedIds: readonly string[]
  readonly setSelectedIds: (ids: readonly string[]) => void
  /** Ask the open drawing to delete or deselect what is picked on it; nothing happens when no drawing is open. */
  readonly sendRequest: (kind: DraftRequest) => void
  /** The open drawing canvas registers how it deletes and deselects (null when it closes). */
  readonly registerSelectionActions: (actions: DraftSelectionActions | null) => void
}

export function useDraftController(): DraftController {
  const [settings, setSettings] = useState<DraftSettings>(DEFAULT_DRAFT_SETTINGS)
  const [params, setParams] = useState<ModifyParams>(DEFAULT_MODIFY_PARAMS)
  const [pending, setPending] = useState<DraftPending>(null)
  const [selectedIds, setSelectedIds] = useState<readonly string[]>([])
  const actions = useRef<DraftSelectionActions | null>(null)
  const registerSelectionActions = useCallback((next: DraftSelectionActions | null) => {
    actions.current = next
  }, [])
  const sendRequest = useCallback((kind: DraftRequest) => {
    const run = actions.current?.[kind]
    if (run) run()
    else console.error('[useDraftController] no drawing is open to', kind)
  }, [])
  return useMemo(() => ({ settings, setSettings, params, setParams, pending, setPending, selectedIds, setSelectedIds, sendRequest, registerSelectionActions }), [settings, params, pending, selectedIds, sendRequest, registerSelectionActions])
}
