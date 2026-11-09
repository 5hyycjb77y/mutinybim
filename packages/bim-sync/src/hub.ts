import {
  addedInterest,
  changesetInInterest,
  elementCount,
  elementKindTable,
  elementValues,
  isServerOnlyCommand,
  KINDS_ADDON_OWNED_FEATURE,
  lowerForOlderPeer,
  lowerPipeJointForOlderPeer,
  PIPES_ADDON_PRODUCTS_FEATURE,
  serverOnlyCommandRefusal,
  sliceChangeset,
  sliceModel,
  type Actor,
  type BimElement,
  type BranchRef,
  type Changeset,
  type ElementKindTable,
  type Interest,
  type ModelState,
} from "@permitzip/bim-kernel";
import { activePackSet, modelPackSet, withPackSet, type PackSet } from "@permitzip/bim-kernel/packs";
import { messageErrorReply, readClientMessage, type ClientMessage, type Presence, type ServerMessage, type SessionReport } from "./protocol";
import { peerHas, peerProtocol, serverProtocol, type Protocol } from "./protocol-version";
import { CellHoldBoard } from "./schedules/cell-holds";
import type { ScheduleEvaluator } from "./schedules/evaluator";
import { actorColor, type ActorRef, type ScheduleServerMessage } from "./schedules/protocol";
import { ScheduleSubscriptions, type ScheduleMetrics } from "./schedules/subscriptions";
import type { Sequencer } from "./sequencer";
import { StaleLeaseError } from "./store";
import { BRANCHES_SESSIONS_FEATURE, BRANCHES_STATE_BROADCAST_FEATURE, BRANCHES_UNAVAILABLE, HISTORY_REVISION_READS_FEATURE, isBranchClientMessage } from "./branches/protocol";
import type { PrincipalLineage } from "./authorization";
import { isLineageClientMessage, LINEAGE_OLDER_SERVER_WORDS, LINEAGES_ROLES_FEATURE } from "./lineages/protocol";
import type { LineageService } from "./lineages/service";
import { readOnlyWords } from "./lineages/rights";
import { HISTORY_COVERAGE_READ_FEATURE } from "./branches/coverage";
import type { BranchService } from "./branches/service";
import { MERGE_FEATURE, type MergeClientMessage, type MergeServerMessage } from "./merge/messages";
import { QUANTITY_DELTA_FEATURE, type QuantityDeltaRequest, type QuantityDeltaServerMessage } from "./delta/messages";

export interface HubConnection {
  readonly id: string;
  send(data: string): void;
}

export interface HubMetrics {
  commits: number;
  rejections: number;
  broadcasts: number;
  /** Revision-only notices sent instead of a changeset to people whose areas it did not touch. */
  advances: number;
  droppedBroadcasts: number;
  /** Commands answered "not saved yet" (storage unreachable or lease lost). */
  unsaved: number;
  bytesOut: number;
  commitMs: number[];
  /** The last joins' cost per step, so a slow "open a zone" can be attributed (most recent last, capped). */
  joins: JoinTiming[];
  /** Open schedules (present when the hub evaluates schedules). */
  schedules?: ScheduleMetrics;
}

export interface JoinTiming {
  readonly authorizeMs: number;
  readonly headMs: number;
  readonly sliceMs: number;
  readonly serializeMs: number;
  readonly bytes: number;
  readonly elements: number;
}

const JOIN_HISTORY = 50;

/** Who a connection is, once its login has been checked for this model's project. */
export interface ConnectionPrincipal {
  readonly actorId: string;
  readonly canWrite: boolean;
  /** Round 11 (W11): what the person holds on the copy this hub serves and every copy above it. Absent: a host that decides per model only. */
  readonly lineage?: PrincipalLineage;
}

export type AuthorizeHello = (hello: Extract<ClientMessage, { type: "hello" }>) => Promise<
  { readonly ok: true; readonly principal: ConnectionPrincipal } | { readonly ok: false; readonly reason: string }
>;

