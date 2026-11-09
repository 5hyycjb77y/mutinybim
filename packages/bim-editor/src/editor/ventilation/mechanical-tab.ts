import { Cable, Network, PackagePlus, Route, Ruler } from 'lucide-react'
import { AIR_CONNECT_WORDS, SIZE_DUCTS_WORDS } from '@permitzip/bim-pack-mechanical/ui'
import { tradeTab } from '../ribbon/trade-tab'
import type { RibbonCommand, RibbonGroup, RibbonTab } from '../ribbon/types'

export interface MechanicalAction {
  readonly run: () => void
  /** Null when it runs; otherwise why not, in the operator's words. */
  readonly blocked: string | null
}

/** The Mechanical tab's actions (built by the Mechanical workflow host). */
export interface MechanicalRibbon {
  readonly routeDuct: MechanicalAction
  readonly placeEquipment: MechanicalAction
  /** Connect › To duct: the selected diffusers, grilles and units into the nearest duct of their system (a preview window, one undo). */
  readonly connectToDuct: MechanicalAction
  /** Analyze › Size ducts: every run of the selected air systems by each system's sizing rule (a preview window, one undo). */
  readonly sizeDucts: MechanicalAction
  /** Diagrams › Air schematic: the live air schematic view, drawn from the model's ducts. */
  readonly airSchematic: MechanicalAction
}

const cmd = (id: string, label: string, icon: RibbonCommand['icon'], description: string, a: MechanicalAction, keywords: readonly string[]): RibbonCommand => ({ id, label, icon, description, keywords: [...keywords], disabledReason: a.blocked, run: a.run, testId: `ribbon-mechanical-${id}` })

/** Mechanical: the same trade tab pattern as Electrical and Plumbing. Ventilation and Kitchen heat join Analyze from the add-on's commands. */
export function mechanicalTab(m: MechanicalRibbon, select: RibbonGroup): RibbonTab {
  return tradeTab({
    id: 'mechanical',
    label: 'Mechanical',
    select,
    create: [
      {
        id: 'mechanical-create',
        label: 'Create',
        commands: [
          cmd('route-duct', 'Route duct', Route, 'Draw duct: supply, return, exhaust, outdoor air. Fittings go in as you turn and branch; rated walls and tight ceilings are checked as you draw', m.routeDuct, ['duct', 'route', 'draw', 'supply', 'return', 'exhaust']),
          cmd('place-equipment', 'Equipment', PackagePlus, 'Place a unit, fan, diffuser or grille from the parts catalog', m.placeEquipment, ['rtu', 'ahu', 'fan', 'diffuser', 'grille', 'register', 'equipment']),
        ],
      },
    ],
    connect: { id: 'mechanical-connect', label: 'Connect', commands: [cmd('connect-to-duct', AIR_CONNECT_WORDS.label, Cable, AIR_CONNECT_WORDS.description, m.connectToDuct, AIR_CONNECT_WORDS.keywords)] },
    analyze: { id: 'mechanical-analyze', label: 'Analyze', commands: [cmd('size-ducts', SIZE_DUCTS_WORDS.label, Ruler, SIZE_DUCTS_WORDS.description, m.sizeDucts, SIZE_DUCTS_WORDS.keywords)] },
    documents: [
      {
        id: 'mechanical-diagrams',
        label: 'Diagrams',
        commands: [cmd('air-schematic', 'Air schematic', Network, 'Each air system from its unit through the mains and branches to every diffuser, with sizes and airflow, drawn live from the model; click a symbol to select it in the model', m.airSchematic, ['schematic', 'air', 'duct diagram', 'riser', 'cfm', 'diagram'])],
      },
    ],
  })
}

const NOTHING = (): void => undefined

/** The Mechanical tab while the Mechanical tools load (or failed): every command off, saying why. */
export function waitingRibbon(reason: string): MechanicalRibbon {
  const off = { run: NOTHING, blocked: reason }
  return { routeDuct: off, placeEquipment: off, connectToDuct: off, sizeDucts: off, airSchematic: off }
}

/** This add-on's tabs by the ids in its `ADDON_UI` (`tabsFrom`). */
export const TABS = { mechanical: mechanicalTab }
