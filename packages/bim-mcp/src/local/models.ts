import type { Interest } from "@permitzip/bim-kernel";
import { AgentSession, agentActor } from "@permitzip/bim-sync";
import { editResultBody, explain, failure, text } from "../answers";
import { editIdempotencyKey, type ResolveBimCaller } from "../caller";
import { approvalIoFromRequest, type ApprovalGate } from "../approvals";
import { withAreaSessionVia, interestOf } from "../area";
import type { ModelAccess } from "../host";
import type { LocalModelServer } from "./model-server";

export interface LocalModelAccessOptions {
  readonly server: LocalModelServer;
  /** The person this server runs for (their name on every change). */
  readonly person: string;
  /** This agent run (one per server start). */
  readonly runId: string;
  /** Refuse every edit (reads and previews still work). */
  readonly readOnly?: boolean;
  /** Loads the part geometry engine when a model has modeled parts (default: the open engine). */
  readonly partGeometry?: (session: AgentSession) => Promise<void>;
  /** Asked before every edit an add-on pack sends through the caller (absent: edits land as sent). */
  readonly approvals?: ApprovalGate;
  /** The agent's name on its changes and in the editor's list of who is here (default "Local agent"). */
  readonly agentName?: string;
}

export const LOCAL_AGENT_NAME = "Local agent";

export const READ_ONLY_REFUSAL = "This tool server is read-only (--read-only), so nothing was changed. Restart it without --read-only to edit.";

async function defaultPartGeometry(session: AgentSession): Promise<void> {
  const geometry = await import("@permitzip/bim-editor/contracts/bim/part-geometry");
  if (geometry.hasModeledParts(session.model())) await geometry.initPartGeometry();
}

/**
 * Model access for one person on their own computer: every session signs in
 * as an agent acting for them, every edit goes through the model server's
 * own commit path (saved, conflict, refused or not saved yet), and a
 * read-only server refuses edits before any model server contact.
 */
export function localModelAccess(options: LocalModelAccessOptions): ModelAccess {
  const partGeometry = options.partGeometry ?? defaultPartGeometry;
  const agentName = options.agentName ?? LOCAL_AGENT_NAME;
  const session = async <T>(modelId: string, interest: Interest | undefined, work: (s: AgentSession) => Promise<T>): Promise<T> => {
    const s = await AgentSession.open({ url: options.server.url, token: "local", modelId, actor: agentActor(options.person, options.runId, agentName), interest, socketFactory: options.server.socketFactory });
    try {
      await partGeometry(s);
      return await work(s);
    } finally {
      s.close();
    }
  };
  return {
    withModel: (_extra, args, work) => session(args.model_id, interestOf(args.level, args.zone), work),
    withArea: (_extra, args, work) => withAreaSessionVia((interest, w) => session(args.model_id, interest, w), args, work),
    async edit(tool, _extra, args, editArgs, build) {
      try {
        if (options.readOnly) return { ...text({ status: "refused", code: "read_only", message: READ_ONLY_REFUSAL, element_ids: [], model_id: args.model_id }), isError: true };
        return await withAreaSessionVia(
          (interest, w) => session(args.model_id, interest, w),
          args,
          async (s) => {
            const base = args.base_revision ?? s.revision();
            const idempotencyKey = editIdempotencyKey(options.runId, tool, { model_id: args.model_id, args: editArgs }, base);
            const built = build(s.model(), idempotencyKey);
            if (!built.ok) {
              if (built.code) return { ...text({ status: "refused", code: built.code, message: built.message, element_ids: built.elementIds ?? [], model_id: args.model_id }), isError: true };
              return failure(built.message);
            }
            const result = await s.edit(built.command, { idempotencyKey, baseRevision: base });
            return text({ ...editResultBody(result, args.model_id), command: built.command.type });
          },
        );
      } catch (err) {
        return explain(err, tool);
      }
    },
  };
}

/**
 * The caller every add-on pack works through on this computer: the person
 * running the server, one agent run, sessions on the local model server. A
 * read-only server refuses a write before any model server contact.
 */
export function localCaller(options: LocalModelAccessOptions): ResolveBimCaller {
  const partGeometry = options.partGeometry ?? defaultPartGeometry;
  const agentName = options.agentName ?? LOCAL_AGENT_NAME;
  return async (extra, projectId, write) => {
    if (write && options.readOnly) throw new Error(READ_ONLY_REFUSAL);
    return {
      userId: options.person,
      runId: options.runId,
      agentName,
      async open(modelId, interest) {
        const s = await AgentSession.open({ url: options.server.url, token: "local", modelId, actor: agentActor(options.person, options.runId, agentName), interest, socketFactory: options.server.socketFactory });
        try {
          await partGeometry(s);
        } catch (err) {
          s.close();
          throw err;
        }
        const gate = options.approvals;
        if (!gate) return s;
        // Every edit through this session asks the person first, whichever pack tool sends it.
        const send = s.edit.bind(s);
        s.edit = async (command, opts) => {
          const decision = await gate.decide(extra, { tool: command.type, projectId, modelId, summary: `make the edit "${command.type}" in model ${modelId}`, tier: "ask_every_time" }, approvalIoFromRequest(extra));
          if (decision.approved) return send(command, opts);
          return { status: "refused", code: "not_approved", message: decision.message.replace(/^Not applied: /, "").replace(/ Nothing changed\.$/, ""), elementIds: [], latestRevision: s.revision() };
        };
        return s;
      },
    };
  };
}
