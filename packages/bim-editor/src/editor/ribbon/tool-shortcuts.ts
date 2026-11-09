export type BuildingModelTool = 'select' | 'place' | 'route' | 'move' | 'measure' | 'box' | 'split'

/** Single-key shortcuts for the model tools (shown in tooltips; the surface handles the keys). */
export const TOOL_SHORTCUTS: Readonly<Record<BuildingModelTool, string>> = { select: 'Esc', place: 'P', route: 'D', move: 'M', measure: 'T', box: 'B', split: 'S' }
