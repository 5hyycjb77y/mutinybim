import { loadPointFingerprint } from "./load-points/fingerprint";
import { shareLoadIndex } from "./requirements/load-index";
import { distance } from "./geometry";
import { KernelError, type KernelErrorCode, type TrackedReader } from "./model";
import { recomputeDerivedAfter } from "./derived";
import { markKnownIssues } from "./network";
import { canonicalJson } from "./canonical";
import { checkEdit, type ValidationIssue } from "./validate";
import { documentFieldValue } from "./document-fields";
import { organizationFieldValue } from "./organization/fields";
import { lockRefusal, stampNewElements } from "./organization/rules";
import { carryOrganization } from "./organization/model";
import { carryClassIndexes } from "./registry/recognition";
import { carryRevision } from "./revision-carry";
import { serviceFingerprint } from "./connections/links";
import { authoredShapeField, kindFieldValue, storedField } from "./kinds";
import { connectorEndsTable } from "./kinds/ends";
import type { BimElement, Connection, ElementId, ModelState, Profile, RunSize, Vec2 } from "./types";
import type { SharedCoordinates, SitePoint } from "./site";
import type { Command } from "./commands";

export type AuthoredValue = number | string | boolean | Vec2 | Profile | RunSize | SitePoint | SharedCoordinates;

/** An explicitly chosen value. Competing authored values conflict. */
export interface AuthoredWrite {
  readonly elementId: ElementId;
  readonly field: string;
  readonly value: AuthoredValue;
}

/**
 * A serializable statement of what a command meant. Stored with the
 * changeset so later commits that propagate geometry can check they still
 * hold, and conflict instead of silently undoing someone's work.
 */
export type IntentPredicate =
  | { readonly kind: "tap_at"; readonly tapId: ElementId; readonly position: Vec2 }
  | { readonly kind: "field_equals"; readonly elementId: ElementId; readonly field: string; readonly value: AuthoredValue };

export interface CommandError {
  readonly code: KernelErrorCode | "stale_base" | "conflict" | "forbidden";
  readonly message: string;
  readonly elementIds: readonly ElementId[];
  readonly limit?: SlideLimit;
}

export interface SlideLimit {
  readonly requested: number;
  readonly accepted: number;
  readonly binding: { readonly code: CommandError["code"]; readonly message: string } | null;
}

export interface ExecuteOk {
  readonly ok: true;
  /** New state with derived values recomputed (revision not yet bumped). */
  readonly model: ModelState;
  /** Elements created or changed (removed ones are in `removedIds`). */
  readonly changedIds: readonly ElementId[];
  /** Elements the command removed. */
  readonly removedIds: readonly ElementId[];
  /** Connections the command cut (delete with the disconnect or cascade policy). */
  readonly removedConnections: readonly Connection[];
  /** Connections the command made (undo of a delete puts cut connections back). */
  readonly addedConnections: readonly Connection[];
  /** Server-derived: every element read, with the version seen. */
  readonly readSet: Readonly<Record<string, number>>;
  readonly authored: readonly AuthoredWrite[];
  readonly intents: readonly IntentPredicate[];
  /** What happened beyond the changed elements, in words (a delete that capped run ends). Absent when there is nothing to say. */
  readonly summary?: readonly string[];
  /** Issues that were already open before this edit and still are. Absent when the model is valid. */
  readonly openIssues?: readonly ValidationIssue[];
}

export interface ExecuteErr {
  readonly ok: false;
  readonly error: CommandError;
}

export type ExecuteResult = ExecuteOk | ExecuteErr;

function valuesField(record: Readonly<Record<string, number | string | boolean>>, field: string, prefix: string): AuthoredValue | undefined {
  return field.startsWith(prefix) ? record[field.slice(prefix.length)] : undefined;
}

function isPoint(v: AuthoredValue | undefined): v is Vec2 {
  return typeof v === "object" && v !== null && "x" in v && "y" in v && typeof v.x === "number" && typeof v.y === "number";
}