export interface HubOptions {
  /** When set, every connection must pass this check before it can read or write. */
  readonly authorize?: AuthorizeHello;
  /** Another process took the model's lease: this hub must stop serving it. */
  readonly onLeaseLost?: (err: StaleLeaseError) => void;
  /** A session sent its measurements (regional sessions). */
  readonly onReport?: (input: { readonly connectionId: string; readonly actorId: string; readonly report: SessionReport }) => void;
  /**
   * Evaluates schedules over the whole model this hub serves (Stream E's row
   * engine). Absent: `schedule_open` is answered "not available here".
   */
  readonly schedules?: ScheduleEvaluator;
  /** What this server advertises in `welcome` (default: this release's `serverProtocol()`). */
  readonly protocol?: Protocol;
  /**
   * Branches, saved versions and history reads for this model (round 8b).
   * Absent: those requests are answered "not available here" and the
   * features are not advertised.
   */
  readonly branches?: BranchService;
  /**
   * Merge preview and apply on this model's branch session (round 8b). The
   * host recomputes everything from the model it holds and reads approvals as
   * the person on this connection. Absent: answered "not available here" and
   * `branches:merge` is not advertised.
   */
  readonly merge?: (msg: MergeClientMessage, from: { readonly connectionId: string; readonly principal: ConnectionPrincipal; readonly actor: Actor | null }) => Promise<MergeServerMessage>;
  /** Quantity change between revisions (or Main and this branch). Absent: not advertised, answered "not available". */
  readonly quantityDelta?: (msg: QuantityDeltaRequest) => Promise<QuantityDeltaServerMessage>;
  /** Round 11 (W11): copies with a purpose on this model. Absent: lineage requests are answered in the "older server" words and not advertised. */
  readonly lineages?: LineageService;
}

export const MERGE_UNAVAILABLE = "Merging isn't available on this model server yet.";
export const QUANTITY_DELTA_UNAVAILABLE = "Quantity comparisons aren't available on this model server yet.";

export const SCHEDULES_UNAVAILABLE = "Live schedules aren't available on this model server yet.";

export const NOT_SAVED_STORAGE = "Not saved yet: the server can't reach the database. Your change is kept and will be sent again automatically.";
export const NOT_SAVED_OWNER = "Not saved yet: this server no longer owns the model. Your change is kept and will be sent again when you reconnect.";
export const STORAGE_UNAVAILABLE = "The server can't reach the database right now. You are seeing the last saved state; edits wait until it is back.";

/**
 * Transport-agnostic server side of the protocol. The dev server and the
 * Postgres authority wire it to WebSockets; tests drive it directly.
 */
export class SyncHub {
  private readonly connections = new Map<string, HubConnection>();
  private readonly principals = new Map<string, ConnectionPrincipal>();
  private readonly presence = new Map<string, Presence>();
  /** Loaded areas per connection; absent means the whole model. */
  private readonly interests = new Map<string, Interest>();
  private dropNext = 0;
  /** Which connection sent each command still being decided or written. */
  private readonly origin = new Map<string, string>();
  /**
   * Changes held back per connection, in revision order. A person's own edit
   * reaches their connections only once it is durable (they treat it as
   * "saved"); anything after it waits behind it so every connection still
   * receives revisions in order.
   */
  private readonly held = new Map<string, Array<{ readonly cs: Changeset; readonly own: boolean }>>();
  private durable = -1;
  readonly metrics: HubMetrics = { commits: 0, rejections: 0, broadcasts: 0, advances: 0, droppedBroadcasts: 0, unsaved: 0, bytesOut: 0, commitMs: [], joins: [] };
  /** Open schedules, evaluated over the whole model (null: this hub has no evaluator). */
  private readonly schedules: ScheduleSubscriptions | null;
  private readonly holds = new CellHoldBoard();
  /** Who each connection said it is in its hello (names on cell holds). */
  private readonly actors = new Map<string, Actor>();
  /** Schedule messages waiting behind a connection's held changesets (one revision on screen). */
  private readonly scheduleHeld = new Map<string, Array<{ readonly revision: number; readonly message: ScheduleServerMessage }>>();
  /** What each connection said it reads in its hello (version 1, no features, when it said nothing). */
  private readonly peers = new Map<string, Protocol>();
  /** The model this hub serves, once its head has been read (its add-on set lowers records for older peers). */
  private modelId: string | null = null;
  readonly protocol: Protocol;

