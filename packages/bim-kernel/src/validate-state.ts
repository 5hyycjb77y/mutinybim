/**
 * A model's validation state as plain data (round 9 lane K9), so the process
 * that opens a model adopts what validation already knew about it instead of
 * re-checking every element: one cold pass is 1.6-1.8 s at 1M.
 *
 * What is kept: the open issues and which checks hold them, "fully derived",
 * and which add-on contributions each check reads (the point index). It is
 * written for one state (a revision of one model), one build of the checks
 * (`codeKey`, the host's) and one add-on set (`validationSetKey`).
 *
 * Adopted lazily: a host offers the state it read beside the head
 * (`offerValidationState`); the first fact asked about that record takes it
 * when the revision, build, shape version, element and connection counts and
 * the key of the set the record resolves to all match, and the checks that
 * held issues, run again, give exactly the issues kept. Anything else is the
 * cold pass, as before. Nothing is skipped: what is adopted is what a cold
 * pass over this same state, build and set found.
 */
import { establishedFacts, factsAwaitSetCarry, registerFactsAdoption } from "./network";
import { pinKey, type PackPin } from "./packs/pin";
import { activePackSet, withModelStatePacks } from "./packs/scope";
import { installedFirstPartyPacks, type PackSet } from "./packs/set";
import { PACK_CONTRACT_VERSION } from "./packs/version";
import { elementCount } from "./store";
import { asElementId, type ModelState } from "./types";
import { issuesFromUnits, issuesOf, issueUnitsOf, type ValidationIssue } from "./validate";
import { dropPointReads, exportPointReads, hasUsablePointReads, importPointReads, type PointReadsExport } from "./validate-ledger";

/** The body's shape. Change it and every kept state is ignored (read as a mismatch), never misread. */
export const VALIDATION_STATE_VERSION = 1;

export interface ValidationState {
  readonly version: number;
  readonly revision: number;
  /** `validationSetKey` of the set the facts hold under. */
  readonly setKey: string;
  /** The host's build (its checks). */
  readonly codeKey: string;
  readonly elementCount: number;
  readonly connectionCount: number;
  readonly consistent: boolean;
  readonly issues: readonly ValidationIssue[];
  readonly units: { readonly connections: readonly string[]; readonly elements: readonly string[]; readonly groups: readonly string[]; readonly whole: boolean };
  readonly reads: PointReadsExport;
}

/**
 * Names one add-on set for a kept state: the contract, the installed
 * first-party add-ons, the set's own packs and firm rows, and the build each
 * outside add-on is pinned at (`pins`, the model's: two builds of one version
 * are different add-ons, so their facts are never shared).
 */
export function validationSetKey(set: PackSet, pins: readonly PackPin[] = []): string {
  const base = installedFirstPartyPacks()
    .map((p) => `${p.manifest.id}@${p.manifest.version}`)
    .join(",");
  const builds = pins
    .filter((p) => p.digest !== undefined)
    .map(pinKey)
    .sort()
    .join(",");
  return `contract:${PACK_CONTRACT_VERSION}|base:${base}|set:${set.revision}${builds ? `|builds:${builds}` : ""}`;
}

const pinsOf = (model: ModelState): readonly PackPin[] => model.settings.packs ?? [];

/**
 * `model`'s validation state, or null when it isn't fully known yet. Nothing
 * is established from scratch here (no cold pass): a state is written from
 * what commits and the cold pass already found. After an add-on switch those
 * facts hold under the set before it; they are carried across first, which
 * re-runs only the checks that read what the switched add-on contributes (the
 * work the next edit would do), so a model closed right after a switch keeps
 * its state and the next process adopts it instead of checking everything.
 */
