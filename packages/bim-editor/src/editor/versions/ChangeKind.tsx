'use client'

import { clientOnly as dynamic } from '@permitzip/bim-editor/client-only'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { RotateCwIcon, TagIcon } from 'lucide-react'
import {
  CHANGE_WORDS,
  changeKindWords,
  checkingContextFor,
  changeTargetKey,
  classifyProblem,
  classifyingResponsibilities,
  coveringResponsibilities,
  modelCoverageContext,
  writeCheckingContext,
  type ChangeTarget,
  type ModelState,
} from '@permitzip/bim-kernel'
import { activePackSet, modelPackSet } from '@permitzip/bim-kernel/packs'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { useEditorHost } from '@permitzip/bim-editor/host'
import { classifyChangeFrom, fetchChangeSignificanceFrom } from '../../contracts/bim/change-orders/client'
import type { ChangeSignificanceResponse, SignificanceView } from '../../contracts/bim/change-orders/model'
import { versionRangeTarget } from '../../contracts/bim/change-orders/model'
import type { VersionEntry } from '../../contracts/building-model/branch-versions'
import type { BranchChannel } from '../branches/useBranches'
import { useQuantityDelta } from '../change-orders/useQuantityDelta'
import type { ModelStore } from '../model-store'
import { ModelFromStore } from '../state/model-from-store'

const ChangeKindDialog = dynamic(() => import('./ChangeKindDialog').then((m) => m.ChangeKindDialog), { ssr: false })

type Load = { readonly state: 'loading' } | { readonly state: 'error'; readonly message: string } | { readonly state: 'ready'; readonly data: ChangeSignificanceResponse }

/** The current classifications and the viewer's own responsibilities, loaded once for the Versions list. */
export function useChangeSignificance(projectId: string, active: boolean) {
  const changeOrders = useEditorHost().data.changeOrders
  const [attempt, setAttempt] = useState(0)
  const key = `${projectId}|${attempt}`
  const [answer, setAnswer] = useState<{ readonly key: string; readonly load: Load } | null>(null)
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    fetchChangeSignificanceFrom(changeOrders, projectId, controller.signal)
      .then((data) => setAnswer({ key, load: { state: 'ready', data } }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        console.error('[ChangeKind] loading classifications failed', err)
        setAnswer({ key, load: { state: 'error', message: err instanceof Error ? err.message : "What kind of changes these were didn't load." } })
      })
    return () => controller.abort()
  }, [changeOrders, projectId, active, key])
  const load: Load = answer && answer.key === key ? answer.load : { state: 'loading' }
  return { load, reload: useCallback(() => setAttempt((n) => n + 1), []) }
}

export interface ChangeKindProps {
  readonly projectId: string
  readonly target: ChangeTarget
  readonly load: Load
  readonly onReload: () => void
  readonly channel: BranchChannel | null
  readonly model: ModelState | null
}

/**
 * Under a version (or on a branch): what kind of change it was. Until a
 * covering professional says, it reads "Design change. Not a change order."
 * Everyone sees it; only a responsible professional whose accepted area
 * covers the change can set it, and the button says why when it is off.
 */
