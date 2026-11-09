import { linkLoad } from './link-load'
import { executeCommand, linkServing, type Command, type ConductorSet, type ModelState, type ServiceLink } from '@permitzip/bim-kernel'
import { describeCircuit, existingCircuitRefusal, panelSchedule } from '../connections/panel'

/**
 * What the circuit dialogs send, worked out before anything is sent: the
 * commands in order, dry-run through the kernel on the current model, so the
 * dialog can say the plain reason it would be refused (or what it will make)
 * while the person is still choosing. Membership is only what the person
 * selected (internal design note): nothing here adds a member.
 */

export interface CircuitPlan {
  readonly ok: true
  readonly commands: readonly Command[]
  /** The undo label for the last command ("add 4 receptacles to L1-3"). */
  readonly label: string
  /** What it makes, in words: "L1-3 (phase B): 4 devices, 720 VA". */
  readonly summary: string
  /** The circuit or feeder it ends on. */
  readonly linkId: string
}

export interface CircuitRefusal {
  readonly ok: false
  readonly reason: string
}

export type CircuitPlanResult = CircuitPlan | CircuitRefusal

function link(model: ModelState, id: string): ServiceLink | null {
  const el = model.elements[id]
  return el?.kind === 'service_link' ? el : null
}

/** Why a command would move or renumber an existing circuit (it keeps its panel and number on a renovation), or null. */
export function existingCircuitBlock(model: ModelState, c: Command): string | null {
  if (c.type === 'edit_service_link') {
    const l = link(model, c.linkId)
    return l ? existingCircuitRefusal(model.elements, l, { ...(c.sourceId ? { sourceId: c.sourceId } : {}), ...(c.positions ? { positions: c.positions } : {}) }) : null
  }
  if (c.type === 'reposition_service_links') {
    for (const m of c.moves) {
      const l = link(model, m.linkId)
      const why = l ? existingCircuitRefusal(model.elements, l, { positions: m.positions }) : null
      if (why) return why
    }
  }
  return null
}

/** Run the commands one after another on a copy of the model; the first refusal wins. */
export function dryRun(model: ModelState, commands: readonly Command[]): { ok: true; model: ModelState } | CircuitRefusal {
  let at = model
  for (const c of commands) {
    const locked = existingCircuitBlock(at, c)
    if (locked) return { ok: false, reason: locked }
    const r = executeCommand(at, c)
    if (!r.ok) return { ok: false, reason: r.error.message }
    at = r.model
  }
  return { ok: true, model: at }
}

function circuitName(model: ModelState, linkId: string): string {
  const l = link(model, linkId)
  return l ? describeCircuit(model.elements, l).name : linkId
}

