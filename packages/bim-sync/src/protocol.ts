import { z } from "zod";
import { actorSchema, commandRequestSchema, interestSchema, type BimElement, type Connection, type Interest } from "@permitzip/bim-kernel";
import { protocolSchema, type Protocol } from "./protocol-version";
import { scheduleClientMessageSchemas, type ScheduleServerMessage } from "./schedules/protocol";
import { branchClientMessageSchemas, type BranchServerMessage } from "./branches/protocol";
import { mergeClientMessageSchemas, type MergeServerMessage } from "./merge/messages";
import { quantityDeltaRequestSchema, type QuantityDeltaServerMessage } from "./delta/messages";
import { lineageClientMessageSchemas, type LineageServerMessage } from "./lineages/protocol";

/** Ephemeral activity: never persisted, never a model edit. */
export const presenceSchema = z.object({
  actor: actorSchema,
  activity: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("idle") }),
    z.object({
      kind: z.literal("dragging_tap"),
      tapId: z.string(),
      s: z.number(),
      limited: z.boolean(),
      binding: z.string().nullable(),
    }),
    z.object({ kind: z.literal("working"), note: z.string().max(200) }),
    /** A soft lock: others see who is editing the note and can't start editing it (see note-locks). */
    z.object({ kind: z.literal("editing_note"), itemId: z.string().min(1).max(200), ownerId: z.string().min(1).max(200), ttlMs: z.number().int().min(1000).max(120000) }),
  ]),
});
export type Presence = z.infer<typeof presenceSchema>;

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    actor: actorSchema,
    lastRevision: z.number().int().min(-1),
    /** Login token (e.g. a Supabase access token) for backends that authorize connections. */
    token: z.string().min(1).max(8192).optional(),
    modelId: z.string().min(1).max(200).optional(),
    /** The areas this person has loaded. Absent: the whole model. */
    interest: interestSchema.optional(),
    /** What this client reads (protocol-version.ts). Absent: version 1, no features. */
    protocol: protocolSchema.optional(),
  }),
  /** Change the loaded areas; the server sends only partitions not already covered. */
  z.object({ type: z.literal("interest"), interest: interestSchema }),
  z.object({ type: z.literal("command"), request: commandRequestSchema }),
  z.object({
    type: z.literal("heartbeat"),
    lastRevision: z.number().int().min(0),
    /** Client clock (epoch ms) when sent; echoed so the client can estimate its offset from the server clock. */
    sentAt: z.number().finite().optional(),
  }),
  z.object({ type: z.literal("sync"), fromRevision: z.number().int().min(0) }),
  z.object({ type: z.literal("presence"), presence: presenceSchema }),
  /** What this session measured (regional sessions); the server logs it and shows totals on /metrics. */
  z.object({ type: z.literal("report"), report: z.lazy(() => sessionReportSchema) }),
  /** Schedule subscriptions and cell holds (schedules/protocol.ts). */
  ...scheduleClientMessageSchemas,
  /** Branches, saved versions and history reads (branches/protocol.ts). */
  ...branchClientMessageSchemas,
  /** Merging a branch into Main (merge/messages.ts). */
  ...mergeClientMessageSchemas,
  /** Quantity change between two revisions, or Main and this branch (delta/messages.ts). */
  quantityDeltaRequestSchema,
  /** Round 11 W11: copies with a purpose, compare, review, accept back (lineages/protocol.ts). */
  ...lineageClientMessageSchemas,
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

const percentilesSchema = z.object({
  count: z.number().int().min(0),
  p50: z.number().finite().nullable(),
  p95: z.number().finite().nullable(),
});
export type Percentiles = z.infer<typeof percentilesSchema>;

/**
 * One session's measurements. Times are milliseconds. `localPreview` is from
 * submitting an edit to the next painted frame; `commit` from sending an edit to
 * its saved answer; `remoteVisibility` from the server committing someone
 * else's edit to this browser receiving it (server clock, offset-corrected).
 */
export const sessionReportSchema = z.object({
  label: z.string().max(80).nullable(),
  clientSessionId: z.string().max(128),
  localPreview: percentilesSchema,
  commit: percentilesSchema,
  remoteVisibility: percentilesSchema,
  /** hello → welcome, per join (first join and every reconnect). */
  join: percentilesSchema,
  /** Round trip of the best heartbeat used for the clock offset, and the offset itself. */
  clockRttMs: z.number().finite().nullable(),
  clockOffsetMs: z.number().finite().nullable(),
  reconnects: z.number().int().min(0),
  environment: z.object({
    userAgent: z.string().max(400).nullable(),
    timeZone: z.string().max(80).nullable(),
    /** navigator.connection, where the browser offers it. */
    effectiveType: z.string().max(20).nullable(),
    downlinkMbps: z.number().finite().nullable(),
    networkRttMs: z.number().finite().nullable(),
    /** "warm" when the page itself came from the browser cache, "cold" when downloaded, null when unknown. */
    pageCache: z.enum(["cold", "warm"]).nullable(),
  }),
});
export type SessionReport = z.infer<typeof sessionReportSchema>;

/**
 * Server messages are produced by our own trusted code, so they are typed
 * rather than validated; clients still check revision continuity.
 */