/** A stored field read by name, as a value intents compare: text, numbers, flags and points (the forms a kind's authored shape fields take). */
function asAuthored(v: unknown): AuthoredValue | undefined {
  if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "object" && v !== null && "x" in v && "y" in v && typeof v.x === "number" && typeof v.y === "number") return { x: v.x, y: v.y };
  return undefined;
}

/** How far along its host a placed record sits, when its row places it by the stored field `field` (`hostedBy.placement.along`). */
function placedAlong(el: BimElement, field: string): number | undefined {
  if (connectorEndsTable().placement(el.kind)?.along !== field) return undefined;
  const v = storedField(el, field);
  return typeof v === "number" ? v : undefined;
}

export function authoredFieldValue(el: BimElement, field: string): AuthoredValue | undefined {
  if (el.kind === "part" && field.startsWith("values.")) return valuesField(el.values, field, "values.");
  if (el.kind === "part_type" && field.startsWith("typeValues.")) return valuesField(el.definition.typeValues, field, "typeValues.");
  switch (field) {
    case "s":
      return el.kind === "run_fitting" ? el.host?.s : placedAlong(el, "s");
    case "family":
      return el.kind === "run_fitting" ? el.family : undefined;
    case "coefficientOverride.c":
      return el.kind === "run_fitting" ? el.coefficientOverride?.c ?? "none" : undefined;
    case "design":
      return el.kind === "mep_system" ? canonicalJson(el.design ?? null) + canonicalJson(el.fittingDefaults ?? null) + canonicalJson(el.coefficientTable ?? null) : undefined;
    case "host":
      return el.kind === "part" ? canonicalJson(el.host ?? null) + canonicalJson(el.curbMm ?? null) : undefined;
    case "clearances":
      return el.kind === "part" ? canonicalJson(el.clearances ?? null) : el.kind === "part_type" ? canonicalJson(el.definition.clearances ?? null) : undefined;
    case "size":
      return el.kind === "run_segment" ? el.size : undefined;
    case "profile":
      return "profile" in el ? el.profile : undefined;
    case "position":
      return el.kind === "part" ? el.position : asAuthored(authoredShapeField(el, "position"));
    case "start":
      return el.kind === "wall" ? el.start : undefined;
    case "end":
      return el.kind === "wall" ? el.end : undefined;
    case "offset":
      return el.kind === "tag" || el.kind === "opening" ? el.offset : undefined;
    case "text":
      return el.kind === "tag" ? el.text : undefined;
    case "offsetMm":
      return el.kind === "part" ? el.offsetMm : undefined;
    case "rotationDeg":
      return el.kind === "part" ? el.rotationDeg : undefined;
    case "mark":
      return el.kind === "part" ? el.mark : asAuthored(authoredShapeField(el, "mark"));
    case "name":
      return el.kind === "level" || el.kind === "mounting_plane" ? el.name : undefined;
    case "heightMm":
      return el.kind === "mounting_plane" ? el.heightMm : undefined;
    case "mount":
      return el.kind === "part" ? (el.mount ?? "as_drawn") : undefined;
    case "intakes":
      return el.kind === "part" ? canonicalJson(el.intakes ?? null) : undefined;
    case "elevationMm":
      return el.kind === "level" ? el.elevationMm : undefined;
    case "basePoint":
      return el.kind === "site" ? el.basePoint : undefined;
    case "basePointShared":
      return el.kind === "site" ? el.basePointShared : undefined;
    case "trueNorthDeg":
      return el.kind === "site" ? el.trueNorthDeg : undefined;
    case "surveyPoint":
      return el.kind === "site" ? el.surveyPoint : undefined;
    case "workingAngleDeg":
      return el.kind === "site" ? (el.workingAngleDeg ?? 0) : undefined;
    case "service":
      return el.kind === "service_link" ? serviceFingerprint(el) : undefined;
    case "catalog":
      return el.kind === "service_catalog" ? canonicalJson(el.entry) : "";
    case "load_point":
      return el.kind === "load_point" ? loadPointFingerprint(el) : "";
    default:
      // A value an add-on-owned kind keeps, by the flat name old changesets stored it under or its parameter key.
      return kindFieldValue(el, field) ?? documentFieldValue(el, field) ?? organizationFieldValue(el, field);
  }
}

