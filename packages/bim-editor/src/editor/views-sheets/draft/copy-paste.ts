import type { Command, ModelState, Vec2 } from '@permitzip/bim-kernel'

/**
 * Copy and paste of placed parts (U4), on drawings: Ctrl/Cmd+C remembers the
 * selected parts and where they sit, Ctrl/Cmd+V sends the kernel's
 * `copy_elements` so the copies land with that group's middle under the
 * pointer. One paste is one edit and one undo. Copies are on no circuit and
 * start without a mark, as the kernel copies them. The clipboard is this tab's
 * only (nothing durable): a copy is a moment's intent, not saved state.
 */
export interface PartClip {
  readonly ids: readonly string[]
  /** The middle of the copied parts, model mm: what lands under the pointer. */
  readonly anchor: Vec2
  /** Their average height above project zero (mm): in 3D the pointer is read on this plane, so the copies land under it, not where the floor below it is. */
  readonly heightMm?: number
}

/** The most `copy_elements` takes at once. */
export const MAX_CLIP = 200

/** The selection as a clip, or why there is nothing to copy (in words for the hint line). */
export function clipOf(model: ModelState, selectedIds: readonly string[]): PartClip | string {
  if (selectedIds.length === 0) return 'Select the devices or equipment to copy first.'
  const parts = selectedIds.flatMap((id) => {
    const el = model.elements[id]
    return el?.kind === 'part' && !el.planned ? [el] : []
  })
  if (parts.length === 0) return 'Copy works on devices, fixtures and equipment for now; ducts, pipes and notes copy later.'
  if (parts.length > MAX_CLIP) return `That is ${parts.length} parts; copy at most ${MAX_CLIP} at once.`
  const anchor = { x: parts.reduce((s, p) => s + p.position.x, 0) / parts.length, y: parts.reduce((s, p) => s + p.position.y, 0) / parts.length }
  const heightOf = (p: (typeof parts)[number]) => {
    const level = model.elements[p.levelId]
    return (level?.kind === 'level' ? level.elevationMm : 0) + p.offsetMm
  }
  const heightMm = Math.round((parts.reduce((s, p) => s + heightOf(p), 0) / parts.length) * 1000) / 1000
  return { ids: parts.map((p) => p.id), anchor, heightMm }
}

/** The edit a paste sends: copies of the clip with its middle at `at` (model mm). `newId` makes each copy's id. */
export function pasteCommand(clip: PartClip, at: Vec2, newId: (sourceId: string, i: number) => string): Extract<Command, { type: 'copy_elements' }> {
  return {
    type: 'copy_elements',
    ids: [...clip.ids],
    newIds: clip.ids.map((id, i) => newId(id, i)),
    delta: { x: Math.round(at.x - clip.anchor.x), y: Math.round(at.y - clip.anchor.y) },
  }
}

/** What the hint line says after a copy. */
export function copiedHint(clip: PartClip): string {
  const n = clip.ids.length
  return `Copied ${n} ${n === 1 ? 'part' : 'parts'}. Point where they go and press Ctrl+V (⌘V on a Mac); they land under the pointer at the height they were copied from.`
}

let tabClip: PartClip | null = null
const clipListeners = new Set<() => void>()

/** What Ctrl+C last copied in this tab (any drawing, the 3D view, the ribbon or the right-click menu); null before the first copy. */
export function currentClip(): PartClip | null {
  return tabClip
}

export function rememberClip(clip: PartClip): void {
  tabClip = clip
  for (const listener of clipListeners) listener()
}

/** For `useSyncExternalStore`: Paste turns on the moment something is copied. */
export function subscribeClip(listener: () => void): () => void {
  clipListeners.add(listener)
  return () => {
    clipListeners.delete(listener)
  }
}

let pasteSeq = 0

/** Ids for one paste's copies: unique per paste, so pasting twice makes two sets. */
export function pasteIds(): (sourceId: string, i: number) => string {
  pasteSeq += 1
  const stamp = `${Date.now().toString(36)}-${pasteSeq}`
  return (id, i) => `${id}-copy-${stamp}-${i + 1}`
}

/** Where copies land with no point under the pointer: beside the originals, 2 ft over and 2 ft up the plan. */
export const PASTE_BESIDE_MM = 609.6

/** A paste in the 3D view: under the pointer on the level's floor, or beside the originals when the pointer isn't over the model. */
export function pasteNear(clip: PartClip, at: Vec2 | null, newId: (sourceId: string, i: number) => string): { readonly command: Extract<Command, { type: 'copy_elements' }>; readonly label: string; readonly hint: string } {
  const where = at ?? { x: clip.anchor.x + PASTE_BESIDE_MM, y: clip.anchor.y + PASTE_BESIDE_MM }
  const command = pasteCommand(clip, where, newId)
  const n = command.ids.length
  const what = `${n} ${n === 1 ? 'part' : 'parts'}`
  return {
    command,
    label: `paste ${what}`,
    hint: `Pasted ${what}${at ? ' under the pointer' : " beside the originals (point at the floor where they go to paste there)"}. Undo takes them back.`,
  }
}

/** Why Paste is off, or null when there is something to paste. */
export function pasteBlocked(clip: PartClip | null, editBlocked: string | null): string | null {
  return editBlocked ?? (clip ? null : 'Nothing copied yet: select devices or equipment and press Ctrl+C (⌘C on a Mac).')
}

/** True when a key press belongs to a text field, so Ctrl+C / Ctrl+V there copy text, not parts. */
export function typingIn(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT'
}
