import { z } from "zod";
import { authorFromActor, authorWords, PROVIDER_ID } from "../authorship/author";
import { UNSIGNED_PROVIDER_ID } from "../authorship/unsigned";
import { canonicalJson } from "../canonical";
import { finish, guard, refuse, type AuthoredWrite, type ExecuteResult } from "../command-core";
import { TrackedReader } from "../model";
import { GLOBAL_PARTITION } from "../partition";
import { draftElements } from "../store";
import { asElementId, type BimElement, type ElementId, type ModelState } from "../types";
import { peerReads } from "../elements/feature";
import { LINEAGES_REVIEW_FEATURE } from "../lineages/types";
import { divergencesWritable, isSubmittalRecord, readDivergenceBody, readSubmittalBody, submittalsWritable } from "./records";
import { DIVERGENCE_KIND, SUBMITTAL_KIND, SUBMITTAL_REVIEW_LABELS, SUBMITTAL_REVIEW_STATES, type DesignBasisRef, type DivergenceBody, type DivergenceElement, type SubmittalBody, type SubmittalElement, type SubmittalReview } from "./types";

/**
 * Submittal and divergence writers (round 9, `submittals:records` and
 * `submittals:divergence`). A submittal is offered for elements, types or
 * requirements and reviewed per item; an approved substitution is recorded as
 * a divergence. None of these commands touches a design element: changing
 * the design to match is an edit on the design that cites the copy's
 * difference ("matched in design", round 11), like any design change. A
 * submittal may transmit a copy's delta (`lineageId`, `deltaDigest`). No
 * price, no due date.
 */

const id = z.string().trim().min(1).max(200);
const text = (max: number) => z.string().trim().max(max);
const atInput = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/, "Give the time as an ISO 8601 UTC time").optional();
const externalRefInput = z.object({ provider: text(40).min(1), ref: text(400).min(1) }).strict();

const designBasisInput = z
  .object({
    elementIds: z.array(id).max(500).optional(),
    typeIds: z.array(id).max(200).optional(),
    requirementRefs: z.array(text(200).min(1)).max(200).optional(),
  })
  .strict();

const itemInput = z.object({ id: text(40).min(1), label: text(200).min(1), offeredFor: designBasisInput.optional(), externalRefs: z.array(externalRefInput).max(20).optional() }).strict();

export const submittalCommandSchemas = [
  z
    .object({
      type: z.literal("add_submittal"),
      /** Chosen by the sender so a retried request makes the same submittal. */
      submittalId: id,
      title: text(200).min(1),
      revision: text(20).min(1).optional(),
      offeredFor: designBasisInput,
      items: z.array(itemInput).min(1).max(200),
      externalRefs: z.array(externalRefInput).max(20).optional(),
      /** Round 11: the copy this submittal transmits and the delta digest its review covers (both or neither). */
      lineageId: text(64).min(1).optional(),
      deltaDigest: z.string().regex(/^[0-9a-f]{64}$/, "A delta digest is 64 lower-case hex digits").optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("review_submittal"),
      submittalId: id,
      /** One item; absent: the submittal as a whole. */
      itemId: text(40).min(1).optional(),
      state: z.enum(SUBMITTAL_REVIEW_STATES),
      notes: text(2000).optional(),
      at: atInput,
    })
    .strict(),
  z
    .object({
      type: z.literal("record_divergence"),
      divergenceId: id,
      designBasis: designBasisInput,
      approvedProduct: z.object({ label: text(200).min(1), submittalId: id.optional(), itemId: text(40).min(1).optional() }).strict(),
      notes: text(2000),
      /** Recorded only when a person sets it; never inferred. */
      responsibleParty: z.object({ label: text(120).min(1), ref: text(200).min(1).optional() }).strict().optional(),
      responsibilityNote: text(1000).optional(),
      at: atInput,
    })
    .strict(),
] as const;

export const submittalCommandSchema = z.discriminatedUnion("type", [...submittalCommandSchemas]);
export type SubmittalCommand = z.infer<typeof submittalCommandSchema>;

const SUBMITTAL_COMMANDS: ReadonlySet<string> = new Set(submittalCommandSchemas.map((s) => s.shape.type.value));

export function isSubmittalCommand(command: { readonly type: string }): command is SubmittalCommand {
  return SUBMITTAL_COMMANDS.has(command.type);
}

/** Who is deciding and when (the model server's checked actor and its clock). */
export interface SubmittalCommandContext {
  readonly actorId?: string;
  readonly actor?: { readonly id: string; readonly name: string; readonly kind: "human" | "agent" };
  readonly at?: string;
}

