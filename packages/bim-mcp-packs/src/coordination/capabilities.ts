import type { BranchRef, LinkedSurfaceSource, ModelState } from "@permitzip/bim-kernel";
import type { LinkedModelIndex, LintConfig, LintEngine } from "@permitzip/bim-lint";
import type { AgentSession } from "@permitzip/bim-sync";
import type { Extra } from "../runtime";

/**
 * The host services the coordination tools need beyond the caller: where the
 * lint keeps its settings and accepted findings, the lint engines and this
 * thread's recent edits, the status pictures, the project's linked models as
 * surfaces, and branches (start one, propose its merge).
 */

// ---------------------------------------------------------------------------
// The coordination lint's durable state

export interface LintAcceptance {
  readonly findingId: string;
  readonly rule: string;
  readonly reason: string;
  readonly acceptedBy: string;
  readonly acceptedAt: string;
}

export interface LintRetraction extends LintAcceptance {
  readonly retractedBy: string;
  readonly retractedAt: string;
  readonly retractReason: string;
}

/**
 * How much of the project's linked models the lint saw. complete: all of
 * them. none: the project links none. indexing: still being read, so clashes
 * with them are missing (re-run). incomplete: some couldn't be read.
 */
export type LinkedCoverage = "complete" | "none" | "indexing" | "incomplete";

export interface LinkedForLint {
  readonly models: readonly LinkedModelIndex[];
  readonly note: string | null;
  readonly coverage: LinkedCoverage;
  /** Linked models the project has; null when unknown (their list couldn't be read yet). */
  readonly expected: number | null;
}

export interface LinkedReadOptions {
  /** An explicit check waits up to this long for linked models still being indexed; absent: never waits (the lint on a saved edit). */
  readonly waitMs?: number;
}

export interface BimLintStores {
  /** The thread's settings, else the person's own for this model, else the defaults. */
  settings(extra: unknown, projectId: string, modelId: string): Promise<LintConfig>;
  /** Saves for this agent thread (or the person's own when `scope` is "person"); null clears back to the fallback. */
  saveSettings(extra: unknown, projectId: string, modelId: string, config: LintConfig | null, scope: "thread" | "person"): Promise<void>;
  acceptedIds(extra: unknown, projectId: string, modelId: string): Promise<ReadonlySet<string>>;
  acceptances(extra: unknown, projectId: string, modelId: string): Promise<LintAcceptance[]>;
  accept(extra: unknown, projectId: string, modelId: string, a: { findingId: string; rule: string; reason: string }): Promise<LintAcceptance>;
  /** Retracts an active acceptance: the finding shows again; who, when and why are kept. */
  retract(extra: unknown, projectId: string, modelId: string, r: { findingId: string; reason: string }): Promise<LintRetraction>;
  linked(extra: unknown, projectId: string, opts?: LinkedReadOptions): Promise<LinkedForLint>;
  projectName(extra: unknown, projectId: string): Promise<string | null>;
  /** True when this agent thread's model reads images. Absent or unknown: no automatic pictures. */
  seesImages?(extra: unknown, projectId: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// The lint engines and this thread's edits

/** One saved edit this thread made, newest last in a list. */
export interface RecentEdit {
  readonly tool: string;
  readonly revision: number;
  readonly changed: readonly string[];
  readonly at: string;
}

/** The lint engines a host keeps warm per model, and the edits it saw this thread save. */
export interface LintEngines {
  /** The engine for an explicit check (bim_lint_check, the status snapshot): built now whatever the model's size. */
  engineForCheck(cacheKey: string, model: ModelState, linked: readonly LinkedModelIndex[]): LintEngine;
  /** This thread's last saved edits on a model (newest last); empty when the host keeps no edit log. */
  recentEdits(extra: unknown, modelId: string): readonly RecentEdit[];
  /** How often an automatic picture rides a saved edit: after this many edits, or this many milliseconds. */
  readonly autoPicture: { readonly everyEdits: number; readonly everyMs: number };
}

/** A small status picture: what it shows, and the PNG when one was drawn. */
export interface StatusPicture {
  readonly meta: unknown;
  readonly image?: Buffer;
}

/** Up to `max` small pictures of the model: the last-edited plan, a sheet, a 3D view, or the views and sheets named. */
export type StatusPictures = (model: ModelState, recentChanged: readonly string[], max: number, ask: { readonly views?: readonly string[]; readonly sheets?: readonly string[] }) => Promise<readonly StatusPicture[]>;

/** Everything the lint tools need from their host beyond the caller. */
export interface LintToolsHost {
  readonly stores: BimLintStores;
  readonly engines: LintEngines;
  readonly pictures: StatusPictures;
}

// ---------------------------------------------------------------------------
// Linked models as surfaces

/** The project's linked models as surface sources, with a note in words when they couldn't all be read. Throws when none could be read. */
export type LinkedSurfaceSources = (extra: Extra, projectId: string) => Promise<{ readonly sources: readonly LinkedSurfaceSource[]; readonly note: string | null }>;

// ---------------------------------------------------------------------------
// Branches

export type AgentBranchResult =
  | { readonly status: "started"; readonly branch: BranchRef; readonly thread: "switched" | "no_thread" | "not_switched"; readonly message: string }
  | { readonly status: "proposed"; readonly proposalId: string; readonly message: string }
  | { readonly status: "refused"; readonly message: string };

/** The branch actions open to one caller, behind the person's Approve. */
export interface CallerBranchActions {
  /** Start a branch from Main (the session is on Main), then point this thread at it. */
  start(input: { readonly session: AgentSession; readonly name: string; readonly fromVersion?: number }): Promise<AgentBranchResult>;
  /** Propose this thread's branch to Main; people approve it. */
  proposeMerge(input: { readonly session: AgentSession; readonly userId: string }): Promise<AgentBranchResult>;
}

/** The branch actions for a caller on a project (resolved after the caller's own checks; throws when they can't be). */
export type BranchActions = (extra: Extra, projectId: string) => Promise<CallerBranchActions>;
