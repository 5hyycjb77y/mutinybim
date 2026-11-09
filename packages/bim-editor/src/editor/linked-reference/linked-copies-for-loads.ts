import {
  existingLinkedCopy,
  hostedOn,
  linkedCopyStamp,
  linkedCopyLevelId,
  linkedCopyStampOf,
  linkedElementKey,
  OPENING_SILL_KEY,
  stationAlong,
  type Command,
  type ElementId,
  type LinkedCopyRow,
  type LinkedCopyStamp,
  type LinkedReferenceIndex,
  type ModelState,
  type ReferenceItem,
  type SpaceEnvelope,
  type Vec2,
} from '@permitzip/bim-kernel'

/**
 * The first use of copies kept in step with the link: a space's
 * outside walls and their windows and doors, as the linked model has them,
 * copied into our model as walls and openings so load calculations can read
 * them; then, when the link updates, each copy settled one at a time ("Update
 * from the link" / "Keep mine"), each one undo. Pure: builds the commands.
 */

type Step = Extract<Command, { type: 'batch_edits' }>['commands'][number]

const OPENING_KINDS = ['opening']

function wallStep(item: ReferenceItem, levelId: string, elementId: string): Step | null {
  if (!item.line) return null
  return {
    type: 'create_element',
    elementId,
    kind: 'wall',
    levelId,
    placement: { kind: 'line', start: round(item.line.axis.start), end: round(item.line.axis.end) },
    size: { thicknessMm: Math.max(1, Math.round(item.line.widthMm)), heightMm: Math.max(1, Math.round(item.maxZ - item.minZ)) },
  }
}

const round = (p: Vec2): Vec2 => ({ x: Math.round(p.x), y: Math.round(p.y) })

function centreOf(item: ReferenceItem): Vec2 {
  let x = 0
  let y = 0
  for (const p of item.outline) {
    x += p.x
    y += p.y
  }
  return { x: x / item.outline.length, y: y / item.outline.length }
}

/** The height of a level, or null when the id names none. */
function levelZ(model: ModelState, levelId: string | null): number | null {
  const l = levelId ? model.elements[levelId] : undefined
  return l?.kind === 'level' ? l.elevationMm : null
}

/** The base height of a wall in our model (its level), for measuring a copied window's sill from. */
function hostBaseZ(model: ModelState, hostId: string): number | null {
  const host = model.elements[hostId]
  return host ? levelZ(model, linkedCopyLevelId(model.elements, host)) : null
}

type Host = { readonly id: string; readonly start: Vec2; readonly end: Vec2; readonly baseZ: number | null }

function openingStep(item: ReferenceItem, host: Host, elementId: string): Step | null {
  const width = Math.round(item.line ? Math.hypot(item.line.axis.end.x - item.line.axis.start.x, item.line.axis.end.y - item.line.axis.start.y) : 900)
  const s = stationAlong(host.start, host.end, centreOf(item), width)
  if (s === null) return null
  return {
    type: 'create_hosted',
    elementId,
    kind: 'opening',
    openingType: item.rule.envelope === 'door' ? 'door' : 'window',
    hostId: host.id,
    s,
    side: 1,
    size: { widthMm: width, heightMm: Math.max(1, Math.round(item.maxZ - item.minZ)) },
    // The link's sill, measured from the base of the wall it is copied into.
    ...(host.baseZ !== null ? { values: { [OPENING_SILL_KEY]: Math.max(0, Math.round(item.minZ - host.baseZ)) } } : {}),
  }
}

const stampStep = (stamps: Array<{ elementId: string; stamp: LinkedCopyStamp | null }>): Step => ({ type: 'set_element_linked_copy', stamps })

export type CopyOutcome = { readonly kind: 'command'; readonly command: Command; readonly walls: number; readonly openings: number } | { readonly kind: 'nothing'; readonly message: string }

/** Copy a space's outside walls and their openings from the link (ones already copied are left alone). */
export function copyEnvelopeForLoads(model: ModelState, index: LinkedReferenceIndex, envelope: SpaceEnvelope, levelId: ElementId, newId: (prefix: string) => string): CopyOutcome {
  const steps: Step[] = []
  const stamps: Array<{ elementId: string; stamp: LinkedCopyStamp }> = []
  const hosts = new Map<string, Host>()
  let walls = 0
  let openings = 0
  for (const w of envelope.walls) {
    const item = index.byKey.get(linkedElementKey(w.wall))
    if (!item?.line) continue
    const had = existingLinkedCopy(model.elements, w.wall.sourceId, w.wall.globalId)
    if (had && 'start' in had && 'end' in had) {
      hosts.set(linkedElementKey(w.wall), { id: had.id, start: had.start, end: had.end, baseZ: hostBaseZ(model, had.id) })
      continue
    }
    const id = newId('wall')
    const step = wallStep(item, levelId, id)
    if (!step) continue
    steps.push(step)
    stamps.push({ elementId: id, stamp: linkedCopyStampOf(index, item) })
    hosts.set(linkedElementKey(w.wall), { id, start: round(item.line.axis.start), end: round(item.line.axis.end), baseZ: levelZ(model, levelId) })
    walls += 1
  }
  for (const o of envelope.openings) {
    if (existingLinkedCopy(model.elements, o.ref.sourceId, o.ref.globalId)) continue
    const item = index.byKey.get(linkedElementKey(o.ref))
    const host = hosts.get(linkedElementKey(o.wall))
    if (!item || !host) continue
    const id = newId('opening')
    const step = openingStep(item, host, id)
    if (!step) continue
    steps.push(step)
    stamps.push({ elementId: id, stamp: linkedCopyStampOf(index, item) })
    openings += 1
  }
  if (steps.length === 0) return { kind: 'nothing', message: "This space's outside walls and windows from the linked model are already in the model." }
  steps.push(stampStep(stamps))
  return { kind: 'command', command: { type: 'batch_edits', label: 'Copy outside walls and windows from the linked model for loads', commands: steps }, walls, openings }
}

