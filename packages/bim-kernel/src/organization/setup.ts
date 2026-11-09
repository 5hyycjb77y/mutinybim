import { contribute, type Pack } from "../packs/contract";
import { firstPartyBaseRevision, installedFirstPartyPacks, PackSet, PackSetError, type PackPin } from "../packs/set";
import { pinKey, type PackDigest, type PackTier } from "../packs/pin";
import { setModelStateBinder, type ModelPackState, type ModelStateBinder } from "../packs/scope";
import { DISCIPLINE_POINT, type DisciplineDef } from "../disciplines/types";
import { organizationOf } from "./model";
import { registerRevisionCarry } from "../revision-carry";
import { elementsOfKind } from "../store";
import type { BimElement } from "../types";

/**
 * Model setup that travels in changesets (round 8): which add-ons a model
 * uses and which firm disciplines are pinned to it, as organization records
 * (`AddonSetupEntry`, `DisciplineSetupEntry`). This file turns a model state
 * into the pack set it opens with: `settings.packs`, minus add-ons switched
 * off, plus add-ons switched on, with pinned firm disciplines as firm rows
 * (`PackSetOptions.firm`). Hosts register `createModelStateBinder` over the
 * packs they install, so `executeCommand` and host reads resolve the set
 * from the state they run on.
 */

/** Peers that read and store add-on and discipline setup entries. A writer stores them only when the peers list it. */
export const ORGANIZATION_SETUP_FEATURE = "organization:setup";

/** The record id of a model's switch for one add-on. */
export function addonSetupId(packId: string): string {
  return `setup-addon:${packId}`;
}

/** The record id of a firm discipline pinned to a model. */
export function disciplineSetupId(disciplineId: string): string {
  return `setup-discipline:${disciplineId}`;
}

/** Whether a record id is a model setup record (a host rebinds the model after a commit touching one). */
export function isModelSetupRecordId(id: string): boolean {
  return id.startsWith("setup-addon:") || id.startsWith("setup-discipline:");
}

export interface ModelSetup {
  /** True when the model stores at least one setup entry (on or off, pinned or unpinned). */
  readonly hasEntries: boolean;
  /** The pins the model opens with: `settings.packs` with switched-off add-ons removed and switched-on ones added. */
  readonly pins: readonly PackPin[];
  /** Firm disciplines pinned to the model, in record order. */
  readonly firmDisciplines: readonly DisciplineDef[];
  /** Stable text for the above; equal keys resolve to the same set on the same host. */
  readonly key: string;
}

const NO_SETUP: ModelSetup = { hasEntries: false, pins: [], firmDisciplines: [], key: "" };

interface CachedSetup {
  readonly packs: readonly PackPin[] | undefined;
  readonly setup: ModelSetup;
}

/** Per organization view (itself cached per elements record and carried across unrelated edits). */
const setupCache = new WeakMap<object, CachedSetup>();

type Elements = ModelPackState["elements"];

function isSetupRecord(el: BimElement | undefined): boolean {
  return el?.kind === "organization" && (el.entry.type === "addon" || el.entry.type === "discipline");
}

/**
 * Per elements record: whether it holds any setup record, in any zone (a
 * superset of what the organization view counts, so "none" here is "none"
 * there). Read from the store's kind index, not the organization view: a
 * head no command produced (just loaded, or an applied changeset) would
 * otherwise build the partition index for every read under
 * `withModelStatePacks`. Carried to the next revision unless it changed an
 * organization record.
 */
const setupRecordsIn = new WeakMap<Elements, boolean>();

function holdsSetupRecords(elements: Elements): boolean {
  const known = setupRecordsIn.get(elements);
  if (known !== undefined) return known;
  const holds = elementsOfKind(elements, "organization").some(isSetupRecord);
  setupRecordsIn.set(elements, holds);
  return holds;
}

registerRevisionCarry("organization.setup-records", (from, to, changedIds) => {
  const known = setupRecordsIn.get(from);
  if (known === undefined || setupRecordsIn.has(to)) return;
  for (const id of changedIds) if (from[id]?.kind === "organization" || to[id]?.kind === "organization") return;
  setupRecordsIn.set(to, known);
});

/** `settings.packs` alone, for a model with no setup record. */
const pinsOnly = new WeakMap<readonly PackPin[], ModelSetup>();

function pinsOnlySetup(packs: readonly PackPin[] | undefined): ModelSetup {
  if (!packs || packs.length === 0) return NO_SETUP;
  const known = pinsOnly.get(packs);
  if (known) return known;
  const setup: ModelSetup = { ...NO_SETUP, pins: packs, key: pinsKey(packs, []) };
  pinsOnly.set(packs, setup);
  return setup;
}

