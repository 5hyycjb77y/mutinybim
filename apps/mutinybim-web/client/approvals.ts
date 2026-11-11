/**
 * What an outside assistant is waiting for this person to approve, read from
 * this app (the signed-in person's own requests only), and their answer sent
 * back. The editor page shows it above the model, so nobody has to go and
 * look on the Approvals page.
 */

export interface WaitingApproval {
  readonly id: string;
  readonly assistant: string;
  /** Empty when the change is to the person's script library, not a model. */
  readonly modelId: string;
  readonly modelName: string;
  readonly title: string;
  readonly href: string;
}

export type ApprovalAnswer = "approve" | "decline";

/** A problem the person can read and act on. */
export class ApprovalsError extends Error {
  constructor(
    message: string,
    readonly signedOut = false,
  ) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toWaiting(value: unknown): WaitingApproval | null {
  if (!isRecord(value)) return null;
  const { id, assistant, modelId, modelName, title, href } = value;
  if (typeof id !== "string" || typeof assistant !== "string" || typeof modelId !== "string" || typeof modelName !== "string" || typeof title !== "string" || typeof href !== "string") return null;
  return { id, assistant, modelId, modelName, title, href };
}

const SIGNED_OUT = "You are signed out, so approval requests can't be shown. Log in again.";

export async function fetchWaitingApprovals(signal?: AbortSignal): Promise<readonly WaitingApproval[]> {
  const response = await fetch("/api/hosted/approvals/waiting", { credentials: "same-origin", headers: { accept: "application/json" }, ...(signal ? { signal } : {}) });
  if (response.status === 401) throw new ApprovalsError(SIGNED_OUT, true);
  if (!response.ok) throw new ApprovalsError(`Checking for approval requests failed (the server answered ${response.status}). Open Approvals to see what is waiting.`);
  const body: unknown = await response.json();
  if (!isRecord(body) || !Array.isArray(body.waiting)) throw new ApprovalsError("Checking for approval requests failed (the server's answer wasn't a list). Open Approvals to see what is waiting.");
  const list: readonly unknown[] = body.waiting;
  return list.flatMap((w) => toWaiting(w) ?? []);
}

/** Sends the person's answer; the words say what happened (applied, declined, or why not). */
export async function answerApproval(id: string, answer: ApprovalAnswer): Promise<{ readonly ok: boolean; readonly words: string }> {
  const response = await fetch(`/approvals/${encodeURIComponent(id)}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ decision: answer }).toString(),
  });
  if (response.status === 401) throw new ApprovalsError("You are signed out, so your answer wasn't sent. Log in again, then answer on Approvals.", true);
  const body: unknown = (response.headers.get("content-type") ?? "").includes("application/json") ? await response.json() : null;
  if (!response.ok) {
    throw new ApprovalsError(isRecord(body) && typeof body.error === "string" ? body.error : `Your answer wasn't accepted (the server answered ${response.status}). Nothing changed; answer it on Approvals instead.`);
  }
  const state = isRecord(body) && typeof body.state === "string" ? body.state : "";
  const outcome = isRecord(body) && typeof body.outcome === "string" ? body.outcome : "";
  return { ok: state !== "failed" && state !== "expired", words: outcome || (answer === "approve" ? "Approved." : "Declined. Nothing changed.") };
}
