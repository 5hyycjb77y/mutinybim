'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { CalcRegistry, ProjectCodeAdoption } from '@permitzip/bim-calc'
import type { planAutoSize } from '@permitzip/bim-pack-plumbing/host'
import { loadAddOns, requireAddOns } from '../../contracts/building-model/add-ons'
import type { Command, ModelState } from '@permitzip/bim-kernel'
import type { EditorDataHost } from '@permitzip/bim-editor-host'
import { unavailableWords } from '@permitzip/bim-editor/host/unavailable'

let registry: CalcRegistry | null = null

export interface ProjectPlumbingCodes {
  readonly plumbing: ProjectCodeAdoption | null
  readonly fuelGas: ProjectCodeAdoption | null
  /** Why the Code Study couldn't be read, in the operator's words; null when it was. */
  readonly problem: string | null
  readonly loading: boolean
}

/** The project's plumbing and fuel gas codes from its Code Study (filed under any discipline). */
export function useProjectPlumbingCodesFrom(port: EditorDataHost['codeAdoption'], projectId: string | undefined): ProjectPlumbingCodes {
  const [state, setState] = useState<ProjectPlumbingCodes>({ plumbing: null, fuelGas: null, problem: null, loading: projectId !== undefined })
  useEffect(() => {
    if (!projectId || !port) return
    let cancelled = false
    port
      .read({ projectId })
      .then(async (res) => {
        if (res.status === 401 || res.status === 403) throw new Error("you can't read this project's Code Study")
        if (!res.ok) throw new Error(`Code Study answered HTTP ${res.status}`)
        const body: unknown = await res.json()
        const rows = typeof body === 'object' && body !== null && 'adopted_codes' in body && Array.isArray(body.adopted_codes) ? body.adopted_codes : []
        const typed = rows.flatMap((r: unknown) => {
          if (typeof r !== 'object' || r === null) return []
          const o = r as Record<string, unknown>
          return typeof o.code_name === 'string' && typeof o.edition === 'string' && typeof o.status === 'string' ? [{ code_name: o.code_name, edition: o.edition, status: o.status }] : []
        })
        const { plumbing } = await loadAddOns()
        if (!cancelled) setState({ plumbing: plumbing.plumbingAdoptionFrom(typed), fuelGas: plumbing.fuelGasAdoptionFrom(typed), problem: null, loading: false })
      })
      .catch((err: unknown) => {
        console.error('[useProjectPlumbingCodes] reading the project Code Study failed', { projectId, err })
        if (!cancelled) setState({ plumbing: null, fuelGas: null, problem: `The plumbing code couldn't be read from the Code Study (${err instanceof Error ? err.message : String(err)}).`, loading: false })
      })
    return () => {
      cancelled = true
    }
  }, [port, projectId])
  if (projectId && !port) return { plumbing: null, fuelGas: null, problem: unavailableWords("The project's Code Study"), loading: false }
  return state
}

/**
 * Auto-sizing as you model: after each edit the person saves here, every
 * pipe system set to auto (its own setting, else the project's) gets the
 * sizes its calc proposes, each system as its own undoable "Auto-sized …"
 * edit. Systems on check are never touched. Sizing edits and undo don't
 * trigger it, so it never fights the person.
 */
export function useAutoSizeFrom(port: EditorDataHost['codeAdoption'], projectId: string | undefined, submit: (command: Command, undoLabel?: string) => string | null): (command: Command, model: ModelState) => void {
  const codes = useProjectPlumbingCodesFrom(port, projectId)
  const codesRef = useRef(codes)
  const submitRef = useRef(submit)
  useEffect(() => {
    codesRef.current = codes
    submitRef.current = submit
  })
  /** Each "couldn't auto-size" reason once per session, not after every edit. */
  const told = useRef(new Set<string>())
  return useCallback((command: Command, model: ModelState) => {
    const { plumbing } = requireAddOns()
    if (plumbing.isAutoSizeExempt(command.type)) return
    const c = codesRef.current
    if (c.loading) return
    let plan: ReturnType<typeof planAutoSize>
    try {
      registry ??= requireAddOns().calc.builtinCalcRegistry()
      plan = plumbing.planAutoSize(registry, model, { projectAdoptions: { plumbing: c.plumbing, fuel_gas: c.fuelGas } }, { idPrefix: `auto-r${model.revision}` })
    } catch (err) {
      console.error('[useAutoSize] sizing after an edit failed', { command: command.type, err })
      toast.error(`Auto-sizing failed: ${err instanceof Error ? err.message : String(err)}. Sizes were not changed.`)
      return
    }
    for (const edit of plan.edits) {
      const refusal = submitRef.current(edit.command, edit.command.label)
      if (refusal) toast.error(`Auto-sizing ${edit.systemName} wasn't saved: ${refusal}`)
      else toast(`${edit.command.label}. Undo puts the drawn sizes back.`)
    }
    for (const s of plan.skipped) {
      const key = `${s.systemId}:${s.reason}`
      if (told.current.has(key)) continue
      told.current.add(key)
      toast.warning(`Auto-sizing is on for ${s.systemName}, but it couldn't be sized: ${c.problem ?? s.reason}`)
    }
  }, [])
}
