import { z } from "zod";
import { authorFromActor, PROVIDER_ID } from "../authorship/author";
import { sha256HexOf } from "../authorship/canonical";
import { UNSIGNED_PROVIDER_ID } from "../authorship/unsigned";
import { canonicalJson } from "../canonical";
import { finish, guard, refuse, type ExecuteResult } from "../command-core";
import { peerReads } from "../elements/feature";
import { isRequirementStateRecord } from "../graph/records";
import { TrackedReader } from "../model";
import { GLOBAL_PARTITION } from "../partition";
import { registerKernelKindRows, type ElementKindItem } from "../registry/element-kind-point";
import { draftElements, recordsOfKinds, elementsOfKind } from "../store";
import { asElementId, type BimElement, type ElementId, type ModelElementBase, type ModelState } from "../types";
import type { PackCommandDef } from "../commands";
import type { CommandContext } from "../part-commands";
import { DISPOSITION_REASON_MAX, DISPOSITION_REASON_MIN, FINDING_DISPOSITION_KIND, MAIN_LINEAGE, readFindingDisposition, writeFindingDisposition, type FindingDisposition, type FindingDispositionScope } from "./disposition";
import { findingRefId } from "./ref";

/**
 * A disposition is a record in the model (round 11, D2): open source, it
 * travels with the model and every copy of it. Kind `finding_disposition`,
 * one kernel row (`registerKernelKindRows`), nature `record`, no geometry.
 *
 * Stored forever: `{ id, kind: "finding_disposition", version, authoredRev,
 * partition, disposition: <snake_case body, as `writeFindingDisposition`
 * writes it>, schemaVersion: 1 }`. The record id is derived from the
 * finding, the copy and the source version, so a retried request writes the
 * same record and a later decision on the same version replaces it; a new
 * source version is a new record (the earlier one stays, read as history).
 */

/** Peers that read and store finding dispositions in the model (round 11). An older peer is refused in its words. */
export const FINDINGS_LEDGER_FEATURE = "findings:ledger";
export const FINDING_DISPOSITION_SCHEMA_VERSION = 1;

export const FINDING_DISPOSITION_KIND_ROW: ElementKindItem = {
  kind: FINDING_DISPOSITION_KIND,
  label: "Decision on a problem",
  nature: "record",
  upgrade: { newForOlderPeers: true, feature: FINDINGS_LEDGER_FEATURE },
};

registerKernelKindRows("kernel.findings", [FINDING_DISPOSITION_KIND_ROW]);

export interface FindingDispositionElement extends ModelElementBase {
  readonly kind: typeof FINDING_DISPOSITION_KIND;
  readonly disposition: ReturnType<typeof writeFindingDisposition>;
  readonly schemaVersion?: number;
}

type Elements = Readonly<Record<string, BimElement>>;

/** The record id for a decision on `findingId` at `sourceVersion` on one copy. */
export function dispositionRecordId(findingId: string, sourceVersion: string, lineageId: string = MAIN_LINEAGE): ElementId {
  return asElementId(`fd-${sha256HexOf(canonicalJson([findingId, sourceVersion, lineageId])).slice(0, 24)}`);
}

/** The stored record for a disposition (strict: the body must read back). */
export function dispositionRecord(d: FindingDisposition): FindingDispositionElement {
  const body = writeFindingDisposition(d);
  const read = readFindingDisposition(body);
  if (!read.ok) throw new Error(`[bim-kernel/findings] a disposition doesn't read back: ${read.reason}`);
  return { id: dispositionRecordId(d.findingId, d.sourceVersion, d.scope.lineageId), kind: FINDING_DISPOSITION_KIND, version: 0, authoredRev: {}, partition: GLOBAL_PARTITION, disposition: body, schemaVersion: FINDING_DISPOSITION_SCHEMA_VERSION };
}

/** A disposition as the ledger holds it: the decision, and the revision its record was last written at (null: not in this model, from a sign-off or an override). */
export interface HeldDisposition {
  readonly disposition: FindingDisposition;
  readonly recordId: string | null;
  readonly recordedRevision: number | null;
}

export interface DispositionIndex {
  /** Every readable disposition, by finding id (any copy, any version). */
  readonly byFinding: ReadonlyMap<string, readonly HeldDisposition[]>;
  readonly count: number;
  /** Stored records this release couldn't read (kept as stored). */
  readonly unreadable: number;
}

function heldRevision(el: BimElement): number | null {
  const revs = Object.values(el.authoredRev ?? {}).filter((n): n is number => typeof n === "number");
  return revs.length > 0 ? Math.max(...revs) : null;
}

/** The source version of a disposition stored before versions were recorded: it holds against whatever version is in force. */
export const UNVERSIONED = "unversioned";

const indexes = new WeakMap<Elements, DispositionIndex>();

/**
 * The model's dispositions, from the kind index (never a model scan):
 * `finding_disposition` records, and every requirement `overridden` state
 * read as an `override` disposition (stored bytes unchanged; an override
 * written before round 11 names no version, so it reads against the version
 * in force, `UNVERSIONED`). Memoised per revision.
 */