/** The model's setup: one map read on a revision with no setup record; else O(setup entries) the first time per organization view, one map read after. */
export function modelSetupOf(model: Pick<ModelPackState, "elements" | "connections" | "settings">): ModelSetup {
  if (!holdsSetupRecords(model.elements)) return pinsOnlySetup(model.settings.packs);
  const org = organizationOf(model);
  const hit = setupCache.get(org);
  if (hit && hit.packs === model.settings.packs) return hit.setup;
  // A removed pin still counts: the binder must resolve the model without it rather than leave an older binding in force.
  let hasEntries = false;
  for (const record of org.stored.values()) {
    if (record.entry.type === "addon" || record.entry.type === "discipline") {
      hasEntries = true;
      break;
    }
  }
  const pins = model.settings.packs ?? [];
  const setup = hasEntries ? computeSetup(org.addons.map((a) => a.entry), org.pinnedDisciplines.map((d) => d.entry.discipline), model.settings.packs) : pins.length === 0 ? NO_SETUP : { ...NO_SETUP, pins, key: pinsKey(pins, []) };
  setupCache.set(org, { packs: model.settings.packs, setup });
  return setup;
}

/** One add-on's switch as setup reads it: the stored entry, or the one a command is about to write. */
export interface AddonSwitch {
  readonly packId: string;
  readonly version: string;
  readonly on: boolean;
  readonly digest?: PackDigest;
  readonly tier?: PackTier;
}

/**
 * The pin a switch makes: its version, and its build and tier when it names them. A switch that
 * names no build keeps the settings pin's when the version is the same (switching an outside
 * add-on off and on again never drops which build the model pinned).
 */
function switchedPin(s: AddonSwitch, settingsPin: PackPin | undefined): PackPin {
  if (s.digest !== undefined) return { id: s.packId, version: s.version, digest: s.digest, ...(s.tier !== undefined ? { tier: s.tier } : {}) };
  if (settingsPin && settingsPin.version === s.version && settingsPin.digest !== undefined) return { id: s.packId, version: s.version, digest: settingsPin.digest, ...(settingsPin.tier !== undefined ? { tier: settingsPin.tier } : {}) };
  return { id: s.packId, version: s.version };
}

function computeSetup(switches: readonly AddonSwitch[], firmDisciplines: readonly DisciplineDef[], settingsPins: readonly PackPin[] | undefined): ModelSetup {
  const switched = new Map(switches.map((s) => [s.packId, s] as const));
  const pins: PackPin[] = [];
  for (const pin of settingsPins ?? []) {
    const s = switched.get(pin.id);
    if (s && !s.on) continue;
    pins.push(s ? switchedPin(s, pin) : pin);
  }
  for (const s of switches) if (s.on && !pins.some((p) => p.id === s.packId)) pins.push(switchedPin(s, undefined));
  return { hasEntries: true, pins, firmDisciplines, key: pinsKey(pins, firmDisciplines) };
}

function pinsKey(pins: readonly PackPin[], firm: readonly DisciplineDef[]): string {
  return JSON.stringify([pins.map(pinKey), firm]);
}

export interface ResolvedModelPacks {
  readonly set: PackSet;
  /** Pins this host lacks (pack or exact version); the model still opens without them. */
  readonly missing: readonly PackPin[];
  /** Why the pinned firm disciplines were left out, if they were (a stored row a newer release wrote, say). */
  readonly firmProblems: readonly string[];
}

/**
 * The packs a model's pins name among `available`, and the pins it lacks. A
 * pin for an installed first-party add-on the host doesn't list (one a model
 * switched on before it became first-party) is neither: every model opens
 * with that add-on already.
 */
export function pinnedPacks(pins: readonly PackPin[], available: readonly Pack[]): { readonly chosen: readonly Pack[]; readonly missing: readonly PackPin[] } {
  const chosen: Pack[] = [];
  const missing: PackPin[] = [];
  for (const pin of pins) {
    const exact = available.find((p) => p.manifest.id === pin.id && p.manifest.version === pin.version);
    if (exact) chosen.push(exact);
    else if (!installedFirstPartyPacks().some((p) => p.manifest.id === pin.id)) missing.push(pin);
  }
  return { chosen, missing };
}

/** Resolve a model's setup against the packs a host has. Never throws for stored data: problems are reported, rows left out. */
export function resolveModelSetup(setup: ModelSetup, available: readonly Pack[]): ResolvedModelPacks {
  const { chosen, missing } = pinnedPacks(setup.pins, available);
  const firm = setup.firmDisciplines.length > 0 ? { firm: [contribute(DISCIPLINE_POINT, setup.firmDisciplines)] } : {};
  try {
    return { set: PackSet.create(chosen, firm), missing, firmProblems: [] };
  } catch (err) {
    if (!(err instanceof PackSetError)) throw err;
    console.error("[bim-kernel/organization] the model's add-on setup was refused; it opens without the add-ons and firm rows that conflict", { problems: err.problems });
    try {
      return { set: PackSet.create(chosen), missing, firmProblems: err.problems };
    } catch (again) {
      if (!(again instanceof PackSetError)) throw again;
      console.error("[bim-kernel/organization] the model's add-ons were refused together; it opens with the built-in and first-party trades only", { problems: again.problems });
      return { set: PackSet.create([]), missing: [...missing, ...chosen.map((p) => ({ id: p.manifest.id, version: p.manifest.version }))], firmProblems: [...err.problems, ...again.problems] };
    }
  }
}