  constructor(
    private readonly sequencer: Sequencer,
    private readonly options: HubOptions = {},
  ) {
    const base = options.protocol ?? serverProtocol();
    // Each feature is advertised only by a hub that serves it.
    const served = [
      ...(options.branches ? [BRANCHES_SESSIONS_FEATURE, HISTORY_REVISION_READS_FEATURE, BRANCHES_STATE_BROADCAST_FEATURE] : []),
      ...(options.branches?.servesCoverage() ? [HISTORY_COVERAGE_READ_FEATURE] : []),
      ...(options.merge ? [MERGE_FEATURE] : []),
      ...(options.quantityDelta ? [QUANTITY_DELTA_FEATURE] : []),
      ...(options.lineages ? options.lineages.features() : []),
    ];
    this.protocol = served.length > 0 ? { ...base, features: [...new Set([...base.features, ...served])] } : base;
    // A record upgrade that writes a gated shape runs only while this server and every connected peer read it.
    sequencer.setUpgradePolicy((feature) => this.everyoneReads(feature));
    // A branch closed or merged (here or, through the host, on another machine): every page that reads it hears once, in place.
    options.branches?.onStateChange((branch) => this.announceBranchState(branch));
    this.schedules = options.schedules
      ? new ScheduleSubscriptions(options.schedules, (subscriber, revision, message) => this.deliverSchedule(subscriber, revision, message), {
          loadHead: () => sequencer.head(),
        })
      : null;
    if (this.schedules) this.metrics.schedules = this.schedules.metrics;
    sequencer.onCommit((changeset) => {
      // Schedules are evaluated here, on the server: a lost client broadcast (drill) does not skip them.
      this.schedules?.onCommit(changeset);
      if (this.dropNext > 0) {
        // Fault injection for the R6 drill: the broadcast is lost; nothing else follows.
        this.dropNext -= 1;
        this.metrics.droppedBroadcasts += 1;
        return;
      }
      this.metrics.broadcasts += 1;
      this.broadcastChangeset(changeset);
    });
    sequencer.onDurable((revision) => {
      this.durable = Math.max(this.durable, revision);
      this.releaseHeld();
    });
  }

  /** Drop the next N commit broadcasts (drill only). */
  dropNextBroadcasts(n = 1): void {
    this.dropNext += n;
  }

  /**
   * Add a connection. A host that authorized the login before choosing this hub
   * passes the principal here, and the hello is not authorized a second time.
   */
  join(conn: HubConnection, principal?: ConnectionPrincipal): void {
    this.connections.set(conn.id, conn);
    if (principal) this.principals.set(conn.id, principal);
    else if (!this.options.authorize) this.principals.set(conn.id, { actorId: "*", canWrite: true });
  }

  principalOf(connectionId: string): ConnectionPrincipal | null {
    return this.principals.get(connectionId) ?? null;
  }

  /** What a connection said it reads (version 1, no features, before its hello or when it said nothing). */
  peerProtocolOf(connectionId: string): Protocol {
    return peerProtocol(this.peers.get(connectionId));
  }

  /** This server and every signed-in connection advertise `feature` (none connected: only this server). */
  everyoneReads(feature: string): boolean {
    if (!peerHas(this.protocol, feature)) return false;
    for (const id of this.principals.keys()) {
      if (!peerHas(this.peers.get(id), feature)) return false;
    }
    return true;
  }

  /** The person's access changed mid-session (for example edit removed, view kept). */
  setPrincipal(connectionId: string, principal: ConnectionPrincipal): void {
    if (this.connections.has(connectionId)) this.principals.set(connectionId, principal);
  }

