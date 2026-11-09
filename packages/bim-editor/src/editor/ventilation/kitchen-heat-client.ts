import { useCallback, useEffect, useMemo, useState } from 'react'
import { lookupTableSchema, type LookupTable } from '@permitzip/bim-kernel/policy'
import type { EditorDataHost } from '@permitzip/bim-editor-host'
import { EditorServiceUnavailableError } from '@permitzip/bim-editor/host/unavailable'

type LibraryPort = EditorDataHost['firmLibrary']

/** The lookup tables kitchen heat reads: the firm's, and the project's when one is open. */
export interface KitchenHeatTables {
  readonly status: 'loading' | 'ready' | 'error'
  readonly firm: readonly LookupTable[]
  readonly project: readonly LookupTable[]
  /** What went wrong and what to do, in words; null unless `status` is error. */
  readonly error: string | null
  readonly retry: () => void
}

async function listTables(port: LibraryPort, scope: string): Promise<LookupTable[]> {
  if (!port) throw new EditorServiceUnavailableError('The firm library')
  const res = await port.listOfType({ scope, type: 'lookup_table' })
  if (!res.ok) throw new Error(`the library answered ${res.status}`)
  const body: unknown = await res.json()
  const items = typeof body === 'object' && body !== null && 'items' in body && Array.isArray(body.items) ? (body.items as unknown[]) : null
  if (!items) throw new Error('the library sent no item list')
  const out: LookupTable[] = []
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue
    const i = item as { deprecated?: unknown; table?: unknown; name?: unknown }
    if (i.deprecated === true) continue
    const parsed = lookupTableSchema.safeParse(i.table)
    if (!parsed.success) throw new Error(`the library listed the table ${typeof i.name === 'string' ? `'${i.name}'` : ''} without its rows`)
    out.push(parsed.data)
  }
  return out
}

/** Reads the firm's (and the project's) lookup tables once per open; `retry` reads them again. */
export function useKitchenHeatTablesFrom(port: LibraryPort, projectId: string | null | undefined): KitchenHeatTables {
  const [attempt, setAttempt] = useState(0)
  const key = `${projectId ?? ''}#${attempt}`
  const [read, setRead] = useState<{ readonly key: string } & Omit<KitchenHeatTables, 'retry'>>({ key: '', status: 'loading', firm: [], project: [], error: null })
  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  useEffect(() => {
    let live = true
    Promise.all([listTables(port, 'firm'), projectId ? listTables(port, `project:${projectId}`) : Promise.resolve([])])
      .then(([firm, project]) => {
        if (live) setRead({ key, status: 'ready', firm, project, error: null })
      })
      .catch((err: unknown) => {
        console.error('[kitchen-heat] reading the lookup tables failed', { projectId, err })
        if (live) setRead({ key, status: 'error', firm: [], project: [], error: `Couldn't read the kitchen heat tables: ${err instanceof Error ? err.message : String(err)}. Try again, or check the firm library › Lookup tables.` })
      })
    return () => {
      live = false
    }
  }, [port, projectId, key])
  return useMemo(() => {
    if (read.key !== key) return { status: 'loading', firm: [], project: [], error: null, retry }
    const { key: _read, ...tables } = read
    return { ...tables, retry }
  }, [read, key, retry])
}
