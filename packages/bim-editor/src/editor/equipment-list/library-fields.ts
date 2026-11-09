'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { sharedFieldItemSchema, type SharedFieldItem } from '@permitzip/bim-library'
import type { EditorDataAnswer, EditorDataHost } from '@permitzip/bim-editor-host'
import { useOptionalEditorHost } from '@permitzip/bim-editor/host'
import { unavailableWords } from '@permitzip/bim-editor/host/unavailable'
import { builtinEquipmentParameters, equipmentParameterOf, layerParameters, type EquipmentParameter, type ParameterSource } from './parameters'

/**
 * The firm's and this project's equipment fields, over the built-in baseline
 * (decision 3, NEXT-BATCH §8: anyone who can edit the model adds project
 * columns; only library editors add firm columns). Read from
 * `GET /api/bim/library/fields?projectId=` and published through
 * `POST /api/bim/library/publish`; the database's row rules decide who may
 * publish where. When the firm and project fields can't be read the list
 * still has the built-in columns, and says so.
 */

export type LibraryLoad = 'idle' | 'loading' | 'ready' | 'error'

export interface PublishAllowed {
  readonly allowed: boolean
  /** Why not, in words a person can act on. */
  readonly reason?: string
}

export interface EquipmentLibrary {
  readonly parameters: readonly EquipmentParameter[]
  readonly status: LibraryLoad
  /** What went wrong reading the firm and project fields; null when nothing did. */
  readonly error: string | null
  readonly project: PublishAllowed
  readonly retry: () => void
  /** Publish a new project field and add it to `parameters`. */
  readonly addProjectField: (input: NewFieldInput) => Promise<{ readonly ok: true; readonly parameter: EquipmentParameter } | { readonly ok: false; readonly message: string }>
}

export type NewFieldType = 'text' | 'yes_no' | 'number'

export interface NewFieldInput {
  readonly label: string
  readonly type: NewFieldType
  /** For a number: one of `NEW_FIELD_UNITS`. */
  readonly unit?: string
}

/** Units a new number column may use: the ones a part parameter stores as typed. */
export const NEW_FIELD_UNITS: readonly { readonly unit: NonNullable<SharedFieldItem['unit']>; readonly kind: NonNullable<SharedFieldItem['kind']>; readonly label: string }[] = [
  { unit: '1', kind: 'dimensionless', label: 'No unit' },
  { unit: 'V', kind: 'voltage', label: 'Volts (V)' },
  { unit: 'A', kind: 'current', label: 'Amps (A)' },
  { unit: 'VA', kind: 'power_apparent', label: 'VA' },
  { unit: 'kW', kind: 'power_real', label: 'kW' },
  { unit: 'hp', kind: 'power_mechanical', label: 'Horsepower (hp)' },
  { unit: 'Btu/h', kind: 'thermal_power', label: 'Btu/h' },
  { unit: 'cfm', kind: 'flow_air', label: 'CFM' },
  { unit: 'gpm', kind: 'flow_liquid', label: 'GPM' },
  { unit: 'psi', kind: 'pressure', label: 'psi' },
  { unit: 'lb', kind: 'mass', label: 'Pounds (lb)' },
]

/** A label as a parameter name: "Hood ID" → `hood_id`. Null when nothing usable is left. */
export function parameterNameOf(label: string): string | null {
  const name = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^(\d)/, 'f_$1')
    .slice(0, 60)
  return /^[a-z][a-z0-9_]*$/.test(name) ? name : null
}

/** The shared-field item a new project column publishes, or why it can't. */
export function newProjectFieldItem(projectId: string, input: NewFieldInput, taken: ReadonlySet<string>): { readonly item: SharedFieldItem } | { readonly refused: string } {
  const label = input.label.trim()
  if (label === '') return { refused: 'Give the column a name (Hood ID).' }
  if (label.length > 80) return { refused: 'Keep the name to 80 characters.' }
  const name = parameterNameOf(label)
  if (!name) return { refused: 'Use letters or digits in the name.' }
  if (taken.has(name)) return { refused: `${label} is already a column; pick it from the list instead.` }
  const base = { id: `project:${projectId}:field:${name}`.slice(0, 200), revision: 1, key: `param.${name}`, label, appliesTo: ['mep.equipment', 'mep.plumbing_fixture'], group: 'Project', editable: true, storage: { kind: 'parameter' as const, scope: 'instance' as const, name } }
  if (input.type === 'text') return { item: { ...base, valueType: 'text' } }
  if (input.type === 'yes_no') return { item: { ...base, valueType: 'boolean' } }
  const unit = NEW_FIELD_UNITS.find((u) => u.unit === input.unit)
  if (!unit) return { refused: 'Choose the unit the number is in.' }
  return { item: { ...base, valueType: 'quantity', kind: unit.kind, unit: unit.unit } }
}

