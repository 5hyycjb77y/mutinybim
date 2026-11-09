'use client'

import { clientOnly as dynamic } from '@permitzip/bim-editor/client-only'
import { useCallback, useMemo, useState } from 'react'
import { levelHeightLabel, type Command, type Level, type ModelState } from '@permitzip/bim-kernel'
import type { ModelViewer3D } from '@permitzip/bim-viewer-3d'
import { newElementId } from '../placement'
import { suggestLevelName } from './surface-pick'
import { useLevelPick } from './use-level-pick'
import { useLevelPlanes } from './use-level-planes'

const AddLevelDialog = dynamic(() => import('./AddLevelDialog').then((m) => m.AddLevelDialog), { ssr: false })

const ArchitectLevelsDialog = dynamic(() => import('./ArchitectLevelsDialog').then((m) => m.ArchitectLevelsDialog), { ssr: false })

/** What the ribbon or a panel asked for. */
export type LevelRequest = 'add' | 'architect'

/**
 * Everything about making levels from the building, in one place so the
 * Building Model surface only mounts it:
 *
 * - Add level (typed), with Pick a surface (click a roof or floor in 3D and the
 *   height fills in, "Roof" suggested at the top) and Use the architect's levels;
 * - the architect's levels preview and sync;
 * - the 3D level planes (shown when `showPlanes` and the 3D view is open).
 */
export function LevelTools({
  projectId,
  model,
  levels,
  viewer,
  live3d,
  showPlanes,
  extentKey,
  canEdit,
  blockedReason,
  submit,
  request,
  onRequest,
  hint,
}: {
  readonly projectId: string
  readonly model: ModelState | null
  readonly levels: readonly Level[]
  readonly viewer: ModelViewer3D | null
  /** The live 3D view is the one on screen (planes and picking happen there). */
  readonly live3d: boolean
  readonly showPlanes: boolean
  readonly extentKey: unknown
  readonly canEdit: boolean
  readonly blockedReason: string
  readonly submit: (command: Command, label: string) => string | null
  readonly request: LevelRequest | null
  readonly onRequest: (request: LevelRequest | null) => void
  readonly hint: (text: string | null) => void
}) {
  const [picking, setPicking] = useState(false)
  const [picked, setPicked] = useState<{ name: string; elevationMm: number; from: string } | null>(null)
  const [highlightedId, setHighlightedId] = useState<string | null>(null)

  useLevelPlanes({
    viewer,
    levels: useMemo(() => levels.map((l) => ({ id: l.id, name: l.name, elevationMm: l.elevationMm })), [levels]),
    show: showPlanes && live3d,
    highlightedId,
    extentKey,
  })

  useLevelPick({
    viewer,
    armed: picking && live3d,
    hint,
    onCancel: () => {
      setPicking(false)
      onRequest('add')
    },
    onPicked: (elevationMm, hit) => {
      void (async () => {
        const top = await viewer?.sceneExtentMm().catch((err: unknown) => {
          console.error('[LevelTools] measuring the building top for the level name failed', err)
          return null
        })
        setPicked({ name: suggestLevelName(elevationMm, levels, top?.max.z ?? null), elevationMm, from: `the ${hit.source === 'linked' ? 'linked model' : 'model'} at ${levelHeightLabel(elevationMm)}` })
        setPicking(false)
        hint(null)
        onRequest('add')
      })()
    },
  })

  const close = useCallback(() => {
    setPicked(null)
    setHighlightedId(null)
    onRequest(null)
  }, [onRequest])

  return (
    <>
      {request === 'add' && (
        <AddLevelDialog
          key={picked ? `picked-${picked.elevationMm}` : 'typed'}
          existing={levels}
          initial={picked}
          onCancel={close}
          onNameChange={setHighlightedId}
          onAdd={(name, elevationMm) => submit({ type: 'create_level', levelId: newElementId('lvl'), name, elevationMm }, `add level ${name}`)}
          onMove={(levelId, elevationMm) => submit({ type: 'update_level', levelId, elevationMm }, `level moved to ${levelHeightLabel(elevationMm)}`)}
          onUseArchitect={() => onRequest('architect')}
          onPickSurface={
            live3d
              ? () => {
                  setPicked(null)
                  setPicking(true)
                  onRequest(null)
                }
              : undefined
          }
        />
      )}
      {request === 'architect' && model && (
        <ArchitectLevelsDialog projectId={projectId} model={model} canEdit={canEdit} blockedReason={blockedReason} submit={submit} onClose={close} />
      )}
    </>
  )
}
