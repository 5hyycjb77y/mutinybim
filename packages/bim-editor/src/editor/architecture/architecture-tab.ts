import { Building, Columns3, DoorOpen, Footprints, Frame, Grid3x3, House, Layers, Minus, PanelTop, RectangleHorizontal, Ruler, Square, SquareDashed, Triangle } from 'lucide-react'
import type { ComponentType } from 'react'
import type { RibbonCommand, RibbonGroup, RibbonTab } from '../ribbon/types'
import { tradeTab } from '../ribbon/trade-tab'
import { BUILD_TOOLS, DATUM_TOOLS, type ArchitectureTool, type ArchitectureToolId } from './tools/catalog'

/** What the Architecture tab reads from its workflow: the armed tool, how to arm one, and why it can't. */
export interface ArchitectureRibbon {
  readonly tool: ArchitectureToolId | null
  readonly setTool: (id: ArchitectureToolId | null) => void
  /** Why nothing can be drawn (editing off, no plan open); null when it can. */
  readonly blocked: string | null
  /** Open the type dialog for the selection; null when nothing typed is selected. */
  readonly editType: (() => void) | null
  /** Why Edit type… can't open now (it needs no plan); absent: the tools' reason. */
  readonly editTypeWhy?: string | null
  /** Add a level (the Level tool); null when it can't open now. */
  readonly addLevel: (() => void) | null
  /** Why the Level tool can't open (it needs no plan); absent: the tools' reason. */
  readonly levelWhy?: string | null
}

/**
 * The Level tool from what the surface offers: it opens the surface's Add
 * level dialog, needs no open plan, and says why when editing is off, a
 * sheet is in front or the surface has no level dialog.
 */
export function levelButton(s: { readonly editBlocked: string | null; readonly modelToolsOff: boolean; readonly requestLevel?: () => void }): Pick<ArchitectureRibbon, 'addLevel' | 'levelWhy'> {
  const why = s.editBlocked ?? (s.modelToolsOff ? 'Add levels from a plan or the 3D view: open one from the Views and sheets panel' : s.requestLevel ? null : 'Add levels from Model › Levels on this surface')
  return { addLevel: why === null && s.requestLevel ? s.requestLevel : null, levelWhy: why }
}

const ICONS: Readonly<Record<ArchitectureToolId, ComponentType>> = {
  level: Layers,
  grid: Grid3x3,
  reference_plane: Minus,
  wall: RectangleHorizontal,
  wall_rectangle: Frame,
  door: DoorOpen,
  window: PanelTop,
  floor: Square,
  room: House,
  opening: SquareDashed,
  ceiling: Building,
  roof: Triangle,
  column: Columns3,
  stair: Footprints,
}

function toolCommand(r: ArchitectureRibbon, t: ArchitectureTool): RibbonCommand {
  if (t.mode === 'dialog') {
    return { id: `architecture.${t.id}`, label: t.label, icon: ICONS[t.id], description: t.description, disabledReason: r.addLevel ? null : (r.levelWhy ?? r.blocked ?? 'Add levels from Model › Levels on this surface'), ...(r.addLevel ? { run: r.addLevel } : {}), testId: `architecture-${t.id}` }
  }
  return {
    id: `architecture.${t.id}`,
    label: t.label,
    icon: ICONS[t.id],
    description: t.description,
    ...(t.shortcut ? { shortcut: t.shortcut } : {}),
    disabledReason: r.blocked,
    pressed: r.tool === t.id,
    run: () => r.setTool(r.tool === t.id ? null : t.id),
    testId: `architecture-${t.id}`,
  }
}

function architectureTab(r: ArchitectureRibbon, select: RibbonGroup): RibbonTab {
  const datums: RibbonGroup = { id: 'architecture.datums', label: 'Datums', commands: DATUM_TOOLS.map((t) => toolCommand(r, t)) }
  // Nine tools: the ribbon shows the first four and folds the rest under More.
  const build: RibbonGroup = { id: 'architecture.build', label: 'Build', commands: BUILD_TOOLS.map((t) => toolCommand(r, t)) }
  const types: RibbonGroup = {
    id: 'architecture.types',
    label: 'Types',
    commands: [{ id: 'architecture.edit_type', label: 'Edit type…', icon: Ruler, description: "Change the selection's type: layers, thickness, ratings", disabledReason: r.editType ? null : (r.editTypeWhy ?? r.blocked ?? 'Select one wall, door or window that has a type'), ...(r.editType ? { run: r.editType } : {}), testId: 'architecture-edit-type' }],
  }
  return tradeTab({ id: 'architecture', label: 'Architecture', select, create: [datums, build], design: types })
}

const NOTHING = (): void => {}

/** The tab while the workflow loads or can't run: every tool says why. */
export function waitingRibbon(reason: string): ArchitectureRibbon {
  return { tool: null, setTool: NOTHING, blocked: reason, editType: null, addLevel: null }
}

export const TABS = { architecture: architectureTab }