function summaryOf(after: ModelState, linkId: string): string {
  const l = link(after, linkId)
  if (!l) return ''
  const c = describeCircuit(after.elements, l)
  const phases = c.phases.length === 0 ? '' : c.phases.length === 1 ? ` (phase ${c.phases[0]})` : ` (${c.phases.join(', ')})`
  const breaker = c.ratingA ? `, ${c.ratingA} A breaker` : ''
  if (c.role === 'feeder') return `${c.name}${phases}${breaker}`
  return `${c.name}${phases}: ${plural(c.members.length, 'device', 'devices')}, ${Math.round(linkLoad(after, linkId)?.inventory.va ?? 0)} VA${breaker}`
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

export type CircuitTarget =
  | { readonly kind: 'new'; readonly linkId: string; readonly positions: readonly number[] | null; readonly ratingA: number | null; readonly description: string }
  | { readonly kind: 'existing'; readonly linkId: string }

/**
 * Put the selected loads on a circuit of `panelId`: a new one in the slots
 * given (or the free ones that best balance the phases), or an existing one. Loads already
 * on another circuit come off it first, in the same plan.
 */
export function planAddToCircuit(model: ModelState, memberIds: readonly string[], panelId: string, target: CircuitTarget): CircuitPlanResult {
  if (memberIds.length === 0) return { ok: false, reason: 'Select the devices to circuit first.' }
  const commands: Command[] = []
  const leaving = new Map<string, string[]>()
  for (const id of memberIds) {
    const part = model.elements[id]
    if (part?.kind !== 'part') return { ok: false, reason: `${id} is not a placed part.` }
    for (const linkId of Object.values(part.served ?? {})) {
      const current = link(model, linkId)
      if (!current || current.role !== 'branch' || (target.kind === 'existing' && current.id === target.linkId)) continue
      leaving.set(current.id, [...(leaving.get(current.id) ?? []), id])
    }
  }
  for (const [linkId, ids] of leaving) commands.push({ type: 'remove_link_members', linkId, elementIds: ids })
  const already = target.kind === 'existing' ? link(model, target.linkId) : null
  const incoming = already ? memberIds.filter((id) => !already.members.some((m) => m.elementId === id)) : memberIds
  if (target.kind === 'existing') {
    if (!already) return { ok: false, reason: 'That circuit is gone; pick another.' }
    if (incoming.length === 0) return { ok: false, reason: `Everything selected is already on this circuit.` }
    commands.push({ type: 'add_link_members', linkId: target.linkId, members: incoming.map((elementId) => ({ elementId })) })
  } else {
    commands.push({
      type: 'create_service_link',
      linkId: target.linkId,
      sourceId: panelId,
      ...(target.positions ? { positions: [...target.positions] } : {}),
      members: memberIds.map((elementId) => ({ elementId })),
      ...(target.description.trim() ? { description: target.description.trim() } : {}),
      ...(target.ratingA ? { electrical: { ratingA: target.ratingA } } : {}),
    })
  }
  const run = dryRun(model, commands)
  if (!run.ok) return run
  const linkId = target.linkId
  return { ok: true, commands, label: `put ${plural(memberIds.length, 'device', 'devices')} on ${circuitName(run.model, linkId)}`, summary: summaryOf(run.model, linkId), linkId }
}

/**
 * Feed a panel or transformer from a breaker in `sourceId` (or a transformer's
 * secondary). An existing feeder moves to the new source instead of making a
 * second one.
 */
export function planFeed(model: ModelState, fedId: string, sourceId: string, opts: { readonly linkId: string; readonly positions: readonly number[] | null; readonly ratingA: number | null; readonly feederType: string }): CircuitPlanResult {
  const fed = model.elements[fedId]
  if (fed?.kind !== 'part') return { ok: false, reason: 'Select the panel or transformer to feed.' }
  const fedSchedule = panelSchedule(model.elements, fedId)
  if (!fedSchedule) return { ok: false, reason: 'Only panelboards, switchboards and transformers take a feeder; the selection is not one.' }
  const current = fedSchedule.fedBy ? link(model, fedSchedule.fedBy.linkId) : null
  const electrical = { ...(opts.ratingA ? { ratingA: opts.ratingA } : {}), ...(opts.feederType.trim() ? { feederType: opts.feederType.trim() } : {}) }
  const command: Command = current
    ? { type: 'edit_service_link', linkId: current.id, sourceId, ...(opts.positions ? { positions: [...opts.positions] } : {}), ...(Object.keys(electrical).length > 0 ? { electrical } : {}) }
    : { type: 'create_service_link', linkId: opts.linkId, sourceId, ...(opts.positions ? { positions: [...opts.positions] } : {}), members: [{ elementId: fedId }], ...(Object.keys(electrical).length > 0 ? { electrical } : {}) }
  const run = dryRun(model, [command])
  if (!run.ok) return run
  const linkId = current?.id ?? opts.linkId
  return { ok: true, commands: [command], label: `feed ${fedSchedule.name}`, summary: summaryOf(run.model, linkId), linkId }
}

export interface CircuitChanges {
  readonly description?: string
  readonly positions?: readonly number[]
  readonly ratingA?: number | null
  /** null: back to the default wire for the breaker. */
  readonly conductors?: ConductorSet | null
  /** One-way length for voltage drop and fault current, ft; null clears it. */
  readonly lengthFt?: number | null
}

export function planEditCircuit(model: ModelState, linkId: string, changes: CircuitChanges): CircuitPlanResult {
  const current = link(model, linkId)
  if (!current) return { ok: false, reason: 'That circuit is gone.' }
  const sameConductors = (a: ConductorSet | null | undefined, b: ConductorSet | null | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
  const electrical = {
    ...(changes.ratingA !== undefined && changes.ratingA !== (current.electrical?.ratingA ?? null) ? { ratingA: changes.ratingA } : {}),
    ...(changes.conductors !== undefined && !sameConductors(changes.conductors, current.electrical?.conductors) ? { conductors: changes.conductors } : {}),
    ...(changes.lengthFt !== undefined && changes.lengthFt !== (current.electrical?.lengthFt ?? null) ? { lengthFt: changes.lengthFt } : {}),
  }
  const samePositions = changes.positions === undefined || changes.positions.join(',') === [...current.source.positions].sort((a, b) => a - b).join(',')
  const command: Command = {
    type: 'edit_service_link',
    linkId,
    ...(changes.description !== undefined && changes.description !== current.description ? { description: changes.description } : {}),
    ...(!samePositions && changes.positions ? { positions: [...changes.positions] } : {}),
    ...(Object.keys(electrical).length > 0 ? { electrical } : {}),
  }
  if (Object.keys(command).length === 2) return { ok: false, reason: 'Nothing changed.' }
  const run = dryRun(model, [command])
  if (!run.ok) return run
  return { ok: true, commands: [command], label: `change ${circuitName(model, linkId)}`, summary: summaryOf(run.model, linkId), linkId }
}

/** Take devices off whatever branch circuits they are on. */
export function planRemoveFromCircuits(model: ModelState, memberIds: readonly string[]): CircuitPlanResult {
  const byLink = new Map<string, string[]>()
  for (const id of memberIds) {
    const part = model.elements[id]
    if (part?.kind !== 'part') continue
    for (const [connector, linkId] of Object.entries(part.served ?? {})) {
      const l = linkServing(model.elements, id, connector)
      if (!l || l.role !== 'branch') continue
      byLink.set(linkId, [...(byLink.get(linkId) ?? []), id])
    }
  }
  if (byLink.size === 0) return { ok: false, reason: 'Nothing selected is on a circuit.' }
  const commands: Command[] = [...byLink].map(([linkId, elementIds]) => ({ type: 'remove_link_members', linkId, elementIds }))
  const run = dryRun(model, commands)
  if (!run.ok) return run
  const n = [...byLink.values()].reduce((s, ids) => s + ids.length, 0)
  const first = [...byLink.keys()][0] ?? ''
  return { ok: true, commands, label: `take ${plural(n, 'device', 'devices')} off ${byLink.size === 1 ? circuitName(model, first) : `${byLink.size} circuits`}`, summary: '', linkId: first }
}
