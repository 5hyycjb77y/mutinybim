import { z } from "zod";
import { canonicalJson } from "../canonical";
import { finish, guard, refuse, type AuthoredWrite, type ExecuteResult } from "../command-core";
import { TrackedReader } from "../model";
import { GLOBAL_PARTITION } from "../partition";
import { draftElements, elementsOfKind } from "../store";
import { asElementId, type BimElement, type ElementId, type ModelState } from "../types";
import { checkRuleWords } from "./conformance";
import { requirementById } from "./engine";
import { nameOf } from "./names";
import { determinationsWritable, isDeterminationRecord, readRuleRecord, requirementStatesWritable, rulesWritable } from "./records";
import { LOCAL_SOURCE_ID, localRuleElementId } from "./sources/local";
import {
  KNOWN_DETERMINATION_CONFIDENCES,
  KNOWN_DETERMINATION_SUBJECTS,
  type DeterminationBody,
  type DeterminationElement,
  type RequirementStateBody,
  type RequirementStateElement,
  type RuleElement,
  type RuleRecord,
} from "./types";

/**
 * Graph edits (contract 1.4.0): record a determination, supersede one with a
 * newer decision, set a requirement's person-made state (verify; override
 * with a value and a reason; withdraw with a reason; back to proposed), and
 * add, edit or delete the model's local rules. Each is one undo step.
 *
 * Writers are strict and gated: nothing is stored unless the model server
 * (and every peer) reads the record kind (`graph:determinations`,
 * `graph:rules`, `graph:requirement_states`); the refusal says so in words.
 * Who may verify (people with code-study edit rights, never an agent) is the
 * host's permission check before it sends the command.
 */

const id = z.string().trim().min(1).max(200);
const words = (max: number) => z.string().trim().min(1).max(max);
const scalar = z.union([z.number().finite(), z.string().trim().max(400), z.boolean()]);
const unitCode = z.string().trim().min(1).max(40);
const isoDate = z.string().trim().min(4).max(40);

const inputRef = z
  .object({
    key: words(200),
    elementId: id.optional(),
    value: scalar.optional(),
    unit: unitCode.optional(),
  })
  .strict();

const subjectInput = z
  .object({
    kind: z.enum(KNOWN_DETERMINATION_SUBJECTS),
    /** The space, zone or element; absent for the model. */
    id: id.optional(),
  })
  .strict();

const decision = {
  value: scalar,
  unit: unitCode.optional(),
  inputs: z.array(inputRef).max(50).optional(),
  /** In the decider's own words; never code text. */
  reasoning: words(2000),
  decidedBy: words(120),
  decidedAt: isoDate.optional(),
  edition: words(80).optional(),
  confidence: z.enum(KNOWN_DETERMINATION_CONFIDENCES),
};

export const graphCommandSchemas = [
  z
    .object({
      type: z.literal("record_determination"),
      /** Chosen by the sender so a retried request makes the same record. */
      determinationId: id,
      subject: subjectInput,
      /** What was decided ("occupancy", "hazard", "occupant_load", a pack's key). */
      key: words(120),
      ...decision,
      /** Absent: recorded. */
      status: z.enum(["draft", "recorded"]).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("supersede_determination"),
      determinationId: id,
      newDeterminationId: id,
      ...decision,
    })
    .strict(),
  z
    .object({
      type: z.literal("set_requirement_state"),
      requirementId: z.string().trim().min(1).max(600),
      /** proposed: back to the derived requirement (clears the stored state). */
      status: z.enum(["verified", "overridden", "withdrawn", "proposed"]),
      value: scalar.optional(),
      unit: unitCode.optional(),
      reason: z.string().trim().max(2000).optional(),
      by: words(120),
      at: isoDate.optional(),
    })
    .strict(),
  z.object({ type: z.literal("add_local_rule"), rule: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ type: z.literal("edit_local_rule"), ruleId: id, rule: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ type: z.literal("delete_local_rules"), ruleIds: z.array(id).min(1).max(200) }).strict(),
] as const;

