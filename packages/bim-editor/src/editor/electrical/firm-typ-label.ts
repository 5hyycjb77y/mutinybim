import { firmTypLabelTemplate } from '@permitzip/bim-pack-electrical'
import type { EditorDataHost } from '@permitzip/bim-editor-host'
import { EditorServiceUnavailableError } from '@permitzip/bim-editor/host/unavailable'

/** The firm's published typical-label standard (a library tag type keyed `electrical.typ_label`), or null when the firm has none. */
export interface FirmTypLabel {
  readonly template: string
  readonly itemId: string
  readonly revision: number
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

export async function loadFirmTypLabelFrom(port: EditorDataHost['firmLibrary']): Promise<FirmTypLabel | null> {
  if (!port) throw new EditorServiceUnavailableError("The firm's typical-label standard")
  const res = await port.listOfType({ scope: 'firm', type: 'tag_type' })
  if (!res.ok) throw new Error(`the firm library answered ${res.status}`)
  const body: unknown = await res.json()
  const items = isRecord(body) && Array.isArray(body.items) ? body.items : null
  if (!items) throw new Error('the firm library sent no item list')
  for (const item of items) {
    if (!isRecord(item) || typeof item.key !== 'string' || !isRecord(item.definition) || typeof item.id !== 'string' || typeof item.revision !== 'number') continue
    const template = firmTypLabelTemplate({ key: item.key, definition: item.definition })
    if (template) return { template, itemId: item.id, revision: item.revision }
  }
  return null
}
