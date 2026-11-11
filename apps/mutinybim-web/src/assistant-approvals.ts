/**
 * Asking the person before an outside assistant changes a model.
 *
 * In order, the first way that works:
 * 1. The assistant's own approval box (MCP elicitation, form mode), when
 *    the assistant has one. The person answers there.
 * 2. An approval page in this app (/approvals/<id>). An assistant that can
 *    open links (MCP elicitation, URL mode) is asked to show it; the tool
 *    call waits a little under a minute for the answer, sending progress.
 * 3. If no one answered by then, the request stays on the approvals page
 *    for 30 minutes. An edit lands the moment the person approves it there;
 *    a script's output lands when the assistant sends it again.
 *
 * Requests are kept in the account database, so a restart of the server
 * loses none of them: an edit approved after a restart still lands, and a
 * retry approved before it still matches.
 *
 * Nothing here can be approved by the assistant: only the signed-in person
 * on the page, or the person in the assistant's own approval box.
 */
import { randomUUID } from "node:crypto";
import type { AssistantApprovalRow, AssistantApprovalState, Db } from "./db";

export const APPROVAL_WAIT_MS = 50_000;
export const APPROVAL_KEEP_MS = 30 * 60_000;
const PROGRESS_EVERY_MS = 10_000;
const EXPIRED_WORDS = "Nobody approved it within 30 minutes, so it was dropped. Nothing changed.";

export type ApprovalState = AssistantApprovalState;

export interface PendingApproval {
  readonly id: string;
  readonly userId: string;
  readonly clientName: string;
  readonly modelId: string;
  readonly modelName: string;
  /** One line the person reads: what lands and where. */
  readonly summary: string;
  readonly details: readonly string[];
  readonly createdAt: number;
  /** "edit": lands on approval even after the call returned. "retry": the assistant sends it again (a script's output). */
  readonly kind: "edit" | "retry";
  /** The request a retry must match (retry kind). */
  readonly key: string | null;
  readonly state: ApprovalState;
  /** What happened after the person answered, in words. */
  readonly outcome: string | null;
  /** What lands when the person approves after the call returned (edit kind). */
  readonly landing: unknown;
}

/** What the app shows about a request that is waiting for the person: only words they read, and where to answer. */
export interface WaitingApproval {
  readonly id: string;
  readonly assistant: string;
  /** The model as its base id (to tell "this model" in the editor); empty for a library save. */
  readonly modelId: string;
  readonly modelName: string;
  readonly title: string;
  readonly askedAt: number;
  readonly href: string;
}

