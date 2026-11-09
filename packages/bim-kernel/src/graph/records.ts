import { parseJurisdiction } from "../jurisdiction";
import { registerSchemaStep, schemaSteps, stepAllowed, type SchemaStep } from "../schema-version/registry";
import type { BimElement } from "../types";
import {
  GRAPH_DETERMINATIONS_FEATURE,
  GRAPH_REQUIREMENT_STATES_FEATURE,
  GRAPH_RULES_FEATURE,
  type Applicability,
  type DeterminationBody,
  type DeterminationElement,
  type InputRef,
  type ObservationBody,
  type ObservationElement,
  type RequirementStateBody,
  type RequirementStateElement,
  type RequirementTemplate,
  type RuleEffect,
  type RuleElement,
  type RuleRecord,
  type RuleTable,
} from "./types";

/**
 * Graph records as this release reads and gates them (contract 1.4.0).
 *
 * Readers are tolerant: a field, kind, status or key this release doesn't
 * know is kept (the stored record is returned as it was, never rewritten
 * here), and a record that isn't one at all is refused with the reason.
 * Writers are strict: `determination`, `rule` and `requirement_state` records
 * are stored only when the peers advertise `graph:determinations`,
 * `graph:rules` and `graph:requirement_states`. Each feature is a gated
 * record step on its kind, so it joins `gatedRecordFeatures()` and every
 * client and server of this release advertises it. `graph:observations` has
 * no step: no peer of this release advertises it, so nothing writes one.
 *
 * The steps have no per-record upgrade (records are never rewritten in bulk),
 * and every stored graph record already reads at the step's version.
 */

const step = (kind: "determination" | "rule" | "requirement_state", feature: string): SchemaStep => ({ kind, from: 1, to: 2, name: `graph-${kind}`, feature, detect: () => false });

export const DETERMINATION_RECORD_STEP = step("determination", GRAPH_DETERMINATIONS_FEATURE);
export const RULE_RECORD_STEP = step("rule", GRAPH_RULES_FEATURE);
export const REQUIREMENT_STATE_RECORD_STEP = step("requirement_state", GRAPH_REQUIREMENT_STATES_FEATURE);

for (const s of [DETERMINATION_RECORD_STEP, RULE_RECORD_STEP, REQUIREMENT_STATE_RECORD_STEP]) {
  if (!schemaSteps(s.kind).some((x) => x.name === s.name)) registerSchemaStep(s);
}

/** Whether the command being decided may store a determination (the peers read `graph:determinations`). */
export function determinationsWritable(): boolean {
  return stepAllowed(DETERMINATION_RECORD_STEP);
}

/** Whether the command being decided may store a local rule (the peers read `graph:rules`). */
export function rulesWritable(): boolean {
  return stepAllowed(RULE_RECORD_STEP);
}

/** Whether the command being decided may store a requirement state (the peers read `graph:requirement_states`). */
export function requirementStatesWritable(): boolean {
  return stepAllowed(REQUIREMENT_STATE_RECORD_STEP);
}

// ── tolerant readers ───────────────────────────────────────────────────────

export type ReadResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

type Raw = Readonly<Record<string, unknown>>;

function isRecord(v: unknown): v is Raw {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const isText = (v: unknown): v is string => typeof v === "string";
const isScalar = (v: unknown): v is number | string | boolean => typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));
const texts = (v: unknown): v is readonly string[] => Array.isArray(v) && v.every(isText);

function bad<T>(reason: string): ReadResult<T> {
  return { ok: false, reason };
}

function readInputs(raw: unknown): readonly InputRef[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const out: InputRef[] = [];
  for (const i of raw) {
    if (!isRecord(i) || !isText(i.key)) return null;
    out.push({ ...i, key: i.key } as InputRef);
  }
  return out;
}