export type ServerMessage =
  /** The model sliced to the connection's interest (whole model when it has none). */
  /**
   * `durableRevision`: everything up to it is in the database. With group
   * commit the model may run a few revisions ahead of it (edits shown to
   * people before their batch is written); see group-commit.ts.
   */
  /** `protocol`: what this server stores and forwards (absent from servers before round 5: version 1, no features). */
  /** `branch`: present when this session is on a branch (servers advertising `branches:sessions`). */
  | { readonly type: "welcome"; readonly model: import("@permitzip/bim-kernel").ModelState; readonly interest?: Interest; readonly durableRevision?: number; readonly protocol?: Protocol; readonly branch?: import("@permitzip/bim-kernel").BranchRef }
  /** `durable`: the server's durable revision when this was sent (may be below this changeset's). */
  | { readonly type: "changeset"; readonly changeset: import("@permitzip/bim-kernel").Changeset; readonly durable?: number }
  | { readonly type: "outcome"; readonly idempotencyKey: string; readonly outcome: import("./store").CommitOutcome }
  /** `serverTime` (epoch ms) and the echoed `sentAt` let the client estimate its clock offset. */
  | { readonly type: "head"; readonly revision: number; readonly serverTime?: number; readonly sentAt?: number; readonly durable?: number }
  /** Revision `revision` committed with nothing inside your areas: keeps every client's revision count contiguous. */
  | { readonly type: "advance"; readonly revision: number; readonly idempotencyKey: string; readonly committedAt?: string; readonly durable?: number }
  /**
   * Newly loaded partitions as of `revision`: elements and the connections
   * between them. Merged once the client's confirmed revision reaches it.
   */
  | {
      readonly type: "area";
      readonly revision: number;
      readonly interest: Interest;
      readonly elements: readonly BimElement[];
      readonly connections: readonly Connection[];
    }
  | { readonly type: "presence"; readonly presence: Presence; readonly connectionId: string }
  | { readonly type: "left"; readonly connectionId: string }
  | { readonly type: "denied"; readonly reason: string }
  /**
   * Your edit is NOT saved yet, and nothing was decided: the server could not
   * reach durable storage, or no longer owns the model. The client keeps the
   * edit and sends it again with the same key, so it is applied exactly once.
   */
  | { readonly type: "unsaved"; readonly idempotencyKey: string; readonly reason: UnsavedReason; readonly message: string }
  /** The server cannot read durable storage right now; what you see is the last saved state. */
  | { readonly type: "unavailable"; readonly message: string }
  /**
   * A message the server could not act on. `code` and `messageType` (round 5
   * on) say which: `unknown_message` is a type this server does not know (a
   * newer client), so the sender learns it was not acted on.
   */
  | { readonly type: "error"; readonly message: string; readonly code?: MessageErrorCode; readonly messageType?: string }
  | ScheduleServerMessage
  | BranchServerMessage
  /** Round 9: this session's branch was closed or merged (servers advertising `branches:state_broadcast`, to peers that read it). */
  | import("./branches/protocol").BranchStateMessage
  | MergeServerMessage
  | QuantityDeltaServerMessage
  /** Round 11 W11: answers to the lineage messages. */
  | LineageServerMessage;

export type UnsavedReason = "storage_unavailable" | "not_owner";

export type MessageErrorCode = "invalid_json" | "unknown_message" | "invalid_message";

export type ClientMessageRead =
  | { readonly ok: true; readonly message: ClientMessage }
  | { readonly ok: false; readonly code: MessageErrorCode; readonly messageType: string | null };

const KNOWN_CLIENT_TYPES: ReadonlySet<string> = new Set(
  clientMessageSchema.options.map((option) => option.shape.type.value),
);

/** Read one client message, saying why when it can't be acted on. */
export function readClientMessage(raw: string): ClientMessageRead {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    console.error("[bim-sync] client sent invalid JSON", err);
    return { ok: false, code: "invalid_json", messageType: null };
  }
  const messageType = typeof json === "object" && json !== null && "type" in json && typeof json.type === "string" ? json.type.slice(0, 100) : null;
  if (messageType === null || !KNOWN_CLIENT_TYPES.has(messageType)) {
    console.error("[bim-sync] client sent a message type this server does not know", { messageType });
    return { ok: false, code: "unknown_message", messageType };
  }
  const parsed = clientMessageSchema.safeParse(json);
  if (!parsed.success) {
    console.error("[bim-sync] client message failed validation", { messageType, issues: parsed.error.issues });
    return { ok: false, code: "invalid_message", messageType };
  }
  return { ok: true, message: parsed.data };
}

export function parseClientMessage(raw: string): ClientMessage | null {
  const read = readClientMessage(raw);
  return read.ok ? read.message : null;
}

/** The answer to a message that could not be acted on (never a silent drop). */
export function messageErrorReply(read: Extract<ClientMessageRead, { ok: false }>): Extract<ServerMessage, { type: "error" }> {
  const message =
    read.code === "unknown_message"
      ? `This model server does not understand "${read.messageType ?? "(no type)"}" messages yet, so nothing was done. Reload the page once the server is updated.`
      : read.code === "invalid_json"
        ? "Message not understood: it was not valid JSON, so nothing was done."
        : read.messageType === "command"
          ? "Message not understood: this model server can't read that edit (it may be older than this page), so it was not saved."
          : `Message not understood: the "${read.messageType ?? ""}" message was malformed, so nothing was done.`;
  return { type: "error", message, code: read.code, ...(read.messageType !== null ? { messageType: read.messageType } : {}) };
}
