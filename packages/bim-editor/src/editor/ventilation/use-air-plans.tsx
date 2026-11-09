'use client'

import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { ROUTING_CONNECT_INTO_FEATURE, type ModelState } from '@permitzip/bim-kernel'
import { airConnectBlocked, airSystemsOfSelection, planSizeAirSystems, previewAirConnect, sizeDuctsLines } from '@permitzip/bim-pack-mechanical'
import { AIR_CONNECT_WORDS, SIZE_DUCTS_WORDS } from '@permitzip/bim-pack-mechanical/ui'
import type { SubmitCommand } from '../views-sheets/types'
import { AirPlanDialog } from './AirPlanDialog'
import type { MechanicalAction } from './mechanical-tab'

const LOADING = 'The model is still loading.'

export interface AirPlanInput {
  readonly model: ModelState | null
  readonly selectedIds: readonly string[]
  readonly editBlocked: string | null
  readonly submit: SubmitCommand
  readonly select: (ids: readonly string[]) => void
  readonly notify: (message: string, kind?: 'info' | 'error') => void
  readonly serverFeatures?: readonly string[]
}

type Open = { readonly kind: 'connect' | 'size'; readonly idPrefix: string } | null

let opened = 0

/** Why Connect › To duct can't run for this selection, or null. */
export function connectToDuctBlocked(model: ModelState | null, selectedIds: readonly string[], editBlocked: string | null): string | null {
  if (!model) return LOADING
  return editBlocked ?? airConnectBlocked(model.elements, selectedIds)
}

/** Why Analyze › Size ducts can't run for this selection, or null. */
export function sizeDuctsBlocked(model: ModelState | null, selectedIds: readonly string[], editBlocked: string | null): string | null {
  if (!model) return LOADING
  if (editBlocked) return editBlocked
  if (selectedIds.length === 0) return SIZE_DUCTS_WORDS.selectFirst
  return airSystemsOfSelection(model.elements, selectedIds).length > 0 ? null : SIZE_DUCTS_WORDS.noAirSystem
}

/**
 * Mechanical › Connect › To duct and Analyze › Size ducts: the two ribbon
 * actions, and the one preview window each opens. The plan is worked out when
 * the window opens and again after any edit while it is open; nothing changes
 * until the person presses the button, and the change is one undo.
 */
export function useAirPlans(input: AirPlanInput): { readonly connectToDuct: MechanicalAction; readonly sizeDucts: MechanicalAction; readonly overlay: ReactNode } {
  const { model, selectedIds, editBlocked, submit, select, notify, serverFeatures } = input
  const [open, setOpen] = useState<Open>(null)
  const start = useCallback((kind: 'connect' | 'size') => {
    opened += 1
    setOpen({ kind, idPrefix: `air${opened}-r${model?.revision ?? 0}` })
  }, [model?.revision])

  const connectBlocked = connectToDuctBlocked(model, selectedIds, editBlocked)
  const sizeBlocked = sizeDuctsBlocked(model, selectedIds, editBlocked)
  const peerMissing = serverFeatures !== undefined && !serverFeatures.includes(ROUTING_CONNECT_INTO_FEATURE) ? AIR_CONNECT_WORDS.peerMissing : null

  const connect = useMemo(() => (open?.kind === 'connect' && model ? previewAirConnect(model, selectedIds, open.idPrefix) : null), [open, model, selectedIds])
  const size = useMemo(() => {
    if (open?.kind !== 'size' || !model) return null
    const plan = planSizeAirSystems(model, airSystemsOfSelection(model.elements, selectedIds))
    return { plan, ...sizeDuctsLines(plan) }
  }, [open, model, selectedIds])

  // Stable while nothing they depend on changes, so the published ribbon doesn't change every render.
  const connectToDuct = useMemo<MechanicalAction>(() => ({ run: () => start('connect'), blocked: peerMissing ?? connectBlocked }), [start, peerMissing, connectBlocked])
  const sizeDucts = useMemo<MechanicalAction>(() => ({ run: () => start('size'), blocked: sizeBlocked }), [start, sizeBlocked])

  const close = useCallback(() => setOpen(null), [])
  const onSelect = useCallback((id: string) => select([id]), [select])

  const apply = useCallback(() => {
    const command = open?.kind === 'connect' ? (connect && !('refused' in connect) ? connect.plan.commands[0] : undefined) : size?.plan.commands[0]
    if (!command) return
    const undo = open?.kind === 'connect' ? AIR_CONNECT_WORDS.undo : SIZE_DUCTS_WORDS.undo
    const refused = submit(command, undo)
    if (refused) {
      console.error('[useAirPlans] the model refused the edit', { kind: open?.kind, refused })
      notify(refused, 'error')
      return
    }
    if (open?.kind === 'connect' && connect && !('refused' in connect)) notify(AIR_CONNECT_WORDS.done(connect.joinable, connect.lines.length))
    else if (size) notify(SIZE_DUCTS_WORDS.done(size.plan.changes.length))
    setOpen(null)
  }, [open, connect, size, submit, notify])

  let overlay: ReactNode = null
  if (open?.kind === 'connect') {
    const lines = connect && !('refused' in connect) ? connect.lines : []
    const empty = connect && 'refused' in connect ? connect.refused : null
    overlay = (
      <AirPlanDialog
        open
        onOpenChange={(o) => !o && close()}
        title={AIR_CONNECT_WORDS.title}
        description={AIR_CONNECT_WORDS.description}
        lines={lines}
        empty={empty}
        blocked={peerMissing ?? editBlocked}
        confirmLabel={AIR_CONNECT_WORDS.connectAll(lines.filter((l) => l.ok).length)}
        closeLabel={AIR_CONNECT_WORDS.close}
        hint={lines.length > 0 && lines.every((l) => !l.ok) ? AIR_CONNECT_WORDS.noneJoin : AIR_CONNECT_WORDS.escHint}
        onConfirm={apply}
        onSelect={onSelect}
        testId="air-connect-dialog"
      />
    )
  } else if (open?.kind === 'size' && size) {
    const empty = size.plan.systems.length === 0 ? SIZE_DUCTS_WORDS.noAirSystem : size.lines.length === 0 ? SIZE_DUCTS_WORDS.nothingToChange : null
    overlay = (
      <AirPlanDialog
        open
        onOpenChange={(o) => !o && close()}
        title={SIZE_DUCTS_WORDS.title}
        description={SIZE_DUCTS_WORDS.description}
        notes={[...size.rules, ...(size.plan.kept > 0 ? [`${size.plan.kept} already the size their airflow calls for.`] : [])]}
        lines={size.lines}
        empty={empty}
        blocked={editBlocked}
        confirmLabel={SIZE_DUCTS_WORDS.apply(size.plan.changes.length)}
        closeLabel={SIZE_DUCTS_WORDS.close}
        hint={SIZE_DUCTS_WORDS.escHint}
        onConfirm={apply}
        onSelect={onSelect}
        testId="size-ducts-dialog"
      />
    )
  }

  return { connectToDuct, sizeDucts, overlay }
}
