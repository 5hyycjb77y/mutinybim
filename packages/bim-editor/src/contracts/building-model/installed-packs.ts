import { bindModelPacks, modelPackSet, outsidePacksForPins, unbindModelPacks, withModelPacks, type InstalledOutsidePack, type Pack, type PackPin, type PackSet } from '@permitzip/bim-kernel/packs'
import { installModelSetupHost, modelSetupOf, resolveModelSetup, type ModelSetup, type ModelState } from '@permitzip/bim-kernel'
import { FIRST_PARTY_ADDONS, installFirstPartyAddOns } from '@permitzip/bim-first-party'
import { CIVIL_PACK } from '@permitzip/bim-pack-civil'

/**
 * The add-ons this deployment can open models with, beyond the
 * first-party trades. Civil is installed as a Preview add-on (round 8): a
 * model uses it only once someone switches it on for that model (Building
 * Model › Manage › Model settings › Add-ons), so every other model opens
 * exactly as before. Structural is first-party since round 14 (on in every
 * model). The model server keeps the same list
 * (`services/bim-authority/src/packs.ts`).
 */
export const INSTALLED_PACKS: readonly Pack[] = [CIVIL_PACK]

/** Add-ons whose results are not yet for issued drawings: listed with a Preview badge. Every installed non-first-party add-on is Preview this round. */
export const PREVIEW_PACK_IDS: ReadonlySet<string> = new Set(INSTALLED_PACKS.map((p) => p.manifest.id))

let installed: readonly Pack[] = INSTALLED_PACKS

/** The host's add-ons now: `INSTALLED_PACKS`, unless a test installed others. */
export function installedPacks(): readonly Pack[] {
  return installed
}

/** Test seam: act as a host that has `packs` installed, until the returned undo runs. */
export function installPacksForTest(packs: readonly Pack[]): () => void {
  const before = installed
  installed = packs
  return () => {
    installed = before
  }
}

let firstPartyInstalled = false

/**
 * The first-party add-ons this process installed in the kernel, by
 * `id@version`. On `globalThis` because a development reload re-runs this
 * module (with fresh add-on objects) while the kernel keeps what it installed.
 */
const PROCESS_INSTALL = Symbol.for('permitzip.building-model.first-party-add-ons')
type ProcessInstall = Map<string, Pack>
type WithProcessInstall = typeof globalThis & { [PROCESS_INSTALL]?: ProcessInstall }

const packKey = (pack: Pack): string => `${pack.manifest.id}@${pack.manifest.version}`

function processInstall(): ProcessInstall | undefined {
  return (globalThis as WithProcessInstall)[PROCESS_INSTALL]
}

function rememberProcessInstall(packs: readonly Pack[]): void {
  ;(globalThis as WithProcessInstall)[PROCESS_INSTALL] = new Map(packs.map((p) => [packKey(p), p] as const))
}

/**
 * Install the first-party add-ons (Electrical, Plumbing and gas, Mechanical,
 * Fire protection) in this process, once, and register this host's add-on
 * list with the kernel so a model's own add-on switches and pinned firm
 * disciplines decide its set wherever a command runs. Every model opens with
 * the first-party add-ons whatever it pins; the Building Model, the MCP
 * routes and the agent worker reach this before their first model read.
 *
 * In development, editing an add-on's source re-runs this module with new
 * add-on objects of the same id and version while the kernel still holds the
 * ones it installed. That reload keeps the installed add-ons and warns
 * (restart to run the edited code) instead of refusing them, so routes keep
 * answering. Anywhere else a different object for an installed id is still
 * refused by the kernel.
 */
export function ensureFirstPartyAddOns(mode: 'development' | 'production' = process.env.NODE_ENV === 'development' ? 'development' : 'production'): void {
  if (firstPartyInstalled) return
  const before = processInstall()
  const reloaded = mode === 'development' && before !== undefined && FIRST_PARTY_ADDONS.every((p) => before.has(packKey(p)))
  if (reloaded) {
    const edited = FIRST_PARTY_ADDONS.filter((p) => before.get(packKey(p)) !== p).map(packKey)
    if (edited.length > 0) console.warn('[building-model] add-on source reloaded in development: keeping the add-ons this process installed first; restart npm run dev to run the edited code', { edited })
  } else {
    installFirstPartyAddOns()
    rememberProcessInstall(FIRST_PARTY_ADDONS)
  }
  installModelSetupHost(() => installed, {
    onProblem: (modelId, resolved) => console.error('[building-model] this model uses add-ons this server does not have; it opens without them', { modelId, missing: resolved.missing, firmProblems: resolved.firmProblems }),
  })
  firstPartyInstalled = true
}

