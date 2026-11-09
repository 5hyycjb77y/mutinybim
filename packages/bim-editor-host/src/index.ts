/**
 * The MutinyBIM editor host contract.
 *
 * The Building Model editor (`@permitzip/bim-editor`) never calls a host's
 * sign-in, router, server routes, storage or agent directly. It asks the
 * `EditorHost` it was given. A host implements this once:
 *
 * - An app that embeds the editor wraps its own sign-in, routes and storage.
 * - The open-source standalone app is one local person, the local model
 *   server, no built-in agent; outside AIs connect through the tool server.
 *
 * Types only: nothing here runs, and nothing here names a host. Optional
 * services (`storage`, `agent`) may be absent; the editor then shows a plain
 * "connect …" message where the feature would be, never an error.
 */
import type { EditorDataHost } from "./data";
import type { EditorShellHost } from "./shell";

export type * from "./data";
export type * from "./shell";

/** Who is editing. */
export interface EditorIdentity {
  readonly userId: string;
  /** What other people see in presence and on records. */
  readonly displayName: string;
  /**
   * The login system the host's people are named under on records: the id
   * written on new ones, its label, and earlier ids its stored records still
   * carry. Absent: "host".
   */
  readonly provider?: { readonly id: string; readonly label: string; readonly legacyIds?: readonly string[] };
}

/** A linked reference model the session loads beside the live model. */
export interface EditorReferenceInfo {
  readonly id: string;
  readonly label: string;
  readonly discipline: "architecture" | "mep";
  readonly bytes: number;
  readonly url: string;
  readonly ifcPlacement: number[][] | null;
  /** fixture = the project's test export (read-only); linked = linked through the panel. */
  readonly source?: "fixture" | "linked";
  /** Key for this reference's element parameters; absent when it has none to offer. */
  readonly parametersSource?: string;
}

/** What opening a model needs: its references and where its model server is. */
export interface EditorSessionConfig {
  readonly references: readonly EditorReferenceInfo[];
  /** Null when live editing is not available here (the editor says so and stays read-only). */
  readonly authority: { readonly url: string; readonly modelId: string } | null;
  /** The element parameters route; `<url>/unplaced` lists elements the IFC left out. */
  readonly revitParametersUrl?: string;
}

/** Opening the model and signing in to its model server. */
export interface EditorSessionHost {
  /**
   * The model's session config, optionally on a branch. Rejects with a message a person can act on.
   * `fresh`: a linked model just changed, so skip any cached copy.
   */
  openConfig(modelRef: string, options?: { readonly branch?: string | null; readonly signal?: AbortSignal; readonly fresh?: boolean }): Promise<EditorSessionConfig>;
  /** The token the model server accepts, or null when the person is signed out. */
  getAccessToken(): Promise<string | null>;
}

/** Where the editor is in the host's address bar. */
export interface EditorLocation {
  readonly pathname: string;
  /** Without the leading `?`. */
  readonly search: string;
}

export interface EditorNavigateOptions {
  /** False keeps the scroll position (default: the host's default). */
  readonly scroll?: boolean;
}

/** Moving within the editor's own page (branch, docked schedule): never leaves the editor. */
export interface EditorRouter {
  /** A React hook: re-renders when the location changes. */
  useLocation(): EditorLocation;
  push(href: string, options?: EditorNavigateOptions): void;
  replace(href: string, options?: EditorNavigateOptions): void;
}

/** Pages outside the editor the host may have. */
export type EditorDestination =
  | { readonly kind: "price_books" }
  | { readonly kind: "connect_source_model"; readonly modelRef: string }
  | { readonly kind: "model_home"; readonly modelRef: string };

export interface EditorLinks {
  /** The host's address for a destination, or null when it has no such page (the editor then shows words, not a link). */
  hrefFor(destination: EditorDestination): string | null;
}

export interface EditorNotifyAction {
  readonly label: string;
  readonly onClick: () => void;
}

export interface EditorNotifyOptions {
  readonly description?: string;
  readonly action?: EditorNotifyAction;
  /** Replaces an earlier message with the same id. */
  readonly id?: string | number;
}

/** Short messages that come and go (saved, couldn't save, …). */
export interface EditorNotifier {
  success(message: string, options?: EditorNotifyOptions): void;
  error(message: string, options?: EditorNotifyOptions): void;
  info(message: string, options?: EditorNotifyOptions): void;
  warning(message: string, options?: EditorNotifyOptions): void;
}

/** A JSON value a preference may hold. */
export type EditorPreferenceValue = string | number | boolean | null | readonly EditorPreferenceValue[] | { readonly [key: string]: EditorPreferenceValue };

/** A namespace's preferences as the editor sees them. */
export interface EditorPreferenceState<T extends Record<string, EditorPreferenceValue | undefined>> {
  /** The stored values merged over the defaults. */
  readonly values: T;
  /** False until the stored values have answered: a first-use hint waits for this, so it never flashes for someone who has seen it. */
  readonly loaded: boolean;
  /** Rejects when it could not be saved; the caller says so. */
  set<K extends keyof T & string>(key: K, value: T[K]): Promise<void>;
}

/** One person's editor preferences (first-use hints, layout), by namespace. Durable where the host can make them durable. */
export interface EditorPreferences {
  /** A React hook. `defaults` must be stable between renders (memoise it). */
  usePreferences<T extends Record<string, EditorPreferenceValue | undefined>>(namespace: string, defaults: T): EditorPreferenceState<T>;
}

/** Files the editor uploads or opens (underlays, backgrounds, linked models, PDFs). */
export interface EditorStorage {
  upload(file: Blob, options: { readonly modelRef: string; readonly purpose: string; readonly name: string }): Promise<{ readonly id: string; readonly url: string }>;
  urlFor(id: string): Promise<string>;
}

/**
 * A host's own agent, when it has one built in. Absent in hosts where outside
 * AIs connect through the tool server instead. The editor uses it to follow
 * the person's agent thread onto the branch that thread works on.
 */
export interface EditorAgentHost {
  /** The id of the person's own agent thread open on this model in this window, or null. Must return the same value until it changes. */
  ownThreadIdOn(modelRef: string): string | null;
  /** Called when the open thread changes. Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /**
   * Open the host's agent on a new thread filed under `modelRef` (null: none)
   * with `text` in its composer, not sent: the person reads, edits and sends
   * it. Absent: the host's agent can't take a drafted request, and the editor
   * says so in plain words instead.
   */
  seedComposer?(seed: { readonly text: string; readonly modelRef: string | null }): void;
}

/** What this host can do, for the editor's "connect …" messages. */
export interface EditorHostCapabilities {
  /** Plain name of the host, in messages ("this computer", the embedding app's name). */
  readonly hostName: string;
  /** Where a person connects storage or an AI, in words ("Settings › Integrations"); null when the host has no such place. */
  readonly connectHint: string | null;
}

/** Everything the editor asks of its host. */
export interface EditorHost {
  /** Server requests, one optional port per capability. */
  readonly data: EditorDataHost;
  /** The host's frame: settings layout, header slot, asset addresses. */
  readonly shell: EditorShellHost;
  readonly identity: EditorIdentity;
  readonly session: EditorSessionHost;
  readonly router: EditorRouter;
  readonly links: EditorLinks;
  readonly notify: EditorNotifier;
  readonly preferences: EditorPreferences;
  readonly storage?: EditorStorage;
  readonly agent?: EditorAgentHost;
  readonly capabilities: EditorHostCapabilities;
}

/** The optional services, by name, for "this needs …" messages. */
export type EditorOptionalService = "storage" | "agent";
