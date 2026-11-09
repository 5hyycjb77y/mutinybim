import { z } from "zod";
import type { AuthoredWrite, ExecuteErr, ExecuteOk, ExecuteResult, IntentPredicate } from "../command-core";
import type { Connection, ElementId, ModelState } from "../types";
import { strictCommands } from "../strict-commands";
import { documentIndex, executeViewCommand, viewCommandSchemas, type ViewCommand } from "./views";

/**
 * Many views and sheets commands as one edit: one approval, one revision, all
 * or nothing. Each step runs against the result of the steps before it, under
 * the same rules as when sent alone, so a batch can create a sheet and place a
 * view on it. The commit checks the union of what every step read against the
 * head it lands on, exactly as for a single command.
 */

export const MAX_BATCH_STEPS = 500;

export const batchCommandSchemas = [
  z.object({
    type: z.literal("batch_documents"),
    /** What the batch does, in words, for the approval card and history. */
    label: z.string().trim().min(1).max(160).optional(),
    commands: z.array(z.discriminatedUnion("type", strictCommands(viewCommandSchemas))).min(1).max(MAX_BATCH_STEPS),
  }),
] as const;

export type BatchCommand = z.infer<(typeof batchCommandSchemas)[number]>;

export function isBatchCommand(command: { readonly type: string }): command is BatchCommand {
  return command.type === "batch_documents";
}

const connectionKey = (c: Connection) => `${c.a.elementId}:${c.a.end}|${c.b.elementId}:${c.b.end}`;

function intentKey(i: IntentPredicate): string {
  return i.kind === "tap_at" ? `tap_at:${i.tapId}` : `field:${i.elementId}:${i.field}`;
}

export function executeBatchCommand(model: ModelState, command: BatchCommand): ExecuteResult {
  // Index the documents once; every step then carries the index forward instead of rebuilding it.
  documentIndex(model);
  return executeSteps(model, command.commands, (m, step) => executeViewCommand(m, step satisfies ViewCommand), command.label ?? "Views and sheets batch");
}

/**
 * Run `steps` as one edit: each against the result of the steps before it,
 * stopping at the first refusal (which names its step). The read set is what
 * the steps read of the model as it was before the batch, so the commit
 * checks it against the head exactly as for one command.
 */
export interface StepRuns<S> {
  /** How many steps from `at` (at least 1) `run` may execute together. */
  readonly lengthAt: (steps: readonly S[], at: number) => number;
  /**
   * Those steps as one edit, with the model and refusal outcome of running
   * them one after another, and their authored writes and intents listed per
   * step in step order. A refusal is re-run step by step to name its step.
   */
  readonly run: (model: ModelState, steps: readonly S[]) => ExecuteResult;
}

export function executeSteps<S extends { readonly type: string }>(model: ModelState, steps: readonly S[], run: (model: ModelState, step: S) => ExecuteResult, label: string, runs?: StepRuns<S>): ExecuteResult {
  let current = model;
  const changed: ElementId[] = [];
  const seenChanged = new Set<ElementId>();
  const removed: ElementId[] = [];
  const removedConnections = new Map<string, Connection>();
  const addedConnections = new Map<string, Connection>();
  const readSet: Record<string, number> = {};
  const authored = new Map<string, AuthoredWrite>();
  const intents = new Map<string, IntentPredicate>();
  const summary: string[] = [];
  let openIssues: ExecuteOk["openIssues"];
  const refusedAt = (i: number, step: S, error: ExecuteErr["error"]): ExecuteErr => ({
    ok: false,
    error: { ...error, message: `Step ${i + 1} of ${steps.length} (${step.type.replace(/_/g, " ")}): ${error.message}` },
  });
  const results: ExecuteOk[] = [];
  for (let i = 0; i < steps.length; ) {
    const length = runs ? Math.max(1, Math.min(runs.lengthAt(steps, i), steps.length - i)) : 1;
    const together = length > 1 && runs ? runs.run(current, steps.slice(i, i + length)) : null;
    results.length = 0;
    if (together?.ok) results.push(together);
    else {
      let at = current;
      for (let k = i; k < i + length; k++) {
        const step = steps[k] as S;
        const result = run(at, step);
        if (!result.ok) return refusedAt(k, step, result.error);
        results.push(result);
        at = result.model;
      }
    }
    i += length;
    for (const result of results) {
      current = result.model;
      openIssues = result.openIssues;
      for (const id of result.changedIds) {
        if (seenChanged.has(id)) continue;
        seenChanged.add(id);
        changed.push(id);
      }
      removed.push(...result.removedIds);
      for (const c of result.removedConnections) removedConnections.set(connectionKey(c), c);
      for (const c of result.addedConnections) addedConnections.set(connectionKey(c), c);
      // Only what existed before the batch can have been changed by someone else.
      for (const [id, version] of Object.entries(result.readSet)) {
        const before = model.elements[id];
        if (before && readSet[id] === undefined) readSet[id] = Math.min(before.version, version);
      }
      for (const a of result.authored) authored.set(`${a.elementId}\u0000${a.field}`, a);
      for (const p of result.intents) intents.set(intentKey(p), p);
      if (result.summary) summary.push(...result.summary);
    }
  }
  return {
    ok: true,
    model: current,
    changedIds: changed,
    removedIds: [...new Set(removed)],
    removedConnections: [...removedConnections.values()],
    addedConnections: [...addedConnections.values()],
    readSet,
    authored: [...authored.values()],
    intents: [...intents.values()],
    summary: [`${label}: ${steps.length} step${steps.length === 1 ? "" : "s"}`, ...summary],
    ...(openIssues && openIssues.length > 0 ? { openIssues } : {}),
  };
}
