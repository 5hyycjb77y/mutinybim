'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { EditorDataHost } from '@permitzip/bim-editor-host'
// Not the host barrel: it re-exports the local host, which loads all of bim-kernel onto the project page.
import { useOptionalEditorHost } from '../../host/context'
import { unavailableWords } from '@permitzip/bim-editor/host/unavailable'

export interface ModelScheduleTreeItem {
  readonly id: string
  readonly name: string
}

/** The tree row id for a model schedule: Building Model opens it as its grid. */
export function modelScheduleNodeId(viewId: string): string {
  return `building-model:schedule:${viewId}`
}

/** The schedule view a `building-model:schedule:<viewId>` row opens, or null. */
export function parseModelScheduleNodeId(nodeId: string): string | null {
  const prefix = 'building-model:schedule:'
  return nodeId.startsWith(prefix) && nodeId.length > prefix.length ? nodeId.slice(prefix.length) : null
}

/** Fired by the open Building Model when its schedules change, so the project tree follows without a reload. */
export const MODEL_SCHEDULES_EVENT = 'mutinybim:schedules'

export interface ModelSchedulesEventDetail {
  readonly projectId: string
  readonly items: readonly ModelScheduleTreeItem[]
}

/** The open Building Model announces its list schedules (called when they change). */
export function announceModelSchedules(detail: ModelSchedulesEventDetail): void {
  window.dispatchEvent(new CustomEvent<ModelSchedulesEventDetail>(MODEL_SCHEDULES_EVENT, { detail }))
}

function isEventDetail(value: unknown): value is ModelSchedulesEventDetail {
  return typeof value === 'object' && value !== null && 'projectId' in value && 'items' in value && Array.isArray(value.items)
}

function isViewsBody(value: unknown): value is { views: { id: string; name: string; listable: boolean }[] } {
  return typeof value === 'object' && value !== null && 'views' in value && Array.isArray(value.views)
}

/** What the person reads when the schedules for the project tree didn't load. */
export function scheduleTreeErrorText(status: number | null): string {
  if (status === 401 || status === 403) return "You can't open this project's Building Model schedules, so the tree shows Building Model without them."
  return "Couldn't load the Building Model schedules for the project tree. The tree shows Building Model without them until you retry."
}

export interface ModelScheduleTreeState {
  /** Null while loading, after a failed load, or without model access. */
  readonly items: readonly ModelScheduleTreeItem[] | null
  /** Plain words for the person when the last load failed; null otherwise. */
  readonly error: string | null
  readonly retry: () => void
}

class ScheduleTreeLoadError extends Error {
  constructor(readonly status: number | null, message: string) {
    super(message)
  }
}

/**
 * The project's Building Model list schedules for Workspace › Building model ›
 * Schedules (null while loading or without model access, so the tree is
 * unchanged). Read once per project visit from the model server. A failed load
 * is shown to the person (a toast with Retry, one per project) as well as
 * logged; `useModelScheduleTreeState` also returns it for a tree that renders
 * its own error row.
 */
type ModelSchedulesPort = EditorDataHost['modelSchedules']

export function useModelScheduleTreeFrom(port: ModelSchedulesPort, projectId: string, canReadModel: boolean): readonly ModelScheduleTreeItem[] | null {
  return useModelScheduleTreeStateFrom(port, projectId, canReadModel).items
}

export function useModelScheduleTreeStateFrom(port: ModelSchedulesPort, projectId: string, canReadModel: boolean): ModelScheduleTreeState {
  const capabilities = useOptionalEditorHost()?.capabilities ?? null
  const [items, setItems] = useState<{ projectId: string; items: readonly ModelScheduleTreeItem[] } | null>(null)
  const [failure, setFailure] = useState<{ projectId: string; text: string } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  const enabled = canReadModel
  useEffect(() => {
    if (!enabled || !port) return
    const controller = new AbortController()
    port
      .list({ projectId }, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new ScheduleTreeLoadError(res.status, `HTTP ${res.status}`)
        const body: unknown = await res.json()
        if (!isViewsBody(body)) throw new ScheduleTreeLoadError(null, 'The schedules came back in an unexpected shape.')
        setFailure(null)
        toast.dismiss(scheduleTreeToastId(projectId))
        setItems({ projectId, items: body.views.filter((v) => v.listable).map((v) => ({ id: v.id, name: v.name })) })
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        console.error('[useModelScheduleTree] loading the building model schedules failed; the tree shows Building Model without them', { projectId, err })
        const text = scheduleTreeErrorText(err instanceof ScheduleTreeLoadError ? err.status : null)
        setFailure({ projectId, text })
        toast.error(text, { id: scheduleTreeToastId(projectId), action: { label: 'Retry', onClick: retry } })
      })
    const onAnnounce = (e: Event) => {
      const detail = e instanceof CustomEvent ? e.detail : null
      if (isEventDetail(detail) && detail.projectId === projectId) {
        setFailure(null)
        toast.dismiss(scheduleTreeToastId(projectId))
        setItems({ projectId, items: detail.items })
      }
    }
    window.addEventListener(MODEL_SCHEDULES_EVENT, onAnnounce)
    return () => {
      controller.abort()
      window.removeEventListener(MODEL_SCHEDULES_EVENT, onAnnounce)
    }
  }, [port, enabled, projectId, attempt, retry])
  const missing = enabled && !port ? unavailableWords('The model’s schedules list', capabilities) : null
  return {
    items: enabled && items?.projectId === projectId ? items.items : null,
    error: missing ?? (enabled && failure?.projectId === projectId ? failure.text : null),
    retry,
  }
}

/** One toast per project, however many trees on the page read the schedules. */
function scheduleTreeToastId(projectId: string): string {
  return `building-model-schedule-tree:${projectId}`
}