/** A stored determination body, checked; unknown fields kept. */
export function readDeterminationBody(raw: unknown): ReadResult<DeterminationBody> {
  if (!isRecord(raw)) return bad("a determination must be an object");
  const subject = raw.subject;
  if (!isRecord(subject) || !isText(subject.kind)) return bad("a determination needs a subject with a kind");
  if (subject.id !== undefined && !isText(subject.id)) return bad("a determination's subject id must be text");
  if (!isText(raw.key) || raw.key.length === 0) return bad("a determination needs a key");
  if (!isScalar(raw.value)) return bad(`determination ${raw.key} needs a value that is a number, text or yes/no`);
  const inputs = readInputs(raw.inputs);
  if (!inputs) return bad(`determination ${raw.key} has inputs that aren't { key, … }`);
  if (!isText(raw.reasoning)) return bad(`determination ${raw.key} needs its reasoning in words`);
  if (!isText(raw.decidedBy)) return bad(`determination ${raw.key} needs who decided it`);
  if (!isText(raw.confidence) || !isText(raw.status)) return bad(`determination ${raw.key} needs a confidence and a status`);
  return { ok: true, value: { ...raw, inputs } as DeterminationBody };
}

export function isDeterminationRecord(el: { readonly kind: string } | undefined): el is DeterminationElement {
  return el !== undefined && el.kind === "determination" && readDeterminationBody((el as Raw).determination).ok;
}

export function isRequirementStateRecord(el: { readonly kind: string } | undefined): el is RequirementStateElement {
  return el !== undefined && el.kind === "requirement_state" && readRequirementStateBody((el as Raw).state).ok;
}

/**
 * A stored observation body (reserved, `graph:observations`), checked; unknown
 * fields kept. Reader only: no peer of this release advertises the feature, so
 * no command of this release writes one; a newer peer's observations survive.
 */
export function readObservationBody(raw: unknown): ReadResult<ObservationBody> {
  if (!isRecord(raw)) return bad("an observation must be an object");
  const subject = raw.subject;
  if (!isRecord(subject) || !isText(subject.kind)) return bad("an observation needs a subject with a kind");
  if (!isText(raw.observedBy) || !isText(raw.at)) return bad("an observation needs who observed it and when");
  if (!isText(raw.result)) return bad("an observation needs a result");
  if (raw.note !== undefined && !isText(raw.note)) return bad("an observation's note must be text");
  if (raw.attachments !== undefined && !Array.isArray(raw.attachments)) return bad("an observation's attachments must be a list");
  return { ok: true, value: { note: "", attachments: [], ...raw } as unknown as ObservationBody };
}

export function isObservationRecord(el: { readonly kind: string } | undefined): el is ObservationElement {
  return el !== undefined && el.kind === "observation" && readObservationBody((el as Raw).observation).ok;
}

/** Whether the command being decided may store an observation: never in this release (the feature is reserved). */
export function observationsWritable(): boolean {
  return false;
}

export function isRuleRecordElement(el: { readonly kind: string } | undefined): el is RuleElement {
  return el !== undefined && el.kind === "rule" && readRuleRecord((el as Raw).rule).ok;
}

/** A stored requirement state, checked; unknown fields kept. */
export function readRequirementStateBody(raw: unknown): ReadResult<RequirementStateBody> {
  if (!isRecord(raw)) return bad("a requirement state must be an object");
  if (!isText(raw.requirementId) || raw.requirementId.length === 0) return bad("a requirement state names its requirement");
  if (!isText(raw.status)) return bad(`the state of ${raw.requirementId} needs a status`);
  if (raw.value !== undefined && !isScalar(raw.value)) return bad(`the state of ${raw.requirementId} has a value that isn't a number, text or yes/no`);
  if (!isText(raw.reason) || !isText(raw.by)) return bad(`the state of ${raw.requirementId} needs a reason and who set it`);
  return { ok: true, value: raw as unknown as RequirementStateBody };
}

function readApplicability(raw: unknown, id: string): ReadResult<Applicability> {
  if (raw === undefined) return { ok: true, value: {} };
  if (!isRecord(raw)) return bad(`rule ${id}'s applicability must be an object`);
  for (const k of ["jurisdiction", "editions", "occupancy", "spaceUses", "classes"] as const) {
    if (raw[k] !== undefined && !texts(raw[k])) return bad(`rule ${id}'s ${k} must be a list of text`);
  }
  if (raw.when !== undefined && !isText(raw.when)) return bad(`rule ${id}'s when must be a formula`);
  return { ok: true, value: raw as Applicability };
}

