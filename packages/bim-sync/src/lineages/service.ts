import {
  type Actor,
  type AuthorRef,
  type MergeWrite,
  type ModelState,
  UNSIGNED_PROVIDER_ID,
  canonicalJson,
} from "@permitzip/bim-kernel";
import {
  acceptBack,
  ancestorAnchor,
  commonAncestor,
  compareLineages,
  forkLineage,
  LineageError,
  lineageChain,
  lineageDelta,
  lineageDeltaDigest,
  lineageLookup,
  reviewLineage,
  type Lineage,
  type LineageAct,
  type LineageAnchor,
  type LineageSide,
  type RecordedLineageAct,
} from "@permitzip/bim-kernel/lineages";
import type { PrincipalLineage } from "../authorization";
import type { HistoryReader } from "../branches/history";
import type { MainLander } from "../merge/engine";
import { LINEAGES_ACCEPT_BACK_FEATURE, LINEAGES_REVIEW_FEATURE, LINEAGES_ROLES_FEATURE, type LineageClientMessage, type LineageServerMessage } from "./protocol";
import { canAct, LINEAGE_RIGHTS_WORDS, rightsOn, type LineageEditScope, type LineageRights, type LineageRow } from "./rights";

/**
 * Answers the five lineage messages for one hub (round 11 W11): list, create
 * (a copy of any readable copy, any depth), compare (the overlay), review and
 * accept back. Every answer is checked against the caller's rights on the
 * copies it names; nothing on a child writes an ancestor except an accept
 * back by someone who may edit that ancestor.
 */

import { LINEAGES_DELTA_FEATURE, LINEAGES_GRANTS_FEATURE } from "./features";
export { LINEAGES_DELTA_FEATURE, LINEAGES_GRANTS_FEATURE };

/** Where a host keeps its copies (model server: bim.lineages over bim.models rows). */
export interface LineageStore {
  /** Every copy of a base model, the first copy included, as stored. */
  rows(baseModelId: string): Promise<readonly LineageRow[]>;
  /** Record a new copy (its id is the store's) and pin its parent's line at the fork revision. */
  createCopy(input: { readonly baseModelId: string; readonly lineage: Omit<Lineage, "id">; readonly editScope: LineageEditScope }): Promise<LineageRow>;
}

/** A copy's line as the host has it open (or can read it). */
export interface LineageLine {
  readonly head: () => Promise<ModelState>;
  readonly history: HistoryReader;
}

/**
 * What makes two recordings the same act: the model, who, the act's kind and copy, the delta it
 * was computed from, the anchor and what it decided. A retry of a review or accept back records once.
 */
export function lineageActKey(input: { readonly baseModelId: string; readonly act: LineageAct; readonly anchor: LineageAnchor; readonly by: AuthorRef }): string {
  const act = input.act.kind === "accept_back" ? { ...input.act, recordIds: [...input.act.recordIds].sort() } : input.act;
  return canonicalJson({ model: input.baseModelId, by: { provider: input.by.provider, subject: input.by.subject }, act, anchor: input.anchor });
}

export const LINEAGE_DELTA_WORDS = {
  moved: "The copy changed since you looked at it. Look at its changes again, then choose.",
  notChanged: (id: string) => `${id} wasn't changed on this copy, so there is nothing of it to review or accept back.`,
} as const;

/** Signed acts, kept by the host's sign-off log (the kernel writes the payload). */
export interface LineageActRecorder {
  /** `caller`: who asked, for a host that records as that person (the model server calls Hours with their sign-in). Recording the same act again returns the record already written. */
  record(input: { readonly baseModelId: string; readonly act: LineageAct; readonly anchor: LineageAnchor; readonly by: AuthorRef; readonly caller?: LineageCaller }): Promise<{ readonly seq: number; readonly ref: string }>;
  list(baseModelId: string, caller?: LineageCaller): Promise<readonly RecordedLineageAct[]>;
}

export interface LineageServiceOptions {
  readonly baseModelId: string;
  /** The copy this hub serves. */
  readonly lineageId: string;
  readonly store: LineageStore;
  /** A copy's line by id (opened by the host when needed). */
  readonly line: (lineageId: string) => Promise<LineageLine>;
  /** Absent: reviews and accept backs are not served (their features are not advertised). */
  readonly acts?: LineageActRecorder;
  /** Lands an accept back on the target copy as the person. Absent: accept back is not served. */
  readonly lander?: (targetLineageId: string, actor: Actor, fromLineageId: string) => Promise<MainLander>;
  readonly now?: () => string;
}

export interface LineageCaller {
  readonly actorId: string;
  /** The connection the request came on (the host finds the person's sign-in from it). */
  readonly connectionId?: string;
  readonly actor: Actor | null;
  readonly lineage?: PrincipalLineage;
}

/** Most differences one compare answer carries; past it the answer is truncated and says so. */
export const LINEAGE_COMPARE_MAX = 5000;

