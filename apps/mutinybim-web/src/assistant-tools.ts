/**
 * The tool server outside assistants reach over the internet: MCP
 * Streamable HTTP at /mcp (the core pack only, ten tools at most) and at
 * /packs/<family>/mcp (the core plus that family). Every other family is
 * on the server but off until the assistant turns it on in the session
 * (`bim_enable_pack`, which sends `notifications/tools/list_changed`).
 * The core, the families and the switch are `@permitzip/bim-mcp`'s; this
 * file only hosts them:
 *
 * - Identity: the person who signed the assistant in (assistant-auth.ts).
 *   Each session is one agent run acting for them.
 * - Authorization: the person's access to each model, checked before any
 *   model contact and again by the model server: someone else's model is
 *   out of reach, and a model shared view-only can be read but never
 *   changed.
 * - Approval: every change asks the person first (assistant-approvals.ts).
 * - Scripts: run in the sealed script box (script-sandbox.ts), one at a
 *   time per person; their output lands only through bim_apply_output,
 *   approved like any other change.
 * - Model server: this app's own, joined in-process through the same
 *   checks the editor's connections pass. The assistant's own name (as it
 *   registered) is on its changes and in the editor's list of who is here.
 * - Sessions and approvals are kept in the account database: after a
 *   restart an assistant carries on in the same session (with the families
 *   it turned on), and requests waiting for the person are still there.
 * - Linked models (linked-hosts.ts): a core tool call naming one is sent to
 *   the linked host's own tool server, which enforces its own permissions;
 *   a change asks the person here first, exactly as for their own models.
 *   Other families don't reach linked models.
 */
import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { ElicitResultSchema, isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { canonicalJson, parseBranchModelId, type Command } from "@permitzip/bim-kernel";
import { approvalIoFromRequest, createBimToolServer, familySlug, LOCAL_SCHEMAS, PACK_CONTROL_TOOL, type ApprovalGate, type CoreSchemas, type BimToolHost, type ResolveBimCaller, type ScriptRunnerHost, type ToolCallWrapper } from "@permitzip/bim-mcp";
import { localCaller, localModelAccess, MemoryScriptLibrary, type LocalModelServer } from "@permitzip/bim-mcp/local";
import { localToolPacks } from "@permitzip/bim-mcp-packs";
import type { AgentEditResult, AgentSocketFactory } from "@permitzip/bim-sync";
import { agentActorId } from "@permitzip/bim-sync";
import { APPROVAL_WAIT_MS, type ApprovalBook, type PendingApproval } from "./assistant-approvals";
import { bearerChallenge, exchangeToken, protectedResourceMetadata, authorizationServerMetadata, registerClient, toolPathOf, verifyAccessToken, type AssistantAuthOptions } from "./assistant-auth";
import type { AssistantSessionRow, Db, ModelAccess, ModelRow, UserRow } from "./db";
import { isLinkedAlias, linkedRefusal, type LinkedHosts } from "./linked-hosts";
import type { HostedScripts } from "./script-sandbox";
import { digest } from "./secrets";

/** What a model connection can do to the side that opened it. */
export interface ModelEndpoint {
  send(data: string): void;
  close(code: number, reason: string): void;
}

/** One connection's half of the model server: messages in, leave on close. */
export interface ModelAttachment {
  receive(raw: string): Promise<void>;
  leave(): Promise<void>;
}

/** Joins the app's model server as a person (app.ts: the same checks a browser's connection passes). */
export type AttachModel = (person: UserRow, actorId: string, modelFromUrl: string | null, endpoint: ModelEndpoint) => ModelAttachment;

export interface AssistantToolsOptions {
  readonly auth: AssistantAuthOptions;
  readonly db: Db;
  readonly dataDir: string;
  readonly approvals: ApprovalBook;
  readonly attach: AttachModel;
  /** Where scripts run (the sealed box on the hosted server). */
  readonly scripts: HostedScripts;
  /** How long a tool call waits for an answer on the approvals page before leaving it there (default 50 s). */
  readonly approvalWaitMs?: number;
  /** Models on linked hosts (absent: none). */
  readonly linked?: LinkedHosts;
}

/** Core tools sent to a linked host as they are (they read, check or preview; nothing lands). */
const LINKED_FORWARDED = new Set(["bim_check_output", "bim_run_script", "bim_model_summary", "bim_query_elements", "bim_inspect_network", "bim_validation_issues"]);
/** Core tools that land a change: the person approves here first, then the host checks it again. */
const LINKED_GATED = new Set(["bim_apply_output", "bim_save_part_type"]);

/** What lands when the person approves a linked change after its tool call returned. */
interface ForwardLanding {
  readonly forward: { readonly alias: string; readonly tool: string; readonly args: Record<string, unknown> };
}

function isForwardLanding(value: unknown): value is ForwardLanding {
  if (typeof value !== "object" || value === null || !("forward" in value)) return false;
  const f = (value as { forward: unknown }).forward;
  if (typeof f !== "object" || f === null) return false;
  const v = f as Record<string, unknown>;
  return typeof v.alias === "string" && typeof v.tool === "string" && typeof v.args === "object" && v.args !== null;
}

function linkedChangeSummary(tool: string, args: Record<string, unknown>): string {
  if (tool === "bim_save_part_type") return "Save the script's part types to the firm library";
  const label = typeof args.label === "string" ? args.label.slice(0, 120) : "the script's result";
  const steps = typeof args.steps === "number" ? ` (${args.steps} step${args.steps === 1 ? "" : "s"})` : "";
  return `Apply “${label}”${steps}`;
}

function linkedChangeDetails(args: Record<string, unknown>): string[] {
  const shown = Object.fromEntries(Object.entries(args).filter(([k]) => k !== "script" && k !== "output"));
  const text = canonicalJson(shown);
  return [text.length > 1500 ? `${text.slice(0, 1500)}…` : text];
}

function resultText(result: { content?: readonly { type: string; text?: string }[] }): string {
  return (result.content ?? []).map((c) => (c.type === "text" ? (c.text ?? "") : "")).join(" ").slice(0, 400);
}

const BODY_LIMIT = 4 * 1024 * 1024;
/** Sessions kept open in memory per person; older ones close and come back from the database when used. */
const SESSIONS_PER_PERSON = 10;
const SESSION_IDLE_MS = 60 * 60_000;
/** Sessions kept in the database per person, and for how long unused. */
const SESSIONS_KEPT_PER_PERSON = 30;
const SESSION_KEEP_MS = 30 * 24 * 60 * 60_000;
const SESSION_TOUCH_MS = 60_000;
const MEMORY_SYNC_URL = "memory://mutinybim-web/sync";
/** This app has no projects; tool families that ask for a project id take this one. */
export const HOSTED_PROJECT_ID = "00000000-0000-4000-8000-000000000001";
/** Given as a read's model_id, it answers with the signed-in person's models instead of reading one. */
export const LIST_MODELS_WORD = "list";
const HOSTED_SCHEMAS: CoreSchemas = {
  reads: { ...LOCAL_SCHEMAS.reads, model_id: LOCAL_SCHEMAS.reads.model_id.describe(`Model id. Pass "${LIST_MODELS_WORD}" to see this person's models.`) },
  scripts: LOCAL_SCHEMAS.scripts,
};


/** Where a library save lands, as the approval names it. */
const LIBRARY_NAME = "your script library";
const NOT_YOURS = "That model isn't in your account or shared with you. It may have been deleted, or its owner stopped sharing it.";
const viewOnlyWords = (name: string) => `You can only view “${name}”: its owner shared it with you as view-only, so nothing was changed. Ask the owner for edit access.`;

function baseModelOf(modelId: string): string {
  return parseBranchModelId(modelId)?.baseModelId ?? modelId;
}

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-session-id, mcp-protocol-version, last-event-id",
  "access-control-expose-headers": "mcp-session-id, mcp-protocol-version, www-authenticate",
  "access-control-max-age": "600",
};

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...CORS, ...headers });
  res.end(JSON.stringify(body));
}