export function dispositionIndex(elements: Elements): DispositionIndex {
  const hit = indexes.get(elements);
  if (hit) return hit;
  const byFinding = new Map<string, HeldDisposition[]>();
  let count = 0;
  let unreadable = 0;
  const add = (h: HeldDisposition) => {
    const list = byFinding.get(h.disposition.findingId);
    if (list) list.push(h);
    else byFinding.set(h.disposition.findingId, [h]);
    count += 1;
  };
  for (const el of recordsOfKinds(elements, [FINDING_DISPOSITION_KIND])) {
    const read = readFindingDisposition(Reflect.get(el, "disposition"));
    if (!read.ok) {
      unreadable += 1;
      continue;
    }
    add({ disposition: read.value, recordId: el.id, recordedRevision: heldRevision(el) });
  }
  for (const el of elementsOfKind(elements, "requirement_state")) {
    const candidate: { readonly kind: string } = el;
    if (!isRequirementStateRecord(candidate)) continue;
    const s = candidate.state;
    if (s.status !== "overridden") continue;
    add({
      disposition: {
        findingId: findingRefId("requirement", s.requirementId),
        sourceVersion: UNVERSIONED,
        action: "override",
        reason: s.reason,
        by: { provider: UNSIGNED_PROVIDER_ID, subject: s.by, kind: "person", displayName: s.by },
        at: s.at ?? "1970-01-01T00:00:00.000Z",
        scope: { lineageId: MAIN_LINEAGE },
      },
      recordId: candidate.id,
      recordedRevision: heldRevision(candidate),
    });
  }
  if (unreadable > 0) console.error("[bim-kernel/findings] some finding_disposition records can't be read; they are kept as stored and ignored", { unreadable });
  const built: DispositionIndex = { byFinding, count, unreadable };
  indexes.set(elements, built);
  return built;
}

// ---------------------------------------------------------------- the writer

const iso = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/, "Give the time as an ISO 8601 UTC time");

export const recordFindingDispositionSchema = z
  .object({
    type: z.literal("record_finding_disposition"),
    findingId: z.string().trim().min(3).max(300),
    sourceVersion: z.string().trim().min(1).max(200),
    action: z.string().trim().regex(/^[a-z][a-z0-9_.]{1,63}$/, "An action is a lower-case word (accepted_known, waived, deferred_to_stage, override)"),
    reason: z.string().trim().min(DISPOSITION_REASON_MIN, "Say why in a sentence; reviewers will read it").max(DISPOSITION_REASON_MAX),
    lineageId: z.string().trim().min(1).max(120).optional(),
    untilGate: z.string().trim().min(1).max(200).optional(),
    untilStage: z.string().trim().min(1).max(200).optional(),
    at: iso.optional(),
  })
  .strict();

export type RecordFindingDispositionCommand = z.infer<typeof recordFindingDispositionSchema>;

function olderPeerRefusal(): never {
  refuse("invalid_value", `${FINDING_DISPOSITION_KIND_ROW.label} can't be saved yet: the model server this model is open on is an older version that doesn't store decisions on problems. Try again once the server is updated. Nothing changed`);
}

/**
 * Record a person's decision on a finding. Who may decide is the host's
 * check before it sends this (`dispositionRefusal`: scope cover, signer-only
 * overrides); the kernel refuses an agent (agents propose, people record),
 * a deferral with nothing to defer to, and older peers.
 */
export function executeRecordFindingDisposition(model: ModelState, c: RecordFindingDispositionCommand, ctx: CommandContext): ExecuteResult {
  return guard(() => {
    if (!peerReads(FINDINGS_LEDGER_FEATURE)) olderPeerRefusal();
    const actor = ctx.actor;
    if (!actor) refuse("invalid_value", "Sign in first: the model needs to know who decided this");
    if (actor.kind !== "human") refuse("invalid_value", "An agent can propose this decision; a person records it. Nothing changed");
    if (c.action === "deferred_to_stage" && !c.untilStage && !c.untilGate) refuse("invalid_value", "Say which stage or issued set this waits for");
    const own: unknown = Reflect.get(actor, "provider");
    const by = authorFromActor(actor, typeof own === "string" && PROVIDER_ID.test(own) ? own : UNSIGNED_PROVIDER_ID);
    const scope: FindingDispositionScope = { lineageId: c.lineageId ?? MAIN_LINEAGE, ...(c.untilGate ? { untilGate: c.untilGate } : {}), ...(c.untilStage ? { untilStage: c.untilStage } : {}) };
    const d: FindingDisposition = { findingId: c.findingId, sourceVersion: c.sourceVersion, action: c.action, reason: c.reason, by, at: ctx.at ?? c.at ?? new Date().toISOString(), scope };
    const rec = dispositionRecord(d);
    const reader = new TrackedReader(model);
    const working = draftElements(model.elements);
    const prior = working[rec.id];
    // Records sit outside the element union; the store indexes any kind string.
    working[rec.id] = { ...rec, version: prior?.version ?? 0 } as unknown as BimElement;
    const summary = c.action === "retracted" ? `Took back the decision on ${c.findingId}` : `Recorded ${c.action.replace(/_/g, " ")} on ${c.findingId}`;
    return finish(reader, working, [rec.id], [{ elementId: rec.id, field: FINDING_DISPOSITION_KIND, value: canonicalJson(rec.disposition) }], () => [], { summary: [summary] });
  });
}

/**
 * The command as a row of `COMMAND_POINT`'s shape, so it parses and runs
 * alone or as a `batch_edits` step. The coordinator adds it to the kernel's
 * command list (one line; see the lane notes).
 */
export const RECORD_FINDING_DISPOSITION_COMMAND: PackCommandDef = {
  type: "record_finding_disposition",
  schema: recordFindingDispositionSchema,
  execute(model, command, ctx) {
    const parsed = recordFindingDispositionSchema.safeParse(command);
    if (!parsed.success) return { ok: false, error: { code: "invalid_value", message: parsed.error.issues[0]?.message ?? "That decision can't be read", elementIds: [] } };
    return executeRecordFindingDisposition(model, parsed.data, ctx);
  },
};