/** The proposed pins and firm rows as a set, or the problems that refuse it (`PackSet.create`'s words). */
export function setupProblems(setup: Pick<ModelSetup, "pins" | "firmDisciplines">, available: readonly Pack[]): readonly string[] {
  const { chosen } = pinnedPacks(setup.pins, available);
  try {
    PackSet.create(chosen, setup.firmDisciplines.length > 0 ? { firm: [contribute(DISCIPLINE_POINT, setup.firmDisciplines)] } : {});
    return [];
  } catch (err) {
    if (err instanceof PackSetError) return err.problems;
    throw err;
  }
}

/** Next setup if one add-on's switch changes (for commands checking before they write). */
export function setupWithSwitch(model: Pick<ModelPackState, "elements" | "connections" | "settings">, packId: string, version: string, on: boolean, build: Pick<AddonSwitch, "digest" | "tier"> = {}): ModelSetup {
  const org = organizationOf(model);
  const switches: AddonSwitch[] = [...org.addons.map((a) => a.entry).filter((s) => s.packId !== packId), { packId, version, on, ...build }];
  return computeSetup(switches, org.pinnedDisciplines.map((d) => d.entry.discipline), model.settings.packs);
}

/** Next setup if the firm disciplines pinned change to `firm`. */
export function setupWithFirm(model: Pick<ModelPackState, "elements" | "connections" | "settings">, firm: readonly DisciplineDef[]): ModelSetup {
  const org = organizationOf(model);
  return computeSetup(org.addons.map((a) => a.entry), firm, model.settings.packs);
}

let hostPacks: (() => readonly Pack[]) | null = null;

/**
 * A host's one call: register its installed add-ons with the kernel, as the
 * model-state binder (`withModelStatePacks`) and as the list setup commands
 * check a switch against. Returns the undo.
 */
export function installModelSetupHost(available: () => readonly Pack[], options: ModelStateBinderOptions = {}): () => void {
  const undoBinder = setModelStateBinder(createModelStateBinder(available, options));
  const previous = hostPacks;
  hostPacks = available;
  return () => {
    undoBinder();
    hostPacks = previous;
  };
}

/** The add-ons the registered host installs; null when no host registered (a script, a kernel test without one). */
export function modelSetupHostPacks(): readonly Pack[] | null {
  return hostPacks ? hostPacks() : null;
}

export interface ModelStateBinderOptions {
  /** Called once per new resolution that has missing pins or refused firm rows. */
  readonly onProblem?: (modelId: string, resolved: ResolvedModelPacks) => void;
}

/**
 * A host's binder: resolves a model state with setup entries to its set,
 * memoised per model by the setup key, the host's pack list and the
 * first-party install. States of a model that has never had a setup entry
 * return null, so the host's own binding by id (`bindModelPacks`) stays in
 * force unchanged; once a model has had one (an undo can remove the record
 * again), the binder keeps answering for it from `settings.packs`.
 */
export function createModelStateBinder(available: () => readonly Pack[], options: ModelStateBinderOptions = {}): ModelStateBinder {
  // Runs on every command: the hit compares the parts of the key (the host's list by identity first) instead of building it.
  const held = new Map<string, { readonly setupKey: string; readonly host: readonly Pack[]; readonly hostKey: string; readonly revision: number; readonly set: PackSet }>();
  const hostKeyOf = (host: readonly Pack[]): string => host.map((p) => `${p.manifest.id}@${p.manifest.version}`).join(",");
  return (model) => {
    const setup = modelSetupOf(model);
    const hit = held.get(model.modelId);
    if (!setup.hasEntries && !hit) return null;
    const host = available();
    const revision = firstPartyBaseRevision();
    if (hit && hit.setupKey === setup.key && hit.revision === revision && (hit.host === host || hit.hostKey === hostKeyOf(host))) return hit.set;
    const resolved = resolveModelSetup(setup, host);
    if (resolved.missing.length > 0 || resolved.firmProblems.length > 0) {
      if (options.onProblem) options.onProblem(model.modelId, resolved);
      else console.error("[bim-kernel/organization] this model's setup names add-ons this host doesn't have; it opens without them", { modelId: model.modelId, missing: resolved.missing, firmProblems: resolved.firmProblems });
    }
    held.set(model.modelId, { setupKey: setup.key, host, hostKey: hostKeyOf(host), revision, set: resolved.set });
    return resolved.set;
  };
}
