'use client'

import { useEffect, useMemo, useState } from 'react'
import { NEC_EDITIONS, resolveNecEdition, type NecEdition, type NecEditionYear } from '@permitzip/bim-calc'
import { necElectricalRules, CONNECTED_LOAD_ONLY, ElectricalLoadEngine, type ElectricalRules } from '@permitzip/bim-pack-electrical/host'
import type { EditorDataHost } from '@permitzip/bim-editor-host'
import { unavailableWords } from '@permitzip/bim-editor/host/unavailable'

export { NEC_EDITIONS }

/** The project's adopted electrical code as Code Study records it (confirmed first). */
interface Adoption {
  readonly codeName: string
  readonly edition: string
  readonly status: 'confirmed' | 'unconfirmed'
}

function adoptionFrom(body: unknown): Adoption | null {
  if (typeof body !== 'object' || body === null || !('adopted_codes' in body) || !Array.isArray(body.adopted_codes)) return null
  const rows = body.adopted_codes.flatMap((r: unknown): Adoption[] => {
    if (typeof r !== 'object' || r === null) return []
    const row = r as Record<string, unknown>
    if (row.discipline !== 'electrical' || typeof row.code_name !== 'string' || typeof row.edition !== 'string') return []
    return row.status === 'confirmed' || row.status === 'unconfirmed' ? [{ codeName: row.code_name, edition: row.edition, status: row.status }] : []
  })
  return rows.find((r) => r.status === 'confirmed') ?? rows[0] ?? null
}

export interface NecRules {
  /** One engine per open model and edition; it reuses unchanged panels' loads between edits. */
  readonly engine: ElectricalLoadEngine
  /** The edition the totals use, for sizing calcs (feeder types); null when there is none. */
  readonly necEdition: NecEdition | null
  /** "NEC 2023 (Code Study: VA USBC 2021)", or why the totals are connected loads only. */
  readonly label: string
  /** Where the edition came from: the project's Code Study, the person's pick here, or nowhere (connected loads only). */
  readonly source: 'project' | 'picked' | 'none'
  readonly picked: NecEditionYear | null
  /** The edition the totals use (project or picked); null when connected loads only. */
  readonly edition: NecEditionYear | null
  readonly pick: (edition: NecEditionYear | null) => void
  /** Code Study couldn't be read; said in the panel view. */
  readonly problem: string | null
}

/**
 * The NEC rules the panel view totals under: the project's Code Study edition,
 * else the edition the person picks in the panel view (this tab only: a view
 * choice, not project data), else connected loads only, labelled as such.
 */
export function useNecRulesFrom(port: EditorDataHost['codeAdoption'], projectId: string): NecRules {
  const [adoption, setAdoption] = useState<Adoption | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [picked, setPicked] = useState<NecEditionYear | null>(null)

  useEffect(() => {
    if (!port) return
    let cancelled = false
    port
      .read({ projectId })
      .then(async (res) => {
        if (res.status === 401 || res.status === 403) throw new Error("you can't read this project's Code Study")
        if (!res.ok) throw new Error(`Code Study answered HTTP ${res.status}`)
        const found = adoptionFrom(await res.json())
        if (!cancelled) setAdoption(found)
      })
      .catch((err: unknown) => {
        console.error('[useNecRules] reading the project Code Study failed', { projectId, err })
        if (!cancelled) setProblem(`The NEC edition couldn't be read from the Code Study (${err instanceof Error ? err.message : String(err)}). Pick it here.`)
      })
    return () => {
      cancelled = true
    }
  }, [port, projectId])

  const missing = port ? null : `${unavailableWords("The project's Code Study")} Pick the NEC edition here.`
  return useMemo(() => {
    const resolved = resolveNecEdition({ ...(picked ? { necEdition: picked } : {}), projectAdoption: adoption })
    const rules: ElectricalRules = resolved.ok ? necElectricalRules(resolved.edition) : CONNECTED_LOAD_ONLY
    const source = picked ? 'picked' : resolved.ok ? 'project' : 'none'
    const label = resolved.ok
      ? `NEC ${resolved.edition.edition}${source === 'project' && adoption ? ` (Code Study: ${adoption.codeName} ${adoption.edition}${adoption.status === 'unconfirmed' ? ', not yet confirmed' : ''})` : ' (picked here)'}`
      : 'Connected loads only: no NEC edition is recorded in the Code Study. Pick one to see NEC demand.'
    const edition = resolved.ok ? (NEC_EDITIONS.find((e) => e === resolved.edition.edition) ?? null) : null
    return { engine: new ElectricalLoadEngine(rules), necEdition: resolved.ok ? resolved.edition : null, label, source, picked, edition, pick: setPicked, problem: missing ?? problem }
  }, [adoption, picked, problem, missing])
}
