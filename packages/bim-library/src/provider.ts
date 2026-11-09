import type { LibraryItem, LibraryItemType } from "./schema";

/**
 * The extension point a host implements to store and share libraries
 * (SCHEDULES-PLAN §3b; contract in PROVIDER.md, checked by
 * `runProviderConformance`). MutinyBIM ships `FileLibraryProvider`; a host app
 * implements its own over its database and permissions. A provider stores,
 * lists and permissions items. It never evaluates them: models evaluate the
 * pinned copies they hold, so drawing a schedule never calls a provider.
 */

export type LibraryScopeKind = "builtin" | "firm" | "project" | "file";

export interface LibraryScope {
  /** Stable within the provider, e.g. `builtin`, `firm:permitzip`, `project:7301`. */
  readonly id: string;
  readonly kind: LibraryScopeKind;
  /** As a person sees it: "Built-in", "PermitZIP", "7301 Demo Site". */
  readonly name: string;
}

export interface LibraryItemSummary {
  readonly id: string;
  readonly type: LibraryItemType;
  readonly key: string;
  readonly name: string;
  readonly revision: number;
  readonly contentHash: string;
  readonly scope: string;
  readonly deprecated: boolean;
}

/** A stored item: its content plus where it lives. `body.contentHash` is always set. */
export type StoredLibraryItem = LibraryItem & { readonly scope: string };

export interface LibraryQuery {
  readonly type?: LibraryItemType;
  /** Case-insensitive match on key or name. */
  readonly text?: string;
  /** Absent: false. */
  readonly includeDeprecated?: boolean;
}

export interface ScopeCapabilities {
  readonly read: boolean;
  readonly publish: boolean;
  /** Why something is not allowed, in words a person can act on. */
  readonly reason?: string;
}

/** A plain-words problem with one item or field. */
export interface LibraryProblem {
  /** The item it concerns (absent: the bundle as a whole). */
  readonly itemId?: string;
  readonly itemKey?: string;
  readonly itemType?: LibraryItemType;
  /** Line in the source text, when it came from one. */
  readonly line?: number;
  readonly message: string;
}

export type PublishResult =
  | { readonly ok: true; readonly summary: LibraryItemSummary }
  | {
      readonly ok: false;
      /** `conflict`: someone published since `baseRevision`; `invalid`: the item failed validation; `forbidden` / `read_only`: no publish here. */
      readonly code: "conflict" | "invalid" | "forbidden" | "read_only";
      readonly message: string;
      readonly problems?: readonly LibraryProblem[];
      /** On conflict: the revision now stored. */
      readonly currentRevision?: number;
    };

export type Unsubscribe = () => void;

export interface LibraryChange {
  readonly scope: string;
  readonly summary: LibraryItemSummary;
}

export interface LibraryProvider {
  /** In precedence order: an item id found in an earlier scope wins. */
  scopes(): Promise<readonly LibraryScope[]>;
  list(scope: string, query?: LibraryQuery): Promise<readonly LibraryItemSummary[]>;
  /** The item from the first scope that has it; a past revision when asked. Throws `LibraryError` "not_found". */
  get(id: string, revision?: number): Promise<StoredLibraryItem>;
  /**
   * Publishes a new revision. `baseRevision` is the revision the edit started
   * from (0 for a new item); anything else stored means a conflict. Absent
   * on a read-only provider.
   */
  publish?(scope: string, item: LibraryItem, baseRevision: number): Promise<PublishResult>;
  capabilities(scope: string): Promise<ScopeCapabilities>;
  watch?(scope: string, onChange: (change: LibraryChange) => void): Unsubscribe;
}

export type LibraryErrorCode = "not_found" | "unknown_scope" | "invalid" | "unavailable";

export class LibraryError extends Error {
  readonly code: LibraryErrorCode;
  readonly problems: readonly LibraryProblem[];
  constructor(code: LibraryErrorCode, message: string, problems: readonly LibraryProblem[] = []) {
    super(message);
    this.name = "LibraryError";
    this.code = code;
    this.problems = problems;
  }
}