export function sameValue(a: AuthoredValue | undefined, b: AuthoredValue | undefined): boolean {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-6;
  return canonicalJson(a ?? null) === canonicalJson(b ?? null);
}

export function intentHolds(model: ModelState, intent: IntentPredicate): boolean {
  const el = model.elements[intent.kind === "tap_at" ? intent.tapId : intent.elementId];
  if (!el) return false;
  if (intent.kind === "tap_at") {
    const at = connectorEndsTable().placement(el.kind)?.at;
    const position = at === undefined ? undefined : asAuthored(storedField(el, at));
    return isPoint(position) && distance(position, intent.position) <= model.settings.connectorToleranceMm;
  }
  return sameValue(authoredFieldValue(el, intent.field), intent.value);
}

export function describeIntent(intent: IntentPredicate): string {
  if (intent.kind === "tap_at") return `${intent.tapId} placed at its chosen position`;
  return `${intent.elementId}.${intent.field} set explicitly`;
}

/** Each successful result's element record, still writable, for the one commit that consumes it. */
const ownedRecords = new WeakMap<ExecuteOk, Record<string, BimElement>>();

/**
 * Hand over a result's freshly built element record so a commit can stamp
 * versions into it instead of copying the whole model again. Returns null if
 * already taken.
 */
export function takeOwnedElements(result: ExecuteOk): Record<string, BimElement> | null {
  const record = ownedRecords.get(result);
  if (!record) return null;
  ownedRecords.delete(result);
  return record;
}

function issueError(issue: ValidationIssue | null): ExecuteErr | null {
  if (!issue) return null;
  return { ok: false, error: { code: issue.code, message: issue.message, elementIds: issue.elementIds } };
}

export interface StructuralChanges {
  readonly removedIds?: readonly ElementId[];
  readonly removedConnections?: readonly Connection[];
  readonly addedConnections?: readonly Connection[];
  readonly summary?: readonly string[];
}

/** The connection list after a command's cuts and additions (the same array when there are none). */
export function nextConnections(current: readonly Connection[], changes: StructuralChanges): readonly Connection[] {
  const cut = changes.removedConnections ?? [];
  const added = changes.addedConnections ?? [];
  if (cut.length === 0 && added.length === 0) return current;
  const gone = new Set(cut.map((c) => c.id));
  const present = new Set(current.map((c) => c.id));
  return [...current.filter((c) => !gone.has(c.id)), ...added.filter((c) => !present.has(c.id))];
}

