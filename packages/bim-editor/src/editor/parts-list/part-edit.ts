import { partGroupName } from '@permitzip/bim-kernel'
import type { CatalogEntry } from '../model-session'
import { editableInPartEditor } from '../part-editor/draft'

/** Why a part's type can't open in the part editor, in plain words; null when it can. */
export function partEditBlockedReason(entry: CatalogEntry, canEdit: boolean): string | null {
  const name = partGroupName(entry.definition)
  if (!canEdit) return `You can't change parts in this model, so ${name} can't open in the part editor.`
  if (entry.definition.model === undefined) return `${name} is a simple shape with no part drawing to open. Use New part to draw your own.`
  if (!editableInPartEditor(entry.definition)) return `${name} is made by a script: run its script again to change it.`
  return null
}
