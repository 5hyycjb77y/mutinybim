'use client'

import { useCallback, useEffect, useState } from 'react'
import type { DesignLimit, DesignLimitSources } from '@permitzip/bim-kernel/policy'
import { useEditorHost } from '@permitzip/bim-editor/host'
import { loadDesignLimitRowsFrom, publishDesignLimitFrom, type PublishOutcome } from '../design-limits/design-limits-client'

/**
 * The firm's and this project's design limits, for the capacity lines on the
 * schedules and the service-size dialog (Library › Design limits rows,
 * read on the caller's own access). Loading and a failed load are states the
 * lines show; until the limits arrive they read the add-on's defaults.
 */
export interface CapacityTargets {
  readonly status: 'loading' | 'ready' | 'error'
  readonly sources: DesignLimitSources
  /** Why the limits didn't load, in words (the lines then use the defaults). */
  readonly problem: string | null
  /** Save a new minimum for one limit on this project only (its own row; the firm's is untouched). */
  readonly setProjectMinimum: (limit: DesignLimit, minPercent: number) => Promise<PublishOutcome>
}

export function useCapacityTargets(projectId: string): CapacityTargets {
  const library = useEditorHost().data.firmLibrary
  const scope = `project:${projectId}`
  const [state, setState] = useState<{ status: CapacityTargets['status']; sources: DesignLimitSources; own: ReadonlyMap<string, number>; problem: string | null }>({ status: 'loading', sources: {}, own: new Map(), problem: null })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let live = true
    loadDesignLimitRowsFrom(library, scope)
      .then((rows) => {
        if (!live) return
        const project = rows.rows.filter((r) => r.layer === 'project').map((r) => r.limit)
        const firm = rows.rows.filter((r) => r.layer === 'firm').map((r) => r.limit)
        setState({ status: 'ready', sources: { project, firm }, own: new Map(rows.own.map((o) => [o.limit.id, o.revision] as const)), problem: null })
      })
      .catch((err: unknown) => {
        console.error('[useCapacityTargets] the design limits failed to load', { scope, err })
        if (live) setState({ status: 'error', sources: {}, own: new Map(), problem: 'The firm’s and project’s targets didn’t load, so the default targets are shown.' })
      })
    return () => {
      live = false
    }
  }, [library, scope, attempt])

  const setProjectMinimum = useCallback(
    async (limit: DesignLimit, minPercent: number): Promise<PublishOutcome> => {
      const outcome = await publishDesignLimitFrom(library, scope, { ...limit, band: { ...limit.band, min: minPercent } }, state.own.get(limit.id) ?? 0)
      if (outcome.ok) setAttempt((n) => n + 1)
      return outcome
    },
    [library, scope, state.own],
  )

  return { status: state.status, sources: state.sources, problem: state.problem, setProjectMinimum }
}