function rpcError(res: ServerResponse, status: number, code: number, message: string, headers: Record<string, string> = {}): void {
  sendJson(res, status, { jsonrpc: "2.0", error: { code, message }, id: null }, headers);
}

async function readRaw(req: IncomingMessage, limit: number): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > limit) return null;
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** What a tool call's request carries that approvals use (progress, the assistant's own requests). */
interface RequestExtra {
  readonly _meta?: { readonly progressToken?: string | number };
  readonly sendNotification?: (notification: { method: string; params: Record<string, unknown> }) => Promise<void>;
  readonly sendRequest?: (request: { method: string; params: Record<string, unknown> }, schema: typeof ElicitResultSchema) => Promise<unknown>;
}

function asExtra(value: unknown): RequestExtra {
  return typeof value === "object" && value !== null ? (value as RequestExtra) : {};
}

/** "create_level" named "Level 2" → "Create level “Level 2”": what the person reads first. */
function commandSummary(command: Command): string {
  const words = command.type.replace(/_/g, " ");
  const named = "name" in command && typeof command.name === "string" && command.name ? ` “${command.name.slice(0, 80)}”` : "";
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}${named}`;
}

/** The command as the person reads it on the approvals page: its kind, and its fields, trimmed. */
function commandDetails(command: Command): string[] {
  const text = canonicalJson(command);
  return [text.length > 1500 ? `${text.slice(0, 1500)}…` : text];
}

function editWords(result: AgentEditResult): string {
  if (result.status === "saved") return `Approved and applied (model revision ${result.revision}).`;
  if (result.status === "conflict") return `Approved, but someone changed the same part of the model first (${result.message}). Nothing changed; ask your assistant again.`;
  if (result.status === "not_saved_yet") return `Approved, but the model server hasn't confirmed it yet (${result.message}).`;
  return `Approved, but the model refused it: ${result.message}`;
}

interface Session {
  readonly transport: WebStandardStreamableHTTPServerTransport;
  readonly server: McpServer;
  readonly userId: string;
  readonly grantId: string;
  /** The stored record (null until the assistant's initialize is answered). */
  row: AssistantSessionRow | null;
  lastSeen: number;
  touched: number;
}

/** What lands when the person approves an edit after its tool call returned. */
interface Landing {
  readonly command: Command;
  readonly idempotencyKey: string;
  readonly baseRevision?: number;
}

function isLanding(value: unknown): value is Landing {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.command === "object" && v.command !== null && typeof (v.command as Record<string, unknown>).type === "string" && typeof v.idempotencyKey === "string" && (v.baseRevision === undefined || typeof v.baseRevision === "number");
}

