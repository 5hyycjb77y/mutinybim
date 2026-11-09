import { Wind } from 'lucide-react'
import { type BlockTableInput, type Sheet, type Vec2 } from '@permitzip/bim-kernel'
import { PRESSURIZATION_TABLE_TITLE } from '@permitzip/bim-pack-mechanical'
import type { RibbonCommand } from '../ribbon/types'
import { newId, type SubmitCommand } from '../views-sheets/types'
import { ventilationTableCorner } from '../ventilation/ribbon'

/**
 * Sheet tab › Figures › Pressurization table: places the live pressurization
 * table (each zone and the building, exhaust, makeup air, outdoor air, net and
 * the makeup-air load) on the open sheet, beside Load summary and Ventilation
 * table. Frozen at issue like every block.
 */

export function pressurizationTableCommand(place: (() => void) | null | undefined, editBlocked: string | null): RibbonCommand {
  return {
    id: 'sheet-pressurization-table',
    label: 'Pressurization table',
    icon: Wind,
    description: 'Put the live building pressurization table on the sheet: exhaust fans, makeup air and unit outdoor air per zone and for the building, positive or negative against the target, and the untempered makeup air load; updated with every edit and frozen when the set is issued',
    keywords: ['pressurization', 'air balance', 'exhaust', 'makeup air', 'mua', 'kef', 'positive', 'negative', 'building pressure', 'table', 'block'],
    disabledReason: place ? editBlocked : 'Open a sheet to place a pressurization table: Views and sheets › a sheet.',
    ...(place ? { run: place } : {}),
    testId: 'ribbon-sheet-pressurization-table',
  }
}

/** The block a Pressurization table places: the whole building, or one level's zones. */
export function pressurizationTableBlock(scope: Extract<BlockTableInput, { scope: unknown }>['scope']) {
  return { template: 'Pressurization table', title: PRESSURIZATION_TABLE_TITLE, table: { kind: 'pressurization' as const, scope } }
}

/** Places a table block on the sheet; returns the new item id, or the refusal in words. */
export function placeTableBlock(sheet: Sheet, block: { readonly template: string; readonly title: string; readonly table: BlockTableInput }, submit: SubmitCommand, at: Vec2 = ventilationTableCorner(sheet)): { readonly itemId: string } | { readonly refusal: string } {
  const itemId = newId('blk')
  const refusal = submit({ type: 'add_field_block', itemId, sheetId: sheet.id, at, block }, `place ${block.table.kind} table`)
  return refusal ? { refusal } : { itemId }
}