/** A model's id and settings; with its records too, its own add-on switches and pinned disciplines count. */
type PinnedModel = Pick<ModelState, 'modelId' | 'settings'> & Partial<Pick<ModelState, 'elements' | 'connections'>>

const boundKey = new Map<string, string>()

function setupOf(model: PinnedModel): ModelSetup {
  if (model.elements && model.connections) return modelSetupOf({ elements: model.elements, connections: model.connections, settings: model.settings })
  const pins: readonly PackPin[] = model.settings.packs ?? []
  return { hasEntries: false, pins, firmDisciplines: [], key: JSON.stringify([pins.map((p) => `${p.id}@${p.version}`), []]) }
}

function keyOf(setup: ModelSetup, host: readonly Pack[]): string {
  return JSON.stringify([setup.key, host.map((p) => `${p.manifest.id}@${p.manifest.version}`)])
}

/**
 * Bind a model to the add-ons it uses that this host has: its pins, its own
 * add-on switches and its pinned firm disciplines (idempotent: a model whose
 * setup and host list are unchanged keeps its set). Called on every model
 * change by the surface, so a switch another person made rebinds here too.
 * A pin this host lacks is logged once per binding and left out: the model
 * still opens with the built-in trades.
 */
export function bindPinnedPacks(model: PinnedModel, baseHost: readonly Pack[] = installed): PackSet {
  ensureFirstPartyAddOns()
  const setup = setupOf(model)
  const { host, blocked, warnings } = withOutsidePacks(model, setup, baseHost)
  const key = keyOf(setup, host)
  const held = modelPackSet(model.modelId)
  if (held && boundKey.get(model.modelId) === key) return held
  if (blocked.length > 0) console.error('[building-model] this model pins outside add-ons it can\'t load here; it opens without them', { modelId: model.modelId, blocked })
  if (warnings.length > 0) console.warn('[building-model] outside add-ons loaded with a warning', { modelId: model.modelId, warnings })
  const { set, missing, firmProblems } = resolveModelSetup(setup, host)
  if (missing.length > 0 || firmProblems.length > 0) console.error('[building-model] this model uses add-ons this server does not have; it opens with the built-in trades', { modelId: model.modelId, missing, firmProblems })
  bindModelPacks(model.modelId, set)
  boundKey.set(model.modelId, key)
  return set
}

/** Run a synchronous engine read (lint, calcs, schedules, space uses) with the model's add-ons in force. */
export function withPinnedPacks<R>(model: PinnedModel, fn: () => R, host: readonly Pack[] = installed): R {
  bindPinnedPacks(model, host)
  return withModelPacks(model.modelId, fn)
}

/** Forget a model's binding when its surface closes. */
export function releasePinnedPacks(modelId: string): void {
  boundKey.delete(modelId)
  unbindModelPacks(modelId)
}

// ── Outside pins (round 11 A11, D5) ─────────────────────────────────────────
// The firm's outside data add-ons (Library › Packages), with their reviews. A
// model's pin loads one only while that build is approved (or withdrawn by its
// catalogue, with a warning); pending, rejected, removed or another build stays
// out and the model opens with its records kept. Kept out of the kernel's
// command binder (`installModelSetupHost`), which can't check a pin's build.

let outside: readonly InstalledOutsidePack[] = []

/** Set the firm's installed outside add-ons (from `installedOutsidePacks`); every binding is recomputed. */
export function setOutsidePacks(entries: readonly InstalledOutsidePack[]): void {
  outside = entries
  boundKey.clear()
}

/** The firm's installed outside add-ons this process knows. */
export function outsidePacks(): readonly InstalledOutsidePack[] {
  return outside
}

/** `host` plus the outside add-ons this model's pins may load, their builds checked against the stored pins; and why any didn't. */
function withOutsidePacks(model: PinnedModel, setup: ModelSetup, host: readonly Pack[]): { readonly host: readonly Pack[]; readonly blocked: readonly string[]; readonly warnings: readonly string[] } {
  if (outside.length === 0) return { host, blocked: [], warnings: [] }
  const stored = model.settings.packs ?? []
  const pins = setup.pins.map((p) => (p.digest ? p : (stored.find((s) => s.id === p.id && s.version === p.version && s.digest) ?? p)))
  const { available, blocked, warnings } = outsidePacksForPins(pins, outside)
  return { host: available.length > 0 ? [...host, ...available] : host, blocked: blocked.map((b) => b.words), warnings }
}
