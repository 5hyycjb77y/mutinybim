import { PIPING_DIAGRAM_KINDS, diagramKindLabel, diagramNodes, documentIndex, type Command, type DiagramHints, type ModelState, type PipeLabel, type StoredDiagramKind, type ViewElement } from '@permitzip/bim-kernel'
import { requireAddOns } from '../../contracts/building-model/add-ons'

/** Which systems a piping diagram draws: the risers on a plumbing set (sanitary with its vents, domestic water, gas), or all of them. */
export const PIPING_SYSTEM_PRESETS = [
  { id: 'all', label: 'All plumbing systems', kinds: undefined },
  { id: 'sanitary', label: 'Sanitary and vent', kinds: ['sanitary', 'vent'] },
  { id: 'water', label: 'Domestic water', kinds: ['domestic_cold_water', 'domestic_hot_water', 'domestic_hot_water_return'] },
  { id: 'gas', label: 'Gas', kinds: ['natural_gas'] },
] as const satisfies ReadonlyArray<{ id: string; label: string; kinds: readonly string[] | undefined }>

export type PipingSystemPreset = (typeof PIPING_SYSTEM_PRESETS)[number]['id']

/** The preset a view's system kinds match; 'custom' when they were set some other way (an agent, an older view). */
export function pipingPresetOf(view: ViewElement): PipingSystemPreset | 'custom' {
  const kinds = view.props?.diagram?.hints?.systemKinds
  if (!kinds || kinds.length === 0) return 'all'
  const key = [...kinds].sort().join(',')
  return PIPING_SYSTEM_PRESETS.find((p) => p.kinds && [...p.kinds].sort().join(',') === key)?.id ?? 'custom'
}

/** The labels a piping diagram can print, in the order they read, and what each is called. */
export const PIPE_LABEL_CHOICES: ReadonlyArray<{ readonly id: PipeLabel; readonly label: string }> = [
  { id: 'load', label: 'What each pipe carries (DFU, WFU, MBH)' },
  { id: 'slope', label: 'Slopes on drains' },
  { id: 'invert', label: 'Inverts on drains' },
  { id: 'length', label: 'Lengths (LF)' },
]

export const isPipingDiagram = (view: ViewElement): boolean => {
  const kind = view.props?.diagram?.kind
  return kind !== undefined && PIPING_DIAGRAM_KINDS.has(kind)
}

/**
 * Live diagram edits as kernel commands: the same `create_view` and
 * `set_view_properties` the agent's bim_layout_one_line sends. A diagram view
 * stores only its kind and hints; nothing here writes line work.
 */

/** The live diagram views of a kind, in name order. */
export function diagramViews(model: ModelState, kind?: StoredDiagramKind): ViewElement[] {
  return documentIndex(model)
    .views.filter((v) => v.viewType === 'detail' && v.props?.diagram && (!kind || v.props.diagram.kind === kind))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
}

/** A name for a new diagram view that no view has yet: "One-line diagram", "One-line diagram 2"… */
export function newDiagramName(model: ModelState, kind: StoredDiagramKind): string {
  const taken = new Set(documentIndex(model).views.map((v) => v.name.toLowerCase()))
  const base = diagramKindLabel(kind)
  if (!taken.has(base.toLowerCase())) return base
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`
}

export function createDiagramCommand(model: ModelState, kind: StoredDiagramKind, viewId: string): Command {
  return { type: 'create_view', viewId, name: newDiagramName(model, kind), viewType: 'detail', props: { diagram: { kind } } }
}

/** The view's hints with `patch` applied; a key set to undefined goes back to its default. */
export function hintsCommand(view: ViewElement, patch: Partial<{ [K in keyof DiagramHints]: DiagramHints[K] | undefined }>): Command | null {
  const def = view.props?.diagram
  if (!def) return null
  const hints: Record<string, unknown> = { ...(def.hints ?? {}) }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete hints[k]
    else hints[k] = v
  }
  return { type: 'set_view_properties', viewId: view.id, props: { diagram: { kind: def.kind, hints: hints as DiagramHints } } }
}

/** Where a piece of equipment sits among what its source feeds: the parent and the siblings in drawing order. */
export function siblingsOf(model: ModelState, view: ViewElement, elementId: string): { parentId: string; ids: string[] } | null {
  const def = view.props?.diagram
  if (!def || PIPING_DIAGRAM_KINDS.has(def.kind)) return null
  const graph = requireAddOns().electrical.electricalDiagramGraph(model.elements, def.hints)
  for (const n of diagramNodes(graph)) {
    const i = n.children.findIndex((c) => c.id === elementId)
    if (i >= 0 && n.elementId) return { parentId: n.elementId, ids: n.children.filter((c) => !c.placeholder && c.elementId).map((c) => c.id) }
  }
  return null
}

/** Move a piece of equipment one place earlier (-1) or later (+1) under its source; null when it can't move that way. */
export function reorderCommand(model: ModelState, view: ViewElement, elementId: string, step: -1 | 1): Command | null {
  const s = siblingsOf(model, view, elementId)
  if (!s) return null
  const i = s.ids.indexOf(elementId)
  const j = i + step
  if (i < 0 || j < 0 || j >= s.ids.length) return null
  const ids = [...s.ids]
  const [moved] = ids.splice(i, 1)
  if (moved === undefined) return null
  ids.splice(j, 0, moved)
  return hintsCommand(view, { order: { ...(view.props?.diagram?.hints?.order ?? {}), [s.parentId]: ids } })
}

/** Add a drag to a piece of equipment's pin (drawing mm), as one hint change. */
export function pinCommand(view: ViewElement, elementId: string, delta: { x: number; y: number }): Command | null {
  const pins = { ...(view.props?.diagram?.hints?.pins ?? {}) }
  const old = pins[elementId] ?? { dx: 0, dy: 0 }
  const round = (v: number) => Math.round(v * 10) / 10
  pins[elementId] = { dx: round(old.dx + delta.x), dy: round(old.dy + delta.y) }
  return hintsCommand(view, { pins })
}

/** Add a drag to one block of diagram text (drawing mm), as one hint change; the text keeps reading the model. */
export function textOffsetCommand(view: ViewElement, key: string, delta: { x: number; y: number }): Command | null {
  const offsets = { ...(view.props?.diagram?.hints?.textOffsets ?? {}) }
  const old = offsets[key] ?? { dx: 0, dy: 0 }
  const round = (v: number) => Math.round(v * 10) / 10
  const next = { ...old, dx: round(old.dx + delta.x), dy: round(old.dy + delta.y) }
  if (next.dx === 0 && next.dy === 0) delete offsets[key]
  else offsets[key] = next
  return hintsCommand(view, { textOffsets: Object.keys(offsets).length > 0 ? offsets : undefined })
}

/** How many things were moved by hand on a diagram: equipment pins and text blocks. */
export function movedCount(view: ViewElement): number {
  const hints = view.props?.diagram?.hints
  return Object.keys(hints?.pins ?? {}).length + Object.keys(hints?.textOffsets ?? {}).length
}