export function ChangeKind({ projectId, target, load, onReload, channel, model }: ChangeKindProps) {
  const changeOrders = useEditorHost().data.changeOrders
  const [open, setOpen] = useState(false)
  const { state: delta, retry } = useQuantityDelta(channel, model, open ? target : null)
  const set = useMemo(() => (model ? (modelPackSet(model.modelId) ?? activePackSet()) : activePackSet()), [model])
  const key = changeTargetKey(target)
  const current: SignificanceView | null = load.state === 'ready' ? (load.data.current.find((c) => c.targetKey === key) ?? null) : null

  const covering = useMemo(() => {
    if (load.state !== 'ready' || delta.status !== 'ready' || !model) return null
    const records = delta.read.changedRecords
    const byId = Object.fromEntries(records.map((r) => [r.id, r]))
    const coverage = coveringResponsibilities(records, load.data.mine.map((m) => m.responsibility), modelCoverageContext({ elements: { ...model.elements, ...byId } }))
    const ids = new Set(classifyingResponsibilities(coverage, load.data.viewerId).map((r) => r.id))
    return { options: load.data.mine.filter((m) => ids.has(m.responsibility.id)), problem: classifyProblem(coverage, load.data.viewerId) }
  }, [load, delta, model])

  if (load.state === 'error') {
    return (
      <p className="flex flex-wrap items-center gap-2 text-xs text-destructive">
        {load.message}
        <Button size="sm" variant="ghost" onClick={onReload}>
          <RotateCwIcon aria-hidden /> Retry
        </Button>
      </p>
    )
  }

  const noResponsibility = load.state === 'ready' && load.data.mine.length === 0
  const disabledWhy = load.state === 'loading' ? 'Loading…' : noResponsibility ? CHANGE_WORDS.whoClassifies : null

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {current ? (
        <>
          <Badge variant="secondary">
            <TagIcon aria-hidden /> {changeKindWords(set, current.kind)}
          </Badge>
          <span className="text-muted-foreground">
            {current.reason}
            {current.citation ? ` (${current.citation})` : ''} — {current.classifiedByLabel}
            {current.historyCount > 1 ? `, changed ${current.historyCount - 1} time${current.historyCount === 2 ? '' : 's'}` : ''}
          </span>
        </>
      ) : (
        <span className="text-muted-foreground">{CHANGE_WORDS.notAChangeOrder}</span>
      )}
      <Button size="sm" variant="ghost" disabled={disabledWhy !== null} title={disabledWhy ?? undefined} onClick={() => setOpen(true)}>
        What kind of change was this?
      </Button>
      {disabledWhy && noResponsibility ? <span className="basis-full text-muted-foreground">{disabledWhy}</span> : null}
      {open && load.state === 'ready' ? (
        covering && covering.problem ? (
          <ChangeKindBlocked message={covering.problem} onClose={() => setOpen(false)} />
        ) : (
          <ChangeKindDialog
            open={open}
            onOpenChange={setOpen}
            target={target}
            set={set}
            currentKind={current?.kind ?? null}
            covering={covering?.options ?? null}
            delta={delta}
            onRetryDelta={retry}
            onSave={async (input) => {
              if (delta.status !== 'ready') throw new Error('Wait for the quantity change to load, then save.')
              await classifyChangeFrom(changeOrders, projectId, { target, ...input, deltaDigest: delta.read.digest, elements: delta.read.changedRecords, ...(model ? { checkingContext: writeCheckingContext(checkingContextFor(model, { elementIds: delta.read.changedRecords.map((r) => String(r.id)) })) } : {}) })
              onReload()
            }}
          />
        )
      ) : null}
    </div>
  )
}

function ChangeKindBlocked({ message, onClose }: { readonly message: string; readonly onClose: () => void }) {
  return (
    <p role="alert" className="flex basis-full flex-wrap items-center gap-2 text-muted-foreground">
      {message} {message === CHANGE_WORDS.noResponsibility ? CHANGE_WORDS.whoClassifies : ''}
      <Button size="sm" variant="ghost" onClick={onClose}>
        Close
      </Button>
    </p>
  )
}

/**
 * Lane B's Versions slot (`VersionsList.renderExtra`): each saved version or
 * issued set classifies the range from the version listed below it up to
 * itself. "Now" has nothing to classify until it is saved.
 */
export function useChangeKindSlot(input: { readonly projectId: string; readonly modelId: string | null; readonly entries: readonly VersionEntry[] | null; readonly channel: BranchChannel | null; readonly model: ModelState | null; readonly store?: ModelStore }): (entry: VersionEntry) => ReactNode {
  const { projectId, modelId, entries, channel, model, store } = input
  const { load, reload } = useChangeSignificance(projectId, modelId !== null)
  return useCallback(
    (entry: VersionEntry) => {
      if (!modelId || !entries || entry.kind === 'now') return null
      const at = entries.findIndex((e) => e.key === entry.key)
      const older = entries.slice(at + 1).find((e) => e.kind !== 'now' && e.revision < entry.revision)
      const target = versionRangeTarget(modelId, older?.revision ?? 0, entry.revision)
      if (!target) return <span className="text-xs text-muted-foreground">Same version as the one below it: nothing to classify.</span>
      if (store) return <ModelFromStore store={store}>{(shown) => <ChangeKind projectId={projectId} target={target} load={load} onReload={reload} channel={channel} model={shown} />}</ModelFromStore>
      return <ChangeKind projectId={projectId} target={target} load={load} onReload={reload} channel={channel} model={model} />
    },
    [projectId, modelId, entries, channel, model, store, load, reload],
  )
}
