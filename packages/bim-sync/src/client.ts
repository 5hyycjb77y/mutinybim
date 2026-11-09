import {
  RevisionGapError,
  applyChangeset,
  asRevision,
  commandIssueMessage,
  commandSchema,
  draftElements,
  executeCommand,
  parseBranchModelId,
  readModelSettings,
  sliceChangeset,
  sliceModel,
  type Actor,
  type BranchRef,
  type Changeset,
  type Command,
  type CommandError,
  type CommandRequest,
  type Connection,
  type Interest,
  type ModelState,
  pointReadsPending,
} from "@permitzip/bim-kernel";
import { PointReadsBuilder } from "./point-reads-idle";
import type { ClientMessage, Presence, ServerMessage } from "./protocol";
import { clientProtocol, peerHas, type Protocol } from "./protocol-version";
import { decideWithUpgrades } from "./upgrade-policy";
import { SCHEDULE_SERVER_TYPES, type ScheduleClientMessage, type ScheduleServerMessage } from "./schedules/protocol";
import { BRANCH_SERVER_TYPES, BRANCHES_SESSIONS_FEATURE, type BranchClientMessage, type BranchServerMessage } from "./branches/protocol";
import { HISTORY_COVERAGE_READ_FEATURE } from "./branches/coverage";
import { MERGE_FEATURE, type MergeClientMessage, type MergeServerMessage } from "./merge/messages";
import { QUANTITY_DELTA_FEATURE, type QuantityDeltaRequest, type QuantityDeltaServerMessage } from "./delta/messages";
import { LINEAGE_SERVER_TYPES, lineageRequestRefusal, type LineageClientMessage, type LineageServerMessage } from "./lineages/protocol";
import { NO_SUCH_MODEL } from "./authorization";
import { SessionMeter, sessionLabelFromPage } from "./session-meter";
import type { CommitOutcome } from "./store";

export interface SyncClientOptions {
  readonly token?: string;
  readonly modelId?: string;
  readonly interest?: Interest;
  /**
   * This editing session (one tab, one agent run). Defaults to a fresh random id
   * per client, so the same person in two tabs gets stale-edit protection.
   */
  readonly clientSessionId?: string;
  /** Measures preview / commit / remote visibility and reports them to the server. */
  readonly meter?: SessionMeter | null;
  readonly reportEveryMs?: number;
}

const REPORT_EVERY_MS = 30_000;
const MM_PER_FT = 304.8;

/**
 * Why the server would throw this command away unread (its message check uses
 * the same rules), in the operator's words; null when it would read it.
 * Prediction alone doesn't check value ranges, so without this the edit shows
 * at once and then stays "Saving…" with nothing coming back.
 */
function unsendable(command: Command): string | null {
  const parsed = commandSchema.safeParse(command);
  if (parsed.success) return null;
  // A key the command doesn't take is a caller bug; say which, so it isn't silently lost.
  if (parsed.error.issues.some((i) => i.code === "unrecognized_keys")) return `That edit can't be saved: ${commandIssueMessage(parsed.error, command)}`;
  const issue = parsed.error.issues[0];
  const field = issue ? [...issue.path].reverse().find((p): p is string => typeof p === "string") : undefined;
  const bound = issue && (issue.code === "too_big" ? issue.maximum : issue.code === "too_small" ? issue.minimum : undefined);
  if (field?.endsWith("Mm") && typeof bound === "number") {
    const what = field === "elevationMm" || field === "offsetMm" ? "height" : "distance";
    return `That ${what} is past what the model allows (${Math.round(Math.abs(bound) / MM_PER_FT)} ft); nothing was saved. Pick a point closer in.`;
  }
  return `That edit can't be saved: ${issue?.message ?? "a value is out of range"}${field ? ` (${field})` : ""}. Nothing was saved.`;
}
/** Recent committed changesets kept for undo (the person's own changes are in here). */
const HISTORY_KEEP = 300;

let sessionIdCounter = 0;