  /** Access removed: say so plainly and stop serving this connection. The host closes the socket. */
  revoke(connectionId: string, reason: string): void {
    const conn = this.connections.get(connectionId);
    if (!conn) return;
    this.schedules?.closeAll(connectionId, "denied", reason);
    this.releaseHolds(connectionId);
    this.principals.delete(connectionId);
    this.sendTo(conn, { type: "denied", reason });
  }

  private halted: string | null = null;

  /**
   * Stop accepting commits at once (lease renewal failed): every later command is
   * answered "not saved yet" and kept by its client for the next owner.
   */
  halt(message: string): void {
    this.halted = message;
  }

  leave(conn: HubConnection): void {
    this.connections.delete(conn.id);
    this.principals.delete(conn.id);
    this.presence.delete(conn.id);
    this.interests.delete(conn.id);
    this.peers.delete(conn.id);
    this.held.delete(conn.id);
    this.schedules?.drop(conn.id);
    this.scheduleHeld.delete(conn.id);
    this.releaseHolds(conn.id);
    this.actors.delete(conn.id);
    this.broadcast({ type: "left", connectionId: conn.id });
  }

  /** Evaluate schedule commits received so far now instead of on the next tick (tests). */
  flushSchedules(): void {
    this.schedules?.flush();
  }

  connectionCount(): number {
    return this.connections.size;
  }

  async handle(conn: HubConnection, raw: string): Promise<void> {
    try {
      await this.dispatch(conn, raw);
    } catch (err) {
      // A read (welcome, head, catch-up, area) needed durable storage and could not get it.
      if (err instanceof StaleLeaseError) {
        this.options.onLeaseLost?.(err);
        this.sendTo(conn, { type: "unavailable", message: NOT_SAVED_OWNER });
        return;
      }
      console.error("[bim-sync] request failed; told the client storage is unavailable", { id: conn.id, err });
      this.sendTo(conn, { type: "unavailable", message: STORAGE_UNAVAILABLE });
    }
  }