const REQUEST_FAILED = "The model server couldn't do that just now; see its log. Try again.";
const NO_RIGHTS = "This model server didn't say what you may do on its copies. Reconnect and try again.";

function authorOf(caller: LineageCaller): AuthorRef {
  return { provider: UNSIGNED_PROVIDER_ID, subject: caller.actorId, kind: caller.actor?.kind === "agent" ? "agent" : "person" };
}

export class LineageService {
  constructor(private readonly opts: LineageServiceOptions) {}

  /** The lineage features this service serves: each is advertised only when its writer is wired. */
  features(): readonly string[] {
    return [LINEAGES_ROLES_FEATURE, LINEAGES_GRANTS_FEATURE, LINEAGES_DELTA_FEATURE, ...(this.opts.acts ? [LINEAGES_REVIEW_FEATURE] : []), ...(this.opts.acts && this.opts.lander ? [LINEAGES_ACCEPT_BACK_FEATURE] : [])];
  }

  async handle(msg: LineageClientMessage, who: LineageCaller): Promise<LineageServerMessage> {
    try {
      return await this.answer(msg, who);
    } catch (err) {
      if (err instanceof LineageError) return { type: "request_refused", requestId: msg.requestId, reason: err.message };
      console.error("[bim-sync] lineage request failed", { type: msg.type, baseModelId: this.opts.baseModelId, err });
      return { type: "request_refused", requestId: msg.requestId, reason: REQUEST_FAILED };
    }
  }

  /** Rights over every stored copy, from the caller's admitted grants. */
  private async rightsOverAll(who: LineageCaller): Promise<{ rows: readonly LineageRow[]; rights: LineageRights }> {
    if (!who.lineage) throw new LineageError(NO_RIGHTS);
    const rows = await this.opts.store.rows(this.opts.baseModelId);
    const lookup = lineageLookup(rows.map((r) => r.lineage));
    const byId = new Map(rows.map((r) => [r.lineage.id, r]));
    const rights = new Map<string, ReadonlySet<string>>();
    for (const row of rows) {
      if (rights.has(row.lineage.id)) continue;
      const chain = lineageChain(lookup, row.lineage.id).map((l) => byId.get(l.lineage.id)).filter((r): r is LineageRow => r !== undefined);
      for (const [id, caps] of who.lineage.rightsOf(chain)) if (!rights.has(id)) rights.set(id, caps);
    }
    return { rows, rights };
  }

  private async side(lineageId: string, since: number): Promise<LineageSide> {
    const line = await this.opts.line(lineageId);
    const head = await line.head();
    return { lineageId, head, changes: await line.history.changesBetween(since, head.revision) };
  }

