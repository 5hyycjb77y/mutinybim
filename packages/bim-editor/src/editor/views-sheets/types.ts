import type { Command } from '@permitzip/bim-kernel'

/** What the canvas shows: the live 3D model (or looking straight down at it), a saved view, or a sheet. */
export type OpenItem =
  | { readonly kind: 'model'; readonly mode: '3d' | 'plan' }
  | { readonly kind: 'view'; readonly id: string }
  | { readonly kind: 'sheet'; readonly id: string }

/** Send one command; null when it is on its way, or the plain reason it was refused. */
export type SubmitCommand = (command: Command, undoLabel?: string) => string | null

export type CreatableViewType = 'floor_plan' | 'ceiling_plan' | 'section' | 'three_d' | 'detail'

export const VIEW_TYPE_LABEL: Record<CreatableViewType | 'schedule', string> = {
  floor_plan: 'Floor plan',
  ceiling_plan: 'Ceiling plan',
  section: 'Section',
  three_d: '3D view',
  detail: 'Detail view (drawing-only)',
  schedule: 'Schedule',
}

/** Drag payload when a view is dragged from the panel onto a sheet. */
export const VIEW_DRAG_TYPE = 'application/x-mutinybim-view'

export function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`
}

export function sameOpen(a: OpenItem, b: OpenItem): boolean {
  if (a.kind === 'model' && b.kind === 'model') return a.mode === b.mode
  if (a.kind === 'view' && b.kind === 'view') return a.id === b.id
  if (a.kind === 'sheet' && b.kind === 'sheet') return a.id === b.id
  return false
}
