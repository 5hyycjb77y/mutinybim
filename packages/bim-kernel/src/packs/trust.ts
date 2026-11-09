/**
 * Trust in an outside add-on (D5, round 11 A11). Signatures say who made a
 * package, conformance says it is well formed, and review says the firm
 * accepts it: none of them certify engineering. An outside add-on is usable
 * on a model only once a person approved that exact version and build.
 *
 * The review states and the check shape are stored (a host keeps them per
 * installed package) and signed shapes read them later, so they are forever
 * after the release: tolerant readers, strict writers, open state names.
 */
import type { AuthorRef } from "../authorship/types";
import { isPackDigest, type OutsidePackPin, type PackDigest, type PackTier } from "./pin";

/** A person's name for a sentence; packs stay below authorship at runtime (types only). */
function personWords(who: AuthorRef): string {
  return who.displayName ?? who.subject;
}

/** One check's outcome. `not_run`: the host couldn't run it (said why); never read as passed. */
export type CheckStatus = "pass" | "fail" | "not_run" | (string & {});

export interface CheckResult {
  readonly status: CheckStatus;
  /** Every problem, in plain words, each with what to do about it where there is something. */
  readonly problems: readonly string[];
}

export const CHECK_PASSED: CheckResult = Object.freeze({ status: "pass", problems: Object.freeze([]) });

export function checkFailed(problems: readonly string[]): CheckResult {
  return { status: "fail", problems: [...problems] };
}

export function checkNotRun(reason: string): CheckResult {
  return { status: "not_run", problems: [reason] };
}

/**
 * Where an installed package stands. `pending`: installed, waiting for a
 * person. `approved`: usable. `rejected`: a person said no. `yanked`: the
 * catalogue withdrew the version; models that pin it keep working and say so.
 * `removed`: withdrawn as harmful; blocked everywhere and its uses flagged.
 */
export type ReviewState = "pending" | "approved" | "rejected" | "yanked" | "removed" | (string & {});

export const REVIEW_STATES = ["pending", "approved", "rejected", "yanked", "removed"] as const;

/** The checks a package went through before it waited for review. */
export interface InstallChecks {
  readonly signature: CheckResult;
  readonly licence: CheckResult;
  readonly conformance: CheckResult;
  /** A script package re-run and compared (SP11); absent for data add-ons. */
  readonly reproduction?: CheckResult;
}

/** One package version's review in one firm (D5 reserved shape). */
export interface InstallReview {
  readonly packageName: string;
  readonly version: string;
  readonly digest: PackDigest;
  readonly checks: InstallChecks;
  readonly state: ReviewState;
  /** The person who decided (approved, rejected), when one did. */
  readonly by?: AuthorRef;
  /** When the state last changed, ISO 8601. */
  readonly at?: string;
  /** Why (a rejection's reason, the catalogue's yank or removal note). */
  readonly reason?: string;
}

/** Whether every check passed: the only reviews a person may approve. */
export function checksPassed(checks: InstallChecks): boolean {
  const all = [checks.signature, checks.licence, checks.conformance, ...(checks.reproduction ? [checks.reproduction] : [])];
  return all.every((c) => c.status === "pass");
}

/** The problems of every check that didn't pass, prefixed with the check's name. */
export function checkProblems(checks: InstallChecks): readonly string[] {
  const named: [string, CheckResult | undefined][] = [
    ["Signature", checks.signature],
    ["Licence", checks.licence],
    ["Conformance", checks.conformance],
    ["Reproduction", checks.reproduction],
  ];
  return named.flatMap(([name, c]) => (c && c.status !== "pass" ? c.problems.map((p) => `${name}: ${p}`) : []));
}

/**
 * The one host setting for code add-ons (the product owner's question 8, pending; the
 * default is data only). `refuse`: a code add-on is refused at install with
 * the words below. `trusted_operator`: the operator of a standalone MutinyBIM
 * installs code add-ons as trusted software in its own process.
 */
export interface HostTrustPolicy {
  readonly codeTier: "refuse" | "trusted_operator";
}

export const DATA_ONLY_POLICY: HostTrustPolicy = Object.freeze({ codeTier: "refuse" });

export function codeTierRefusal(packageName: string, hostName: string): string {
  return `${packageName} runs code. ${hostName} installs data add-ons only (classes, parameter sets, tables, zone purposes); add-ons that run code aren't allowed here.`;
}

/** Whether `tier` may be installed under `policy`; the refusal in words when not. */
export function tierProblem(tier: PackTier, policy: HostTrustPolicy, packageName: string, hostName: string): string | null {
  if (tier === "data") return null;
  if (tier === "code") return policy.codeTier === "trusted_operator" ? null : codeTierRefusal(packageName, hostName);
  return `${packageName} asks for trust tier "${tier}", which this release doesn't know. Ask its publisher for a data version.`;
}