/** The openings hosted on an element, split into copies of the link and ones a person added. */
function hostedSplit(model: ModelState, hostId: string): { copies: ElementId[]; own: ElementId[] } {
  const copies: ElementId[] = []
  const own: ElementId[] = []
  for (const el of hostedOn(model.elements, hostId, OPENING_KINDS)) (linkedCopyStamp(el) ? copies : own).push(el.id)
  return { copies, own }
}

const OWN_OPENINGS = "This wall has a door or window someone added in this model; taking the link's version would remove it. Move it to another wall first, or keep yours."

/** "Update from the link" for one row: one batch, one undo; plain words when it can't be done. */
export function updateFromLinkCommand(model: ModelState, index: LinkedReferenceIndex, row: LinkedCopyRow, newId: (prefix: string) => string): Command | string {
  const el = model.elements[row.elementId]
  if (!el) return 'That copy is no longer in the model.'
  const { copies, own } = row.kind === 'wall' ? hostedSplit(model, row.elementId) : { copies: [], own: [] }
  if (own.length > 0) return OWN_OPENINGS
  if (row.status === 'gone' || !row.source) {
    return { type: 'delete_elements', ids: [...copies, row.elementId], policy: 'cascade' }
  }
  const steps: Step[] = [{ type: 'delete_elements', ids: [...copies, row.elementId], policy: 'cascade' }]
  const stamps: Array<{ elementId: string; stamp: LinkedCopyStamp }> = []
  if (row.kind === 'wall') {
    const levelId = linkedCopyLevelId(model.elements, el)
    if (!levelId || !row.source.line) return "The linked wall is no longer a straight wall; delete the copy and copy it again."
    const id = newId('wall')
    const step = wallStep(row.source, levelId, id)
    if (!step) return "The linked wall is no longer a straight wall; delete the copy and copy it again."
    steps.push(step)
    stamps.push({ elementId: id, stamp: linkedCopyStampOf(index, row.source) })
    const host: Host = { id, start: round(row.source.line.axis.start), end: round(row.source.line.axis.end), baseZ: levelZ(model, levelId) }
    // The windows copied into it come back from the link too, where they are now.
    for (const copyId of copies) {
      const stamp = linkedCopyStamp(model.elements[copyId])
      const item = stamp ? index.byKey.get(linkedElementKey({ sourceId: stamp.linkId, globalId: stamp.globalId })) : undefined
      if (!item) continue
      const oid = newId('opening')
      const os = openingStep(item, host, oid)
      if (!os) continue
      steps.push(os)
      stamps.push({ elementId: oid, stamp: linkedCopyStampOf(index, item) })
    }
  } else if (row.kind === 'opening') {
    const hostId = 'hostId' in el && typeof el.hostId === 'string' ? el.hostId : null
    const host = hostId ? model.elements[hostId] : undefined
    if (!host || !('start' in host) || !('end' in host)) return 'The wall this opening sits in is no longer in the model.'
    const id = newId('opening')
    const os = openingStep(row.source, { id: host.id, start: host.start, end: host.end, baseZ: hostBaseZ(model, host.id) }, id)
    if (!os) return "The linked opening no longer fits in this wall; delete the copy and copy it again."
    steps.push(os)
    stamps.push({ elementId: id, stamp: linkedCopyStampOf(index, row.source) })
  } else {
    return `Updating a ${row.kind} from the link isn't supported yet; keep yours, or delete it and copy it again.`
  }
  steps.push(stampStep(stamps))
  return { type: 'batch_edits', label: `Update ${row.kind} from the linked model`, commands: steps }
}

/** "Keep mine" for one row: the copy stays as it is; a changed source is recorded as seen, a gone one stops being followed. */
export function keepMineCommand(index: LinkedReferenceIndex, row: LinkedCopyRow): Command {
  return { type: 'set_element_linked_copy', stamps: [{ elementId: row.elementId, stamp: row.status === 'gone' || !row.source ? null : linkedCopyStampOf(index, row.source) }] }
}