export const graphCommandSchema = z.discriminatedUnion("type", [...graphCommandSchemas]);
export type GraphCommand = z.infer<typeof graphCommandSchema>;

const GRAPH_COMMANDS: ReadonlySet<string> = new Set(graphCommandSchemas.map((s) => s.shape.type.value));

export function isGraphCommand(command: { readonly type: string }): command is GraphCommand {
  return GRAPH_COMMANDS.has(command.type);
}

const SERVER_OLD = "the model server this model is open on is an older version that doesn't store them. Try again once the server is updated";

// ---------------------------------------------------------------- edit helpers

interface Edit {
  readonly reader: TrackedReader;
  readonly working: Record<string, BimElement>;
  readonly touched: ElementId[];
  readonly authored: AuthoredWrite[];
  readonly removed: ElementId[];
  readonly summary: string[];
}

function begin(model: ModelState): Edit {
  return { reader: new TrackedReader(model), working: draftElements(model.elements), touched: [], authored: [], removed: [], summary: [] };
}

function done(e: Edit): ExecuteResult {
  return finish(e.reader, e.working, e.touched, e.authored, () => [], { removedIds: e.removed, summary: e.summary });
}

function fingerprint(el: BimElement): string {
  const { id: _id, version: _version, authoredRev: _rev, ...rest } = el;
  return canonicalJson(rest);
}

function put(e: Edit, el: DeterminationElement | RuleElement | RequirementStateElement, field: string): void {
  e.working[el.id] = el;
  e.touched.push(el.id);
  e.authored.push({ elementId: el.id, field, value: fingerprint(el) });
}

function existing(e: Edit, key: ElementId): BimElement | undefined {
  return e.working[key] ?? e.reader.find(key);
}

// ---------------------------------------------------------------- determinations

type DecisionInput = Pick<Extract<GraphCommand, { type: "record_determination" }>, keyof typeof decision>;

function subjectOf(e: Edit, s: z.infer<typeof subjectInput>): DeterminationBody["subject"] {
  if (s.kind === "model") {
    if (s.id) refuse("invalid_value", "A model-wide determination has no subject id; leave it out, or pick the space, zone or element it is about");
    return { kind: "model" };
  }
  if (!s.id) refuse("invalid_value", `Name the ${s.kind} this determination is about`);
  const key = asElementId(s.id);
  const el = existing(e, key);
  if (!el) refuse("element_not_found", `There is no ${s.kind} ${s.id} to record a determination on`, [key]);
  if ((s.kind === "space" || s.kind === "zone") && el.kind !== s.kind) refuse("wrong_kind", `${s.id} is a ${el.kind.replace(/_/g, " ")}, not a ${s.kind}`, [key]);
  return { kind: s.kind, id: s.id };
}

function bodyOf(subject: DeterminationBody["subject"], key: string, input: DecisionInput, status: DeterminationBody["status"], supersedes?: string): DeterminationBody {
  return {
    subject,
    key,
    value: input.value,
    ...(input.unit ? { unit: input.unit } : {}),
    inputs: input.inputs ?? [],
    reasoning: input.reasoning,
    decidedBy: input.decidedBy,
    ...(input.decidedAt ? { decidedAt: input.decidedAt } : {}),
    ...(input.edition ? { edition: input.edition } : {}),
    confidence: input.confidence,
    status,
    ...(supersedes ? { supersedes } : {}),
  };
}

function determinationRecord(rid: ElementId, body: DeterminationBody): DeterminationElement {
  return { id: rid, kind: "determination", version: 0, authoredRev: {}, partition: GLOBAL_PARTITION, determination: body };
}

function gateDeterminations(): void {
  if (!determinationsWritable()) refuse("invalid_value", `Decisions can't be recorded yet: ${SERVER_OLD}`);
}