interface Edit {
  readonly ctx: SubmittalCommandContext;
  readonly reader: TrackedReader;
  readonly working: Record<string, BimElement | SubmittalElement | DivergenceElement>;
  readonly touched: ElementId[];
  readonly authored: AuthoredWrite[];
  readonly summary: string[];
}

function begin(model: ModelState, ctx: SubmittalCommandContext): Edit {
  return { ctx, reader: new TrackedReader(model), working: draftElements(model.elements), touched: [], authored: [], summary: [] };
}

function done(e: Edit): ExecuteResult {
  // Records sit outside the element union; the store indexes any kind string.
  return finish(e.reader, e.working as Record<string, BimElement>, e.touched, e.authored, () => [], { summary: e.summary });
}

function put(e: Edit, rec: SubmittalElement | DivergenceElement): void {
  e.working[rec.id] = rec;
  e.touched.push(rec.id);
  const body = rec.kind === SUBMITTAL_KIND ? rec.submittal : rec.divergence;
  e.authored.push({ elementId: rec.id, field: rec.kind, value: canonicalJson(body) });
}

/** Who is speaking, in words: the checked actor's name, an agent named as one. */
function speaker(ctx: SubmittalCommandContext): string {
  if (ctx.actor) {
    const own: unknown = (ctx.actor as { readonly provider?: unknown }).provider;
    return authorWords(authorFromActor(ctx.actor, typeof own === "string" && PROVIDER_ID.test(own) ? own : UNSIGNED_PROVIDER_ID));
  }
  if (ctx.actorId) return ctx.actorId;
  refuse("invalid_value", "Sign in first: the model needs to know who is recording this");
}

function now(ctx: SubmittalCommandContext, sent: string | undefined): string {
  return ctx.at ?? sent ?? new Date().toISOString();
}

function requirePeers(writable: boolean, what: string): void {
  if (!writable) refuse("invalid_value", `${what} can't be saved yet: the model server this model is open on is an older version that doesn't store submittals. Try again once the server is updated`);
}

function basis(e: Edit, input: z.infer<typeof designBasisInput>, what: string): DesignBasisRef {
  const check = (ids: readonly string[] | undefined): ElementId[] => {
    const out: ElementId[] = [];
    for (const raw of new Set(ids ?? [])) {
      const key = asElementId(raw);
      if (!(e.working[key] ?? e.reader.find(key))) refuse("element_not_found", `There is no element or type ${raw} for ${what}. Pick it in the model again`, [key]);
      out.push(key);
    }
    return out;
  };
  const elementIds = check(input.elementIds);
  const typeIds = check(input.typeIds);
  const requirementRefs = [...new Set(input.requirementRefs ?? [])];
  if (elementIds.length + typeIds.length + requirementRefs.length === 0) refuse("invalid_value", `Say what ${what} is for: pick elements, a type or a requirement`);
  return { ...(elementIds.length ? { elementIds } : {}), ...(typeIds.length ? { typeIds } : {}), ...(requirementRefs.length ? { requirementRefs } : {}) };
}

function submittalAt(e: Edit, sid: string): SubmittalElement {
  const key = asElementId(sid);
  const el: { readonly kind: string } | undefined = e.working[key] ?? e.reader.find(key);
  if (!isSubmittalRecord(el)) refuse("element_not_found", `There is no submittal ${sid}`, [key]);
  return el;
}

function addSubmittal(model: ModelState, c: Extract<SubmittalCommand, { type: "add_submittal" }>, ctx: SubmittalCommandContext): ExecuteResult {
  const e = begin(model, ctx);
  requirePeers(submittalsWritable(), "A submittal");
  const key = asElementId(c.submittalId);
  if (e.working[key] ?? e.reader.find(key)) refuse("already_exists", `${c.submittalId} already exists; choose a new id for the submittal`, [key]);
  const seen = new Set<string>();
  const items = c.items.map((item) => {
    if (seen.has(item.id)) refuse("invalid_value", `Two items are both ${item.id}. Number them apart`);
    seen.add(item.id);
    return { id: item.id, label: item.label, ...(item.offeredFor ? { offeredFor: basis(e, item.offeredFor, `item ${item.id}`) } : {}), ...(item.externalRefs?.length ? { externalRefs: item.externalRefs } : {}) };
  });
  const body: SubmittalBody = {
    title: c.title,
    offeredFor: basis(e, c.offeredFor, "the submittal"),
    submittedBy: speaker(ctx),
    revision: c.revision ?? "0",
    review: { state: "pending" },
    items,
    ...(c.externalRefs?.length ? { externalRefs: c.externalRefs } : {}),
    ...(c.lineageId !== undefined && c.deltaDigest !== undefined ? { lineageId: c.lineageId, deltaDigest: c.deltaDigest } : {}),
  };
  if ((c.lineageId === undefined) !== (c.deltaDigest === undefined)) refuse("invalid_value", "A submittal over a copy names both the copy and the delta it covers. Open the copy's differences again, then submit", [key]);
  if (c.lineageId !== undefined && !peerReads(LINEAGES_REVIEW_FEATURE)) refuse("invalid_value", "A submittal over a copy can't be saved yet: the model server this model is open on is an older version that doesn't store copies. Try again once the server is updated", [key]);
  const read = readSubmittalBody(body);
  if (!read.ok) refuse("invalid_value", `Can't record that submittal: ${read.reason}`, [key]);
  put(e, { id: key, kind: SUBMITTAL_KIND, version: 0, authoredRev: {}, partition: GLOBAL_PARTITION, submittal: body });
  e.summary.push(`Added submittal '${c.title}' (${items.length} item${items.length === 1 ? "" : "s"})`);
  return done(e);
}