  private async dispatch(conn: HubConnection, raw: string): Promise<void> {
    const read = readClientMessage(raw);
    if (!read.ok) {
      this.sendTo(conn, messageErrorReply(read));
      return;
    }
    const msg = read.message;
    const authorizeStarted = performance.now();
    if (msg.type === "hello" && this.options.authorize && !this.principals.has(conn.id)) {
      const result = await this.options.authorize(msg);
      if (!result.ok) {
        console.error("[bim-sync] connection refused", { id: conn.id, reason: result.reason });
        this.sendTo(conn, { type: "denied", reason: result.reason });
        return;
      }
      this.principals.set(conn.id, result.principal);
    }
    const principal = this.principals.get(conn.id);
    if (!principal) {
      this.sendTo(conn, { type: "denied", reason: "Sign in to this project first" });
      return;
    }
    if (isBranchClientMessage(msg)) {
      const branches = this.options.branches;
      this.sendTo(conn, branches ? await branches.handle(msg, principal) : { type: "request_refused", requestId: msg.requestId, reason: BRANCHES_UNAVAILABLE });
      return;
    }
    if (isLineageClientMessage(msg)) {
      const lineages = this.options.lineages;
      this.sendTo(conn, lineages ? await lineages.handle(msg, { actorId: principal.actorId, connectionId: conn.id, actor: this.actors.get(conn.id) ?? null, ...(principal.lineage ? { lineage: principal.lineage } : {}) }) : { type: "request_refused", requestId: msg.requestId, reason: LINEAGE_OLDER_SERVER_WORDS[LINEAGES_ROLES_FEATURE] ?? "" });
      return;
    }
    if (msg.type === "merge_preview" || msg.type === "merge_apply") {
      const merge = this.options.merge;
      this.sendTo(conn, merge ? await merge(msg, { connectionId: conn.id, principal, actor: this.actors.get(conn.id) ?? null }) : { type: "merge_refused", requestId: msg.requestId, message: MERGE_UNAVAILABLE });
      return;
    }
    if (msg.type === "quantity_delta") {
      const delta = this.options.quantityDelta;
      this.sendTo(conn, delta ? await delta(msg) : { type: "quantity_delta_refused", requestId: msg.requestId, reason: QUANTITY_DELTA_UNAVAILABLE });
      return;
    }
    switch (msg.type) {
      case "hello": {
        this.actors.set(conn.id, msg.actor);
        if (msg.protocol) this.peers.set(conn.id, msg.protocol);
        else this.peers.delete(conn.id);
        // Interest is set before reading the head, so every later commit is filtered the new way.
        if (msg.interest) this.interests.set(conn.id, msg.interest);
        else this.interests.delete(conn.id);
        await this.sendWelcome(conn, authorizeStarted);
        for (const [id, p] of this.presence) this.sendTo(conn, { type: "presence", presence: p, connectionId: id });
        for (const hold of this.holds.current(Date.now())) if (hold.connectionId !== conn.id) this.sendTo(conn, hold);
        return;
      }
      case "command": {
        if (isServerOnlyCommand(msg.request.command)) {
          this.sendTo(conn, { type: "outcome", idempotencyKey: msg.request.idempotencyKey, outcome: { status: "rejected", error: { code: "forbidden", message: serverOnlyCommandRefusal(msg.request.command.type), elementIds: [] } } });
          return;
        }
        if (!principal.canWrite || (principal.actorId !== "*" && principal.actorId !== msg.request.actor.id)) {
          this.sendTo(conn, {
            type: "outcome",
            idempotencyKey: msg.request.idempotencyKey,
            outcome: {
              status: "rejected",
              error: {
                code: "forbidden",
                message: principal.canWrite
                  ? "You can only edit as yourself"
                  : principal.lineage
                    ? readOnlyWords(principal.lineage.rights, principal.lineage.lineageId)
                    : "You can view this model but not edit it. Ask a project admin for model editing access.",
                elementIds: [],
              },
            },
          });
          return;
        }
        if (this.halted) {
          this.metrics.unsaved += 1;
          this.sendTo(conn, { type: "unsaved", idempotencyKey: msg.request.idempotencyKey, reason: "not_owner", message: this.halted });
          return;
        }
        const started = performance.now();
        const key = msg.request.idempotencyKey;
        this.origin.set(key, conn.id);
        let outcome;
        try {
          outcome = await this.sequencer.submit(msg.request);
        } catch (err) {
          if (this.origin.get(key) === conn.id) this.origin.delete(key);
          // Not decided, not saved: say so plainly and let the client retry with the same key.
          const lost = err instanceof StaleLeaseError;
          if (lost) this.options.onLeaseLost?.(err);
          else console.error("[bim-sync] commit could not reach durable storage", { key: msg.request.idempotencyKey, err });
          this.metrics.unsaved += 1;
          this.sendTo(conn, {
            type: "unsaved",
            idempotencyKey: msg.request.idempotencyKey,
            reason: lost ? "not_owner" : "storage_unavailable",
            message: lost ? NOT_SAVED_OWNER : NOT_SAVED_STORAGE,
          });
          return;
        }
        if (this.origin.get(key) === conn.id) this.origin.delete(key);
        this.metrics.commitMs.push(performance.now() - started);
        if (outcome.status === "committed") this.metrics.commits += 1;
        else this.metrics.rejections += 1;
        this.sendTo(conn, { type: "outcome", idempotencyKey: msg.request.idempotencyKey, outcome });
        return;
      }
      case "heartbeat": {
        const revision = (await this.sequencer.head()).revision;
        this.sendTo(conn, {
          type: "head",
          revision: this.visibleRevision(conn.id, revision),
          serverTime: Date.now(),
          ...(msg.sentAt !== undefined ? { sentAt: msg.sentAt } : {}),
          durable: this.sequencer.durableRevision(revision),
        });
        return;
      }
      case "report":
        this.options.onReport?.({ connectionId: conn.id, actorId: principal.actorId, report: msg.report });
        return;
      case "sync": {
        // Held changes (this person's own, not yet durable, and what follows them) arrive in order when released.
        const limit = this.held.get(conn.id)?.[0]?.cs.revision ?? Number.POSITIVE_INFINITY;
        const changes = await this.sequencer.changesSince(msg.fromRevision);
        const first = changes[0];
        if (first && first.revision > msg.fromRevision + 1) {
          // The changes this client is missing are older than the kept history (changeset retention): send a fresh copy instead.
          console.error("[bim-sync] catch-up is older than the kept history; sending a fresh copy", { id: conn.id, from: msg.fromRevision, oldestKept: first.revision });
          await this.sendWelcome(conn, performance.now());
          return;
        }
        for (const changeset of changes) {
          if (changeset.revision < limit) this.sendChangeset(conn, changeset);
        }
        return;
      }
      case "interest": {
        const prev = this.interests.get(conn.id);
        this.interests.set(conn.id, msg.interest);
        const added = prev ? addedInterest(prev, msg.interest) : null;
        if (!added) return; // narrowing (or from the whole model): the client drops what it no longer needs
        const head = await this.sequencer.head();
        const slice = this.lowerModelFor(conn.id, sliceModel(head, added));
        this.sendTo(conn, {
          type: "area",
          revision: head.revision,
          interest: msg.interest,
          elements: elementValues(slice.elements),
          connections: slice.connections,
        });
        return;
      }
      case "presence":
        this.presence.set(conn.id, msg.presence);
        this.broadcast({ type: "presence", presence: msg.presence, connectionId: conn.id }, conn.id);
        return;
      case "schedule_open":
        if (!this.schedules) {
          this.sendTo(conn, { type: "schedule_closed", subscriptionId: msg.subscriptionId, reason: "closed", message: SCHEDULES_UNAVAILABLE });
          return;
        }
        await this.schedules.open(conn.id, msg.subscriptionId, msg.target, msg.window);
        return;
      case "schedule_window":
        this.schedules?.setWindow(conn.id, msg.subscriptionId, msg.window);
        return;
      case "schedule_close":
        this.schedules?.close(conn.id, msg.subscriptionId);
        return;
      case "editing_cell": {
        const claimed = this.holds.claim(conn.id, this.actorRef(conn.id, principal), msg, msg.ttlMs, Date.now());
        if (claimed) this.broadcast(claimed, conn.id);
        return;
      }
      case "editing_cell_release": {
        const released = this.holds.release(conn.id, msg);
        if (released) this.broadcast(released, conn.id);
        return;
      }
    }
  }

