import { executeCommand, serviceLinkName, type BimElement, type Command, type ModelState } from '@permitzip/bim-kernel'
import { describeElement } from '../placement'

type DeletePolicy = Extract<Command, { type: 'delete_elements' }>['policy']

/** What Remove on Not placed yet would do, decided by the kernel's own delete on the current model. */
export type PlannedRemoval =
  | {
      readonly kind: 'ready'
      readonly command: Extract<Command, { type: 'delete_elements' }>
      /** For the undo toast and the button: "remove K-14", "remove 3 planned items". */
      readonly label: string
      /** The planned parts, by name. */
      readonly names: readonly string[]
      /** Circuits and feeders they come off (the circuit stays, without them). */
      readonly offCircuits: readonly string[]
      /** What is deleted with them: circuits they feed, their tags. */
      readonly alsoRemoved: readonly string[]
      /** Other connections cut. */
      readonly connectionsCut: number
    }
  | { readonly kind: 'refused'; readonly message: string }

function words(model: ModelState, el: BimElement): string {
  if (el.kind !== 'service_link') return describeElement(model, el)
  const name = serviceLinkName(model.elements, el)
  const what = el.role === 'feeder' ? 'feeder' : 'circuit'
  return el.description ? `${what} ${name} (${el.description})` : `${what} ${name}`
}

/**
 * Plan removing planned parts through the normal delete (`delete_elements`):
 * nothing else depends on them → refuse policy; on a circuit → disconnect (they
 * come off it); a panel feeding circuits, or tagged → cascade (those go too).
 * Nothing is sent; the person confirms first.
 */
export function planPlannedRemoval(model: ModelState, ids: readonly string[]): PlannedRemoval {
  if (ids.length === 0) return { kind: 'refused', message: 'Pick at least one item to remove.' }
  const parts = ids.map((id) => model.elements[id])
  const notPlanned = parts.findIndex((el) => el?.kind !== 'part' || el.planned === undefined)
  if (notPlanned >= 0) {
    const el = parts[notPlanned]
    return { kind: 'refused', message: `${el ? describeElement(model, el) : 'That item'} is no longer on the Not placed yet list. Someone may have placed or removed it.` }
  }
  let chosen: { policy: DeletePolicy; result: ReturnType<typeof executeCommand> } | null = null
  for (const policy of ['refuse', 'disconnect', 'cascade'] as const) {
    const result = executeCommand(model, { type: 'delete_elements', ids: [...ids], policy })
    if (result.ok) {
      chosen = { policy, result }
      break
    }
    if (result.error.code !== 'has_dependents') return { kind: 'refused', message: result.error.message }
    chosen = { policy, result }
  }
  if (!chosen || !chosen.result.ok) return { kind: 'refused', message: chosen && !chosen.result.ok ? chosen.result.error.message : 'It can’t be removed.' }
  const { result, policy } = chosen
  const asked = new Set(ids)
  const names = parts.flatMap((el) => (el ? [describeElement(model, el)] : []))
  const alsoRemoved = result.removedIds.filter((id) => !asked.has(id)).flatMap((id) => {
    const el = model.elements[id]
    return el ? [words(model, el)] : []
  })
  const offCircuits = result.changedIds.flatMap((id) => {
    const el = model.elements[id]
    return el?.kind === 'service_link' ? [words(model, el)] : []
  })
  const label = names.length === 1 && names[0] ? `remove ${names[0]}` : `remove ${names.length} planned items`
  return {
    kind: 'ready',
    command: { type: 'delete_elements', ids: [...ids], policy },
    label,
    names,
    offCircuits,
    alsoRemoved,
    connectionsCut: result.removedConnections.filter((c) => !asked.has(c.a.elementId) || !asked.has(c.b.elementId)).length,
  }
}
