import { pushTo } from "./collections";
import { z } from "zod";
import { carryFlowForest } from "./routing/flow-trees";
import {
  authoredFieldValue,
  commandSchema,
  describeIntent,
  executeCommand,
  intentHolds,
  isServerOnlyCommand,
  sameValue,
  takeOwnedElements,
  type AuthoredWrite,
  type Command,
  type CommandError,
  type IntentPredicate,
} from "./commands";
import { markKnownIssues, shareNetwork } from "./network";
import { shareLoadIndex } from "./requirements/load-index";
import { shareRequirementsEngine } from "./requirements/model-engine";
import { sharePartitionIndex } from "./partition";
import { carryClassIndexes } from "./registry/recognition";
import { carryRevision } from "./revision-carry";
import { draftElements, freezeElements } from "./store";
import { asRevision, type BimElement, type Connection, type ElementId, type ModelState, type Revision } from "./types";
import { nextConnections } from "./command-core";
import type { CommandContext } from "./part-commands";

/** What the model server hands a server-only command (`merge_branch_part`'s records); never from a client. */
export type ServerCommandContext = Pick<CommandContext, "mergeLanding" | "importLanding">;

export const actorSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  kind: z.enum(["human", "agent"]),
  /**
   * The identity provider that authorized this actor ("host",
   * "acme.oidc"). Absent: the session's provider (every server before this
   * field, and any server with one provider). A server that serves more than
   * one writes it, and refuses a client's actor naming a provider other than
   * the session's (bim-sync `principalFor`).
   */
  provider: z.string().max(64).regex(/^[a-z][a-z0-9_]*(?:[.:-][a-z0-9_]+)*$/).optional(),
});
export type Actor = z.infer<typeof actorSchema>;
/** The peer reads an actor's optional `provider` (round 9). A server writes it only to peers advertising this. */
export const ACTORS_PROVIDER_FEATURE = "actors:provider";

export const commandRequestSchema = z.object({
  idempotencyKey: z.string().min(8).max(128),
  baseRevision: z.number().int().min(0),
  actor: actorSchema,
  command: commandSchema,
  /**
   * The editing session (one browser tab, one agent run) that sent this. The
   * same person in two tabs is two sessions: their edits conflict like anyone
   * else's. Absent on requests from clients that predate sessions.
   */
  clientSessionId: z.string().min(1).max(128).optional(),
  /**
   * Round 11 (L11): the copy differences this edit settles ("change the design to
   * match"). Carried onto the changeset; never read by the command itself.
   */
  cites: z.array(z.string().min(1).max(256)).max(2000).optional(),
});
export type CommandRequest = z.infer<typeof commandRequestSchema>;

/** A committed, atomic change. Clients apply it whole; nobody sees half. */
export interface Changeset {
  readonly revision: Revision;
  readonly baseRevision: number;
  readonly idempotencyKey: string;
  readonly actor: Actor;
  readonly command: Command;
  /** Full post-change records of every element the change touched. */
  readonly elements: readonly BimElement[];
  readonly readSet: Readonly<Record<string, number>>;
  readonly authored: readonly AuthoredWrite[];
  readonly intents: readonly IntentPredicate[];
  /** True when the command was re-run on a newer head than its base. */
  readonly rebased: boolean;
  readonly committedAt: string;
  /** The session that sent the command (see CommandRequest.clientSessionId). */
  readonly clientSessionId?: string;
  /** Copy differences this change settles (see CommandRequest.cites). Absent on older changesets. */
  readonly cites?: readonly string[];
  /** Elements the change removed. */
  readonly removedIds?: readonly ElementId[];
  /**
   * Each touched or removed element as it was before the change (null: the
   * change created it). Undo restores from here. Absent on older changesets.
   */
  readonly before?: Readonly<Record<string, BimElement | null>>;
  /** Connections the change cut, and made. */
  readonly removedConnections?: readonly Connection[];
  readonly addedConnections?: readonly Connection[];
}

export interface ConflictDetail {
  readonly withActor: Actor;
  readonly withRevision: number;
  readonly reason: string;
}

export type CommitDecision =
  | { readonly ok: true; readonly changeset: Changeset; readonly model: ModelState }
  | { readonly ok: false; readonly error: CommandError; readonly conflict?: ConflictDetail };

/**
 * Decide a commit against the current head. Every sync candidate calls this
 * inside its atomic commit (sequencer process, Postgres transaction, or
 * SpacetimeDB reducer), so validation and commit see the same state.
 *
 * Policy:
 * 1. Re-run the intent command on the head with trusted code; the read set,
 *    authored writes and intent predicates come from that run, never the caller.
 * 2. Competing authored intent: if an authored field this command sets was set
 *    after `baseRevision` to a different value, conflict (no last-write-wins).
 * 3. Derived values just recompute. Geometric propagation must keep every
 *    intent recorded after `baseRevision`; otherwise conflict.
 */