  /** The model sliced to the connection's areas, with this server's protocol. */
  private async sendWelcome(conn: HubConnection, authorizeStarted: number): Promise<void> {
    const interest = this.interests.get(conn.id);
    const headStarted = performance.now();
    const head = await this.sequencer.head();
    const sliceStarted = performance.now();
    this.modelId = head.modelId;
    const model = this.lowerModelFor(conn.id, sliceModel(head, interest));
    const serializeStarted = performance.now();
    const durableRevision = this.sequencer.durableRevision(head.revision);
    const branch = this.options.branches?.current() ?? null;
    const data = JSON.stringify({ type: "welcome", model, ...(interest ? { interest } : {}), durableRevision, protocol: this.protocol, ...(branch ? { branch } : {}) } satisfies ServerMessage);
    const sent = performance.now();
    this.metrics.bytesOut += data.length;
    conn.send(data);
    this.metrics.joins.push({
      authorizeMs: headStarted - authorizeStarted,
      headMs: sliceStarted - headStarted,
      sliceMs: serializeStarted - sliceStarted,
      serializeMs: sent - serializeStarted,
      bytes: data.length,
      elements: elementCount(model.elements),
    });
    if (this.metrics.joins.length > JOIN_HISTORY) this.metrics.joins.splice(0, this.metrics.joins.length - JOIN_HISTORY);
  }

  /** The name and colour others see on this connection's cell holds. */
  private actorRef(connectionId: string, principal: ConnectionPrincipal): ActorRef {
    const said = this.actors.get(connectionId);
    // A connection authorized as someone is shown as that someone, whatever its hello claimed.
    const actor = said && (principal.actorId === "*" || principal.actorId === said.id) ? said : null;
    const id = actor?.id ?? principal.actorId;
    return { id, name: actor ? (actor.kind === "agent" ? `${actor.name} (agent)` : actor.name) : id, color: actorColor(id) };
  }