function readTemplate(raw: unknown, id: string): ReadResult<RequirementTemplate> {
  if (!isRecord(raw)) return bad(`rule ${id} produces something that isn't a requirement`);
  if (!isText(raw.key) || raw.key.length === 0) return bad(`rule ${id} produces a requirement with no key`);
  for (const k of ["anchor", "value", "unit", "compare"] as const) if (!isText(raw[k])) return bad(`rule ${id}'s ${raw.key} needs ${k}`);
  if (raw.delivered !== undefined && !isText(raw.delivered)) return bad(`rule ${id}'s ${raw.key} delivered must be an input key`);
  return { ok: true, value: raw as unknown as RequirementTemplate };
}

function readTable(raw: unknown, id: string): ReadResult<RuleTable> {
  if (!isRecord(raw) || !isText(raw.id) || !texts(raw.columns) || !Array.isArray(raw.rows)) return bad(`rule ${id} has a table that isn't { id, columns, rows }`);
  for (const row of raw.rows) if (!Array.isArray(row) || !row.every((c) => typeof c === "string" || (typeof c === "number" && Number.isFinite(c)))) return bad(`rule ${id}'s table ${raw.id} has a row that isn't numbers and labels`);
  return { ok: true, value: raw as unknown as RuleTable };
}

function readEffect(raw: unknown, id: string): ReadResult<RuleEffect> {
  if (!isRecord(raw) || !isText(raw.target) || !isText(raw.value) || !isText(raw.cause) || !isText(raw.effect)) return bad(`rule ${id} has an effect that isn't { target, effect, value, cause }`);
  return { ok: true, value: raw as unknown as RuleEffect };
}

/** The round 10 (C10) pin fields on a rule and its citation, when present: refused only when malformed. */
function readRuleVersionFields(raw: Readonly<Record<string, unknown>>, c: Readonly<Record<string, unknown>>, id: string): ReadResult<null> {
  if (raw.ruleVersion !== undefined && (!isText(raw.ruleVersion) || raw.ruleVersion.trim().length === 0 || raw.ruleVersion.length > 64)) return bad(`rule ${id}'s ruleVersion must be short text ("3", "2026-11-04")`);
  if (raw.correctedAt !== undefined && !isText(raw.correctedAt)) return bad(`rule ${id}'s correctedAt must be a date`);
  if (raw.carriedForward !== undefined) {
    if (!Array.isArray(raw.carriedForward)) return bad(`rule ${id}'s carriedForward must be a list of { fromEdition, fromSection? }`);
    for (const f of raw.carriedForward) {
      if (!isRecord(f) || !isText(f.fromEdition) || (f.fromSection !== undefined && !isText(f.fromSection))) return bad(`rule ${id}'s carriedForward must be a list of { fromEdition, fromSection? }`);
    }
  }
  if (c.jurisdictionId !== undefined && parseJurisdiction(c.jurisdictionId) === null) return bad(`rule ${id}'s citation names a jurisdiction that isn't { country, subdivision?, locality?, authority? }`);
  if (c.adoptedAs !== undefined && !isText(c.adoptedAs)) return bad(`rule ${id}'s citation adoptedAs must be text`);
  if (c.amendment !== undefined && !(isRecord(c.amendment) && isText(c.amendment.id) && isText(c.amendment.version))) return bad(`rule ${id}'s citation amendment must be { id, version }`);
  return { ok: true, value: null };
}

/** A rule's `appliesAt` (round 11), when present: refused only when malformed; unknown fields kept. */
function readAppliesAt(raw: unknown, id: string): ReadResult<null> {
  if (raw === undefined) return { ok: true, value: null };
  if (!isRecord(raw)) return bad(`rule ${id}'s appliesAt must be { stages?, anchors? }`);
  if (raw.stages !== undefined && !texts(raw.stages)) return bad(`rule ${id}'s appliesAt stages must be a list of stage ids`);
  if (raw.anchors !== undefined) {
    if (!Array.isArray(raw.anchors)) return bad(`rule ${id}'s appliesAt anchors must be a list of { kind, id }`);
    for (const a of raw.anchors) if (!isRecord(a) || !isText(a.kind) || !(a.id === null || isText(a.id))) return bad(`rule ${id}'s appliesAt anchors must be a list of { kind, id }`);
  }
  return { ok: true, value: null };
}