function recordDetermination(model: ModelState, c: Extract<GraphCommand, { type: "record_determination" }>): ExecuteResult {
  gateDeterminations();
  const e = begin(model);
  const rid = asElementId(c.determinationId);
  if (existing(e, rid)) refuse("already_exists", `${c.determinationId} already exists; choose a new id for the determination`, [rid]);
  const subject = subjectOf(e, c.subject);
  const d = determinationRecord(rid, bodyOf(subject, c.key, c, c.status ?? "recorded"));
  put(e, d, "determination");
  const where = subject.id ? nameOf(existing(e, asElementId(subject.id)), subject.id) : "the model";
  e.summary.push(`Recorded ${c.key.replace(/[._]/g, " ")} for ${where}`);
  return done(e);
}

function supersedeDetermination(model: ModelState, c: Extract<GraphCommand, { type: "supersede_determination" }>): ExecuteResult {
  gateDeterminations();
  const e = begin(model);
  const oldId = asElementId(c.determinationId);
  const old = existing(e, oldId);
  if (!old) refuse("element_not_found", `There is no determination ${c.determinationId}`, [oldId]);
  if (!isDeterminationRecord(old)) refuse("wrong_kind", `${c.determinationId} is a ${old.kind.replace(/_/g, " ")}, not a determination`, [oldId]);
  if (old.determination.status === "superseded") refuse("invalid_value", `${c.determinationId} was already replaced; supersede the one in force instead`, [oldId]);
  const nid = asElementId(c.newDeterminationId);
  if (existing(e, nid)) refuse("already_exists", `${c.newDeterminationId} already exists; choose a new id for the new determination`, [nid]);
  put(e, { ...old, determination: { ...old.determination, status: "superseded" } }, "determination");
  put(e, determinationRecord(nid, bodyOf(old.determination.subject, old.determination.key, c, "recorded", old.id)), "determination");
  const where = old.determination.subject.id ? nameOf(existing(e, asElementId(old.determination.subject.id)), old.determination.subject.id) : "the model";
  e.summary.push(`Replaced the ${old.determination.key.replace(/[._]/g, " ")} determination for ${where}`);
  return done(e);
}

// ---------------------------------------------------------------- requirement states

/** The element id a requirement's state is stored under: stable per requirement id. */
export function requirementStateElementId(requirementId: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < requirementId.length; i++) {
    const c = requirementId.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return `requirement_state:${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

function setRequirementState(model: ModelState, c: Extract<GraphCommand, { type: "set_requirement_state" }>): ExecuteResult {
  if (!requirementStatesWritable()) refuse("invalid_value", `Requirement checks can't be saved yet: ${SERVER_OLD}`);
  const e = begin(model);
  const prior = elementsOfKind(model.elements, "requirement_state").find((s) => s.state.requirementId === c.requirementId);
  const rid = prior?.id ?? asElementId(requirementStateElementId(c.requirementId));
  const req = requirementById(model, c.requirementId);
  if (c.status === "proposed") {
    if (!prior) refuse("invalid_value", "Nothing to change: that requirement has no saved check");
    delete e.working[prior.id];
    e.removed.push(prior.id);
    e.summary.push(`Back to proposed: ${req?.title ?? c.requirementId}`);
    return done(e);
  }
  if (!req) refuse("element_not_found", `There is no requirement ${c.requirementId} on this model now; its rule may no longer apply`);
  const reason = c.reason ?? "";
  if ((c.status === "overridden" || c.status === "withdrawn") && reason.length === 0) refuse("invalid_value", `Say why you ${c.status === "overridden" ? "override" : "withdraw"} ${req.title}: a reason is required`);
  if (c.status === "overridden" && c.value === undefined) refuse("invalid_value", `Give the value that replaces ${req.title}'s`);
  if (c.status !== "overridden" && c.value !== undefined) refuse("invalid_value", "Only an override carries a value");
  const body: RequirementStateBody = {
    requirementId: c.requirementId,
    status: c.status,
    ...(c.value !== undefined ? { value: c.value } : {}),
    ...(c.unit ? { unit: c.unit } : c.status === "overridden" ? { unit: req.unit } : {}),
    reason,
    by: c.by,
    ...(c.at ? { at: c.at } : {}),
  };
  const el: RequirementStateElement = prior ? { ...prior, state: body } : { id: rid, kind: "requirement_state", version: 0, authoredRev: {}, partition: GLOBAL_PARTITION, state: body };
  if (prior && fingerprint(prior) === fingerprint(el)) refuse("invalid_value", `Nothing to change: ${req.title} is already ${c.status}`, [prior.id]);
  put(e, el, "state");
  e.summary.push(`${c.status === "verified" ? "Verified" : c.status === "overridden" ? "Overrode" : "Withdrew"} ${req.title}`);
  return done(e);
}

