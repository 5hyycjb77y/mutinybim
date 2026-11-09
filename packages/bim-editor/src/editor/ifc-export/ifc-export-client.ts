'use client'

import type { z } from 'zod'
import type { EditorDataAnswer, EditorDataHost } from '@permitzip/bim-editor-host'
import { EditorServiceUnavailableError } from '@permitzip/bim-editor/host/unavailable'
import { ifcExportDownloadSchema, ifcExportListSchema, ifcExportViewSchema, type IfcExportView } from '../../contracts/building-model/ifc-export-contract'

/** The browser's side of Export IFC (the host's `ifcExport` port). Every answer is checked against the shared contract. */

type IfcExportPort = EditorDataHost['ifcExport']
const EXPORT = 'Export IFC'

function portOf(port: IfcExportPort): NonNullable<IfcExportPort> {
  if (!port) throw new EditorServiceUnavailableError(EXPORT)
  return port
}

function errorText(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null
  const detail: unknown = Reflect.get(body, 'detail')
  const error: unknown = Reflect.get(body, 'error')
  if (typeof detail === 'string' && detail) return detail
  return typeof error === 'string' && error ? error : null
}

async function answer<T>(res: EditorDataAnswer, schema: z.ZodType<T>, doing: string): Promise<T> {
  const body: unknown = await res.json().catch((err: unknown) => {
    console.error(`[ifc-export-client] ${doing}: the answer wasn't readable`, err)
    return null
  })
  if (!res.ok) throw new Error(errorText(body) ?? `${doing} failed (HTTP ${res.status}). Try again.`)
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    console.error(`[ifc-export-client] ${doing}: unexpected answer`, parsed.error.issues.slice(0, 3))
    throw new Error(`${doing}: the server's answer couldn't be read. Reload and try again.`)
  }
  return parsed.data
}

export async function fetchIfcExportsFrom(port: IfcExportPort, projectId: string): Promise<IfcExportView[]> {
  return (await answer(await portOf(port).list({ projectId }), ifcExportListSchema, 'Loading IFC exports')).exports
}

export async function startIfcExportFrom(port: IfcExportPort, projectId: string, modelId: string): Promise<IfcExportView> {
  const res = await portOf(port).start({ projectId, modelId })
  return answer(res, ifcExportViewSchema, 'Exporting IFC')
}

export async function ifcExportDownloadUrlFrom(port: IfcExportPort, projectId: string, artifactId: string): Promise<string> {
  return (await answer(await portOf(port).download({ projectId, artifactId }), ifcExportDownloadSchema, 'Getting the IFC download')).url
}