function randomSessionId(): string {
  const cryptoObj: unknown = Reflect.get(globalThis, "crypto");
  const uuid = typeof cryptoObj === "object" && cryptoObj !== null ? Reflect.get(cryptoObj, "randomUUID") : undefined;
  if (typeof uuid === "function") {
    const value: unknown = Reflect.apply(uuid, cryptoObj, []);
    if (typeof value === "string") return `s-${value}`;
  }
  // Secure fallback for runtimes without randomUUID — session ids must not
  // be guessable, so derive from getRandomValues (never Math.random()).
  const getRandomValues =
    typeof cryptoObj === "object" && cryptoObj !== null ? Reflect.get(cryptoObj, "getRandomValues") : undefined;
  if (typeof getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    Reflect.apply(getRandomValues, cryptoObj, [bytes]);
    return `s-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
  }
  // Last resort, no Web Crypto at all: timestamp + monotonic counter.
  sessionIdCounter += 1;
  return `s-${Date.now().toString(36)}-${sessionIdCounter.toString(36)}`;
}

function nextFrame(callback: () => void): void {
  const raf: unknown = Reflect.get(globalThis, "requestAnimationFrame");
  if (typeof raf === "function") Reflect.apply(raf, globalThis, [callback]);
  else setTimeout(callback, 0);
}

const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

export interface Transport {
  send(data: string): void;
  close(): void;
}

/** "degraded": connected, but the server cannot reach durable storage; edits wait and retry. */
export type ConnectionStatus = "connecting" | "live" | "catching_up" | "offline" | "denied" | "degraded";

/**
 * Where the person's edits stand. "Saved" means only one thing: the server
 * answered committed, which it does after the edit is durable in its database.
 */
export interface SaveState {
  /** Edits sent and not yet answered (shown as "saving…"). */
  readonly pending: number;
  /** Edits the server said were NOT saved yet; they are being sent again. */
  readonly retrying: number;
  /** Plain-language reason while anything is waiting, otherwise null. */
  readonly message: string | null;
}

export interface SyncClientEvents {
  /** Fired whenever the view changes: confirmed head + local predictions. */
  onView?(view: ModelState, info: { confirmedRevision: number; pending: number }): void;
  onOutcome?(request: CommandRequest, outcome: CommitOutcome): void;
  onPresence?(connectionId: string, presence: Presence | null): void;
  onStatus?(status: ConnectionStatus): void;
  onRemoteChange?(revision: number, actor: Actor): void;
  onDenied?(reason: string): void;
  /**
   * The server's model went BACKWARDS (reset, restore): local state and unsaved
   * edits were discarded and a fresh copy loaded. Tell the person.
   */
  onModelReset?(info: { readonly fromRevision: number; readonly toRevision: number; readonly droppedEdits: number }): void;
  /** Saving progress changed (pending / retrying / reason). */
  onSaveState?(state: SaveState): void;
  /** This session's branch was closed or merged (here or on another machine); the session stays open read-only. */
  onBranchState?(branch: BranchRef): void;
}

/** Backoff for an edit the server could not save yet: 1 s, 2 s, 4 s … capped at 10 s. */
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 10_000;

/**
 * A backend-neutral client for live model sync. Every candidate exposes the
 * same surface to the UI and scripted agents.
 */
export interface SyncAdapter {
  readonly backend: string;
  view(): ModelState | null;
  confirmedRevision(): number;
  submit(command: Command, opts?: SubmitOptions): { ok: true; request: CommandRequest } | { ok: false; error: CommandError };
  publishPresence(activity: Presence["activity"]): void;
  dispose(): void;
}

export interface SubmitOptions {
  /**
   * Commit from an explicit revision instead of the latest confirmed one. Agents
   * use this for work computed at the revision they read (a possibly stale base).
   */
  readonly baseRevision?: number;
  /** Reuse an idempotency key (retry drills). */
  readonly idempotencyKey?: string;
}

const MERGE_SERVER_TYPES: readonly MergeServerMessage["type"][] = ["merge_preview_result", "merge_apply_result", "merge_refused"];
const QUANTITY_DELTA_SERVER_TYPES: readonly QuantityDeltaServerMessage["type"][] = ["quantity_delta_result", "quantity_delta_refused"];

const SERVER_TYPES = new Set<string>(["welcome", "changeset", "outcome", "head", "advance", "area", "presence", "left", "error", "denied", "unsaved", "unavailable", "branch_state", ...SCHEDULE_SERVER_TYPES, ...BRANCH_SERVER_TYPES, ...MERGE_SERVER_TYPES, ...QUANTITY_DELTA_SERVER_TYPES, ...LINEAGE_SERVER_TYPES]);

/** Every answer that carries the requestId of the request it answers. */
type RequestAnswer = BranchServerMessage | MergeServerMessage | QuantityDeltaServerMessage | LineageServerMessage;
type RequestMessage = BranchClientMessage | MergeClientMessage | QuantityDeltaRequest | LineageClientMessage;
type WithoutRequestId<M> = M extends { readonly requestId: string } ? Omit<M, "requestId"> : never;

function isBranchAnswer(msg: RequestAnswer): msg is BranchServerMessage {
  return (BRANCH_SERVER_TYPES as readonly string[]).includes(msg.type);
}

function isMergeAnswer(msg: RequestAnswer): msg is MergeServerMessage {
  return (MERGE_SERVER_TYPES as readonly string[]).includes(msg.type);
}

function isQuantityDeltaAnswer(msg: RequestAnswer): msg is QuantityDeltaServerMessage {
  return (QUANTITY_DELTA_SERVER_TYPES as readonly string[]).includes(msg.type);
}

function isLineageAnswer(msg: RequestAnswer): msg is LineageServerMessage {
  return (LINEAGE_SERVER_TYPES as readonly string[]).includes(msg.type);
}

/** A copy request (`lineage_list`, `lineage_compare`, `lineage_delta`, `lineage_review`, `lineage_accept_back`, …) sent without its requestId. */
export type LineageRequest = WithoutRequestId<LineageClientMessage>;

/** A merge request (`merge_preview`, `merge_apply`) sent without its requestId. */
export type MergeRequest = WithoutRequestId<MergeClientMessage>;
/** A quantity delta request sent without its requestId. */
export type QuantityDeltaAsk = WithoutRequestId<QuantityDeltaRequest>;

/** A branch or history request sent without its requestId; the client assigns one. */
export type BranchRequest = WithoutRequestId<BranchClientMessage>;

/** The server did not answer a branch or history request (offline, closed, or too slow). */
export class BranchRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BranchRequestError";
  }
}

const BRANCH_REQUEST_TIMEOUT_MS = 30_000;
let requestCounter = 0;

/** Schedule subscriptions riding this client's socket (schedules/connection.ts). */
export interface ScheduleChannel {
  message(msg: ScheduleServerMessage): void;
  /** Welcomed (first join or reconnect): the server holds no subscriptions for this socket yet. */
  welcomed(): void;
  /** Another connection left (its cell holds go with it). */
  left(connectionId: string): void;
  outcome(request: CommandRequest, outcome: CommitOutcome): void;
}

type AreaMessage = Extract<ServerMessage, { type: "area" }>;

/** A model server not yet redeployed still sends double-encoded settings for older models; read them here too. */
function withReadableSettings(model: ModelState): ModelState {
  try {
    return { ...model, settings: readModelSettings(model.settings) };
  } catch (err) {
    console.error("[bim-sync] the model's settings can't be read; edits that measure lengths will be refused", { modelId: model.modelId, err });
    return model;
  }
}

function isServerMessage(value: unknown): value is ServerMessage {
  if (typeof value !== "object" || value === null || !("type" in value)) return false;
  const type = value.type;
  return typeof type === "string" && SERVER_TYPES.has(type);
}

function samePending(a: readonly CommandRequest[], b: readonly CommandRequest[]): boolean {
  return a.length === b.length && a.every((req, i) => req === b[i]);
}

let keyCounter = 0;
let keyEntropyCounter = 0;
function newKey(actorId: string): string {
  keyCounter += 1;
  // Operation keys must not be guessable: prefer Web Crypto entropy over
  // Math.random(). Uniqueness is already guaranteed by the counter.
  const cryptoObj: unknown = Reflect.get(globalThis, "crypto");
  const getRandomValues =
    typeof cryptoObj === "object" && cryptoObj !== null ? Reflect.get(cryptoObj, "getRandomValues") : undefined;
  let rand: string;
  if (typeof getRandomValues === "function") {
    const bytes = new Uint8Array(6);
    Reflect.apply(getRandomValues, cryptoObj, [bytes]);
    rand = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  } else {
    keyEntropyCounter += 1;
    rand = keyEntropyCounter.toString(36);
  }
  return `${actorId}-${Date.now().toString(36)}-${keyCounter}-${rand}`;
}

export class SyncClient implements SyncAdapter {
  readonly backend: string = "dev-sequencer";
  private confirmed: ModelState | null = null;
  private pending: CommandRequest[] = [];
  /** Requests awaiting an outcome, independent of whether their changeset already arrived. */
  private readonly submitted = new Map<string, CommandRequest>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  /** Confirmed revision at each unanswered head check: an answer may be older than newer live updates. */
  private headCheckBases: number[] = [];
  private status: ConnectionStatus = "connecting";
  /** Set while reloading after the server's model went backwards; reported on the next welcome. */
  private resetFrom: { readonly revision: number; readonly droppedEdits: number } | null = null;
  /** Loaded areas; undefined means the whole model. */
  private interest: Interest | undefined;
  /** A newly loaded area that is ahead of what we have confirmed; merged when we catch up to it. */
  private pendingArea: AreaMessage | null = null;
  /** Predictions for one confirmed head + pending list; re-running them per call is O(edits × model). */
  private viewCache: { readonly confirmed: ModelState; readonly pending: readonly CommandRequest[]; readonly view: ModelState } | null = null;
  /** After an edit, the point index its first check skipped is built from an idle callback (on the confirmed head, else the view). */
  private readonly pointReads = new PointReadsBuilder(() => {
    const confirmed = this.confirmed;
    return confirmed && pointReadsPending(confirmed) ? confirmed : this.viewCache?.view ?? null;
  });
  /** Edits the server could not save yet, with their next resend. */
  private readonly retrying = new Map<string, { attempts: number; timer: ReturnType<typeof setTimeout> | null }>();
  private storageMessage: string | null = null;
  private lastSaveState: SaveState = { pending: 0, retrying: 0, message: null };
  private token: string | undefined;
  readonly clientSessionId: string;
  private readonly meter: SessionMeter | null;
  /** When each unanswered edit was first sent (monotonic ms), for commit latency. */
  private readonly sentAt = new Map<string, number>();
  private helloAt: number | null = null;
  private welcomed = false;
  private reportTimer: ReturnType<typeof setInterval> | null = null;
  /** Committed changesets as applied here, newest last (undo planning and prediction). */
  private history: Changeset[] = [];
  /**
   * The highest revision the server has said is durable. A server using group
   * commit shows edits before they are written; if it dies first, the next
   * welcome is below what we held but not below this, and that is not a reset.
   */
  private durableRevision = -1;
  /** The server's protocol from its last welcome. */
  private serverProtocol: Protocol | undefined = undefined;
  private readonly scheduleChannels = new Set<ScheduleChannel>();
  /** Branch and history requests waiting for their answer, by requestId. */
  private readonly requests = new Map<string, { readonly resolve: (msg: RequestAnswer) => void; readonly reject: (err: Error) => void; readonly timer: ReturnType<typeof setTimeout> }>();
  /** The branch this session is on, from the last welcome (null: Main). */
  private branchRef: BranchRef | null = null;

  constructor(
    private readonly transport: Transport,
    private readonly actor: Actor,
    private readonly events: SyncClientEvents = {},
    private readonly heartbeatMs = 10_000,
    private readonly auth: SyncClientOptions = {},
  ) {
    this.interest = auth.interest;
    this.token = auth.token;
    this.clientSessionId = auth.clientSessionId ?? randomSessionId();
    // A guided session opens the page with ?bimSession=<label>: measure even where the host passed no meter.
    const label = auth.meter === undefined ? sessionLabelFromPage() : null;
    this.meter = auth.meter ?? (label ? new SessionMeter(label) : null);
  }

  /** Send what this session measured so far (no-op without a meter or samples). */
  sendReport(): void {
    if (!this.meter || !this.meter.hasSamples()) return;
    this.send({ type: "report", report: this.meter.report(this.clientSessionId) });
  }

  /** Route schedule messages to `channel` (and tell it when the socket is welcomed). */
  attachSchedules(channel: ScheduleChannel): () => void {
    this.scheduleChannels.add(channel);
    return () => this.scheduleChannels.delete(channel);
  }

  /** True once welcomed on the current socket: schedule messages may be sent. */
  scheduleReady(): boolean {
    return this.confirmed !== null && this.status !== "offline" && this.status !== "denied" && this.status !== "connecting";
  }

  sendSchedule(msg: ScheduleClientMessage): void {
    this.send(msg);
  }

  /** Replace the login token sent on the next hello (access tokens expire; refresh before reconnecting). */
  setToken(token: string | undefined): void {
    this.token = token;
  }

  /** The areas this client holds (undefined: everything). */
  currentInterest(): Interest | undefined {
    return this.interest;
  }

  /**
   * Load a different set of areas. Areas dropped are forgotten locally at
   * once; the server sends only partitions not already held.
   */
  setInterest(interest: Interest): void {
    this.interest = interest;
    this.pendingArea = null;
    if (this.confirmed) {
      this.confirmed = sliceModel(this.confirmed, interest);
      this.emitView();
    }
    this.send({ type: "interest", interest });
  }

  /** Call when the transport opens (first connect or reconnect). */
  opened(): void {
    this.headCheckBases = [];
    // Status first: some transports answer hello synchronously (from a local cache).
    this.setStatus(this.confirmed ? "catching_up" : "connecting");
    this.helloAt = now();
    this.send({
      type: "hello",
      actor: this.actor,
      lastRevision: this.confirmed?.revision ?? -1,
      token: this.token,
      modelId: this.auth.modelId,
      interest: this.interest,
      protocol: clientProtocol(),
    });
    if (this.heartbeat) clearInterval(this.heartbeat);
    // R6: periodic head check so a lost final broadcast is still recovered.
    this.heartbeat = setInterval(() => this.checkHead(), this.heartbeatMs);
    if (this.meter && !this.reportTimer) this.reportTimer = setInterval(() => this.sendReport(), this.auth.reportEveryMs ?? REPORT_EVERY_MS);
  }

  closed(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.setStatus("offline");
    this.failRequests("Lost the connection to the model server before it answered. Try again once it reconnects.");
  }

  /** The branch this session is on (null: Main, or not welcomed yet). */
  branch(): BranchRef | null {
    return this.branchRef;
  }

  /** The server lists, creates and closes branches (its welcome advertised `branches:sessions`). */
  branchesAvailable(): boolean {
    return peerHas(this.serverProtocol, BRANCHES_SESSIONS_FEATURE);
  }

  /** The server answers `coverage_check` from its own history (its welcome advertised `history:coverage_read`). */
  coverageAvailable(): boolean {
    return peerHas(this.serverProtocol, HISTORY_COVERAGE_READ_FEATURE);
  }

  /**
   * Send a branch or history request and wait for its one answer. Rejects with
   * BranchRequestError when offline, on disconnect, or after 30 seconds; a
   * refusal arrives as a `request_refused` answer, not a rejection.
   */
  request(msg: BranchRequest, timeoutMs = BRANCH_REQUEST_TIMEOUT_MS): Promise<BranchServerMessage> {
    return this.ask(msg, timeoutMs, isBranchAnswer);
  }

  /** The server previews and lands merges of this branch into Main (its welcome advertised `branches:merge`). */
  mergeAvailable(): boolean {
    return peerHas(this.serverProtocol, MERGE_FEATURE);
  }

  /** `merge_preview` / `merge_apply` on this branch session; one answer, like `request`. */
  mergeRequest(msg: MergeRequest, timeoutMs = BRANCH_REQUEST_TIMEOUT_MS): Promise<MergeServerMessage> {
    return this.ask(msg, timeoutMs, isMergeAnswer);
  }

  /** The server answers `quantity_delta` (its welcome advertised `history:quantity_delta`). */
  quantityDeltaAvailable(): boolean {
    return peerHas(this.serverProtocol, QUANTITY_DELTA_FEATURE);
  }

  /** One quantity delta read; one answer, like `request`. */
  quantityDeltaRequest(msg: QuantityDeltaAsk, timeoutMs = BRANCH_REQUEST_TIMEOUT_MS): Promise<QuantityDeltaServerMessage> {
    return this.ask(msg, timeoutMs, isQuantityDeltaAnswer);
  }

  /**
   * One copy request; one answer. A server that didn't advertise the request's feature is never
   * asked: the answer is a refusal in the "older server" words, so the screen says why.
   */
  lineageRequest(msg: LineageRequest, timeoutMs = BRANCH_REQUEST_TIMEOUT_MS): Promise<LineageServerMessage> {
    const refused = lineageRequestRefusal(this.serverProtocol, { ...msg, requestId: "local" } as LineageClientMessage);
    if (refused) return Promise.resolve(refused);
    return this.ask(msg, timeoutMs, isLineageAnswer);
  }

  private ask<A extends RequestAnswer>(msg: WithoutRequestId<RequestMessage>, timeoutMs: number, fits: (answer: RequestAnswer) => answer is A): Promise<A> {
    if (!this.scheduleReady()) return Promise.reject(new BranchRequestError("Not connected to the model server yet, so nothing was asked. Try again once it is live."));
    requestCounter += 1;
    const requestId = `${this.clientSessionId}-r${requestCounter}`;
    return new Promise<A>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(requestId);
        reject(new BranchRequestError("The model server didn't answer in time. Try again."));
      }, timeoutMs);
      const settle = (answer: RequestAnswer) => {
        if (fits(answer)) resolve(answer);
        else {
          console.error("[bim-sync] answer of the wrong kind for a request", { asked: msg.type, got: answer.type, requestId });
          reject(new BranchRequestError("The model server's answer didn't match the question. Try again."));
        }
      };
      this.requests.set(requestId, { resolve: settle, reject, timer });
      // The union member's own fields plus the id: one of the request client messages.
      this.send({ ...msg, requestId } as RequestMessage);
    });
  }

  private failRequests(message: string): void {
    for (const [id, pending] of this.requests) {
      clearTimeout(pending.timer);
      pending.reject(new BranchRequestError(message));
      this.requests.delete(id);
    }
  }

  checkHead(): void {
    if (!this.confirmed) return;
    this.headCheckBases.push(this.confirmed.revision);
    if (this.headCheckBases.length > 32) this.headCheckBases.shift();
    this.send({ type: "heartbeat", lastRevision: this.confirmed.revision, sentAt: Date.now() });
  }

  receive(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.error("[bim-sync] server sent invalid JSON", err);
      return;
    }
    if (!isServerMessage(parsed)) {
      console.error("[bim-sync] server sent an unknown message", parsed);
      return;
    }
    const msg = parsed;
    switch (msg.type) {
      case "welcome": {
        // Asked for a branch: never show another model's data under its name (an older server serves Main for any id).
        const asked = this.auth.modelId ? parseBranchModelId(this.auth.modelId) : null;
        if (asked && (msg.branch?.modelId !== this.auth.modelId || msg.model.modelId !== this.auth.modelId)) {
          console.error("[bim-sync] asked for a branch, the server answered with another model; not shown", { asked: this.auth.modelId, got: msg.model.modelId, branch: msg.branch?.modelId ?? null });
          if (this.heartbeat) clearInterval(this.heartbeat);
          this.heartbeat = null;
          this.setStatus("denied");
          this.events.onDenied?.(NO_SUCH_MODEL);
          return;
        }
        this.branchRef = msg.branch ?? null;
        const heldRevision = this.confirmed?.revision;
        const welcomeRevision = msg.model.revision;
        if (heldRevision !== undefined && welcomeRevision < heldRevision && welcomeRevision >= this.durableRevision) {
          // Edits we were shown never became durable (the server stopped first). The fresh copy
          // replaces them; our own unsaved edits are re-run on it, so send them from its revision.
          this.rebasePending(welcomeRevision);
        }
        this.durableRevision = msg.durableRevision ?? welcomeRevision;
        this.serverProtocol = msg.protocol;
        this.confirmed = sliceModel(withReadableSettings(msg.model), this.interest);
        // A fresh copy: earlier changesets stay true unless the model went backwards.
        this.history = this.history.filter((cs) => cs.revision <= msg.model.revision);
        this.pendingArea = null;
        this.storageMessage = null;
        this.setStatus("live");
        // resendPending below sends every waiting edit now; restart their backoff from scratch.
        this.clearRetryTimers();
        if (this.resetFrom) {
          const from = this.resetFrom;
          this.resetFrom = null;
          this.events.onModelReset?.({ fromRevision: from.revision, toRevision: msg.model.revision, droppedEdits: from.droppedEdits });
        }
        // Reconnect: pending commands are re-sent; idempotency keys return the first outcome.
        if (this.pending.length > 0) this.resendPending();
        // Edits already seen committed whose answer was lost with the old connection: ask again.
        for (const request of this.submitted.values()) {
          if (!this.pending.includes(request)) this.send({ type: "command", request });
        }
        if (this.helloAt !== null) this.meter?.recordJoin(now() - this.helloAt, this.welcomed);
        this.helloAt = null;
        this.welcomed = true;
        this.emitView();
        // An early clock sample, so remote-visibility numbers start with the session.
        if (this.meter) this.checkHead();
        for (const channel of this.scheduleChannels) channel.welcomed();
        return;
      }
      case "changeset": {
        if (msg.durable !== undefined) this.durableRevision = Math.max(this.durableRevision, msg.durable);
        if (!this.confirmed) return;
        if (msg.changeset.revision <= this.confirmed.revision) return; // already have it
        try {
          // A change can reach past our areas (a riser through every level): keep only our part.
          const sliced = sliceChangeset(msg.changeset, this.interest);
          this.confirmed = applyChangeset(this.confirmed, sliced);
          this.history.push(sliced);
          if (this.history.length > HISTORY_KEEP) this.history.splice(0, this.history.length - HISTORY_KEEP);
        } catch (err) {
          if (err instanceof RevisionGapError) {
            this.setStatus("catching_up");
            this.send({ type: "sync", fromRevision: this.confirmed.revision });
            return;
          }
          throw err;
        }
        this.pending = this.pending.filter((p) => p.idempotencyKey !== msg.changeset.idempotencyKey);
        const remote = !this.submitted.has(msg.changeset.idempotencyKey) && msg.changeset.clientSessionId !== this.clientSessionId;
        // Our own committed change is the answer: the "saved" message that follows it can be lost
        // with the connection, and the edit has already left `pending`, so nothing would resend it.
        this.settleCommitted(msg.changeset.idempotencyKey, msg.changeset.revision, msg.changeset.rebased);
        // Only live arrivals: a catch-up after a reconnect measures the outage, not the link.
        if (remote && this.status === "live") this.meter?.recordRemoteArrival(msg.changeset.committedAt, Date.now());
        if (msg.changeset.actor.id !== this.actor.id) {
          this.events.onRemoteChange?.(msg.changeset.revision, msg.changeset.actor);
        }
        this.mergeAreaIfDue();
        this.setStatus("live");
        this.emitView();
        return;
      }
      case "advance": {
        if (msg.durable !== undefined) this.durableRevision = Math.max(this.durableRevision, msg.durable);
        if (!this.confirmed || msg.revision <= this.confirmed.revision) return;
        if (msg.revision !== this.confirmed.revision + 1) {
          this.setStatus("catching_up");
          this.send({ type: "sync", fromRevision: this.confirmed.revision });
          return;
        }
        if (msg.committedAt && !this.submitted.has(msg.idempotencyKey) && this.status === "live") {
          this.meter?.recordRemoteArrival(msg.committedAt, Date.now());
        }
        this.confirmed = { ...this.confirmed, revision: asRevision(msg.revision) };
        this.pending = this.pending.filter((p) => p.idempotencyKey !== msg.idempotencyKey);
        this.mergeAreaIfDue();
        this.setStatus("live");
        this.emitView();
        return;
      }
      case "area": {
        if (!this.confirmed) return;
        this.pendingArea = msg;
        if (msg.revision > this.confirmed.revision) {
          this.setStatus("catching_up");
          this.send({ type: "sync", fromRevision: this.confirmed.revision });
          return;
        }
        this.mergeAreaIfDue();
        this.emitView();
        return;
      }
      case "outcome": {
        const req = this.submitted.get(msg.idempotencyKey);
        this.submitted.delete(msg.idempotencyKey);
        this.stopRetry(msg.idempotencyKey);
        const firstSent = this.sentAt.get(msg.idempotencyKey);
        this.sentAt.delete(msg.idempotencyKey);
        if (firstSent !== undefined && msg.outcome.status === "committed") this.meter?.recordCommit(now() - firstSent);
        if (this.retrying.size === 0) this.storageMessage = null;
        if (this.status === "degraded" && this.retrying.size === 0) this.setStatus("live");
        const outcome = msg.outcome;
        if (outcome.status === "rejected") {
          this.pending = this.pending.filter((p) => p.idempotencyKey !== msg.idempotencyKey);
          this.emitView();
        } else if (this.confirmed && this.confirmed.revision < outcome.revision) {
          // Our commit is ahead of what we hold (its broadcast may be lost): fetch the gap now.
          this.setStatus("catching_up");
          this.send({ type: "sync", fromRevision: this.confirmed.revision });
        } else {
          this.pending = this.pending.filter((p) => p.idempotencyKey !== msg.idempotencyKey);
          this.emitView();
        }
        if (req) {
          this.events.onOutcome?.(req, outcome);
          for (const channel of this.scheduleChannels) channel.outcome(req, outcome);
        }
        // "Base is ahead of the model": the server's model went backwards under us.
        // Only for an edit we still track: a repeated delivery after the reload is ignored.
        if (req && outcome.status === "rejected" && outcome.error.code === "stale_base") this.reloadAfterReset(1);
        this.emitSaveState();
        return;
      }
      case "unsaved": {
        // Not decided, not saved. Keep the edit and send it again with the SAME key:
        // if the server did store it before failing, the retry gets that first answer.
        if (!this.submitted.has(msg.idempotencyKey)) return;
        this.storageMessage = msg.message;
        this.setStatus("degraded");
        this.scheduleRetry(msg.idempotencyKey);
        this.emitSaveState();
        return;
      }
      case "unavailable":
        this.storageMessage = msg.message;
        this.setStatus("degraded");
        this.emitSaveState();
        return;
      case "head": {
        if (msg.durable !== undefined) this.durableRevision = Math.max(this.durableRevision, msg.durable);
        if (msg.serverTime !== undefined && msg.sentAt !== undefined) this.meter?.recordClockSample(msg.sentAt, Date.now(), msg.serverTime);
        // A server never goes backwards except when the model is reset, so compare with
        // what we held when we asked: an answer that is only older than later live updates is not a reset.
        const askedAt = this.headCheckBases.length > 0 ? Math.min(...this.headCheckBases) : (this.confirmed?.revision ?? -1);
        this.headCheckBases.shift();
        if (this.confirmed && msg.revision < askedAt) {
          this.reloadAfterReset();
          return;
        }
        if (this.confirmed && msg.revision > this.confirmed.revision) {
          this.setStatus("catching_up");
          this.send({ type: "sync", fromRevision: this.confirmed.revision });
        } else if (this.status === "degraded" && this.retrying.size === 0) {
          // The server answered from storage again.
          this.storageMessage = null;
          this.setStatus("live");
          this.emitSaveState();
        }
        return;
      }
      case "presence":
        this.events.onPresence?.(msg.connectionId, msg.presence);
        return;
      case "left":
        this.events.onPresence?.(msg.connectionId, null);
        for (const channel of this.scheduleChannels) channel.left(msg.connectionId);
        return;
      case "schedule_rows":
      case "schedule_patch":
      case "schedule_closed":
      case "editing_cell":
      case "editing_cell_release":
        for (const channel of this.scheduleChannels) channel.message(msg);
        return;
      case "branches":
      case "branch_saved":
      case "versions":
      case "version_saved":
      case "version_deleted":
      case "state_at_result":
      case "changed_between_result":
      case "coverage_result":
      case "request_refused":
      case "merge_preview_result":
      case "merge_apply_result":
      case "merge_refused":
      case "quantity_delta_result":
      case "quantity_delta_refused":
      case "lineages":
      case "lineage_saved":
      case "lineage_compare_result":
      case "lineage_act_recorded":
      case "lineage_delta_result": {
        const pending = this.requests.get(msg.requestId);
        if (!pending) {
          console.error("[bim-sync] answer to a request this client is not waiting for", { type: msg.type, requestId: msg.requestId });
          return;
        }
        clearTimeout(pending.timer);
        this.requests.delete(msg.requestId);
        if (msg.type === "branch_saved" && this.branchRef?.modelId === msg.branch.modelId) this.branchRef = msg.branch;
        pending.resolve(msg);
        return;
      }
      case "branch_state":
        // Quietly in place: the socket, the view and any open schedules stay; the next edit is refused with the branch's words.
        if (!this.branchRef || this.branchRef.modelId !== msg.branch.modelId) {
          console.error("[bim-sync] branch state for a branch this session isn't on; ignored", { on: this.branchRef?.modelId ?? null, got: msg.branch.modelId });
          return;
        }
        this.branchRef = msg.branch;
        this.events.onBranchState?.(msg.branch);
        return;
      case "error":
        console.error("[bim-sync] server error", { code: msg.code ?? null, messageType: msg.messageType ?? null, message: msg.message });
        return;
      case "denied":
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.heartbeat = null;
        this.setStatus("denied");
        this.events.onDenied?.(msg.reason);
        return;
    }
  }

  view(): ModelState | null {
    if (!this.confirmed) return null;
    const cached = this.viewCache;
    if (cached && cached.confirmed === this.confirmed && samePending(cached.pending, this.pending)) return cached.view;
    let model = this.confirmed;
    for (const req of this.pending) {
      const res = this.predict(model, req.command);
      if (res.ok) model = { ...res.model, revision: model.revision };
    }
    this.viewCache = { confirmed: this.confirmed, pending: [...this.pending], view: model };
    return model;
  }

  confirmedRevision(): number {
    return this.confirmed?.revision ?? -1;
  }

  /** A committed changeset this client has applied (undo needs the person's own recent ones). */
  committed(revision: number): Changeset | null {
    return this.history.find((cs) => cs.revision === revision) ?? null;
  }

  private commandContext(): { history: readonly Changeset[]; actorId: string } {
    return { history: this.history, actorId: this.actor.id };
  }

  /** What the server advertised in its welcome (undefined: a server from before round 5). */
  serverProtocolOf(): Protocol | undefined {
    return this.serverProtocol;
  }

  /**
   * Run a command locally the way the server will: a gated record upgrade
   * (its step is registered here, so this client reads its shape) is
   * predicted only when the server advertised the feature. An older server
   * never upgrades, so neither does the prediction. The server also waits for
   * every other connected peer, so a prediction can still be answered without it.
   */
  private predict(model: ModelState, command: Command) {
    const server = this.serverProtocol;
    return decideWithUpgrades(command, (feature) => peerHas(server, feature), () => executeCommand(model, command, this.commandContext()));
  }

  /** Committed state only (no local predictions). Sheets and exports render from this. */
  confirmedModel(): ModelState | null {
    return this.confirmed;
  }

  pendingCount(): number {
    return this.pending.length;
  }

  saveState(): SaveState {
    const waiting = this.retrying.size > 0 || this.status === "degraded";
    return { pending: this.pending.length, retrying: this.retrying.size, message: waiting ? this.storageMessage : null };
  }

  submit(command: Command, opts: SubmitOptions = {}): { ok: true; request: CommandRequest } | { ok: false; error: CommandError } {
    const view = this.view();
    if (!this.confirmed || !view) {
      return { ok: false, error: { code: "invalid_value", message: "Not connected yet", elementIds: [] } };
    }
    const refused = unsendable(command);
    if (refused) {
      console.error("[bim-sync] refused an edit the server would not read", { type: command.type, refused });
      return { ok: false, error: { code: "invalid_value", message: refused, elementIds: [] } };
    }
    const predicted = this.predict(view, command);
    if (!predicted.ok) return { ok: false, error: predicted.error };
    const startedAt = now();
    const request: CommandRequest = {
      idempotencyKey: opts.idempotencyKey ?? newKey(this.actor.id),
      baseRevision: opts.baseRevision ?? this.confirmed.revision,
      actor: this.actor,
      command,
      clientSessionId: this.clientSessionId,
    };
    this.pending.push(request);
    this.submitted.set(request.idempotencyKey, request);
    if (!this.sentAt.has(request.idempotencyKey)) this.sentAt.set(request.idempotencyKey, startedAt);
    this.send({ type: "command", request });
    this.emitView();
    this.emitSaveState();
    this.pointReads.schedule();
    const meter = this.meter;
    if (meter) nextFrame(() => meter.recordPreview(now() - startedAt));
    return { ok: true, request };
  }

  /** Unsaved edits based past `revision` are sent from it instead (same keys: still applied at most once). */
  private rebasePending(revision: number): void {
    this.pending = this.pending.map((request) => {
      if (request.baseRevision <= revision) return request;
      const rebased: CommandRequest = { ...request, baseRevision: revision };
      if (this.submitted.has(request.idempotencyKey)) this.submitted.set(request.idempotencyKey, rebased);
      return rebased;
    });
    for (const [key, request] of this.submitted) {
      if (request.baseRevision > revision) this.submitted.set(key, { ...request, baseRevision: revision });
    }
  }

  /** Re-send pending commands after a reconnect; idempotency keys make this safe (R5). */
  resendPending(): void {
    for (const request of this.pending) this.send({ type: "command", request });
  }

  publishPresence(activity: Presence["activity"]): void {
    this.send({ type: "presence", presence: { actor: this.actor, activity } });
  }

  dispose(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.reportTimer) clearInterval(this.reportTimer);
    this.reportTimer = null;
    this.sendReport();
    this.clearRetryTimers();
    this.retrying.clear();
    this.pointReads.stop();
    this.transport.close();
  }

  private settleCommitted(key: string, revision: number, rebased: boolean): void {
    const req = this.submitted.get(key);
    if (!req) return;
    this.submitted.delete(key);
    this.stopRetry(key);
    if (this.retrying.size === 0) this.storageMessage = null;
    const firstSent = this.sentAt.get(key);
    this.sentAt.delete(key);
    if (firstSent !== undefined) this.meter?.recordCommit(now() - firstSent);
    const outcome: CommitOutcome = { status: "committed", revision, rebased };
    this.events.onOutcome?.(req, outcome);
    for (const channel of this.scheduleChannels) channel.outcome(req, outcome);
  }

  private scheduleRetry(key: string): void {
    const entry = this.retrying.get(key) ?? { attempts: 0, timer: null };
    if (entry.timer) clearTimeout(entry.timer);
    const delay = Math.min(RETRY_BASE_MS * 2 ** entry.attempts, RETRY_MAX_MS);
    entry.attempts += 1;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      const request = this.pending.find((p) => p.idempotencyKey === key);
      if (request) this.send({ type: "command", request });
    }, delay);
    this.retrying.set(key, entry);
  }

  private stopRetry(key: string): void {
    const entry = this.retrying.get(key);
    if (entry?.timer) clearTimeout(entry.timer);
    this.retrying.delete(key);
  }

  private clearRetryTimers(): void {
    for (const entry of this.retrying.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = null;
      entry.attempts = 0;
    }
  }

  private emitSaveState(): void {
    const next = this.saveState();
    const prev = this.lastSaveState;
    if (prev.pending === next.pending && prev.retrying === next.retrying && prev.message === next.message) return;
    this.lastSaveState = next;
    this.events.onSaveState?.(next);
  }

  /**
   * Our confirmed revision is ahead of the server's, so nothing we hold can be
   * built on: drop confirmed state and unsaved edits and ask for a fresh copy.
   */
  private reloadAfterReset(refusedEdits = 0): void {
    this.headCheckBases = [];
    if (this.resetFrom || !this.confirmed) return;
    // The refused edit already left `pending`; it was not saved either.
    this.resetFrom = { revision: this.confirmed.revision, droppedEdits: this.pending.length + refusedEdits };
    this.confirmed = null;
    this.history = [];
    this.pending = [];
    this.clearRetryTimers();
    this.retrying.clear();
    this.pendingArea = null;
    this.submitted.clear();
    this.sentAt.clear();
    this.setStatus("catching_up");
    this.send({ type: "hello", actor: this.actor, lastRevision: -1, token: this.token, modelId: this.auth.modelId, interest: this.interest, protocol: clientProtocol() });
  }

  /**
   * Merge a newly loaded area once our confirmed revision has reached it.
   * At the same revision its records are current. Past it, any record that
   * changed since arrived in a changeset we already applied, so only records
   * we do not hold yet are taken.
   */
  private mergeAreaIfDue(): void {
    const area = this.pendingArea;
    const model = this.confirmed;
    if (!area || !model || area.revision > model.revision) return;
    this.pendingArea = null;
    const elements = draftElements(model.elements);
    const overwrite = area.revision === model.revision;
    for (const el of area.elements) if (overwrite || !elements[el.id]) elements[el.id] = el;
    const known = new Set(model.connections.map((c) => c.id));
    const connections: Connection[] = [...model.connections, ...area.connections.filter((c) => !known.has(c.id))];
    this.confirmed = sliceModel({ ...model, elements, connections }, this.interest);
  }

  private send(msg: ClientMessage): void {
    this.transport.send(JSON.stringify(msg));
  }

  private setStatus(status: ConnectionStatus): void {
    if (status === this.status) return;
    this.status = status;
    this.events.onStatus?.(status);
  }

  private emitView(): void {
    // Predictions re-run every unsaved edit on the new confirmed head; with nobody listening (agents,
    // scripted clients) that is pure cost on every incoming change, so it waits until view() is asked for.
    const onView = this.events.onView;
    if (onView) {
      const view = this.view();
      if (view) onView(view, { confirmedRevision: this.confirmedRevision(), pending: this.pending.length });
    }
    this.emitSaveState();
  }
}
