// Frozen copy of the kernel before the network index (as of commit b91b54f24). Equivalence reference for
// __tests__/scale-equivalence.test.ts and scripts/bench-heavy.ts only; never imported by src.
import { z } from "zod";
import {
  authoredFieldValue,
  commandSchema,
  describeIntent,
  executeCommand,
  intentHolds,
  sameValue,
  type AuthoredWrite,
  type Command,
  type CommandError,
  type IntentPredicate,
} from "./commands";
import { asRevision, type BimElement, type ElementId, type ModelState, type Revision } from "./types";

export const actorSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  kind: z.enum(["human", "agent"]),
});
export type Actor = z.infer<typeof actorSchema>;

export const commandRequestSchema = z.object({
  idempotencyKey: z.string().min(8).max(128),
  baseRevision: z.number().int().min(0),
  actor: actorSchema,
  command: commandSchema,
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

  const exec = executeCommand(head, request.command);
  if (!exec.ok) return { ok: false, error: exec.error };

  // Your own earlier edits that you had not yet seen confirmed are not competing intent.
  const others = sinceBase.filter((cs) => cs.actor.id !== request.actor.id);

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
  const writtenIds = new Set<string>(exec.changedIds); // the reference kernel has no removals
  const intentElement = (intent: IntentPredicate): string => (intent.kind === "tap_at" ? intent.tapId : intent.elementId);
  const intentField = (intent: IntentPredicate): string => (intent.kind === "tap_at" ? "position" : intent.field);
  const lastSetAt = new Map<string, number>();
  sinceBase.forEach((cs, i) => {
    for (const w of cs.authored) if (writtenIds.has(w.elementId)) lastSetAt.set(`${w.elementId}\u0000${w.field}`, i);
    for (const intent of cs.intents) if (writtenIds.has(intentElement(intent))) lastSetAt.set(`${intentElement(intent)}\u0000${intentField(intent)}`, i);
  });
  for (const [i, cs] of sinceBase.entries()) {
    if (cs.actor.id === request.actor.id) continue;
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
    authoredByElement.set(w.elementId, [...(authoredByElement.get(w.elementId) ?? []), w.field]);
  }

  const changed: BimElement[] = [];
  const elements: Record<string, BimElement> = { ...head.elements };
  for (const id of exec.changedIds) {
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
  };
  return { ok: true, changeset, model: { ...head, revision, elements } };
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
  const elements: Record<string, BimElement> = { ...model.elements };
  for (const el of cs.elements) elements[el.id] = el;
  return { ...model, revision: cs.revision, elements };
}

/**
 * For candidates that validate outside the commit transaction: every element
 * read during validation must be unchanged at commit (R3), not only the rows
 * being written.
 */
export function readSetStillValid(model: ModelState, readSet: Readonly<Record<string, number>>): boolean {
  return Object.entries(readSet).every(([id, version]) => model.elements[id]?.version === version);
}
