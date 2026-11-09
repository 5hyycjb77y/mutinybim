import { createHash } from "node:crypto";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { canonicalJson, commandIssueMessage, commandSchema, type Command, type Interest, type ModelState } from "@permitzip/bim-kernel";
import type { AgentSession } from "@permitzip/bim-sync";
import { editResultBody, explain, failure, notSent, text } from "./answers";
import { withAreaSessionVia } from "./area";
import type { BuiltCommand, ToolResult } from "./host";

/**
 * The caller every MutinyBIM tool pack works through: who is asking (the
 * person, and the agent run acting for them) and how this host reaches the
 * model as them. A host resolves one per call, after its own sign-in and
 * permission checks (`ResolveBimCaller(extra, projectId, write)` refuses
 * before any model server contact), so every pack's tools get the same
 * identity, permissions and model server without knowing the host.
 */

/** The MCP request's auth context, as a tool handler receives it. */
export type Extra = { authInfo?: AuthInfo };

/** What a host's gate before an edit answers: null lets the edit go to the model server. */
export type BeforeEditAnswer = { readonly body: unknown; readonly isError: boolean } | null;

export interface BimCaller {
  readonly userId: string;
  /** This agent run (a thread, or a stable id for an outside client): it keys idempotent edits. */
  readonly runId: string;
  readonly agentName: string;
  /** A person working directly (Print set, Issue set): edits are theirs, not an agent's. */
  readonly asPerson?: boolean;
  /** The branch this caller's sessions connect to (null: Main); edit answers name it. */
  readonly branchId?: string | null;
  /** A session on the model server as this caller, loaded with `interest` (absent: the whole model). */
  open(modelId: string, interest: Interest | undefined): Promise<AgentSession>;
  /** The host's gate before an edit is sent (a preview its approval card needs, a closed branch). */
  beforeEdit?(input: { readonly session: AgentSession; readonly command: Command; readonly modelId: string }): Promise<BeforeEditAnswer>;
  /** Told after an edit is saved (a host notifies whoever an answer it changed belongs to). */
  afterSaved?(input: { readonly modelId: string; readonly before: ModelState; readonly after: ModelState; readonly changedIds: readonly string[] }): Promise<void>;
}

export type ResolveBimCaller = (extra: Extra, projectId: string, write: boolean) => Promise<BimCaller>;

/** Same tool call, same key: a retried call (network blip, worker resume) gets the first answer instead of applying the edit twice. */
export function editIdempotencyKey(runId: string, toolName: string, args: unknown, baseRevision: number): string {
  const digest = createHash("sha256").update(canonicalJson({ runId, toolName, args, baseRevision })).digest("hex").slice(0, 40);
  return `agent-${digest}`;
}

export async function withSession<T>(who: BimCaller, modelId: string, interest: Interest | undefined, work: (session: AgentSession) => Promise<T>): Promise<T> {
  const session = await who.open(modelId, interest);
  try {
    return await work(session);
  } finally {
    session.close();
  }
}

/** A session loaded with the area an agent named (the level by id or a loose name; an unknown level refuses with the candidates). */
export async function withAreaSession<T>(who: BimCaller, modelId: string, area: { level?: string; zone?: string }, work: (session: AgentSession, level: string | undefined) => Promise<T>): Promise<T | ReturnType<typeof failure>> {
  return withAreaSessionVia((interest, w) => withSession(who, modelId, interest, w), area, work);
}

const gateAnswer = (answer: NonNullable<BeforeEditAnswer>) => ({ ...text(answer.body), ...(answer.isError ? { isError: true } : {}) });

