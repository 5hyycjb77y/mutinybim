/**
 * The Architecture tools: what each draws and how it is drawn. The order is
 * the Build group's: the most used first, so they stay visible and the rest
 * fold under More.
 */

export type ArchitectureToolId = 'level' | 'grid' | 'reference_plane' | 'wall' | 'wall_rectangle' | 'door' | 'window' | 'floor' | 'room' | 'opening' | 'ceiling' | 'roof' | 'column' | 'stair'

/** `room`: click inside closed walls (a space bounded by them). `rectangle`: two opposite corners make a closed chain of four. */
export type ToolMode = 'chain' | 'rectangle' | 'line' | 'area' | 'point' | 'hosted' | 'room' | 'dialog'

export interface ArchitectureTool {
  readonly id: ArchitectureToolId
  readonly label: string
  readonly description: string
  readonly mode: ToolMode
  /** The record kind it makes (`create_element`'s kind; `ceiling` uses its own command). */
  readonly kind: string
  /** What the hint bar calls one. */
  readonly noun: string
  /** Two-key tip, also shown in search. */
  readonly shortcut?: string
}

export const DATUM_TOOLS: readonly ArchitectureTool[] = [
  { id: 'level', label: 'Level', description: 'Add a level at a height', mode: 'dialog', kind: 'level', noun: 'level' },
  { id: 'grid', label: 'Grid', description: 'Draw a grid line; labels go A, B, C… and 1, 2, 3… by themselves', mode: 'line', kind: 'grid', noun: 'grid line', shortcut: 'G R' },
  { id: 'reference_plane', label: 'Reference plane', description: 'Draw a named line to snap to on this level', mode: 'line', kind: 'reference_plane', noun: 'reference plane' },
]

export const BUILD_TOOLS: readonly ArchitectureTool[] = [
  { id: 'wall', label: 'Wall', description: 'Draw walls corner to corner; they join where they meet', mode: 'chain', kind: 'wall', noun: 'wall', shortcut: 'W W' },
  { id: 'door', label: 'Door', description: 'Put a door in a wall', mode: 'hosted', kind: 'door', noun: 'door', shortcut: 'D R' },
  { id: 'window', label: 'Window', description: 'Put a window in a wall', mode: 'hosted', kind: 'window', noun: 'window', shortcut: 'W N' },
  { id: 'floor', label: 'Floor', description: 'Click inside walls to fill the room with a floor, or click its corners', mode: 'area', kind: 'slab', noun: 'floor' },
  { id: 'room', label: 'Room', description: 'Click inside walls to make a room bounded by them', mode: 'room', kind: 'space', noun: 'room' },
  { id: 'opening', label: 'Opening', description: 'Cut a plain opening in a wall', mode: 'hosted', kind: 'opening', noun: 'opening' },
  { id: 'ceiling', label: 'Ceiling', description: 'Draw a ceiling by its corners', mode: 'area', kind: 'ceiling', noun: 'ceiling' },
  { id: 'roof', label: 'Roof', description: 'Draw a roof by its footprint', mode: 'area', kind: 'architecture.roof', noun: 'roof' },
  { id: 'column', label: 'Column', description: 'Place a column', mode: 'point', kind: 'column', noun: 'column' },
  { id: 'stair', label: 'Stair', description: 'Draw a straight stair from its foot to its top', mode: 'line', kind: 'architecture.stair', noun: 'stair' },
  { id: 'wall_rectangle', label: 'Rectangle walls', description: 'Click two opposite corners: four walls, joined at every corner', mode: 'rectangle', kind: 'wall', noun: 'wall' },
]

export const ARCHITECTURE_TOOLS: readonly ArchitectureTool[] = [...DATUM_TOOLS, ...BUILD_TOOLS]

export function toolById(id: string): ArchitectureTool | undefined {
  return ARCHITECTURE_TOOLS.find((t) => t.id === id)
}