function reviewSubmittal(model: ModelState, c: Extract<SubmittalCommand, { type: "review_submittal" }>, ctx: SubmittalCommandContext): ExecuteResult {
  const e = begin(model, ctx);
  requirePeers(submittalsWritable(), "A review");
  const s = submittalAt(e, c.submittalId);
  const review: SubmittalReview = { state: c.state, reviewer: speaker(ctx), at: now(ctx, c.at), ...(c.notes ? { notes: c.notes } : {}) };
  let next: SubmittalBody;
  if (c.itemId) {
    if (!s.submittal.items.some((i) => i.id === c.itemId)) refuse("element_not_found", `'${s.submittal.title}' has no item ${c.itemId}`, [s.id]);
    next = { ...s.submittal, items: s.submittal.items.map((i) => (i.id === c.itemId ? { ...i, review } : i)) };
  } else {
    next = { ...s.submittal, review };
  }
  put(e, { ...s, submittal: next });
  const what = c.itemId ? `item ${c.itemId} of '${s.submittal.title}'` : `'${s.submittal.title}'`;
  e.summary.push(`${SUBMITTAL_REVIEW_LABELS[c.state]}: ${what}`);
  return done(e);
}

function recordDivergence(model: ModelState, c: Extract<SubmittalCommand, { type: "record_divergence" }>, ctx: SubmittalCommandContext): ExecuteResult {
  const e = begin(model, ctx);
  requirePeers(divergencesWritable(), "An approved substitution");
  const key = asElementId(c.divergenceId);
  if (e.working[key] ?? e.reader.find(key)) refuse("already_exists", `${c.divergenceId} already exists; choose a new id`, [key]);
  if (c.approvedProduct.submittalId) {
    const s = submittalAt(e, c.approvedProduct.submittalId);
    if (c.approvedProduct.itemId && !s.submittal.items.some((i) => i.id === c.approvedProduct.itemId)) refuse("element_not_found", `'${s.submittal.title}' has no item ${c.approvedProduct.itemId}`, [s.id]);
  }
  const body: DivergenceBody = {
    designBasis: basis(e, c.designBasis, "the substitution"),
    approvedProduct: { label: c.approvedProduct.label, ...(c.approvedProduct.submittalId ? { submittalId: asElementId(c.approvedProduct.submittalId) } : {}), ...(c.approvedProduct.itemId ? { itemId: c.approvedProduct.itemId } : {}) },
    approvedBy: speaker(ctx),
    at: now(ctx, c.at),
    notes: c.notes,
    ...(c.responsibleParty ? { responsibleParty: c.responsibleParty } : {}),
    ...(c.responsibilityNote ? { responsibilityNote: c.responsibilityNote } : {}),
  };
  const read = readDivergenceBody(body);
  if (!read.ok) refuse("invalid_value", `Can't record that substitution: ${read.reason}`, [key]);
  put(e, { id: key, kind: DIVERGENCE_KIND, version: 0, authoredRev: {}, partition: GLOBAL_PARTITION, divergence: body });
  e.summary.push(`Recorded an approved substitution: ${c.approvedProduct.label}. Design not changed`);
  return done(e);
}

export function executeSubmittalCommand(model: ModelState, command: SubmittalCommand, ctx: SubmittalCommandContext = {}): ExecuteResult {
  return guard(() => {
    switch (command.type) {
      case "add_submittal":
        return addSubmittal(model, command, ctx);
      case "review_submittal":
        return reviewSubmittal(model, command, ctx);
      case "record_divergence":
        return recordDivergence(model, command, ctx);
    }
  });
}