/** Re-derive, validate and package a command's working copy. Every command ends here. */
export function finish(
  reader: TrackedReader,
  working: Record<string, BimElement>,
  touched: Iterable<ElementId>,
  authored: AuthoredWrite[],
  intentsFor: (model: ModelState) => IntentPredicate[],
  changes: StructuralChanges = {},
): ExecuteResult {
  const removed = new Set<ElementId>(changes.removedIds ?? []);
  const touchedIds = [...new Set<ElementId>([...touched, ...removed])];
  runEditHooks(reader.model, working, touchedIds);
  stampNewElements(reader.model, working, touchedIds);
  const locked = lockRefusal(reader.model, working, touchedIds);
  if (locked) return { ok: false, error: { code: "locked", message: locked.message, elementIds: locked.elementIds } };
  const connections = nextConnections(reader.model.connections, changes);
  const base: ModelState = connections === reader.model.connections ? reader.model : { ...reader.model, connections };
  // The command has written all its loads: carry the load index so the walks below read it without a pass.
  shareLoadIndex(reader.model.elements, working, touchedIds);
  const derived = recomputeDerivedAfter(base, working, touchedIds);
  const changed = new Set<ElementId>([...touchedIds, ...derived.changedIds]);
  // An element whose only change is its airflow total can't raise an issue: no validation rule reads airflow.
  const airflowOnly = derived.airflowOnlyIds && derived.airflowOnlyIds.length > 0 ? new Set(derived.airflowOnlyIds) : null;
  // They keep their kind too, so carrying the organization index can skip them.
  const beyondAirflow = airflowOnly ? [...changed].filter((id) => !airflowOnly.has(id)) : [...changed];
  const check = checkEdit(reader.model, base, derived.model, beyondAirflow, touchedIds);
  const err = issueError(check.refusal);
  if (err) return err;
  markKnownIssues(derived.model, check.open);
  carryOrganization(reader.model.elements, derived.model.elements, beyondAirflow);
  carryClassIndexes(reader.model.elements, derived.model.elements, changed);
  carryRevision(reader.model.elements, derived.model.elements, changed);
  const result: ExecuteOk = {
    ok: true,
    model: derived.model,
    changedIds: [...changed].filter((id) => !removed.has(id)),
    removedIds: [...removed],
    removedConnections: changes.removedConnections ?? [],
    addedConnections: changes.addedConnections ?? [],
    readSet: reader.readSet(),
    authored,
    intents: intentsFor(derived.model),
    ...(changes.summary && changes.summary.length > 0 ? { summary: changes.summary } : {}),
    ...(check.open.length > 0 ? { openIssues: check.open } : {}),
  };
  if (derived.model.elements === working) ownedRecords.set(result, working);
  return result;
}

export function guard(fn: () => ExecuteResult): ExecuteResult {
  try {
    return fn();
  } catch (err) {
    if (err instanceof KernelError) {
      return { ok: false, error: { code: err.code, message: err.message, elementIds: err.elementIds } };
    }
    throw err;
  }
}

export function refuse(code: KernelErrorCode, message: string, elementIds: readonly ElementId[] = []): never {
  throw new KernelError(code, message, elementIds);
}

// ── Handler table ────────────────────────────────────────────────────────────
//
// The edit spine imports no domain. What it needs from above (the full intent
// schema, steps that run inside every edit) is registered here at startup by
// the module that owns it; `commands.ts` registers the parser when it loads.

/** A raw command checked against the full intent schema. */
export type CommandParser = (raw: unknown) => { readonly success: true; readonly data: Command } | { readonly success: false; readonly error: { readonly issues: readonly { readonly message: string }[] } };

/**
 * A step every command's `finish` runs on its working copy (an upgrade on
 * edit). It may rewrite elements in `touchedIds` only, or push the id of an
 * element it rewrites because of them (a space bounded by a wall that moved).
 */
export type EditHook = (base: ModelState, working: Record<string, BimElement>, touchedIds: ElementId[]) => void;

interface CommandHandlerTable {
  parser: CommandParser | null;
  readonly editHooks: Map<string, EditHook>;
}

const handlers: CommandHandlerTable = { parser: null, editHooks: new Map() };

/** Register the intent-command parser (`commands.ts` does, once, when it loads). */
export function registerCommandParser(parser: CommandParser): void {
  handlers.parser = parser;
}

/** Check raw input against the full intent schema. Throws when nothing registered one: the kernel was loaded without its commands. */
export function parseCommand(raw: unknown): ReturnType<CommandParser> {
  if (!handlers.parser) throw new Error("No command parser is registered: load @permitzip/bim-kernel (or its commands entry) before checking commands");
  return handlers.parser(raw);
}

/** Register an edit hook under `id` (registering the same id again replaces it, in its original place). */
export function registerEditHook(id: string, hook: EditHook): void {
  handlers.editHooks.set(id, hook);
}

/** Run every registered edit hook, in registration order. */
export function runEditHooks(base: ModelState, working: Record<string, BimElement>, touchedIds: ElementId[]): void {
  for (const hook of handlers.editHooks.values()) hook(base, working, touchedIds);
}