// ---------------------------------------------------------------- local rules

function localRuleFrom(raw: Readonly<Record<string, unknown>>): RuleRecord {
  const r = readRuleRecord({ ...raw, provider: LOCAL_SOURCE_ID });
  if (!r.ok) refuse("invalid_value", `That rule can't be stored: ${r.reason}`);
  const findings = checkRuleWords(r.value);
  if (findings.length > 0) refuse("invalid_value", findings.map((f) => f.message).join(". "));
  return r.value;
}

function ruleRecord(rid: ElementId, rule: RuleRecord): RuleElement {
  return { id: rid, kind: "rule", version: 0, authoredRev: {}, partition: GLOBAL_PARTITION, rule };
}

function gateRules(): void {
  if (!rulesWritable()) refuse("invalid_value", `Code-study rules can't be saved in the model yet: ${SERVER_OLD}`);
}

function addLocalRule(model: ModelState, c: Extract<GraphCommand, { type: "add_local_rule" }>): ExecuteResult {
  gateRules();
  const e = begin(model);
  const rule = localRuleFrom(c.rule);
  const rid = asElementId(localRuleElementId(rule.ruleId));
  if (existing(e, rid)) refuse("already_exists", `This model already has a rule ${rule.ruleId}; edit it, or give the new one another id`, [rid]);
  put(e, ruleRecord(rid, rule), "rule");
  e.summary.push(`Added the rule ${rule.citation.instrument} ${rule.citation.section}: ${rule.title}`);
  return done(e);
}

function editLocalRule(model: ModelState, c: Extract<GraphCommand, { type: "edit_local_rule" }>): ExecuteResult {
  gateRules();
  const e = begin(model);
  const rid = asElementId(localRuleElementId(c.ruleId));
  const prior = existing(e, rid);
  if (prior?.kind !== "rule") refuse("element_not_found", `This model has no rule ${c.ruleId}`, [rid]);
  const rule = localRuleFrom({ ...c.rule, ruleId: c.ruleId });
  const next: RuleElement = { ...prior, rule };
  if (fingerprint(next) === fingerprint(prior)) refuse("invalid_value", `Nothing to change: ${rule.title} already reads that way`, [rid]);
  put(e, next, "rule");
  e.summary.push(`Changed the rule ${rule.title}`);
  return done(e);
}

function deleteLocalRules(model: ModelState, c: Extract<GraphCommand, { type: "delete_local_rules" }>): ExecuteResult {
  gateRules();
  const e = begin(model);
  const titles: string[] = [];
  for (const ruleId of new Set(c.ruleIds)) {
    const rid = asElementId(localRuleElementId(ruleId));
    const prior = existing(e, rid);
    if (prior?.kind !== "rule") refuse("element_not_found", `This model has no rule ${ruleId}`, [rid]);
    titles.push(prior.rule.title);
    delete e.working[rid];
    e.removed.push(rid);
  }
  e.summary.push(titles.length === 1 ? `Deleted the rule ${titles[0]}` : `Deleted ${titles.length} rules`);
  return done(e);
}

export function executeGraphCommand(model: ModelState, command: GraphCommand): ExecuteResult {
  return guard(() => {
    switch (command.type) {
      case "record_determination":
        return recordDetermination(model, command);
      case "supersede_determination":
        return supersedeDetermination(model, command);
      case "set_requirement_state":
        return setRequirementState(model, command);
      case "add_local_rule":
        return addLocalRule(model, command);
      case "edit_local_rule":
        return editLocalRule(model, command);
      case "delete_local_rules":
        return deleteLocalRules(model, command);
    }
  });
}
