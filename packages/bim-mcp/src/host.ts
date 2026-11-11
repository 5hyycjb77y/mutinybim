import type { AuthorRef, Command, ModelState, Registry } from "@permitzip/bim-kernel";
import type { PartTypeItem, ScriptItem } from "@permitzip/bim-library";
import type { ScriptRunRequest, ScriptRunResult } from "@permitzip/bim-script";
import type { AgentSession } from "@permitzip/bim-sync";
import type { ApprovalGate } from "./approvals";
import type { ScriptPreviewStore } from "./scripts/previews";

/**
 * What a host gives the MutinyBIM tool server. The tools are the same
 * everywhere; a host decides only these five things:
 *
 * - Identity: who is calling (`author`, `scope`).
 * - Authorization: may they do it. `models.withModel` checks the caller may
 *   read the model and `models.edit` that they may edit it, before any model
 *   server contact; `authorize` is asked before a script runs; the library
 *   says whether the caller may add to it (`firmWrite`).
 * - Approval: a person decides every edit and every library save
 *   (`approvals`).
 * - Script runner: where a script runs (`runner`). Never in the process
 *   serving the tools.
 * - Model server: how the tools reach the model (`models`).
 *
 * And, optionally, where scripts are kept between calls (`previews`).
 *
 * The open local host (`createLocalHost`) is one person on their own
 * computer. A hosted product supplies its own sign-in, permissions, approval
 * cards and sealed script machines through the same interface.
 */

export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

/** A command built against the model the edit will land on, or the refusal in words. */
export type BuiltCommand =
  | { readonly ok: true; readonly command: Command }
  /** `code` / `elementIds`: the kernel rule the refusal comes from, when there is one. */
  | { readonly ok: false; readonly message: string; readonly code?: string; readonly elementIds?: readonly string[] };

// db-shape: MCP tool arguments (which model to open), not a database row
export type ModelArgs = { project_id: string; model_id: string; level?: string; zone?: string; base_revision?: number };

export interface ModelAccess {
  /** The model as the caller reads it (the host checks read access first); the session closes after `work`. */
  withModel<T>(extra: unknown, args: ModelArgs, work: (session: AgentSession) => Promise<T>): Promise<T>;
  /**
   * The model loaded with the area an agent named (`level` by id or a loose
   * name; refused, with the candidates, when it names no level): `work` gets
   * the level's canonical name.
   */
  withArea<T>(extra: unknown, args: ModelArgs, work: (session: AgentSession, level: string | undefined) => Promise<T>): Promise<T | ToolResult>;
  /**
   * Send a built command through the model server as the caller (the host
   * checks edit access first). `editArgs` with the run, model and base
   * revision make the idempotency key, so a retried call lands once.
   */
  edit(tool: string, extra: unknown, args: ModelArgs, editArgs: unknown, build: (model: ModelState, key: string) => BuiltCommand): Promise<ToolResult>;
}

export interface ScriptRunScope {
  /** The agent thread the run belongs to: a host keeps one script machine per thread. */
  readonly conversationId: string;
  readonly projectId: string;
}

/** Whether scripts can run here at all, in words when not (asked before an agent writes one). */
export type ScriptRunnerAvailability = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** Runs scripts somewhere other than this process; whatever calls it only orchestrates. */
export interface ScriptRunnerHost {
  run(request: ScriptRunRequest, scope: ScriptRunScope): Promise<ScriptRunResult>;
  availability(): Promise<ScriptRunnerAvailability>;
}

/** One person's approval of one script version for reuse by other agents and people. */
export interface ScriptApproval {
  readonly libraryItemId: string;
  readonly revisionHash: string;
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly revokedBy: string | null;
  readonly revokedAt: string | null;
  readonly reason: string | null;
}

/** Library approvals for script versions (people only; an agent reads them, never approves). */
export interface ScriptApprovalStore {
  /** The approval in force for this version, or null when none (or revoked). */
  approvalOf(libraryItemId: string, revisionHash: string): Promise<ScriptApproval | null>;
  approve(libraryItemId: string, revisionHash: string, reason: string | null): Promise<ScriptApproval>;
  revoke(libraryItemId: string, revisionHash: string, reason: string): Promise<ScriptApproval>;
}