/** The node request as a web one (the transport speaks web requests). */
function webRequest(req: IncomingMessage, raw: string | undefined, signal: AbortSignal): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  const url = `http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`;
  return new Request(url, { method: req.method ?? "GET", headers, signal, ...(raw !== undefined ? { body: raw } : {}) });
}

/** Writes the transport's web response (a JSON body or an event stream) to the node response. */
function sendWeb(res: ServerResponse, response: Response, abort: AbortController): void {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  res.writeHead(response.status, headers);
  if (!response.body) return void res.end();
  const stream = Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>);
  res.on("close", () => {
    abort.abort();
    stream.destroy();
  });
  stream.on("error", (err) => {
    if (!abort.signal.aborted) console.error("[mutinybim-web] an assistant's response stream failed", { err });
    res.end();
  });
  stream.pipe(res);
}

/** The family a tools/call turns on (bim_enable_pack with a family), if any, in one message or a batch. */
function familiesTurnedOn(body: unknown): string[] {
  const messages = Array.isArray(body) ? body : [body];
  const out: string[] = [];
  for (const m of messages) {
    if (typeof m !== "object" || m === null) continue;
    const msg = m as { method?: unknown; params?: { name?: unknown; arguments?: { family?: unknown } } };
    if (msg.method !== "tools/call" || msg.params?.name !== PACK_CONTROL_TOOL || typeof msg.params.arguments?.family !== "string") continue;
    const slug = familySlug(msg.params.arguments.family);
    if (slug) out.push(slug);
  }
  return out;
}

export interface AssistantTools {
  /** Answers the request if it is for the tool server or its sign-in addresses; false otherwise. */
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
  /** Ends a person's assistant sessions for one grant (they signed it out). */
  endGrant(grantId: string): void;
  close(): Promise<void>;
}