  private releaseHolds(connectionId: string): void {
    for (const released of this.holds.releaseAll(connectionId)) this.broadcast(released, connectionId);
  }

  /**
   * Schedule rows and patches for revision R reach a connection only after
   * changeset R has (a person's own unsaved edit holds its changesets back,
   * and the schedule waits with them), so geometry and schedules on one
   * screen show one revision. Revision -1: not tied to a revision (closed).
   */
  private deliverSchedule(connectionId: string, revision: number, message: ScheduleServerMessage): void {
    const conn = this.connections.get(connectionId);
    if (!conn || !this.principals.has(connectionId)) return;
    const firstHeld = this.held.get(connectionId)?.[0]?.cs.revision;
    const waiting = this.scheduleHeld.get(connectionId);
    if (revision >= 0 && ((firstHeld !== undefined && firstHeld <= revision) || (waiting && waiting.length > 0))) {
      if (waiting) waiting.push({ revision, message });
      else this.scheduleHeld.set(connectionId, [{ revision, message }]);
      return;
    }
    this.sendTo(conn, message);
  }

  private releaseScheduleHeld(connectionId: string, conn: HubConnection): void {
    const waiting = this.scheduleHeld.get(connectionId);
    if (!waiting) return;
    const firstHeld = this.held.get(connectionId)?.[0]?.cs.revision ?? Number.POSITIVE_INFINITY;
    while (waiting.length > 0) {
      const next = waiting[0];
      if (!next || next.revision >= firstHeld) break;
      waiting.shift();
      this.sendTo(conn, next.message);
    }
    if (waiting.length === 0) this.scheduleHeld.delete(connectionId);
  }

  /**
   * Each person gets the part of a change inside their areas, or a
   * revision-only notice, at once; except that a person's own edit waits on
   * their connections until it is durable (see `held`).
   */
  private broadcastChangeset(cs: Changeset): void {
    const sender = this.origin.get(cs.idempotencyKey);
    for (const conn of this.connections.values()) {
      const principal = this.principals.get(conn.id);
      if (!principal) continue;
      const own = sender === conn.id || (principal.actorId !== "*" && principal.actorId === cs.actor.id);
      const queue = this.held.get(conn.id);
      if (queue && queue.length > 0) queue.push({ cs, own });
      else if (own && cs.revision > this.durable) this.held.set(conn.id, [{ cs, own }]);
      else this.sendChangeset(conn, cs);
    }
  }

  private releaseHeld(): void {
    for (const [id, queue] of this.held) {
      const conn = this.connections.get(id);
      if (!conn || !this.principals.has(id)) {
        this.held.delete(id);
        continue;
      }
      while (queue.length > 0) {
        const next = queue[0];
        if (!next || (next.own && next.cs.revision > this.durable)) break;
        queue.shift();
        this.sendChangeset(conn, next.cs);
      }
      if (queue.length === 0) this.held.delete(id);
      this.releaseScheduleHeld(id, conn);
    }
  }

  /** The newest revision this connection may be told about (its own unsaved edit holds it back). */
  private visibleRevision(connectionId: string, head: number): number {
    const first = this.held.get(connectionId)?.[0];
    return first ? Math.min(head, first.cs.revision - 1) : head;
  }

  private sendChangeset(conn: HubConnection, cs: Changeset): void {
    const interest = this.interests.get(conn.id);
    const durable = this.durable >= 0 ? { durable: this.durable } : {};
    if (changesetInInterest(cs, interest)) {
      this.sendTo(conn, { type: "changeset", changeset: this.lowerChangesetFor(conn.id, sliceChangeset(cs, interest)), ...durable });
      return;
    }
    this.metrics.advances += 1;
    this.sendTo(conn, { type: "advance", revision: cs.revision, idempotencyKey: cs.idempotencyKey, committedAt: cs.committedAt, ...durable });
  }