export interface StoredScriptItem {
  readonly scope: string;
  readonly body: ScriptItem;
}

export interface StoredPartTypeItem {
  readonly scope: string;
  readonly body: PartTypeItem;
}

/** One save of a script or a script's part type: written (and why), already the same, or refused in words. */
export type LibrarySaveResult =
  | { readonly status: "saved"; readonly summary: { readonly revision: number }; readonly because: readonly string[] }
  | { readonly status: "up_to_date"; readonly id: string; readonly revision: number }
  | { readonly status: "refused"; readonly code: string; readonly message: string };

/** The library the script tools read and save to, as the caller sees it. */
export interface ScriptLibrary {
  readonly callerId: string;
  /** Whether the caller may add to the library, and the words when not. */
  readonly firmWrite: { readonly allowed: true } | { readonly allowed: false; readonly reason: string };
  scripts(): Promise<readonly StoredScriptItem[]>;
  partTypes(): Promise<readonly StoredPartTypeItem[]>;
  saveScript(scope: string, script: ScriptItem): Promise<LibrarySaveResult>;
  savePartTypesFromRun(scope: string, items: readonly PartTypeItem[]): Promise<readonly LibrarySaveResult[]>;
  readonly approvals: Pick<ScriptApprovalStore, "approvalOf">;
}

export type AuthorizeAnswer = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** Actions a host is asked about that no model session or library already decides. */
export interface AuthorizeAsk {
  readonly action: "script.run";
  readonly projectId: string;
}

/** What the script tools need from a host. */
export interface ScriptToolHost {
  readonly withModel: ModelAccess["withModel"];
  readonly edit: ModelAccess["edit"];
  runner(extra: unknown): ScriptRunnerHost;
  scope(extra: unknown, projectId: string): ScriptRunScope;
  library(extra: unknown): Promise<ScriptLibrary>;
  /** Who asks for the run: the agent, on behalf of the person. */
  author(extra: unknown, callerId: string): AuthorRef;
  /** Asked right before a script runs. */
  authorize(extra: unknown, ask: AuthorizeAsk): Promise<AuthorizeAnswer>;
  readonly approvals: ApprovalGate;
  /**
   * Where scripts are kept between calls (scripts/previews.ts), so an agent
   * sends a script once and lands a preview by its id. A hosted product
   * returns a store that outlives a restart and its longest approval wait;
   * one person's computer uses `MemoryScriptPreviewStore`. Absent: nothing
   * is kept, and a preview returns the whole script in apply_with.args.
   */
  previews?(extra: unknown): ScriptPreviewStore;
  /** Loads the part geometry engine for part pictures (default: the open engine). */
  drawingEngine?(): Promise<void>;
  now?(): Date;
}

/** A host's requirements graph (code studies and the like), bound while a read asks "why is this here?". */
export interface RequirementsBinding {
  /** Why the answer leaves the host's requirements out, or null. */
  readonly note: string | null;
  withBound<T>(model: ModelState, ask: () => T): T;
}

/** Optional facts a host adds to the core reads. Absent: the open defaults. */
export interface ReadExtensions {
  /** The words a questions email names the project with; default "this project". */
  projectLabel?(extra: unknown, projectId: string): Promise<string>;
  /** The class registry `class` filters read; default the kernel's built-in registry. */
  classRegistry?(extra: unknown, projectId: string): Promise<{ readonly registry: Registry; readonly warning?: string }>;
  /** The host's requirements, bound while `why` / `if_removed` ask; default the model's own. */
  requirements?(extra: unknown, projectId: string): Promise<RequirementsBinding>;
}

/** What the read tools need from a host. */
export interface ReadToolHost {
  readonly withArea: ModelAccess["withArea"];
  readonly reads?: ReadExtensions;
}

/** Everything the core pack needs: one object a host builds once. */
export interface BimToolHost extends ScriptToolHost, ReadToolHost {}