/**
 * A rule as any source supplies it (a local `rule` record, an add-on row, a
 * host snapshot), checked; unknown fields kept. Refused, with the reason,
 * when it lacks what the engine needs to evaluate or cite it.
 */
export function readRuleRecord(raw: unknown): ReadResult<RuleRecord> {
  if (!isRecord(raw)) return bad("a rule must be an object");
  if (!isText(raw.ruleId) || raw.ruleId.length === 0) return bad("a rule needs a ruleId");
  const id = raw.ruleId;
  if (!isText(raw.provider) || raw.provider.length === 0) return bad(`rule ${id} needs its provider`);
  const c = raw.citation;
  if (!isRecord(c) || !isText(c.instrument) || !isText(c.edition) || !isText(c.section)) return bad(`rule ${id} needs a citation with instrument, edition and section`);
  if (!isText(raw.title) || !isText(raw.summary) || !isText(raw.discipline)) return bad(`rule ${id} needs a title, a summary and a discipline`);
  const applies = readApplicability(raw.applies, id);
  if (!applies.ok) return applies;
  if (!texts(raw.reads)) return bad(`rule ${id}'s reads must be a list of input keys`);
  if (!Array.isArray(raw.produces)) return bad(`rule ${id}'s produces must be a list`);
  const produces: RequirementTemplate[] = [];
  for (const t of raw.produces) {
    const r = readTemplate(t, id);
    if (!r.ok) return r;
    produces.push(r.value);
  }
  if (raw.parameters !== undefined) {
    if (!isRecord(raw.parameters)) return bad(`rule ${id}'s parameters must be an object`);
    for (const [k, v] of Object.entries(raw.parameters)) {
      const ok = typeof v === "string" || typeof v === "boolean" || (isRecord(v) && typeof v.value === "number" && Number.isFinite(v.value) && isText(v.unit));
      if (!ok) return bad(`rule ${id}'s parameter ${k} must be text, yes/no or { value, unit }`);
    }
  }
  if (raw.tables !== undefined) {
    if (!Array.isArray(raw.tables)) return bad(`rule ${id}'s tables must be a list`);
    for (const t of raw.tables) {
      const r = readTable(t, id);
      if (!r.ok) return r;
    }
  }
  if (raw.relaxes !== undefined) {
    if (!Array.isArray(raw.relaxes)) return bad(`rule ${id}'s effects must be a list`);
    for (const e of raw.relaxes) {
      const r = readEffect(e, id);
      if (!r.ok) return r;
    }
  }
  if (raw.acceptedValues !== undefined) {
    if (!Array.isArray(raw.acceptedValues)) return bad(`rule ${id}'s accepted values must be a list`);
    for (const a of raw.acceptedValues) {
      if (!isRecord(a) || !isText(a.key) || !(a.anchorId === null || isText(a.anchorId)) || !isScalar(a.value) || !isText(a.reason)) return bad(`rule ${id} has an accepted value that isn't { key, anchorId, value, reason }`);
      if (a.unit !== undefined && !isText(a.unit)) return bad(`rule ${id}'s accepted value for ${a.key} has a unit that isn't text`);
    }
  }
  const v = raw.verification;
  if (!isRecord(v) || !isText(v.status)) return bad(`rule ${id} needs a verification status`);
  const pin = readRuleVersionFields(raw, c, id);
  if (!pin.ok) return pin;
  const at = readAppliesAt(raw.appliesAt, id);
  if (!at.ok) return at;
  return { ok: true, value: { ...raw, applies: applies.value, produces } as unknown as RuleRecord };
}

/** The body a graph record carries, by kind, or null for any other element. */
export function graphRecordKind(el: BimElement | undefined): "determination" | "rule" | "requirement_state" | "observation" | null {
  if (!el) return null;
  return el.kind === "determination" || el.kind === "rule" || el.kind === "requirement_state" || el.kind === "observation" ? el.kind : null;
}