export function planCommit(
  head: ModelState,
  sinceBase: readonly Changeset[],
  request: CommandRequest,
  now: () => string = () => new Date().toISOString(),
  /** Committed changesets from an undo's target revision through the head (undo only). */
  history: readonly Changeset[] = sinceBase,
  /** What only the model server supplies to a server-only command (`merge_branch_part`'s records). */
  server: ServerCommandContext = {},
): CommitDecision {
  if (request.baseRevision > head.revision) {
    return {
      ok: false,
      error: {
        code: "stale_base",
        message: `Base revision ${request.baseRevision} is ahead of the model (${head.revision})`,
        elementIds: [],
      },
    };
  }

  const exec = executeCommand(head, request.command, { ...server, history, actorId: request.actor.id, actor: request.actor, at: now() });
  if (!exec.ok) return { ok: false, error: exec.error };

  // Your own earlier edits from this same session, not yet seen confirmed, are not competing
  // intent. The same person's other tab or other agent run is a different session.
  const others = sinceBase.filter((cs) => !sameSession(cs, request));

  // A merged part writes the branch's records whole: anything someone changed on Main since the merge read it would be lost.
  // Only the records it writes count; values derived from them just recompute.
  if (isServerOnlyCommand(request.command)) {
    for (const id of (server.mergeLanding?.writes ?? []).map((w) => w.elementId)) {
      const changedBy = [...others].reverse().find((cs) => cs.elements.some((el) => el.id === id) || (cs.removedIds ?? []).includes(id));
      if (changedBy) {
        return {
          ok: false,
          error: { code: "conflict", message: `Main changed while merging: ${changedBy.actor.name} changed ${id}. Preview the merge again, then merge.`, elementIds: [id] },
          conflict: { withActor: changedBy.actor, withRevision: changedBy.revision, reason: "competing_authored_value" },
        };
      }
    }
  }

  // Deleting something another person changed after you looked at it would discard their work unseen.
  for (const id of exec.removedIds) {
    const changedBy = [...others].reverse().find((cs) => cs.elements.some((el) => el.id === id));
    if (changedBy) {
      return {
        ok: false,
        error: { code: "conflict", message: `${changedBy.actor.name} changed ${id} after you looked at it; check it before deleting`, elementIds: [id] },
        conflict: { withActor: changedBy.actor, withRevision: changedBy.revision, reason: "competing_authored_value" },
      };
    }
  }

  for (const write of exec.authored) {
    const current = head.elements[write.elementId];
    if (!current) continue;
    const competing = findAuthor(others, write.elementId, write.field);
    if (competing && !sameValue(authoredFieldValue(current, write.field), write.value)) {
      return {
        ok: false,
        error: {
          code: "conflict",
          message: `${competing.actor.name} changed ${write.elementId} ${write.field} while you were editing`,
          elementIds: [write.elementId],
        },
        conflict: { withActor: competing.actor, withRevision: competing.revision, reason: "competing_authored_value" },
      };
    }
  }

  // Only an element this change writes (directly or by propagation) or removes can lose an intent to it:
  // every other element is exactly as the head has it. Checking just those keeps a command sent on an old
  // head (thousands of changesets behind) proportional to what it changes, not to how far behind it is.
  const writtenIds = new Set<string>([...exec.changedIds, ...exec.removedIds]);
  const intentElement = (intent: IntentPredicate): string => (intent.kind === "tap_at" ? intent.tapId : intent.elementId);
  const intentField = (intent: IntentPredicate): string => (intent.kind === "tap_at" ? "position" : intent.field);
  const lastSetAt = new Map<string, number>();
  sinceBase.forEach((cs, i) => {
    for (const w of cs.authored) if (writtenIds.has(w.elementId)) lastSetAt.set(`${w.elementId}\u0000${w.field}`, i);
    for (const intent of cs.intents) if (writtenIds.has(intentElement(intent))) lastSetAt.set(`${intentElement(intent)}\u0000${intentField(intent)}`, i);
  });
  for (const [i, cs] of sinceBase.entries()) {
    if (sameSession(cs, request)) continue;
    for (const intent of cs.intents) {
      const element = intentElement(intent);
      if (!writtenIds.has(element) || (lastSetAt.get(`${element}\u0000${intentField(intent)}`) ?? i) > i) continue;
      if (!intentHolds(exec.model, intent)) {
        return {
          ok: false,
          error: {
            code: "conflict",
            message: `This change would undo ${cs.actor.name}'s edit (${describeIntent(intent)})`,
            elementIds: intent.kind === "tap_at" ? [intent.tapId] : [intent.elementId],
          },
          conflict: { withActor: cs.actor, withRevision: cs.revision, reason: "intent_broken" },
        };
      }
    }
  }

  const revision = asRevision(head.revision + 1);
  const authoredByElement = new Map<ElementId, string[]>();
  for (const w of exec.authored) {
    pushTo(authoredByElement, w.elementId, w.field);
  }

  const changed: BimElement[] = [];
  const before: Record<string, BimElement | null> = {};
  // The command built a fresh copy of head for this call: stamp versions into it instead of
  // copying every element again (that copy dominates commit time on large models).
  const elements: Record<string, BimElement> = takeOwnedElements(exec) ?? draftElements(exec.model.elements);
  for (const id of exec.removedIds) {
    const prior = head.elements[id];
    if (prior) before[id] = prior;
  }
  for (const id of exec.changedIds) {
    before[id] = head.elements[id] ?? null;
    const after = exec.model.elements[id];
    if (!after) continue;
    const fields = authoredByElement.get(id) ?? [];
    const authoredRev: Record<string, number> = { ...after.authoredRev };
    for (const f of fields) authoredRev[f] = revision;
    const next: BimElement = { ...after, version: (head.elements[id]?.version ?? 0) + 1, authoredRev };
    elements[id] = next;
    changed.push(next);
  }

  const rebased = sinceBase.length > 0;

  const changeset: Changeset = {
    revision,
    baseRevision: request.baseRevision,
    idempotencyKey: request.idempotencyKey,
    actor: request.actor,
    command: request.command,
    elements: changed,
    readSet: exec.readSet,
    authored: exec.authored,
    intents: exec.intents,
    rebased,
    committedAt: now(),
    ...(request.clientSessionId ? { clientSessionId: request.clientSessionId } : {}),
    ...(request.cites && request.cites.length > 0 ? { cites: request.cites } : {}),
    before,
    ...(exec.removedIds.length > 0 ? { removedIds: exec.removedIds } : {}),
    ...(exec.removedConnections.length > 0 ? { removedConnections: exec.removedConnections } : {}),
    ...(exec.addedConnections.length > 0 ? { addedConnections: exec.addedConnections } : {}),
  };
  const committed = freezeElements(elements);
  const model: ModelState = { ...head, revision, elements: committed, connections: exec.model.connections };
  // Same content as the validated, fully derived command result apart from versions.
  const touched = [...exec.changedIds, ...exec.removedIds];
  if (model.connections === head.connections) shareNetwork(head.elements, committed, touched);
  carryClassIndexes(head.elements, committed, touched);
  carryRevision(head.elements, committed, touched);
  sharePartitionIndex(head.elements, committed, touched);
  shareLoadIndex(head.elements, committed, touched);
  shareRequirementsEngine(head.elements, committed, touched);
  // Only versions differ from the command result: the systems' kept flow walks still describe this head.
  carryFlowForest(exec.model.elements, committed);
  markKnownIssues(model, exec.openIssues ?? []);
  return { ok: true, changeset, model };
}