/** The request as one line a person reads: what changes and in which model by name, never a model id. */
export function approvalTitle(item: Pick<PendingApproval, "summary" | "modelId" | "modelName">): string {
  const where = `in “${item.modelName}”`;
  const landing = /^land "([\s\S]*)" in model \S+ as one undo step: ([\s\S]+)$/.exec(item.summary);
  if (landing) return `${landing[1] ?? ""} — ${landing[2] ?? ""}, ${where}`;
  const named = item.modelId ? item.summary.split(` in model ${item.modelId}`).join(` ${where}`) : item.summary;
  const text = !item.modelId || named.includes(where) ? named : `${named}, ${where}`;
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

export function toWaiting(item: PendingApproval): WaitingApproval {
  return { id: item.id, assistant: item.clientName, modelId: item.modelId.split("~")[0] ?? item.modelId, modelName: item.modelName, title: approvalTitle(item), askedAt: item.createdAt, href: `/approvals/${item.id}` };
}

/** How an approved change ended: whether it is in the model now, and the words the person reads. */
export interface LandingOutcome {
  readonly applied: boolean;
  readonly words: string;
}

/** Lands an approved edit whose call already returned. */
export type Lander = (item: PendingApproval) => Promise<LandingOutcome>;

function toItem(row: AssistantApprovalRow): PendingApproval {
  return {
    id: row.id,
    userId: row.user_id,
    clientName: row.client_name,
    modelId: row.model_id,
    modelName: row.model_name,
    summary: row.summary,
    details: row.details,
    createdAt: row.created_at,
    kind: row.kind,
    key: row.key,
    state: row.state,
    outcome: row.outcome,
    landing: row.landing,
  };
}

function toRow(item: PendingApproval): AssistantApprovalRow {
  return {
    id: item.id,
    user_id: item.userId,
    client_name: item.clientName,
    model_id: item.modelId,
    model_name: item.modelName,
    summary: item.summary,
    details: item.details,
    kind: item.kind,
    key: item.key,
    state: item.state,
    outcome: item.outcome,
    landing: item.landing,
    created_at: item.createdAt,
  };
}

export class ApprovalBook {
  private readonly listeners = new Set<(userId: string) => void>();
  /** Tool calls still waiting for an answer (in this process only). */
  private readonly waiters = new Map<string, (answer: "approved" | "declined") => void>();
  /** Requests the person approved while the assistant's call was still waiting: that call is applying them now. */
  private readonly applying = new Set<string>();
  private lander: Lander | null = null;

  constructor(private readonly db: Db) {}

  /** Told when someone's list changes (a live page refreshes). */
  onChange(listener: (userId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** How an approved edit lands after its call returned (the tool server sets it). */
  setLander(lander: Lander): void {
    this.lander = lander;
  }

  private changed(userId: string): void {
    for (const listener of this.listeners) listener(userId);
  }

  private prune(): void {
    const cutoff = Date.now() - APPROVAL_KEEP_MS;
    this.db.expireAssistantApprovals(cutoff, cutoff - APPROVAL_KEEP_MS, EXPIRED_WORDS);
  }

  private save(item: PendingApproval): PendingApproval {
    this.db.saveAssistantApproval(toRow(item));
    return item;
  }

  create(input: Pick<PendingApproval, "userId" | "clientName" | "modelId" | "modelName" | "summary" | "details" | "kind" | "key"> & { readonly landing?: unknown }): PendingApproval {
    this.prune();
    const item = this.save({ ...input, id: randomUUID(), createdAt: Date.now(), state: "waiting", outcome: null, landing: input.landing ?? null });
    this.changed(item.userId);
    return item;
  }

  /** What lands if the person approves after the call returned. */
  setLanding(item: PendingApproval, landing: unknown): PendingApproval {
    const now = this.get(item.userId, item.id);
    if (!now || now.state !== "waiting") return now ?? item;
    return this.save({ ...now, landing });
  }

  /** Newest first; only this person's. */
  of(userId: string): readonly PendingApproval[] {
    this.prune();
    return this.db.assistantApprovalsOf(userId).map(toItem);
  }

  /** What is waiting for this person's answer, oldest first. */
  waiting(userId: string): readonly WaitingApproval[] {
    return this.of(userId)
      .filter((i) => i.state === "waiting")
      .map(toWaiting)
      .reverse();
  }

  get(userId: string, id: string): PendingApproval | null {
    this.prune();
    const row = this.db.assistantApproval(id);
    return row && row.user_id === userId ? toItem(row) : null;
  }

  /** Waits for the person's answer; "timeout" leaves the request on the page. */
  wait(item: PendingApproval, ms: number, tick: (waitedMs: number) => void): Promise<"approved" | "declined" | "timeout"> {
    return new Promise((resolve) => {
      const started = Date.now();
      const ticker = setInterval(() => tick(Date.now() - started), PROGRESS_EVERY_MS);
      const timer = setTimeout(() => finish("timeout"), ms);
      const finish = (answer: "approved" | "declined" | "timeout") => {
        clearInterval(ticker);
        clearTimeout(timer);
        this.waiters.delete(item.id);
        resolve(answer);
      };
      this.waiters.set(item.id, (answer) => finish(answer));
    });
  }

  /** The person's answer from the page. Returns the item (with its outcome) or null when it isn't theirs. */
  async answer(userId: string, id: string, approve: boolean): Promise<PendingApproval | null> {
    const item = this.get(userId, id);
    if (!item) return null;
    if (item.state !== "waiting") return item;
    const waiter = this.waiters.get(id);
    let next: PendingApproval;
    if (!approve) {
      next = this.save({ ...item, state: "declined", outcome: "You declined it. Nothing changed.", landing: null });
      waiter?.("declined");
    } else if (waiter) {
      next = this.save({ ...item, state: "approved", outcome: "Approved. Your assistant is applying it now.", landing: null });
      this.applying.add(id);
      waiter("approved");
    } else if (item.landing !== null && this.lander) {
      // Marked first, so a second press while it lands doesn't land it twice.
      this.save({ ...item, state: "approved", outcome: "Approved. Applying it now." });
      try {
        const ended = await this.lander(item);
        next = this.save({ ...item, state: ended.applied ? "landed" : "failed", outcome: ended.words, landing: null });
      } catch (err) {
        console.error("[mutinybim-web] an approved change couldn't be applied", { id, err });
        next = this.save({ ...item, state: "failed", outcome: `Approved, but it couldn't be applied: ${err instanceof Error ? err.message : String(err)}. Nothing changed; ask your assistant again.`, landing: null });
      }
    } else {
      next = this.save({ ...item, state: "approved", outcome: "Approved. Tell your assistant to send it again; it lands then." });
    }
    this.changed(userId);
    return next;
  }

  /**
   * How it ended for a request the person approved while the assistant's call
   * was still waiting: applied, or not (with why). Without this the page would
   * say "applying it now" for good.
   */
  settle(userId: string, id: string, applied: boolean, outcome: string): void {
    if (!this.applying.delete(id)) return;
    const item = this.get(userId, id);
    if (!item || item.state !== "approved") return;
    this.save({ ...item, state: applied ? "landed" : "failed", outcome, landing: null });
    this.changed(userId);
  }

  /** A retry of a request the person already approved on the page: used once. */
  takeApprovedRetry(userId: string, key: string): boolean {
    for (const item of this.of(userId)) {
      // One the assistant's waiting call is applying right now is not a retry to take: it would land twice.
      if (item.kind === "retry" && item.key === key && item.state === "approved" && !this.applying.has(item.id)) {
        this.save({ ...item, state: "landed", outcome: "Approved and sent again by your assistant." });
        this.changed(userId);
        return true;
      }
    }
    return false;
  }

  /** A retry the person hasn't answered yet (so a second call doesn't add a second request). */
  waitingRetry(userId: string, key: string): PendingApproval | null {
    return this.of(userId).find((i) => i.kind === "retry" && i.key === key && i.state === "waiting") ?? null;
  }
}
