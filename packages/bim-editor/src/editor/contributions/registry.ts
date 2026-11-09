import { isFirstPartyPackId } from '@permitzip/bim-kernel/packs'
import { FIRST_PARTY_CONTRIBUTIONS } from './first-party'
import type { AddonAvailability, AddonContributions, AddonId, ComponentContribution, ComponentSlot, RibbonContribution } from './types'

let registered: readonly AddonContributions[] = FIRST_PARTY_CONTRIBUTIONS

/** Every add-on's ribbon contributions, in registration order (first-party first). */
export function ribbonContributions(): readonly RibbonContribution[] {
  return registered.flatMap((a) => a.ribbon)
}

/** The add-on tabs that carry `field` in their UI data, with its value, in registration order. */
export function addonTabsWith(field: 'plan' | 'scheduleStart'): readonly { readonly id: string; readonly value: string }[] {
  const out: { readonly id: string; readonly value: string }[] = []
  for (const c of ribbonContributions()) {
    const value = c.kind === 'ribbon-command' ? undefined : c[field]
    if (value) out.push({ id: c.id, value })
  }
  return out
}

/** The components contributed to one slot, typed by the slot. */
export function componentContributions<P>(slot: ComponentSlot<P>): readonly ComponentContribution<P>[] {
  const out: ComponentContribution<P>[] = []
  for (const a of registered) for (const c of a.components) if (c.slot === slot) out.push(c as unknown as ComponentContribution<P>)
  return out
}

/** Everything one add-on contributes, by label, for Settings › MutinyBIM library › Add-ons. */
export function addonContents(addon: AddonId): readonly string[] {
  const out: string[] = []
  for (const a of registered) {
    for (const c of a.ribbon) if (c.addon === addon) out.push(c.kind === 'ribbon-command' ? `${c.label} command` : `${c.label} tab`)
    for (const c of a.components) if (c.addon === addon) out.push(c.label)
  }
  return out
}

/**
 * Register another add-on's screens (a pack this host installs, or a test's).
 * Returns the undo. The ribbon and slots pick them up with no edit of their own.
 */
export function registerAddonContributions(contributions: AddonContributions): () => void {
  registered = [...registered, contributions]
  bump()
  return () => {
    registered = registered.filter((a) => a !== contributions)
    bump()
  }
}

/** The availability when the host says nothing more: the first-party add-ons, nothing missing. */
export const FIRST_PARTY_ONLY: AddonAvailability = { active: new Set(), notLoaded: new Map() }

/** Whether a contribution's add-on is in the model's active set (first-party add-ons always are). */
export function isAddonActive(addon: AddonId, availability: AddonAvailability = FIRST_PARTY_ONLY): boolean {
  return isFirstPartyPackId(addon) || availability.active.has(addon)
}

// ---- Loading: one promise per contribution, shared by every surface; a failure can be retried.

export type LoadState<M> =
  | { readonly status: 'loading' }
  | { readonly status: 'loaded'; readonly module: M }
  | { readonly status: 'error'; readonly message: string }

interface Loadable<M> {
  readonly addon: AddonId
  readonly id: string
  readonly load: () => Promise<M>
}

const states = new Map<object, LoadState<unknown>>()
const pending = new Map<object, Promise<void>>()
const listeners = new Set<() => void>()
let version = 0

function bump(): void {
  version += 1
  for (const l of listeners) l()
}

/** For `useSyncExternalStore`: a change whenever a contribution finishes loading, fails, or is registered. */
export function subscribeContributions(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function contributionsVersion(): number {
  return version
}

function start<M>(c: Loadable<M>): LoadState<M> {
  const loading: LoadState<M> = { status: 'loading' }
  states.set(c, loading)
  const done = c.load().then(
    (module) => {
      states.set(c, { status: 'loaded', module })
      pending.delete(c)
      bump()
    },
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[building-model] an add-on screen did not load', { addon: c.addon, id: c.id, err })
      states.set(c, { status: 'error', message })
      pending.delete(c)
      bump()
    },
  )
  pending.set(c, done)
  return loading
}

/** Where a contribution's code is; starts loading it the first time it is asked for. */
export function loadState<M>(c: Loadable<M>): LoadState<M> {
  const held = states.get(c) as LoadState<M> | undefined
  return held ?? start(c)
}

/** Try a failed contribution again (the Retry button). */
export function retryContribution<M>(c: Loadable<M>): void {
  start(c)
  bump()
}

/** Load every ribbon contribution now (tests; a host that wants them before first paint). */
export async function loadRibbonContributions(): Promise<void> {
  for (const c of ribbonContributions()) loadState<unknown>(c)
  await Promise.all([...pending.values()])
}

/** Test seam: forget what loaded, so the next read starts again. */
export function resetContributionLoadsForTest(): void {
  states.clear()
  pending.clear()
  bump()
}