interface FieldsBody {
  readonly fields: readonly { readonly scope: string; readonly item: unknown }[]
  readonly project?: PublishAllowed
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function isFieldsBody(v: unknown): v is FieldsBody {
  return isRecord(v) && Array.isArray(v.fields) && v.fields.every((f) => isRecord(f) && typeof f.scope === 'string')
}

function sourceOf(scope: string): ParameterSource {
  if (scope === 'firm') return 'firm'
  if (scope.startsWith('project:')) return 'project'
  return 'builtin'
}

async function errorText(res: EditorDataAnswer): Promise<string> {
  const body: unknown = await res.json().catch((err: unknown) => {
    console.error('[equipment-list] reading the library refusal failed', err)
    return null
  })
  if (isRecord(body) && typeof body.error === 'string') return body.error
  if (isRecord(body) && typeof body.message === 'string') return body.message
  return `The library answered HTTP ${res.status}.`
}

/** Parameters from the stored fields; an item that no longer reads is named in the log and left out. */
export function parametersFromBody(body: FieldsBody): EquipmentParameter[] {
  const out: EquipmentParameter[] = []
  for (const f of body.fields) {
    const parsed = sharedFieldItemSchema.safeParse(f.item)
    if (!parsed.success) {
      console.error('[equipment-list] a library field no longer reads; it is left out of the list', { scope: f.scope, issues: parsed.error.issues.slice(0, 3) })
      continue
    }
    const p = equipmentParameterOf(parsed.data, sourceOf(f.scope))
    if (p) out.push(p)
  }
  return out
}

const NO_PROJECT: PublishAllowed = { allowed: false, reason: 'Open the Equipment list from a project’s Building Model to add project columns.' }

const FIELDS = 'Firm and project columns'

export function useEquipmentLibraryFrom(port: EditorDataHost['firmLibrary'], projectId: string | null | undefined): EquipmentLibrary {
  const capabilities = useOptionalEditorHost()?.capabilities ?? null
  const builtin = useMemo(() => builtinEquipmentParameters(), [])
  const [stored, setStored] = useState<readonly EquipmentParameter[]>([])
  const [added, setAdded] = useState<readonly EquipmentParameter[]>([])
  const [status, setStatus] = useState<LibraryLoad>(projectId ? 'loading' : 'idle')
  const [error, setError] = useState<string | null>(null)
  const [project, setProject] = useState<PublishAllowed>(NO_PROJECT)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!projectId || !port) return
    let live = true
    port
      .fields({ projectId })
      .then(async (res) => {
        if (!res.ok) throw new Error(await errorText(res))
        const body: unknown = await res.json()
        if (!isFieldsBody(body)) throw new Error('The library fields came back in an unexpected shape.')
        if (!live) return
        setStored(parametersFromBody(body))
        setProject(body.project ?? { allowed: false, reason: "This project's library can't be published to from here." })
        setError(null)
        setStatus('ready')
      })
      .catch((err: unknown) => {
        console.error('[equipment-list] loading firm and project fields failed', { projectId, err })
        if (!live) return
        setError(`Firm and project columns couldn't be loaded (${err instanceof Error ? err.message : 'the connection dropped'}). The built-in columns still work; try again.`)
        setStatus('error')
      })
    return () => {
      live = false
    }
  }, [port, projectId, attempt])

  const parameters = useMemo(() => layerParameters([builtin, stored, added]), [builtin, stored, added])
  const retry = useCallback(() => {
    setStatus('loading')
    setAttempt((n) => n + 1)
  }, [])

  const addProjectField = useCallback<EquipmentLibrary['addProjectField']>(
    async (input) => {
      if (!projectId) return { ok: false, message: NO_PROJECT.reason ?? '' }
      const made = newProjectFieldItem(projectId, input, new Set(parameters.map((p) => p.name)))
      if ('refused' in made) return { ok: false, message: made.refused }
      if (!port) return { ok: false, message: `${unavailableWords('Saving a project column', capabilities)} Nothing was added.` }
      try {
        const res = await port.publish({ scope: `project:${projectId}`, item: { type: 'field', body: made.item }, baseRevision: 0 })
        const body: unknown = await res.json().catch((err: unknown) => {
          console.error('[equipment-list] reading the publish answer failed', err)
          return null
        })
        if (!res.ok || !isRecord(body) || body.ok !== true) {
          const message = isRecord(body) && typeof body.message === 'string' ? body.message : isRecord(body) && typeof body.error === 'string' ? body.error : `Saving the column failed (HTTP ${res.status}).`
          return { ok: false, message: `${message} Nothing was added.` }
        }
        const parameter = equipmentParameterOf(made.item, 'project')
        if (!parameter) return { ok: false, message: 'The column was saved but is not a part value; ask for help.' }
        setAdded((a) => [...a, parameter])
        return { ok: true, parameter }
      } catch (err) {
        console.error('[equipment-list] publishing a project field failed', { projectId, err })
        return { ok: false, message: `Saving the column failed (${err instanceof Error ? err.message : 'the connection dropped'}). Nothing was added; try again.` }
      }
    },
    [port, capabilities, projectId, parameters],
  )

  const missing = projectId && !port ? `${unavailableWords(FIELDS, capabilities)} The built-in columns still work.` : null
  const shown: LibraryLoad = !projectId ? 'idle' : missing ? 'error' : status === 'idle' ? 'loading' : status
  return { parameters, status: shown, error: projectId ? (missing ?? error) : null, project: projectId ? project : NO_PROJECT, retry, addProjectField }
}
