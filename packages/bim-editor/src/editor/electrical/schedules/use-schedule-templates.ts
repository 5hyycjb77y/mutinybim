'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { formTemplateSchema, type FormScheduleKind, type FormTemplate } from '@permitzip/bim-kernel'
import type { EditorDataAnswer, EditorDataHost } from '@permitzip/bim-editor-host'
import { unavailableWords } from '@permitzip/bim-editor/host/unavailable'

/** One of the firm's saved schedule templates (GET /api/bim/schedule-templates `firm`). */
export interface FirmScheduleTemplate {
  readonly kind: FormScheduleKind
  readonly name: string
  readonly template: FormTemplate
  readonly isDefault: boolean
  readonly revision: number
}

export interface ScheduleTemplates {
  readonly status: 'idle' | 'loading' | 'ready' | 'error'
  /** Why the firm's templates couldn't load, in plain words. Built-in templates still work. */
  readonly problem: string | null
  /** Whether this person may save to the firm library. */
  readonly canWrite: boolean
  readonly firm: readonly FirmScheduleTemplate[]
  readonly firmDefault: (kind: FormScheduleKind) => FirmScheduleTemplate | null
  /** Save to the firm library; null when saved, else the plain refusal. */
  readonly save: (input: { readonly kind: FormScheduleKind; readonly name: string; readonly template: FormTemplate; readonly makeDefault: boolean }) => Promise<string | null>
}

// Tolerant reader: any stored kind reads back; the add-on that owns it decides what it prints.
const isKind = (v: unknown): v is FormScheduleKind => typeof v === 'string' && v.trim().length > 0

function firmTemplateFrom(row: unknown): FirmScheduleTemplate | null {
  if (typeof row !== 'object' || row === null) return null
  const r = row as Record<string, unknown>
  if (!isKind(r.kind) || typeof r.name !== 'string') return null
  const template = formTemplateSchema.safeParse(r.template)
  if (!template.success) {
    console.error('[useScheduleTemplates] a firm template did not parse; leaving it out', { kind: r.kind, name: r.name, issue: template.error.issues[0] })
    return null
  }
  return { kind: r.kind, name: r.name, template: template.data, isDefault: r.isDefault === true, revision: typeof r.revision === 'number' ? r.revision : 1 }
}

/** The body of GET /api/bim/schedule-templates, or null when it isn't that shape. */
export function parseScheduleTemplatesResponse(body: unknown): { canWrite: boolean; firm: FirmScheduleTemplate[] } | null {
  if (typeof body !== 'object' || body === null || !('firm' in body) || !Array.isArray(body.firm)) return null
  const canWrite = 'canWrite' in body && body.canWrite === true
  return { canWrite, firm: body.firm.flatMap((row: unknown) => firmTemplateFrom(row) ?? []) }
}

async function errorText(res: EditorDataAnswer): Promise<string> {
  try {
    const body: unknown = await res.json()
    if (typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string') return body.error
  } catch (err) {
    console.error('[useScheduleTemplates] error response had no JSON body', err)
  }
  return `the server answered HTTP ${res.status}`
}

/**
 * The firm's schedule templates (firm library), fetched once the first time
 * `enabled` is true. A failed load is said in plain words; the built-in
 * templates (in the kernel) work without it.
 */
export function useScheduleTemplatesFrom(port: EditorDataHost['firmLibrary'], enabled: boolean): ScheduleTemplates {
  const [status, setStatus] = useState<ScheduleTemplates['status']>('idle')
  const [problem, setProblem] = useState<string | null>(null)
  const [canWrite, setCanWrite] = useState(false)
  const [firm, setFirm] = useState<readonly FirmScheduleTemplate[]>([])
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    if (!enabled || !port) return
    let cancelled = false
    port
      .scheduleTemplates()
      .then(async (res) => {
        if (res.status === 401 || res.status === 403) throw new Error("you don't have access to the firm library")
        if (!res.ok) throw new Error(await errorText(res))
        const parsed = parseScheduleTemplatesResponse(await res.json())
        if (!parsed) throw new Error('the answer was not a list of templates')
        if (cancelled) return
        setCanWrite(parsed.canWrite)
        setFirm(parsed.firm)
        setProblem(null)
        setStatus('ready')
      })
      .catch((err: unknown) => {
        console.error('[useScheduleTemplates] loading firm schedule templates failed', err)
        if (cancelled) return
        setProblem(`Your firm's templates couldn't load (${err instanceof Error ? err.message : String(err)}). The built-in templates still work.`)
        setCanWrite(false)
        setStatus('error')
      })
    return () => {
      cancelled = true
    }
  }, [port, enabled, generation])

  const save = useCallback<ScheduleTemplates['save']>(async (input) => {
    if (!port) return `Not saved. ${unavailableWords('Saving to the firm library')}`
    try {
      const res = await port.saveScheduleTemplate(input)
      if (!res.ok) return `Not saved: ${await errorText(res)}.`
      setGeneration((g) => g + 1)
      return null
    } catch (err) {
      console.error('[useScheduleTemplates] saving a firm schedule template failed', err)
      return `Not saved: ${err instanceof Error ? err.message : 'the connection failed'}. Try again.`
    }
  }, [port])

  const missing = enabled && !port ? `${unavailableWords("Your firm's templates")} The built-in templates still work.` : null
  const shown = missing ? 'error' : enabled && status === 'idle' ? 'loading' : status
  return useMemo(
    () => ({ status: shown, problem: missing ?? problem, canWrite: missing ? false : canWrite, firm, firmDefault: (kind: FormScheduleKind) => firm.find((t) => t.kind === kind && t.isDefault) ?? null, save }),
    [shown, missing, problem, canWrite, firm, save],
  )
}