  private async answer(msg: LineageClientMessage, who: LineageCaller): Promise<LineageServerMessage> {
    const { requestId } = msg;
    const { rows, rights } = await this.rightsOverAll(who);
    const lookup = lineageLookup(rows.map((r) => r.lineage));
    const need = (id: string, cap: string, words: string) => {
      if (!lookup(id)) throw new LineageError(`There is no copy "${id}" on this model.`);
      if (!rightsOn(rights, id).has(cap)) throw new LineageError(rightsOn(rights, id).has("read") || cap === "read" ? words : LINEAGE_RIGHTS_WORDS.noRead);
    };
    switch (msg.type) {
      case "lineage_list":
        return { type: "lineages", requestId, lineages: rows.filter((r) => rightsOn(rights, r.lineage.id).has("read")).map((r) => r.lineage) };
      case "lineage_create": {
        const fromId = msg.from ?? this.opts.lineageId;
        need(fromId, "read", LINEAGE_RIGHTS_WORDS.noRead);
        const parent = lookup(fromId);
        if (!parent) throw new LineageError(`There is no copy "${fromId}" on this model.`);
        const parentHead = (await (await this.opts.line(fromId)).head()).revision;
        const draft = forkLineage({
          id: "pending",
          parent,
          revision: msg.fromRevision ?? parentHead,
          parentHead,
          role: msg.role,
          name: msg.name,
          createdBy: authorOf(who),
          createdAt: (this.opts.now ?? (() => new Date().toISOString()))(),
          ...(msg.owner ? { owner: msg.owner } : {}),
          ...(msg.terms ? { terms: msg.terms } : {}),
        });
        const { id: _pending, ...lineage } = draft;
        const row = await this.opts.store.createCopy({ baseModelId: this.opts.baseModelId, lineage, editScope: "named" });
        return { type: "lineage_saved", requestId, lineage: row.lineage };
      }
      case "lineage_compare": {
        need(msg.a, "read", LINEAGE_RIGHTS_WORDS.noRead);
        need(msg.b, "read", LINEAGE_RIGHTS_WORDS.noRead);
        const ancestor = commonAncestor(lookup, msg.a, msg.b);
        const [a, b] = await Promise.all([this.side(msg.a, ancestor.revision), this.side(msg.b, ancestor.revision)]);
        const acts = this.opts.acts ? await this.opts.acts.list(this.opts.baseModelId, who) : [];
        const compared = compareLineages(lookup, a, b, { acts });
        const truncated = compared.differences.length > LINEAGE_COMPARE_MAX;
        return { type: "lineage_compare_result", requestId, ancestor: compared.ancestor, differences: truncated ? compared.differences.slice(0, LINEAGE_COMPARE_MAX) : compared.differences, truncated };
      }
      case "lineage_delta": {
        need(msg.lineageId, "read", LINEAGE_RIGHTS_WORDS.noRead);
        const anchor = ancestorAnchor(lookup, msg.lineageId, msg.to);
        const child = await this.side(msg.lineageId, anchor.revision);
        if (msg.atRevision !== undefined && child.head.revision !== msg.atRevision) throw new LineageError(LINEAGE_DELTA_WORDS.moved);
        const whole = lineageDelta(lookup, child, msg.to);
        if (!msg.recordIds) return { type: "lineage_delta_result", requestId, anchor: whole.anchor, headRevision: child.head.revision, changedIds: whole.changedIds, deltaDigest: whole.deltaDigest };
        const chosen = [...new Set(msg.recordIds)].sort();
        const changed = new Set<string>(whole.changedIds);
        const missing = chosen.find((id) => !changed.has(id));
        if (missing) throw new LineageError(LINEAGE_DELTA_WORDS.notChanged(missing));
        const deltaDigest = lineageDeltaDigest(chosen, anchor.revision, (id) => child.head.elements[id] ?? null);
        return { type: "lineage_delta_result", requestId, anchor, headRevision: child.head.revision, changedIds: chosen, deltaDigest };
      }
      case "lineage_review": {
        const acts = this.opts.acts;
        if (!acts) throw new LineageError("Reviewing a copy isn't available on this model server yet.");
        const allowed = canAct(rights, { kind: "review", lineageId: msg.lineageId });
        if (!allowed.ok) throw new LineageError(allowed.reason);
        const child = await this.side(msg.lineageId, ancestorAnchor(lookup, msg.lineageId, msg.to).revision);
        const { act, anchor } = reviewLineage({ lookup, child, ...(msg.to ? { to: msg.to } : {}), outcome: msg.outcome, ...(msg.reason ? { reason: msg.reason } : {}), deltaDigest: msg.deltaDigest });
        const recorded = await acts.record({ baseModelId: this.opts.baseModelId, act, anchor, by: authorOf(who), caller: who });
        return { type: "lineage_act_recorded", requestId, act, seq: recorded.seq };
      }
      case "lineage_accept_back": {
        const acts = this.opts.acts;
        const landerFor = this.opts.lander;
        if (!acts || !landerFor) throw new LineageError("Accepting parts of a copy back isn't available on this model server yet.");
        const chain = lineageChain(lookup, msg.from);
        const to = msg.to ?? chain[1]?.lineage.id;
        if (!to) throw new LineageError(`"${msg.from}" has no copy above it to accept records back onto.`);
        const allowed = canAct(rights, { kind: "accept_back", from: msg.from, to });
        if (!allowed.ok) throw new LineageError(allowed.reason);
        const pin = chain.find((l) => l.lineage.id === to)?.pinnedAt;
        if (pin === undefined || pin === null) throw new LineageError(`"${to}" isn't a copy "${msg.from}" came from, so nothing can go back to it from there.`);
        const [child, target] = await Promise.all([this.side(msg.from, pin), this.side(to, pin)]);
        const result = acceptBack({ lookup, child, target, recordIds: msg.recordIds, deltaDigest: msg.deltaDigest });
        if (!result.ok) throw new LineageError(`${result.conflicts.length} of these records were also changed on the copy they go back to. Look at the differences again, then pick records that weren't.`);
        if (!result.landing.ok) throw new LineageError(result.landing.error.message);
        const landed = result.landing;
        const writes: MergeWrite[] = [
          ...landed.changedIds.map((id) => ({ elementId: id, record: landed.model.elements[id] ?? null })),
          ...landed.removedIds.map((id) => ({ elementId: id, record: null })),
        ];
        const actor: Actor = who.actor ?? { id: who.actorId, name: who.actorId, kind: "human" };
        // Signed first: a host that refuses the act lands nothing. Landing after a recorded act can be
        // retried; the same act records once.
        const recorded = await acts.record({ baseModelId: this.opts.baseModelId, act: result.act, anchor: result.anchor, by: authorOf(who), caller: who });
        const lander = await landerFor(to, actor, msg.from);
        const fromName = lookup(msg.from)?.name ?? msg.from;
        const outcome = await lander.land({ writes, add: landed.addedConnections, remove: landed.removedConnections, label: `Accept back from ${fromName}`, mainHead: target.head.revision });
        if (!outcome.ok) throw new LineageError(outcome.message);
        return { type: "lineage_act_recorded", requestId, act: result.act, seq: recorded.seq, revision: outcome.revision };
      }
    }
  }
}