function sameSession(cs: Changeset, request: CommandRequest): boolean {
  return cs.actor.id === request.actor.id && (cs.clientSessionId ?? null) === (request.clientSessionId ?? null);
}

function findAuthor(log: readonly Changeset[], elementId: ElementId, field: string): Changeset | undefined {
  for (let i = log.length - 1; i >= 0; i--) {
    const cs = log[i];
    if (cs && cs.authored.some((w) => w.elementId === elementId && w.field === field)) return cs;
  }
  return undefined;
}

export class RevisionGapError extends Error {
  constructor(readonly have: number, readonly got: number) {
    super(`Changeset ${got} does not follow local revision ${have}`);
    this.name = "RevisionGapError";
  }
}

/** Apply a committed changeset. Throws on a revision gap so the caller fills it from the log. */
export function applyChangeset(model: ModelState, cs: Changeset): ModelState {
  if (cs.revision !== model.revision + 1) throw new RevisionGapError(model.revision, cs.revision);
  const draft = draftElements(model.elements);
  for (const id of cs.removedIds ?? []) delete draft[id];
  for (const el of cs.elements) draft[el.id] = el;
  const elements = freezeElements(draft);
  const ids = [...cs.elements.map((el) => el.id), ...(cs.removedIds ?? [])];
  // A connection is held only when both its ends are (an area slice may hold one end).
  const added = (cs.addedConnections ?? []).filter((c) => elements[c.a.elementId] && elements[c.b.elementId]);
  const connections = nextConnections(model.connections, { removedConnections: cs.removedConnections, addedConnections: added });
  if (connections === model.connections) shareNetwork(model.elements, elements, ids);
  carryClassIndexes(model.elements, elements, ids);
  carryRevision(model.elements, elements, ids);
  sharePartitionIndex(model.elements, elements, ids);
  shareLoadIndex(model.elements, elements, ids);
  shareRequirementsEngine(model.elements, elements, ids);
  return { ...model, revision: cs.revision, elements, connections };
}

/**
 * For candidates that validate outside the commit transaction: every element
 * read during validation must be unchanged at commit (R3), not only the rows
 * being written.
 */
export function readSetStillValid(model: ModelState, readSet: Readonly<Record<string, number>>): boolean {
  return Object.entries(readSet).every(([id, version]) => model.elements[id]?.version === version);
}
