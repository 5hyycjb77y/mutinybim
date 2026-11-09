import { DEFAULT_FIELD_BLOCK_WIDTH_MM, KEYNOTE_FIELD, sheetPaper, type Command, type KeynoteRow, type KeynoteTableSnapshot, type Sheet, type Vec2 } from '@permitzip/bim-kernel'
import { builtinLibraryBundle, keynoteTableItemSchema, type KeynoteTableItem } from '@permitzip/bim-library'
import { newId, type SubmitCommand } from './types'

/**
 * Annotate › Keynote and Sheets › Keynote list. Keynote tables come from the
 * library in force: the built-in rows plus every add-on's starter tables
 * (each add-on that ships one). An element
 * keeps its key as its own `keynote` value; a keynote tag prints it; a sheet's
 * keynote list shows only the keys on the views placed on that sheet. Pure:
 * the canvas and the ribbon send what these build.
 */

/** The keynote tables in force, read with the library's own schema; one that doesn't read is left out and logged. */
function keynoteTables(): readonly KeynoteTableItem[] {
  const out: KeynoteTableItem[] = []
  for (const raw of builtinLibraryBundle().keynoteTables ?? []) {
    const parsed = keynoteTableItemSchema.safeParse(raw)
    if (parsed.success) out.push(parsed.data)
    else console.error('[keynotes] a keynote table in the library is not readable; it is left out', { problems: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) })
  }
  return out
}

export interface KeynoteChoice {
  readonly tableId: string
  readonly tableName: string
  readonly key: string
  readonly text: string
  readonly group?: string
}

/** Every keynote a person can pick, table by table, in each table's order. */
export function keynoteChoices(): readonly KeynoteChoice[] {
  const out: KeynoteChoice[] = []
  for (const table of keynoteTables()) {
    for (const k of table.keynotes) out.push({ tableId: table.id, tableName: table.name, key: k.key, text: k.text, ...(k.group ? { group: k.group } : {}) })
  }
  return out
}

/** One table for a sheet's list: every table in force, the first table's words winning when two use the same key. Null when there are none. */
export function keynoteTableForSheets(): KeynoteTableSnapshot | null {
  const tables = keynoteTables()
  if (tables.length === 0) return null
  const seen = new Set<string>()
  const keynotes: KeynoteRow[] = []
  for (const table of tables) {
    for (const k of table.keynotes) {
      if (seen.has(k.key)) continue
      seen.add(k.key)
      keynotes.push({ key: k.key, text: k.text, ...(k.group ? { group: k.group } : {}) })
    }
  }
  const only = tables.length === 1 ? tables[0] : undefined
  return { id: only ? only.id : 'library:keynote_table:in_force', revision: only ? only.revision : 1, name: only ? only.name : 'Keynotes', keynotes }
}

/** A key as typed: trimmed; null when empty or too long to read on a drawing. */
export function cleanKey(text: string): string | null {
  const key = text.trim()
  return key.length > 0 && key.length <= 24 ? key : null
}

/** One click with the Keynote tool: the element takes the key and gets a keynote tag at `head` (one undo). */
export function keynoteCommand(args: { readonly elementId: string; readonly key: string; readonly ownerId: string; readonly itemId: string; readonly head: Vec2; readonly leader: boolean }): Command {
  return {
    type: 'batch_edits',
    label: `Keynote ${args.key}`,
    commands: [
      { type: 'set_element_values', elementIds: [args.elementId], values: { [KEYNOTE_FIELD]: args.key } },
      { type: 'add_drawing_item', itemId: args.itemId, ownerId: args.ownerId, shape: 'tag', points: [args.head], tag: { elementId: args.elementId, template: 'fields', fields: [KEYNOTE_FIELD], leader: args.leader } },
    ],
  }
}

/** Where a keynote list lands when nobody picked a spot: the sheet's right side, near the top. */
export function keynoteListCorner(sheet: Sheet): Vec2 {
  const paper = sheetPaper(sheet)
  const width = Math.min(DEFAULT_FIELD_BLOCK_WIDTH_MM, paper.x)
  return { x: Math.round(paper.x - width - 60), y: Math.round(paper.y * 0.75) }
}

/** Sheets › Live table › Keynote list: the open sheet's list of the keynotes on its views. Returns the new item id, or why not. */
export function placeKeynoteList(sheet: Sheet, submit: SubmitCommand, at: Vec2 = keynoteListCorner(sheet)): { readonly itemId: string } | { readonly refusal: string } {
  const table = keynoteTableForSheets()
  if (!table) return { refusal: 'There are no keynote tables in this model yet: turn on an add-on that ships keynote tables, or add your firm’s in Settings › MutinyBIM library.' }
  const itemId = newId('blk')
  const refusal = submit({ type: 'add_field_block', itemId, sheetId: sheet.id, at, block: { template: 'Keynotes', title: 'KEYNOTES', table: { kind: 'keynotes', sheetId: sheet.id, table: { ...table, keynotes: [...table.keynotes] } } } }, 'place keynote list')
  return refusal ? { refusal } : { itemId }
}