export function createAssistantTools(options: AssistantToolsOptions): AssistantTools {
  const { auth, db, approvals } = options;
  const origin = auth.origin;
  const allowedHost = new URL(origin).host;
  const sessions = new Map<string, Session>();
  const registrations = new Map<string, { count: number; until: number }>();
  let closing = false;

  const sweep = setInterval(() => {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const [id, s] of sessions) if (s.lastSeen < cutoff || !db.assistantGrantExists(s.grantId)) void closeSession(id);
    db.deleteAssistantSessionsBefore(Date.now() - SESSION_KEEP_MS);
  }, 60_000);
  sweep.unref();

  async function closeSession(id: string): Promise<void> {
    const s = sessions.get(id);
    sessions.delete(id);
    if (!s) return;
    try {
      await s.transport.close();
      await s.server.close();
    } catch (err) {
      console.error("[mutinybim-web] closing an assistant session failed", { id, err });
    }
  }

  /** The app's own model server, joined in-process as one agent run for one person. */
  function personModelServer(person: UserRow, actorId: string): LocalModelServer {
    const socketFactory: AgentSocketFactory = (url, handlers) => {
      const modelId = new URL(url).searchParams.get("model");
      let closed = false;
      const attachment = options.attach(person, actorId, modelId, {
        // Delivered on a later turn, as a socket would: the session never receives inside its own send.
        send: (data) => void setTimeout(() => !closed && handlers.onMessage(data), 0),
        close: (_code, reason) => {
          if (closed) return;
          closed = true;
          handlers.onClose(reason);
        },
      });
      let queue: Promise<void> = Promise.resolve();
      setTimeout(() => !closed && handlers.onOpen(), 0);
      return {
        send: (data) => {
          queue = queue.then(() => attachment.receive(data)).catch((err: unknown) => console.error("[mutinybim-web] an assistant's model message failed", { err }));
        },
        close: () => {
          if (closed) return;
          closed = true;
          queue = queue.then(() => attachment.leave()).catch((err: unknown) => console.error("[mutinybim-web] leaving a model failed", { err }));
          handlers.onClose("closed");
        },
      };
    };
    return {
      url: MEMORY_SYNC_URL,
      socketFactory,
      models: () => db.modelsOf(person.id).map((m) => m.id),
      async seed() {
        throw new Error("Make models from My models in the app.");
      },
      async head() {
        return null;
      },
      async close() {},
    };
  }

  function modelsLine(person: UserRow): string {
    const own = db.modelsOf(person.id).map((m) => `${m.name} (model_id ${m.id}, yours)`);
    const shared = db.sharedWith(person.id).map((m) => `${m.name} (model_id ${m.id}, ${m.role === "view" ? "view only" : "you can edit"}, shared by ${m.owner_name})`);
    const all = [...own, ...shared];
    return all.length > 0 ? `${person.display_name}'s models: ${all.slice(0, 40).join("; ")}.` : `${person.display_name} has no models yet; they make one under My models at ${origin}/models.`;
  }

  /**
   * Asks the person: the assistant's own approval box when it has one,
   * otherwise the approvals page (shown by the assistant as a link when it
   * can open links), waiting a little under a minute.
   */
  async function askPerson(server: McpServer, extraValue: unknown, person: UserRow, clientName: string, spec: { readonly modelId: string; readonly modelName: string; readonly summary: string; readonly details: readonly string[]; readonly kind: PendingApproval["kind"]; readonly key: string | null }): Promise<{ readonly answer: "approved" } | { readonly answer: "declined" } | { readonly answer: "waiting"; readonly item: PendingApproval }> {
    const extra = asExtra(extraValue);
    const elicitation = server.server.getClientCapabilities()?.elicitation;
    const canForm = Boolean(elicitation) && (Boolean(elicitation?.form) || !elicitation?.url);
    if (canForm) {
      try {
        const said = await approvalIoFromRequest(extraValue).confirm(`MutinyBIM: ${clientName} wants to make this change in “${spec.modelName}”: ${spec.summary}.\nApprove?`);
        if (said === "approved") return { answer: "approved" };
        if (said === "declined") return { answer: "declined" };
      } catch (err) {
        console.error("[mutinybim-web] the assistant's approval box failed; asking on the approvals page", { userId: person.id, err });
      }
    }
    const item = (spec.key ? approvals.waitingRetry(person.id, spec.key) : null) ?? approvals.create({ userId: person.id, clientName, modelId: spec.modelId, modelName: spec.modelName, summary: spec.summary, details: spec.details, kind: spec.kind, key: spec.key });
    const link = `${origin}/approvals/${item.id}`;
    if (elicitation?.url && extra.sendRequest) {
      extra
        .sendRequest({ method: "elicitation/create", params: { mode: "url", elicitationId: item.id, url: link, message: `Approve or decline ${clientName}'s change to “${spec.modelName}” in MutinyBIM.` } }, ElicitResultSchema)
        .catch((err: unknown) => console.error("[mutinybim-web] asking the assistant to open the approval link failed", { err }));
    }
    const progressToken = extra._meta?.progressToken;
    const waitMs = options.approvalWaitMs ?? APPROVAL_WAIT_MS;
    const answer = await approvals.wait(item, waitMs, (waitedMs) => {
      if (progressToken === undefined || !extra.sendNotification) return;
      extra
        .sendNotification({ method: "notifications/progress", params: { progressToken, progress: Math.round(waitedMs / 1000), total: Math.round(waitMs / 1000), message: `Waiting for ${person.display_name} to approve at ${link}` } })
        .catch((err: unknown) => console.error("[mutinybim-web] sending approval progress failed", { err }));
    });
    if (elicitation?.url && extra.sendNotification && answer !== "timeout") {
      extra.sendNotification({ method: "notifications/elicitation/complete", params: { elicitationId: item.id } }).catch((err: unknown) => console.error("[mutinybim-web] closing the approval link failed", { err }));
    }
    if (answer === "timeout") return { answer: "waiting", item };
    return answer === "approved" ? { answer: "approved" } : { answer: "declined" };
  }

  function makeHost(person: UserRow, grant: { readonly grantId: string; readonly clientName: string }, runId: string, server: () => McpServer): BimToolHost & { readonly caller: ResolveBimCaller; readonly runId: string; readonly person: string } {
    const actorId = agentActorId(person.id, runId);
    const modelServer = personModelServer(person, actorId);
    const access = { server: modelServer, person: person.id, runId, agentName: grant.clientName };
    const models = localModelAccess(access);
    const baseCaller = localCaller(access);
    const library = new MemoryScriptLibrary(person.id);
    const accessTo = (modelId: string): { readonly model: ModelRow; readonly access: ModelAccess } | null => db.accessTo(person.id, baseModelOf(modelId));
    const refused = (message: string, modelId: string) => ({ content: [{ type: "text" as const, text: JSON.stringify({ status: "refused", code: "forbidden", message, element_ids: [], model_id: modelId }) }], isError: true });

    const caller: ResolveBimCaller = async (extra, projectId, write) => {
      const who = await baseCaller(extra, projectId, write);
      return {
        ...who,
        agentName: grant.clientName,
        async open(modelId, interest) {
          const found = accessTo(modelId);
          if (!found) throw new Error(NOT_YOURS);
          if (write && found.access === "view") throw new Error(viewOnlyWords(found.model.name));
          const session = await who.open(modelId, interest);
          const send = session.edit.bind(session);
          // Every change, whichever tool sends it, asks the person first.
          session.edit = async (command, opts): Promise<AgentEditResult> => {
            const now = accessTo(modelId);
            // The tools wrap a refusal as "Not saved: <message>. Nothing changed.", so the message carries neither.
            const no = (code: string, message: string): AgentEditResult => ({ status: "refused", code, message: message.replace(/,? so nothing was changed/, "").replace(/\.$/, ""), elementIds: [], latestRevision: session.revision() });
            if (!now) return no("forbidden", NOT_YOURS);
            if (now.access === "view") return no("forbidden", viewOnlyWords(now.model.name));
            const asked = await askPerson(server(), extra, person, grant.clientName, { modelId, modelName: now.model.name, summary: commandSummary(command), details: commandDetails(command), kind: "edit", key: null });
            if (asked.answer === "approved") return send(command, opts);
            if (asked.answer === "declined") return no("not_approved", `${person.display_name} declined it`);
            const landing: Landing = { command, idempotencyKey: opts.idempotencyKey, ...(opts.baseRevision !== undefined ? { baseRevision: opts.baseRevision } : {}) };
            approvals.setLanding(asked.item, landing);
            return no("awaiting_approval", `waiting for ${person.display_name} to approve it at ${origin}/approvals/${asked.item.id}. Tell them to open that link: it lands the moment they press Approve (within 30 minutes), so don't send it again`);
          };
          return session;
        },
      };
    };

    const approvalsGate: ApprovalGate = {
      mode: "elicitation",
      async decide(extra, proposal) {
        const modelId = proposal.modelId ?? "";
        // A library save (a script's part types) changes no model: only the person's own library.
        const found = modelId ? accessTo(modelId) : null;
        if (modelId && !found) return { approved: false, message: `Not applied: ${NOT_YOURS}` };
        if (found?.access === "view") return { approved: false, message: `Not applied: ${viewOnlyWords(found.model.name)}` };
        const where = found ? found.model.name : LIBRARY_NAME;
        const key = createHash("sha256").update(canonicalJson({ tool: proposal.tool, modelId, summary: proposal.summary, reasons: proposal.reasons ?? [] })).digest("hex");
        if (approvals.takeApprovedRetry(person.id, key)) return { approved: true, by: "person" };
        const asked = await askPerson(server(), extra, person, grant.clientName, { modelId, modelName: where, summary: proposal.summary, details: proposal.reasons ?? [], kind: "retry", key });
        if (asked.answer === "approved") return { approved: true, by: "person" };
        if (asked.answer === "declined") return { approved: false, message: `Not applied: ${person.display_name} declined it. Nothing changed.` };
        return { approved: false, message: `Not applied yet: waiting for ${person.display_name} to approve it at ${origin}/approvals/${asked.item.id}. Tell them to open that link and press Approve, then send exactly the same request again. Nothing changed.` };
      },
    };

    const runner: ScriptRunnerHost = {
      run: (request) => options.scripts.run(person.id, request),
      availability: () => options.scripts.availability(),
    };

    return {
      person: person.id,
      runId,
      caller,
      withModel: models.withModel,
      withArea: models.withArea,
      async edit(tool, extra, args, editArgs, build) {
        const found = accessTo(args.model_id);
        if (!found) return refused(NOT_YOURS, args.model_id);
        if (found.access === "view") return refused(viewOnlyWords(found.model.name), args.model_id);
        return models.edit(tool, extra, args, editArgs, build);
      },
      runner: () => runner,
      scope: (_extra, projectId) => ({ conversationId: runId, projectId }),
      library: async () => library.forCaller(true),
      author: (_extra, callerId) => ({ provider: "mutinybim-web", subject: `agent:${runId}`, kind: "agent", onBehalfOf: { provider: "mutinybim-web", subject: callerId, kind: "person" } }),
      async authorize() {
        const ready = await options.scripts.availability();
        return ready.ok ? { ok: true } : { ok: false, reason: ready.reason };
      },
      approvals: approvalsGate,
    };
  }

  /** Lands an edit the person approved on the page after its tool call returned (also after a restart). */
  approvals.setLander(async (item) => {
    const person = db.userById(item.userId);
    if (!person) return "That account is gone, so nothing changed.";
    if (isForwardLanding(item.landing)) {
      const { alias, tool, args } = item.landing.forward;
      const row = options.linked?.byAlias(person.id, alias) ?? null;
      const provider = row ? options.linked?.provider(row.provider) : null;
      if (!row || !provider || !options.linked) return "That linked model isn't available to you any more, so nothing changed.";
      const hostName = provider.label.replace(/^Log in with /i, "");
      if (!row.can_edit) return `You can only view “${row.label}” in ${hostName}, so nothing changed.`;
      const linked = options.linked;
      const result = await inTurn(person.id, () => linked.call(person, row, tool, args, { agentName: item.clientName, runId: `web-approved-${randomUUID().slice(0, 8)}` }).catch((err: unknown) => linkedRefusal(err, alias)));
      return result.isError ? `Approved, but ${hostName} didn't apply it: ${resultText(result)}` : `Approved and applied in ${hostName}.`;
    }
    if (!isLanding(item.landing)) throw new Error("the approved change wasn't kept in a form that can be applied");
    const found = db.accessTo(person.id, baseModelOf(item.modelId));
    if (!found) return NOT_YOURS;
    if (found.access === "view") return viewOnlyWords(found.model.name);
    const runId = `web-approved-${randomUUID().slice(0, 8)}`;
    const who = await localCaller({ server: personModelServer(person, agentActorId(person.id, runId)), person: person.id, runId, agentName: item.clientName })({}, "", true);
    const session = await who.open(item.modelId, undefined);
    try {
      const { command, idempotencyKey, baseRevision } = item.landing;
      return editWords(await session.edit(command, { idempotencyKey, ...(baseRevision !== undefined ? { baseRevision } : {}) }));
    } finally {
      session.close();
    }
  });

  /** One forwarded script run (or landing) at a time per person, like their runs here. */
  const forwardQueues = new Map<string, Promise<unknown>>();
  function inTurn<T>(userId: string, work: () => Promise<T>): Promise<T> {
    const before = forwardQueues.get(userId) ?? Promise.resolve();
    const next = before.then(work, work);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    forwardQueues.set(userId, settled);
    void settled.then(() => {
      if (forwardQueues.get(userId) === settled) forwardQueues.delete(userId);
    });
    return next;
  }

  /** The words an assistant reads for linked models, or why there are none (never fails the session). */
  async function linkedLine(person: UserRow): Promise<string> {
    if (!options.linked) return "";
    try {
      return await options.linked.assistantLine(person);
    } catch (err) {
      console.error("[mutinybim-web] listing linked models for an assistant failed", { userId: person.id, err });
      return "Linked projects couldn't be listed just now.";
    }
  }

  /** Answers a core tool call that names a linked model; every other call goes on as it is. */
  function linkedRouter(person: UserRow, grant: { readonly clientName: string }, runId: string, server: () => McpServer): ToolCallWrapper | undefined {
    const linked = options.linked;
    if (!linked) return undefined;
    const refusedLinked = (code: string, message: string, modelId: string) => ({ content: [{ type: "text" as const, text: JSON.stringify({ status: "refused", code, message, element_ids: [], model_id: modelId }) }], isError: true });
    return (name, next) =>
      (async (args: unknown, extra: unknown) => {
        const given = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : null;
        const modelId = given && typeof given.model_id === "string" ? given.model_id : null;
        if (!given || !modelId || !isLinkedAlias(modelId)) return (next as (a: unknown, e: unknown) => unknown)(args, extra);
        const row = linked.byAlias(person.id, modelId);
        const provider = row ? linked.provider(row.provider) : null;
        const hostName = provider ? provider.label.replace(/^Log in with /i, "") : "the linked host";
        if (!row || !provider) return refusedLinked("forbidden", `That ${provider?.models.label ?? "linked"} model isn't available to you any more. ${person.display_name} may have lost access, or turned linked projects off on ${origin}/models.`, modelId);
        if (!LINKED_FORWARDED.has(name) && !LINKED_GATED.has(name)) {
          return refusedLinked("not_here", `${name} doesn't reach ${hostName} models from here. Use the core tools (a script does almost everything), or open “${row.label}” in ${hostName}${row.open_url ? ` at ${row.open_url}` : ""} for that.`, modelId);
        }
        const who = { agentName: grant.clientName, runId };
        const forward = () => linked.call(person, row, name, given, who).catch((err: unknown) => linkedRefusal(err, modelId));
        if (LINKED_FORWARDED.has(name)) return name === "bim_run_script" || name === "bim_check_output" ? inTurn(person.id, forward) : forward();
        if (!row.can_edit) return refusedLinked("forbidden", `You can only view “${row.label}” in ${hostName}, so nothing was changed. Ask a project lead there for edit access.`, modelId);
        const asked = await askPerson(server(), extra, person, grant.clientName, { modelId, modelName: row.label, summary: linkedChangeSummary(name, given), details: linkedChangeDetails(given), kind: "edit", key: null });
        if (asked.answer === "declined") return refusedLinked("not_approved", `${person.display_name} declined it. Nothing changed.`, modelId);
        if (asked.answer === "waiting") {
          const landing: ForwardLanding = { forward: { alias: row.alias_id, tool: name, args: given } };
          approvals.setLanding(asked.item, landing);
          return refusedLinked("awaiting_approval", `Waiting for ${person.display_name} to approve it at ${origin}/approvals/${asked.item.id}. Tell them to open that link: it lands the moment they press Approve (within 30 minutes), so don't send it again. Nothing changed yet.`, modelId);
        }
        return inTurn(person.id, forward);
      }) as never;
  }

  function newServer(person: UserRow, grant: { readonly grantId: string; readonly clientName: string }, family: string, runId: string, turnedOn: readonly string[], linkedWords = ""): McpServer {
    let made: McpServer | null = null;
    const host = makeHost(person, grant, runId, () => {
      if (!made) throw new Error("the tool server isn't ready yet");
      return made;
    });
    const aroundTool = linkedRouter(person, grant, runId, () => {
      if (!made) throw new Error("the tool server isn't ready yet");
      return made;
    });
    const instructions =
      `Hosted MutinyBIM at ${origin}, signed in as ${person.display_name}. ${modelsLine(person)}${linkedWords ? ` ${linkedWords}` : ""} This app has no projects: leave project_id out where you can, and where a tool needs one pass ${HOSTED_PROJECT_ID}. ` +
      `Scripts run ${options.scripts.where}: preview with bim_run_script, then land the result with bim_apply_output. ` +
      `Every change asks ${person.display_name} first: in your approval box if you have one, otherwise on ${origin}/approvals. Models shared view-only can be read, never changed.`;
    const linkedTool = aroundTool;
    // Not every assistant shows its model the instructions above, so the model list is also one call away.
    const withModelList: ToolCallWrapper = (name, next) => {
      const inner = linkedTool ? linkedTool(name, next) : next;
      return (async (args: unknown, extra: unknown) => {
        const given = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : null;
        const asked = given && typeof given.model_id === "string" ? given.model_id.trim().toLowerCase() : null;
        if (asked !== LIST_MODELS_WORD) return (inner as (a: unknown, e: unknown) => unknown)(args, extra);
        const linkedNow = await linkedLine(person);
        return { content: [{ type: "text" as const, text: `${modelsLine(person)}${linkedNow ? ` ${linkedNow}` : ""} Call again with one of these model ids. New models are made under My models at ${origin}/models.` }] };
      }) as never;
    };
    made = createBimToolServer({
      host,
      schemas: HOSTED_SCHEMAS,
      runsWhere: options.scripts.where,
      instructions,
      families: [...new Set([family, ...turnedOn].filter((f) => f.length > 0))],
      packs: [localToolPacks(host, path.join(options.dataDir, "assistant-files", person.id))],
      aroundTool: withModelList,
    });
    return made;
  }

  /** A session's transport; its id is fixed when the session is restored from the database. */
  function sessionTransport(id: () => string, live: { session: Session | null }): WebStandardStreamableHTTPServerTransport {
    const transport: WebStandardStreamableHTTPServerTransport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: id,
      onsessioninitialized: (sessionId) => {
        if (live.session) sessions.set(sessionId, live.session);
      },
      onsessionclosed: (sessionId) => {
        // The assistant ended the session itself: it won't come back.
        sessions.delete(sessionId);
        db.deleteAssistantSession(sessionId);
      },
      enableDnsRebindingProtection: true,
      allowedHosts: [allowedHost],
    });
    transport.onclose = () => {
      if (transport.sessionId && sessions.get(transport.sessionId)?.transport === transport) sessions.delete(transport.sessionId);
    };
    return transport;
  }

  /** Makes room for one more open session of this person (the oldest open ones close; they stay restorable). */
  async function roomFor(userId: string): Promise<void> {
    const mine = [...sessions.entries()].filter(([, s]) => s.userId === userId).sort((a, b) => a[1].lastSeen - b[1].lastSeen);
    for (const [id] of mine.slice(0, Math.max(0, mine.length - SESSIONS_PER_PERSON + 1))) await closeSession(id);
  }

  /**
   * A session the server no longer has open (a restart, or closed while
   * idle), brought back from the database: the same agent run, the same
   * families on, the assistant's initialize replayed so its approval box
   * and links work as before.
   */
  async function restore(id: string, signedIn: { readonly user: UserRow; readonly grantId: string; readonly clientName: string }): Promise<Session | null> {
    const row = db.assistantSession(id);
    if (!row || row.user_id !== signedIn.user.id || row.grant_id !== signedIn.grantId || !isInitializeRequest(row.init)) return null;
    await roomFor(signedIn.user.id);
    const server = newServer(signedIn.user, signedIn, row.family, row.run_id, row.families, await linkedLine(signedIn.user));
    const live: { session: Session | null } = { session: null };
    const transport = sessionTransport(() => row.id, live);
    const now = Date.now();
    live.session = { transport, server, userId: signedIn.user.id, grantId: signedIn.grantId, row, lastSeen: now, touched: now };
    await server.connect(transport);
    const headers = { host: allowedHost, "content-type": "application/json", accept: "application/json, text/event-stream" };
    const init = await transport.handleRequest(new Request(`${origin}/mcp`, { method: "POST", headers, body: JSON.stringify(row.init) }), { parsedBody: row.init });
    await init.text();
    const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };
    const done = await transport.handleRequest(new Request(`${origin}/mcp`, { method: "POST", headers: { ...headers, "mcp-session-id": row.id }, body: JSON.stringify(initialized) }), { parsedBody: initialized });
    await done.text();
    if (!sessions.has(row.id)) {
      console.error("[mutinybim-web] an assistant session couldn't be restored", { id, status: init.status });
      await closeSession(row.id);
      return null;
    }
    console.log("[mutinybim-web] an assistant session came back", { userId: signedIn.user.id, family: row.family || "core", families: row.families });
    return live.session;
  }

  async function handleMcp(req: IncomingMessage, res: ServerResponse, family: string): Promise<void> {
    const method = req.method ?? "GET";
    if (method === "OPTIONS") {
      res.writeHead(204, CORS);
      return void res.end();
    }
    if (closing) return rpcError(res, 503, -32000, "This server is restarting. Try again in a moment; your session carries on.", { "retry-after": "5" });
    const signedIn = verifyAccessToken(req.headers.authorization, auth);
    if (!signedIn) {
      const hadToken = typeof req.headers.authorization === "string" && req.headers.authorization.length > 0;
      return rpcError(res, 401, -32001, "Sign in first: this MutinyBIM tool server needs you to sign in through your assistant.", { "www-authenticate": bearerChallenge(origin, family, hadToken ? "invalid_token" : undefined) });
    }
    for (const [name, value] of Object.entries(CORS)) res.setHeader(name, value);
    if (method !== "POST" && method !== "GET" && method !== "DELETE") return rpcError(res, 405, -32000, "Use POST, GET or DELETE.");
    const sessionId = typeof req.headers["mcp-session-id"] === "string" ? req.headers["mcp-session-id"] : undefined;
    let raw: string | undefined;
    let body: unknown;
    if (method === "POST") {
      const read = await readRaw(req, BODY_LIMIT);
      if (read === null) return rpcError(res, 413, -32000, "That request is larger than 4 MB.");
      raw = read;
      try {
        body = raw.length > 0 ? JSON.parse(raw) : undefined;
      } catch (err) {
        console.error("[mutinybim-web] an assistant sent JSON that didn't parse", { err });
        return rpcError(res, 400, -32700, "That request isn't JSON.");
      }
    }
    const abort = new AbortController();
    let known = sessionId ? sessions.get(sessionId) : undefined;
    // Another person's session id is the same as an unknown one.
    if (known && known.userId !== signedIn.user.id) known = undefined;
    if (sessionId && !known) known = (await restore(sessionId, signedIn)) ?? undefined;
    if (sessionId && !known) return rpcError(res, 404, -32001, "That session ended or isn't yours. Start a new one.");
    if (known) {
      const nowMs = Date.now();
      known.lastSeen = nowMs;
      const turnedOn = familiesTurnedOn(body).filter((f) => known?.row && !known.row.families.includes(f));
      if (known.row && turnedOn.length > 0) {
        known.row = { ...known.row, families: [...known.row.families, ...turnedOn], last_seen_at: nowMs };
        db.saveAssistantSession(known.row);
        known.touched = nowMs;
      } else if (known.row && nowMs - known.touched > SESSION_TOUCH_MS) {
        db.touchAssistantSession(known.row.id, nowMs);
        known.touched = nowMs;
      }
      return sendWeb(res, await known.transport.handleRequest(webRequest(req, raw, abort.signal), { parsedBody: body }), abort);
    }
    if (method !== "POST") return rpcError(res, 400, -32000, "No session: start with an initialize request.");
    if (!isInitializeRequest(body)) return rpcError(res, 400, -32000, "No session: start with an initialize request (or the session ended; reconnect).");
    await roomFor(signedIn.user.id);
    const runId = `web-${randomUUID().slice(0, 12)}`;
    const server = newServer(signedIn.user, signedIn, family, runId, [], await linkedLine(signedIn.user));
    const live: { session: Session | null } = { session: null };
    const newId = randomUUID();
    const transport = sessionTransport(() => newId, live);
    const nowMs = Date.now();
    const row: AssistantSessionRow = { id: newId, user_id: signedIn.user.id, grant_id: signedIn.grantId, family, families: [], run_id: runId, init: body, last_seen_at: nowMs };
    live.session = { transport, server, userId: signedIn.user.id, grantId: signedIn.grantId, row, lastSeen: nowMs, touched: nowMs };
    await server.connect(transport);
    const response = await transport.handleRequest(webRequest(req, raw, abort.signal), { parsedBody: body });
    if (sessions.has(newId)) {
      db.saveAssistantSession(row);
      db.trimAssistantSessions(signedIn.user.id, SESSIONS_KEPT_PER_PERSON);
      console.log("[mutinybim-web] an assistant session started", { userId: signedIn.user.id, family: family || "core" });
    }
    return sendWeb(res, response, abort);
  }

  function allowRegistration(req: IncomingMessage): boolean {
    const key = req.socket.remoteAddress ?? "?";
    const nowMs = Date.now();
    const entry = registrations.get(key);
    if (!entry || entry.until < nowMs) {
      registrations.set(key, { count: 1, until: nowMs + 60 * 60_000 });
      return true;
    }
    entry.count += 1;
    return entry.count <= 30;
  }

  function endGrant(grantId: string): void {
    for (const [id, s] of sessions) if (s.grantId === grantId) void closeSession(id);
  }

  return {
    endGrant,
    async handle(req, res, url) {
      const { pathname } = url;
      const method = req.method ?? "GET";
      const wellKnown = /^\/\.well-known\/oauth-protected-resource(\/.*)?$/.exec(pathname);
      if (wellKnown) {
        const family = wellKnown[1] ? toolPathOf(wellKnown[1], auth.families) : "";
        if (family === null) return false;
        if (method === "OPTIONS") return (res.writeHead(204, CORS), res.end(), true);
        sendJson(res, 200, protectedResourceMetadata(origin, family), { "cache-control": "public, max-age=300" });
        return true;
      }
      if (pathname === "/.well-known/oauth-authorization-server") {
        if (method === "OPTIONS") return (res.writeHead(204, CORS), res.end(), true);
        sendJson(res, 200, authorizationServerMetadata(origin), { "cache-control": "public, max-age=300" });
        return true;
      }
      if (pathname === "/oauth/register" || pathname === "/oauth/token" || pathname === "/oauth/revoke") {
        if (method === "OPTIONS") return (res.writeHead(204, CORS), res.end(), true);
        if (method !== "POST") return (sendJson(res, 405, { error: "invalid_request", error_description: "Use POST." }), true);
        const raw = await readRaw(req, 64 * 1024);
        if (raw === null) return (sendJson(res, 413, { error: "invalid_request", error_description: "That request is too large." }), true);
        if (pathname === "/oauth/register") {
          if (!allowRegistration(req)) return (sendJson(res, 429, { error: "temporarily_unavailable", error_description: "Too many registrations from here. Try again in an hour." }), true);
          let body: unknown = null;
          try {
            body = JSON.parse(raw);
          } catch (err) {
            console.error("[mutinybim-web] an assistant registration wasn't JSON", { err });
          }
          const answer = registerClient(db, body);
          sendJson(res, answer.status, answer.body);
          return true;
        }
        const form = new URLSearchParams(raw);
        if (pathname === "/oauth/token") {
          const answer = exchangeToken(form, auth, req.headers.authorization);
          sendJson(res, answer.status, answer.body, answer.status === 401 ? { "www-authenticate": 'Basic realm="mutinybim"' } : {});
          return true;
        }
        const token = form.get("token");
        const ended = token ? db.revokeAssistantToken(digest(token)) : null;
        if (ended) endGrant(ended);
        sendJson(res, 200, {});
        return true;
      }
      const family = toolPathOf(pathname, auth.families);
      if (family === null) return false;
      await handleMcp(req, res, family);
      return true;
    },
    async close() {
      closing = true;
      clearInterval(sweep);
      for (const id of [...sessions.keys()]) await closeSession(id);
    },
  };
}

