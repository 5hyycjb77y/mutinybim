import type { DesignLimit, DesignLimitRow, DesignLimitSources } from '@permitzip/bim-kernel/policy'
import type { EditorDataHost } from '@permitzip/bim-editor-host'
import { EditorServiceUnavailableError, unavailableWords } from '@permitzip/bim-editor/host/unavailable'

type LibraryPort = EditorDataHost['firmLibrary']
const LIBRARY = 'The firm library'

/** A limit the library holds in the scope being edited, with the revision a save starts from. */
export interface LibraryLimit {
  readonly limit: DesignLimit
  readonly revision: number
}

export interface DesignLimitRows {
  readonly rows: readonly DesignLimitRow[]
  /** This scope's own rows (what Change saves over and Put back removes). */
  readonly own: readonly LibraryLimit[]
  /** A band in words ("at most 8 ft/s"). */
  readonly band: (limit: Pick<DesignLimit, 'band' | 'unit'>) => string
}

function isLimit(value: unknown): value is DesignLimit {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.id === 'string' && typeof v.label === 'string' && typeof v.quantity === 'string' && typeof v.unit === 'string' && typeof v.band === 'object' && v.band !== null && typeof v.citation === 'object' && v.citation !== null && typeof v.appliesTo === 'object' && v.appliesTo !== null
}

async function listScope(port: LibraryPort, scope: string): Promise<LibraryLimit[]> {
  if (!port) throw new EditorServiceUnavailableError(LIBRARY)
  const res = await port.listOfType({ scope, type: 'design_limit' })
  if (!res.ok) throw new Error(`the library answered ${res.status}`)
  const body: unknown = await res.json()
  const items = typeof body === 'object' && body !== null && 'items' in body && Array.isArray(body.items) ? (body.items as unknown[]) : null
  if (!items) throw new Error('the library sent no item list')
  const out: LibraryLimit[] = []
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue
    const i = item as { limit?: unknown; revision?: unknown; deprecated?: unknown }
    if (i.deprecated === true || !isLimit(i.limit) || typeof i.revision !== 'number') continue
    out.push({ limit: i.limit, revision: i.revision })
  }
  return out
}

/** Every limit in force for a scope: the add-ons' defaults, the firm's rows, and (for `project:<id>`) the project's. */
export async function loadDesignLimitRowsFrom(port: LibraryPort, scope: string): Promise<DesignLimitRows> {
  const project = scope.startsWith('project:')
  const [policy, firm, own] = await Promise.all([import('@permitzip/bim-kernel/policy'), listScope(port, 'firm'), project ? listScope(port, scope) : Promise.resolve(null)])
  const rows = policy.designLimitRows({ firm: firm.map((f) => f.limit), project: own?.map((o) => o.limit) ?? [] })
  return { rows, own: own ?? firm, band: policy.bandWords }
}

/** The firm's and (with a project) the project's own limits, as route checks and lint read them. */
export async function loadDesignLimitSourcesFrom(port: LibraryPort, projectId: string | null): Promise<DesignLimitSources> {
  const [firm, project] = await Promise.all([listScope(port, 'firm'), projectId ? listScope(port, `project:${projectId}`) : Promise.resolve([])])
  return { firm: firm.map((f) => f.limit), project: project.map((p) => p.limit) }
}

export type PublishOutcome = { readonly ok: true } | { readonly ok: false; readonly message: string }

/** Save one limit as a library item revision (`baseRevision` 0 for a new one); `deprecated` puts it back to the default. */
export async function publishDesignLimitFrom(port: LibraryPort, scope: string, limit: DesignLimit, baseRevision: number, opts: { readonly deprecated?: boolean } = {}): Promise<PublishOutcome> {
  if (!port) return { ok: false, message: `${limit.label} wasn't saved. ${unavailableWords(LIBRARY)}` }
  const { designLimitItemBody } = await import('@permitzip/bim-library')
  const { setBy: _shownOnly, ...toSave } = limit
  const body = { ...designLimitItemBody(toSave, baseRevision + 1), ...(opts.deprecated ? { deprecated: true } : {}) }
  try {
    const res = await port.publish({ scope, item: { type: 'design_limit', body }, baseRevision })
    const answer: unknown = await res.json().catch((err: unknown) => {
      console.error('[design-limits] the publish answer was not JSON', err)
      return null
    })
    if (res.ok) return { ok: true }
    const message = typeof answer === 'object' && answer !== null && 'message' in answer && typeof answer.message === 'string' ? answer.message : `The library answered ${res.status}.`
    if (res.status === 409) return { ok: false, message: `Someone changed ${limit.label} while you were editing. Reload and try again. (${message})` }
    return { ok: false, message }
  } catch (err) {
    console.error('[design-limits] publishing a design limit failed', err)
    return { ok: false, message: `${limit.label} wasn't saved: the library couldn't be reached. Check your connection and try again.` }
  }
}

/** What a limit applies to, in words ("<discipline> · <system>"). */
export function appliesToWords(limit: Pick<DesignLimit, 'appliesTo'>): string {
  const a = limit.appliesTo
  const parts = [a.discipline, ...(a.systems ?? []), ...(a.services ?? []), ...(a.materials ?? []), ...(a.elementClasses ?? [])].filter((p): p is string => typeof p === 'string' && p.length > 0)
  return parts.length === 0 ? 'Everything' : parts.map((p) => p.replace(/^[a-z0-9]+\./, '').replace(/_/g, ' ')).join(' · ')
}