/** What a model may do with one pinned outside add-on. */
export type PackTrust =
  | { readonly use: "load"; readonly warnings: readonly string[] }
  | { readonly use: "block"; readonly reason: string };

/**
 * Whether a model that pins `pin` may load the firm's installed build
 * reviewed as `review`. Only an approved build with the same digest loads;
 * a yanked one loads with a warning; anything else is blocked, in words.
 */
export function packTrustOf(pin: Pick<OutsidePackPin, "id" | "version" | "digest">, review: InstallReview | null, name: string = pin.id): PackTrust {
  const label = `${name} ${pin.version}`;
  if (!review) return { use: "block", reason: `${label} isn't installed in this firm's library.` };
  if (review.digest !== pin.digest) return { use: "block", reason: `This model pinned a different build of ${label} than the one this firm installed. Ask whoever pinned it to send that build, or update the model to the installed one through update review.` };
  switch (review.state) {
    case "approved":
      return { use: "load", warnings: [] };
    case "yanked":
      return { use: "load", warnings: [`${label} was withdrawn by its catalogue${review.reason ? ` (${review.reason})` : ""}. This model keeps working with it; plan to move to a newer version through update review.`] };
    case "pending":
      return { use: "block", reason: `${label} is waiting for review. A person with library approval can approve it in Library › Packages.` };
    case "rejected":
      return { use: "block", reason: `${label} was rejected in review${review.reason ? `: ${review.reason}` : ""}.` };
    case "removed":
      return { use: "block", reason: `${label} was removed as unsafe${review.reason ? ` (${review.reason})` : ""}. Its rows on this model are kept but not used; review where it was used.` };
    default:
      return { use: "block", reason: `${label} is in review state "${review.state}", which this release doesn't know, so it isn't loaded.` };
  }
}

/** A person's or a catalogue's act on a review. */
export type ReviewAct =
  | { readonly kind: "approve"; readonly by: AuthorRef; readonly at: string }
  | { readonly kind: "reject"; readonly by: AuthorRef; readonly at: string; readonly reason: string }
  | { readonly kind: "yank"; readonly at: string; readonly reason?: string }
  | { readonly kind: "remove"; readonly at: string; readonly reason: string };

export class ReviewActError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewActError";
  }
}

/**
 * The review after `act`. Approve and reject are person-only acts on a
 * pending review; approve needs every check passed. A yank applies to an
 * approved or pending version; a removal applies to any. Throws in words.
 */
export function applyReviewAct(review: InstallReview, act: ReviewAct): InstallReview {
  const label = `${review.packageName} ${review.version}`;
  if (act.kind === "approve" || act.kind === "reject") {
    if (act.by.kind !== "person") {
      const person = act.by.onBehalfOf;
      throw new ReviewActError(`Only a person can ${act.kind} an add-on. ${person ? personWords(person) : "The person the agent works for"} does this in Library › Packages.`);
    }
    if (review.state !== "pending") throw new ReviewActError(`${label} is ${review.state}, not waiting for review.`);
    if (act.kind === "approve" && !checksPassed(review.checks)) throw new ReviewActError(`${label} can't be approved until its checks pass: ${checkProblems(review.checks).join("; ")}`);
    if (act.kind === "reject" && act.reason.trim() === "") throw new ReviewActError("Say why it is rejected.");
    return { ...review, state: act.kind === "approve" ? "approved" : "rejected", by: act.by, at: act.at, ...(act.kind === "reject" ? { reason: act.reason } : {}) };
  }
  if (act.kind === "yank") {
    if (review.state !== "approved" && review.state !== "pending") throw new ReviewActError(`${label} is ${review.state}; only an approved or pending version can be withdrawn.`);
    return { ...review, state: "yanked", at: act.at, ...(act.reason ? { reason: act.reason } : {}) };
  }
  if (act.reason.trim() === "") throw new ReviewActError("Say why it is removed.");
  return { ...review, state: "removed", at: act.at, reason: act.reason };
}

function readCheck(value: unknown): CheckResult {
  if (typeof value !== "object" || value === null) return checkNotRun("This check wasn't recorded.");
  const raw = value as Record<string, unknown>;
  const status = typeof raw.status === "string" && raw.status !== "" ? raw.status : "not_run";
  const problems = Array.isArray(raw.problems) ? raw.problems.filter((p): p is string => typeof p === "string") : [];
  return { status, problems };
}

/**
 * Tolerant reader for a stored review's checks: a missing or unreadable check
 * reads as `not_run` (never as passed), an unknown status is kept.
 */
export function readInstallChecks(value: unknown): InstallChecks {
  const raw = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  return {
    signature: readCheck(raw.signature),
    licence: readCheck(raw.licence),
    conformance: readCheck(raw.conformance),
    ...(raw.reproduction !== undefined ? { reproduction: readCheck(raw.reproduction) } : {}),
  };
}

/** Whether a stored digest is one this release can compare. */
export function isReviewDigest(value: unknown): value is PackDigest {
  return isPackDigest(value);
}
