'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { EditorDataAnswer, EditorDataHost } from '@permitzip/bim-editor-host'

/**
 * How the signed-in person last left a schedule grid (column widths, frozen
 * columns, expanded rows), and which schedule they last opened. Kept in the
 * database so it follows them across reloads and machines
 * (durable-agent-state-in-db.mdc), the same way as the view display choice.
 */

export interface SchedulePrefsBody {
  readonly viewId: string
  readonly columnWidths: Readonly<Record<string, number>>
  readonly frozenColumns: number | null
  readonly expandedRows: readonly string[]
  readonly lastOpenedViewId: string | null
}

export interface SchedulePrefs {
  /** False until the saved layout has arrived (or failed to). */
  readonly loaded: boolean
  readonly columnWidths: Readonly<Record<string, number>>
  readonly saveColumnWidths: (widths: Readonly<Record<string, number>>) => void
}

const SAVE_DELAY_MS = 600

export function isSchedulePrefsBody(value: unknown): value is SchedulePrefsBody {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  const widths = v.columnWidths
  return (
    typeof v.viewId === 'string' &&
    typeof widths === 'object' &&
    widths !== null &&
    Object.values(widths).every((w) => typeof w === 'number' && Number.isFinite(w)) &&
    (v.frozenColumns === null || typeof v.frozenColumns === 'number') &&
    Array.isArray(v.expandedRows) &&
    v.expandedRows.every((r) => typeof r === 'string') &&
    (v.lastOpenedViewId === null || typeof v.lastOpenedViewId === 'string')
  )
}

async function refusalText(res: EditorDataAnswer): Promise<string> {
  const body: unknown = await res.json().catch((err: unknown) => {
    console.error('[useSchedulePrefs] reading the refusal failed', err)
    return null
  })
  return typeof body === 'object' && body !== null && 'error' in body ? String(body.error) : `HTTP ${res.status}`
}

export function useSchedulePrefsFrom(port: EditorDataHost['schedulePrefs'], projectId: string, viewId: string): SchedulePrefs {
  const [state, setState] = useState<{ viewId: string; widths: Readonly<Record<string, number>> } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!port) return
    const controller = new AbortController()
    port
      .read({ projectId, viewId }, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(await refusalText(res))
        const body: unknown = await res.json()
        if (!isSchedulePrefsBody(body)) throw new Error('The saved schedule layout came back in an unexpected shape.')
        setState({ viewId, widths: body.columnWidths })
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        console.error('[useSchedulePrefs] loading the saved schedule layout failed', { projectId, viewId, err })
        toast.error("Your column widths for this schedule couldn't be loaded. It opens with the default widths.")
        setState({ viewId, widths: {} })
      })
    // Remember this as the schedule the person last opened.
    port
      .opened({ projectId, viewId }, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(await refusalText(res))
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        console.error('[useSchedulePrefs] remembering the opened schedule failed (non-blocking)', { projectId, viewId, err })
      })
    return () => controller.abort()
  }, [port, projectId, viewId])

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  const saveColumnWidths = useCallback(
    (widths: Readonly<Record<string, number>>) => {
      if (timer.current) clearTimeout(timer.current)
      if (!port) return
      timer.current = setTimeout(() => {
        port
          .saveColumnWidths({ projectId, viewId, columnWidths: widths })
          .then(async (res) => {
            if (!res.ok) throw new Error(await refusalText(res))
          })
          .catch((err: unknown) => {
            console.error('[useSchedulePrefs] saving column widths failed', { projectId, viewId, err })
            toast.error("The new column widths show here, but couldn't be saved for next time.")
          })
      }, SAVE_DELAY_MS)
    },
    [port, projectId, viewId],
  )

  // Without a place to keep it, the grid opens with the default widths and keeps changes for this visit.
  const loaded = !port || state?.viewId === viewId
  return useMemo(() => ({ loaded, columnWidths: loaded && state ? state.widths : {}, saveColumnWidths }), [loaded, state, saveColumnWidths])
}