export function validationStateOf(model: ModelState, codeKey: string): ValidationState | null {
  let known = establishedFacts(model);
  if (!known && factsAwaitSetCarry(model) && hasUsablePointReads(model)) {
    withModelStatePacks(model, () => issuesOf(model));
    known = establishedFacts(model);
  }
  if (!known) return null;
  const units = issueUnitsOf(model, known.issues);
  if (!units) return null;
  const reads = exportPointReads(model);
  if (!reads) return null;
  return {
    version: VALIDATION_STATE_VERSION,
    revision: model.revision,
    setKey: validationSetKey(known.rules, pinsOf(model)),
    codeKey,
    elementCount: elementCount(model.elements),
    connectionCount: model.connections.length,
    consistent: known.consistent,
    issues: known.issues.map((i) => ({ code: i.code, message: i.message, elementIds: [...i.elementIds] })),
    units: { connections: [...units.connections], elements: [...units.elements], groups: [...units.groups], whole: units.whole },
    reads,
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const isNumbers = (v: unknown): v is number[] => Array.isArray(v) && v.every((x) => typeof x === "number");

function isIssue(v: unknown): v is ValidationIssue {
  return isObject(v) && typeof v.code === "string" && typeof v.message === "string" && isStrings(v.elementIds);
}

function isReads(v: unknown): v is PointReadsExport {
  if (!isObject(v)) return false;
  return (
    Array.isArray(v.keys) &&
    v.keys.every((k) => isObject(k) && typeof k.kind === "number" && typeof k.id === "string") &&
    Array.isArray(v.signatures) &&
    v.signatures.every(isNumbers) &&
    isObject(v.byKind) &&
    Object.values(v.byKind).every((n) => typeof n === "number") &&
    isStrings(v.exceptionIds) &&
    isNumbers(v.exceptionSigs) &&
    typeof v.connectionSig === "number" &&
    typeof v.groupSig === "number" &&
    typeof v.wholeSig === "number"
  );
}

/** A kept state read back from storage, checked for shape (any other body is a mismatch). */
export function isValidationState(v: unknown): v is ValidationState {
  if (!isObject(v) || !isObject(v.units)) return false;
  return (
    v.version === VALIDATION_STATE_VERSION &&
    typeof v.revision === "number" &&
    typeof v.setKey === "string" &&
    typeof v.codeKey === "string" &&
    typeof v.elementCount === "number" &&
    typeof v.connectionCount === "number" &&
    typeof v.consistent === "boolean" &&
    Array.isArray(v.issues) &&
    v.issues.every(isIssue) &&
    isStrings(v.units.connections) &&
    isStrings(v.units.elements) &&
    isStrings(v.units.groups) &&
    typeof v.units.whole === "boolean" &&
    isReads(v.reads)
  );
}

/** Why the last offered state was or wasn't adopted, and how often (tests, /metrics). */
export interface ValidationStateStats {
  adopted: number;
  declined: number;
  lastDeclined: string | null;
}

const stats: ValidationStateStats = { adopted: 0, declined: 0, lastDeclined: null };

export function validationStateStats(): Readonly<ValidationStateStats> {
  return { ...stats };
}

interface Offer {
  readonly state: unknown;
  readonly codeKey: string;
}

const offers = new WeakMap<object, Offer>();

/** Offer a kept state for `model` (read beside its head); the first fact asked about the record decides whether it is adopted. */
export function offerValidationState(model: ModelState, state: unknown, codeKey: string): void {
  offers.set(model.elements, { state, codeKey });
}

function decline(reason: string): null {
  stats.declined += 1;
  stats.lastDeclined = reason;
  return null;
}

/** Runs inside the set the record's facts hold under (network.ts `establishCold`). */
function adoptOffered(model: ModelState): { readonly consistent: boolean; readonly issues: readonly ValidationIssue[] } | null {
  const rules = activePackSet();
  const offer = offers.get(model.elements);
  if (!offer) return null;
  offers.delete(model.elements);
  const { state, codeKey } = offer;
  if (!isValidationState(state)) return decline("shape");
  if (state.codeKey !== codeKey) return decline("build");
  if (state.revision !== model.revision) return decline("revision");
  if (state.setKey !== validationSetKey(rules)) return decline("add-on set");
  if (state.elementCount !== elementCount(model.elements) || state.connectionCount !== model.connections.length) return decline("counts");
  if (!importPointReads(model, state.reads)) return decline("reads");
  const units = { connections: state.units.connections, elements: state.units.elements.map(asElementId), groups: state.units.groups.map(asElementId), whole: state.units.whole };
  const issues = issuesFromUnits(model, units, state.issues);
  if (!issues) {
    dropPointReads(model);
    return decline("issues");
  }
  stats.adopted += 1;
  return { consistent: state.consistent, issues };
}

registerFactsAdoption(adoptOffered);
