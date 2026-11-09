import { defaultStarterType, starterElementType, type BimElement, type StarterElementTypeRow } from '@permitzip/bim-kernel'
import type { ArchitectureTool } from './catalog'

/** A wall type's thickness, as the Architecture add-on stores it on the type. */
const TOTAL_THICKNESS_KEY = 'architecture.total_thickness'

/** The type an armed Wall, Door or Window tool draws with, and the size that type draws at. */
export interface ToolType {
  readonly typeId: string
  readonly name: string
  readonly thicknessMm?: number
  readonly openingSize?: { readonly widthMm: number; readonly heightMm: number }
}

function sizeOf(row: StarterElementTypeRow | null, type: BimElement | undefined): Omit<ToolType, 'typeId' | 'name'> {
  const own = type?.kind === 'element_type' ? type.values?.[TOTAL_THICKNESS_KEY] : undefined
  const thicknessMm = row?.size?.thicknessMm ?? (typeof own === 'number' && own > 0 ? own : undefined)
  const { widthMm, heightMm } = row?.size ?? {}
  return { ...(thicknessMm ? { thicknessMm } : {}), ...(widthMm && heightMm ? { openingSize: { widthMm, heightMm } } : {}) }
}

/**
 * The starter type the tool starts with (the add-ons' `toolDefault` for its
 * kind, a door's or window's for its variant), whether or not the model has
 * it yet: drawing with one the model lacks adds it. Null for tools with no
 * starter (floors, columns) or when no add-on in force ships one.
 */
export function toolTypeFor(elements: Readonly<Record<string, BimElement>>, tool: ArchitectureTool): ToolType | null {
  const variant = tool.mode === 'hosted' && tool.kind !== 'opening' ? tool.kind : undefined
  const kind = tool.mode === 'hosted' ? 'opening' : tool.kind
  if (tool.mode !== 'chain' && tool.mode !== 'rectangle' && variant === undefined) return null
  const row = defaultStarterType(kind, variant)
  if (!row) return null
  const inModel = elements[row.id]
  const name = inModel?.kind === 'element_type' ? inModel.name : row.name
  return { typeId: row.id, name, ...sizeOf(row, inModel) }
}

/** What a type is, in plain words, for Properties: a starter's own description, else null. */
export function typeDescription(typeId: string): string | null {
  return starterElementType(typeId)?.description ?? null
}
