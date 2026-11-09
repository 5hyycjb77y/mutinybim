import { DEFAULT_FIELD_BLOCK_WIDTH_MM, LOAD_SUMMARY_TEMPLATE, LOAD_SUMMARY_TITLE, sheetPaper, type Sheet, type Vec2 } from '@permitzip/bim-kernel'
import { newId, type SubmitCommand } from '../views-sheets/types'

/** Where a new block lands when nobody picked a spot: centred across the sheet, halfway down. */
export function loadSummaryCorner(sheet: Sheet): Vec2 {
  const paper = sheetPaper(sheet)
  const width = Math.min(DEFAULT_FIELD_BLOCK_WIDTH_MM, paper.x)
  return { x: Math.round((paper.x - width) / 2), y: Math.round(paper.y / 2) }
}

/**
 * Sheet tab › Figures › Load summary: place the live electrical load summary
 * on the open sheet. Returns the new item id, or the refusal in words.
 */
export function placeLoadSummary(sheet: Sheet, submit: SubmitCommand, at: Vec2 = loadSummaryCorner(sheet)): { readonly itemId: string } | { readonly refusal: string } {
  const itemId = newId('blk')
  const refusal = submit({ type: 'add_field_block', itemId, sheetId: sheet.id, at, block: { template: LOAD_SUMMARY_TEMPLATE, title: LOAD_SUMMARY_TITLE } }, 'place load summary')
  return refusal ? { refusal } : { itemId }
}

/**
 * Sheet tab › Figures › Calculation: place a live calculation sheet (a
 * registered template, for the selected element when the template asks for
 * one) on the open sheet. Returns the new item id, or the refusal in words.
 */
export function placeCalculation(sheet: Sheet, submit: SubmitCommand, template: { readonly id: string; readonly label: string }, subjectId: string | null, at: Vec2 = loadSummaryCorner(sheet)): { readonly itemId: string } | { readonly refusal: string } {
  const itemId = newId('blk')
  const block = { template: template.label, title: template.label.toUpperCase(), ...(subjectId ? { subjectId } : {}), calc: { template: template.id } }
  const refusal = submit({ type: 'add_field_block', itemId, sheetId: sheet.id, at, block }, `place ${template.label.toLowerCase()} calculation`)
  return refusal ? { refusal } : { itemId }
}
