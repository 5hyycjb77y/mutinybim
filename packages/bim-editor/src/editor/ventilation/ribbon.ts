import { Fan, Flame, TableProperties } from 'lucide-react'
import { DEFAULT_FIELD_BLOCK_WIDTH_MM, sheetPaper, type ElementId, type Sheet, type Vec2 } from '@permitzip/bim-kernel'
import type { RibbonCommand } from '../ribbon/types'
import { newId, type SubmitCommand } from '../views-sheets/types'
import { VENTILATION_TABLE_TITLE, ZONE_VENTILATION_TEMPLATE, ZONE_VENTILATION_TITLE, type VentilationScope } from './pack'

/**
 * Ribbon commands for ventilation, as shapes the ui builder mounts:
 * Mechanical › Analyze › Ventilation opens the panel;
 * Sheet tab › Figures › Ventilation table places the live table on the open
 * sheet, beside Load summary. Each carries the reason it is disabled.
 */

export function ventilationPanelCommand(tabId: string, open: (() => void) | null, blocked: string | null): RibbonCommand {
  return {
    id: `${tabId}-ventilation`,
    label: 'Ventilation',
    icon: Fan,
    description: 'Outdoor air and exhaust for every space (Vbz, Voz) under IMC and ASHRAE 62.1 side by side, the adopted code marked governing, and each zone against the unit that serves it',
    keywords: ['outdoor air', 'oa', 'vbz', 'voz', 'imc 403', 'ashrae 62.1', 'exhaust', 'ventilation schedule', 'fresh air'],
    disabledReason: open ? blocked : 'The model is still loading.',
    ...(open ? { run: open } : {}),
    testId: `ribbon-${tabId}-ventilation`,
  }
}

export function kitchenHeatPanelCommand(open: (() => void) | null, blocked: string | null): RibbonCommand {
  return {
    id: 'model-kitchen-heat',
    label: 'Kitchen heat…',
    icon: Flame,
    description: 'Heat each space gains from its kitchen equipment, from the firm’s or the project’s kitchen heat table with its citation, or where to add the table',
    keywords: ['kitchen', 'heat gain', 'fryer', 'range', 'appliance', 'sensible', 'latent', 'btu', 'lookup table', 'loads'],
    disabledReason: open ? blocked : 'The model is still loading.',
    ...(open ? { run: open } : {}),
    testId: 'ribbon-model-kitchen-heat',
  }
}

export function ventilationTableCommand(place: (() => void) | null | undefined, editBlocked: string | null): RibbonCommand {
  return {
    id: 'sheet-ventilation-table',
    label: 'Ventilation table',
    icon: TableProperties,
    description: 'Put the live ventilation table on the sheet: outdoor air and exhaust per space and zone under the governing code, updated with every edit and frozen when the set is issued',
    keywords: ['ventilation schedule', 'outdoor air', 'imc', 'ashrae 62.1', 'block', 'table', 'oa'],
    disabledReason: place ? editBlocked : 'Open a sheet to place a ventilation table: Views and sheets › a sheet.',
    ...(place ? { run: place } : {}),
    testId: 'ribbon-sheet-ventilation-table',
  }
}

/** Where a new table lands when nobody picked a spot: the top-left quarter, clear of the title block. */
export function ventilationTableCorner(sheet: Sheet): Vec2 {
  const paper = sheetPaper(sheet)
  return { x: Math.round(Math.max(0, Math.min(paper.x / 8, paper.x - DEFAULT_FIELD_BLOCK_WIDTH_MM))), y: Math.round(paper.y / 8) }
}

/** One table block for a scope (the block spec's `table`, blocks/table-spec.ts). */
export function ventilationTableBlock(scope: VentilationScope) {
  return { template: 'Ventilation table', title: VENTILATION_TABLE_TITLE, table: { kind: 'ventilation' as const, scope } }
}

/**
 * Sheet › Figures › Ventilation table, today: one zone's summary as an
 * ordinary field block (works once the ventilation field provider is
 * registered). Returns the new item id, or the refusal in words.
 */
export function placeZoneVentilation(sheet: Sheet, zoneId: ElementId, submit: SubmitCommand, at: Vec2 = ventilationTableCorner(sheet)): { readonly itemId: string } | { readonly refusal: string } {
  const itemId = newId('blk')
  const refusal = submit({ type: 'add_field_block', itemId, sheetId: sheet.id, at, block: { template: ZONE_VENTILATION_TEMPLATE, title: ZONE_VENTILATION_TITLE, subjectId: zoneId } }, 'place zone ventilation')
  return refusal ? { refusal } : { itemId }
}
