/**
 * The approval hook: a person decides every edit and every library save
 * before it lands. A gated tool first re-runs and re-checks what was
 * previewed, then asks the gate, and lands only on yes.
 *
 * Three gates ship:
 *
 * - `hostDecidedApproval`: the host's own agent harness asked the person
 *   before the call reached the tool (an Approve card backed by a durable
 *   ledger, or the MCP client's own confirmation). The tool never records
 *   or invents approval state itself.
 * - `elicitationApproval`: the tool server asks the person directly through
 *   MCP elicitation, which the client shows to the person and the agent
 *   cannot answer. A client without elicitation is refused in words.
 * - `autoApproval`: yes to everything. A local demo on your own computer
 *   only (`--approve auto`); it says so on every answer.
 */

export interface ApprovalProposal {
  readonly tool: string;
  readonly projectId: string;
  readonly modelId?: string;
  /** One line the person reads: what lands and where. */
  readonly summary: string;
  readonly tier: "session_allowed" | "ask_every_time";
  readonly reasons?: readonly string[];
}

export type ApprovalDecision = { readonly approved: true; readonly by: string } | { readonly approved: false; readonly message: string };

/** What the tool server can do to reach the person during a call. */
export interface ApprovalIo {
  /** Ask the person yes or no through the client; "unsupported" when the client can't ask. */
  confirm(message: string): Promise<"approved" | "declined" | "unsupported">;
}

export interface ApprovalGate {
  /** Shown in the server's description of itself. */
  readonly mode: "host_decided" | "elicitation" | "auto";
  decide(extra: unknown, proposal: ApprovalProposal, io: ApprovalIo): Promise<ApprovalDecision>;
}

export const hostDecidedApproval: ApprovalGate = {
  mode: "host_decided",
  async decide() {
    return { approved: true, by: "host" };
  },
};

export const ELICITATION_UNSUPPORTED =
  "Not applied: your agent client can't ask you to approve this change (it doesn't support MCP elicitation). Use a client that does, or restart the server with --approve auto for a local demo where every change lands without asking.";

export function elicitationApproval(): ApprovalGate {
  return {
    mode: "elicitation",
    async decide(_extra, proposal, io) {
      const lines = [proposal.summary, ...(proposal.reasons ?? [])].join("\n");
      let answer: Awaited<ReturnType<ApprovalIo["confirm"]>>;
      try {
        answer = await io.confirm(`MutinyBIM wants to ${lines}\nApprove?`);
      } catch (err) {
        console.error("[bim-mcp] asking the person to approve failed", { tool: proposal.tool, err });
        return { approved: false, message: `Not applied: asking you to approve failed (${err instanceof Error ? err.message : String(err)}). Nothing changed.` };
      }
      if (answer === "approved") return { approved: true, by: "person" };
      if (answer === "unsupported") return { approved: false, message: ELICITATION_UNSUPPORTED };
      return { approved: false, message: "Not applied: you declined it. Nothing changed." };
    },
  };
}

export const AUTO_APPROVAL_NOTE = "Landed without asking: this server runs with --approve auto (a local demo).";

export const autoApproval: ApprovalGate = {
  mode: "auto",
  async decide() {
    return { approved: true, by: "auto" };
  },
};

const APPROVE_SCHEMA = { type: "object" as const, properties: { approve: { type: "boolean" as const, title: "Approve", description: "Land this change" } }, required: ["approve"] };

/**
 * How a tool reaches the person from inside a call when it has only the
 * request (MCP elicitation over the request's own channel). A client that
 * can't ask answers "unsupported".
 */
export function approvalIoFromRequest(extra: unknown): ApprovalIo {
  return {
    async confirm(message) {
      const send = typeof extra === "object" && extra !== null && "sendRequest" in extra ? (extra as { sendRequest: unknown }).sendRequest : undefined;
      if (typeof send !== "function") return "unsupported";
      const { ElicitResultSchema } = await import("@modelcontextprotocol/sdk/types.js");
      try {
        const answer = await (send as (r: unknown, s: typeof ElicitResultSchema) => Promise<{ action: string; content?: Record<string, unknown> }>)({ method: "elicitation/create", params: { message, requestedSchema: APPROVE_SCHEMA } }, ElicitResultSchema);
        return answer.action === "accept" && answer.content?.approve === true ? "approved" : "declined";
      } catch (err) {
        if (err instanceof Error && /elicitation/i.test(err.message)) return "unsupported";
        throw err;
      }
    },
  };
}