/** Shared body of every edit tool. */
export async function runEdit(
  caller: ResolveBimCaller,
  tool: string,
  extra: Extra,
  args: { project_id: string; model_id: string; base_revision?: number; level?: string; zone?: string },
  command: Command,
  /** What makes two calls "the same request" (default: the model and the command). */
  requestKey?: unknown,
  /** More for the agent to read beside the result (what the edit looks like where it lands); a function reads the model the edit saved. */
  extraBody?: Record<string, unknown> | null | ((saved: ModelState) => Record<string, unknown>),
) {
  // The model server drops a message it can't parse without an answer; refuse it here, naming the field.
  const checked = commandSchema.safeParse(command);
  if (!checked.success) {
    const message = notSent(commandIssueMessage(checked.error, command));
    return { ...text({ status: "refused", code: "invalid_command", message, element_ids: [], model_id: args.model_id }), isError: true };
  }
  try {
    const who = await caller(extra, args.project_id, true);
    return await withAreaSession(who, args.model_id, args, async (session) => {
      const base = args.base_revision ?? session.revision();
      const gate = (await who.beforeEdit?.({ session, command, modelId: args.model_id })) ?? null;
      if (gate) return gateAnswer(gate);
      const before = session.model();
      const result = await session.edit(command, {
        idempotencyKey: editIdempotencyKey(who.runId, tool, requestKey ?? { model_id: args.model_id, command }, base),
        baseRevision: base,
      });
      if (result.status === "saved") await who.afterSaved?.({ modelId: args.model_id, before, after: session.model(), changedIds: result.changedIds });
      const more = typeof extraBody === "function" ? (result.status === "saved" ? extraBody(session.model()) : {}) : (extraBody ?? {});
      // The caller connected this session to its thread's branch; the session's welcome names it.
      const onBranch = who.branchId ? { id: who.branchId, name: session.branch()?.name ?? who.branchId } : null;
      return text({ ...editResultBody(result, args.model_id), ...(onBranch ? { branch: onBranch } : {}), ...more });
    });
  } catch (err) {
    return explain(err, tool);
  }
}

function isExtra(value: unknown): value is Extra {
  return typeof value === "object" && value !== null;
}

/** Read the model as the caller (read permission) and answer from it. */
export async function readAs(caller: ResolveBimCaller, tool: string, extra: unknown, args: { project_id: string; model_id: string; level?: string; zone?: string }, work: (session: AgentSession) => unknown): Promise<ToolResult> {
  try {
    if (!isExtra(extra)) throw new Error("This request carried no sign-in.");
    const who = await caller(extra, args.project_id, false);
    return await withAreaSession(who, args.model_id, args, async (s) => text(work(s)));
  } catch (err) {
    return explain(err, tool);
  }
}

/** Send a command built on the model the edit lands on, as the caller (write permission), through the host's gate. */
export async function editAs(
  caller: ResolveBimCaller,
  tool: string,
  extra: unknown,
  args: { project_id: string; model_id: string; base_revision?: number; level?: string; zone?: string },
  editArgs: unknown,
  build: (model: ModelState, key: string) => BuiltCommand,
): Promise<ToolResult> {
  try {
    if (!isExtra(extra)) throw new Error("This request carried no sign-in.");
    const who = await caller(extra, args.project_id, true);
    return await withAreaSession(who, args.model_id, args, async (session) => {
      const base = args.base_revision ?? session.revision();
      const idempotencyKey = editIdempotencyKey(who.runId, tool, { model_id: args.model_id, args: editArgs }, base);
      const built = build(session.model(), idempotencyKey);
      if (!built.ok) {
        // A kernel rule behind the builder's refusal: answer like any refused edit, with its code and elements.
        if (built.code) return { ...text({ status: "refused", code: built.code, message: built.message, element_ids: built.elementIds ?? [], model_id: args.model_id }), isError: true };
        return failure(built.message);
      }
      const gate = (await who.beforeEdit?.({ session, command: built.command, modelId: args.model_id })) ?? null;
      if (gate) return gateAnswer(gate);
      const result = await session.edit(built.command, { idempotencyKey, baseRevision: base });
      return text({ ...editResultBody(result, args.model_id), command: built.command.type });
    });
  } catch (err) {
    return explain(err, tool);
  }
}
