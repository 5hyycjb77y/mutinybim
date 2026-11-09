import { Flame } from 'lucide-react'
import { type BlockTableInput } from '@permitzip/bim-kernel'
import { GAS_TABLE_TITLE } from '@permitzip/bim-pack-plumbing'
import type { RibbonCommand } from '../ribbon/types'

/**
 * Sheet tab › Figures › Gas schedule: the live gas schedule (each gas load's
 * input, what it adds to the project, cfh at the gas system's heating value,
 * the counted total), beside Load summary, Ventilation and Pressurization.
 * The same block a report shows; frozen at issue like every block.
 */

export function gasScheduleCommand(place: (() => void) | null | undefined, editBlocked: string | null): RibbonCommand {
  return {
    id: 'sheet-gas-schedule',
    label: 'Gas schedule',
    icon: Flame,
    description: 'Put the live gas schedule on the sheet: every gas load and appliance with its input in MBH, what it adds to the project total, cfh at the gas heating value, and the counted total the meter is sized for; updated with every edit and frozen when the set is issued',
    keywords: ['gas', 'mbh', 'cfh', 'gas load', 'meter', 'appliance', 'schedule', 'table', 'block'],
    disabledReason: place ? editBlocked : 'Open a sheet to place a gas schedule: Views and sheets › a sheet.',
    ...(place ? { run: place } : {}),
    testId: 'ribbon-sheet-gas-schedule',
  }
}

/** The block Gas schedule places: the whole model, or one level's gas loads. Zones are refused (devices carry no zone). */
export function gasScheduleBlock(scope: Exclude<Extract<BlockTableInput, { scope: unknown }>['scope'], { kind: 'zone' }>) {
  return { template: 'Gas schedule', title: GAS_TABLE_TITLE, table: { kind: 'gas' as const, scope } }
}