  /**
   * One `branch_state` per signed-in connection that reads it; nothing is
   * closed or reloaded (no reconnect storm). A page without the feature
   * learns on its next edit, which the write gate refuses in the same words.
   */
  private announceBranchState(branch: BranchRef): void {
    const data = JSON.stringify({ type: "branch_state", branch } satisfies ServerMessage);
    for (const conn of this.connections.values()) {
      if (!this.principals.has(conn.id) || !peerHas(this.peers.get(conn.id), BRANCHES_STATE_BROADCAST_FEATURE)) continue;
      this.metrics.bytesOut += data.length;
      conn.send(data);
    }
  }

  /**
   * The add-on kinds table for the records this hub sends, or null when this
   * connection reads `kinds:addon_owned` (it gets records as stored) or no
   * add-on owns a kind. A record lifted into the parameter form while every
   * connected peer read it would otherwise reach an older peer that joins later.
   */
  private olderPeerTable(connectionId: string, set: PackSet): ElementKindTable | null {
    if (peerHas(this.peers.get(connectionId), KINDS_ADDON_OWNED_FEATURE)) return null;
    const table = elementKindTable(set);
    return table.kinds.length > 0 ? table : null;
  }

  /**
   * How one record is lowered for this connection, or null when it gets
   * records as stored: add-on kinds into their stored form (A9) and, for a
   * peer without `pipes:addon_products`, a pipe fitting's joint kept by end
   * type back to its stored joint name (P10).
   */
  private olderPeerLowering(connectionId: string): { readonly set: PackSet; readonly lower: (el: BimElement) => BimElement } | null {
    const set = (this.modelId ? modelPackSet(this.modelId) : null) ?? activePackSet();
    const table = this.olderPeerTable(connectionId, set);
    const pipes = !peerHas(this.peers.get(connectionId), PIPES_ADDON_PRODUCTS_FEATURE);
    if (!table && !pipes) return null;
    return {
      set,
      lower: (el) => {
        const kinds = table ? lowerForOlderPeer(el, table) : el;
        return pipes ? lowerPipeJointForOlderPeer(kinds) : kinds;
      },
    };
  }

  private lowerModelFor(connectionId: string, model: ModelState): ModelState {
    const lowering = this.olderPeerLowering(connectionId);
    if (!lowering) return model;
    const { set, lower } = lowering;
    return withPackSet(set, () => {
      const values = elementValues(model.elements);
      let changed = false;
      const out = values.map((el) => {
        const low = lower(el);
        if (low !== el) changed = true;
        return low;
      });
      if (!changed) return model;
      const elements: Record<string, BimElement> = {};
      for (const el of out) elements[el.id] = el;
      return { ...model, elements };
    });
  }

  private lowerChangesetFor(connectionId: string, cs: Changeset): Changeset {
    const lowering = this.olderPeerLowering(connectionId);
    if (!lowering) return cs;
    const { set, lower } = lowering;
    return withPackSet(set, () => {
      let changed = false;
      const elements = cs.elements.map((el) => {
        const out = lower(el);
        if (out !== el) changed = true;
        return out;
      });
      let before = cs.before;
      if (cs.before) {
        const next: Record<string, BimElement | null> = {};
        for (const [id, prior] of Object.entries(cs.before)) {
          const out = prior ? lower(prior) : prior;
          if (out !== prior) changed = true;
          next[id] = out;
        }
        before = next;
      }
      return changed ? { ...cs, elements, ...(before ? { before } : {}) } : cs;
    });
  }

  private broadcast(msg: ServerMessage, exceptId?: string): void {
    const data = JSON.stringify(msg);
    for (const conn of this.connections.values()) {
      if (conn.id === exceptId || !this.principals.has(conn.id)) continue;
      this.metrics.bytesOut += data.length;
      conn.send(data);
    }
  }

  private sendTo(conn: HubConnection, msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    this.metrics.bytesOut += data.length;
    conn.send(data);
  }
}
