import { builtinRegistry, type Registry } from "@permitzip/bim-kernel";
import { withContentHash } from "./hash";
import { LAYER_KINDS, resolveLayers, type LayerKind, type LibraryLayer, type ResolvedLibrary } from "./layering";
import {
  LibraryError,
  type LibraryChange,
  type LibraryItemSummary,
  type LibraryProblem,
  type LibraryProvider,
  type LibraryQuery,
  type LibraryScope,
  type PublishResult,
  type ScopeCapabilities,
  type StoredLibraryItem,
  type Unsubscribe,
} from "./provider";
import { LIBRARY_FORMAT, LIBRARY_FORMAT_VERSION, makeItem, parseItem, type LibraryBundle, type LibraryItem } from "./schema";
import { bundleItems, bundleWithItems, loadBundle, locateIn, parseBundle, type LibraryEnvironment } from "./validate";

/**
 * The provider standalone MutinyBIM runs on: libraries as `.mutinylib.json`
 * files, from disk, a folder, a URL or memory. Every source is one scope, in
 * precedence order. Each is validated whole on load (a bad file refuses the
 * provider, never half-loads). A scope is read-only unless it is a file or
 * folder the file system can write, or an in-memory bundle marked writable.
 */

export const LIBRARY_FILE_SUFFIX = ".mutinylib.json";

export interface LibraryFileSystem {
  readText(path: string): Promise<string>;
  /** File names (not paths) in a folder. */
  listDir(path: string): Promise<readonly string[]>;
  /** Absent: every file source is read-only. */
  writeText?(path: string, text: string): Promise<void>;
  /** Whether a file (or, for a file that doesn't exist yet, its folder) can be written. Absent: when `writeText` exists. */
  canWrite?(path: string): Promise<boolean>;
}

export type FileLibrarySource =
  | { readonly scope: LibraryScope; readonly kind: "bundle"; readonly bundle: unknown; readonly writable?: boolean }
  | { readonly scope: LibraryScope; readonly kind: "file"; readonly path: string }
  | { readonly scope: LibraryScope; readonly kind: "folder"; readonly path: string }
  | { readonly scope: LibraryScope; readonly kind: "url"; readonly url: string };

export interface FetchLike {
  (url: string): Promise<{ readonly ok: boolean; readonly status: number; text(): Promise<string> }>;
}

export interface FileLibraryProviderOptions {
  /** In precedence order: the first scope holding an id wins. */
  readonly sources: readonly FileLibrarySource[];
  readonly env: Omit<LibraryEnvironment, "lower" | "registry"> & { readonly registry?: Registry };
  readonly fs?: LibraryFileSystem;
  readonly fetch?: FetchLike;
}

interface LoadedFile {
  /** Absent: held in memory only. */
  readonly path?: string;
  /** The text it was read from, for line numbers; dropped once the file is rewritten. */
  text?: string;
  header: LibraryBundle;
  items: LibraryItem[];
}

interface ScopeState {
  readonly source: FileLibrarySource;
  readonly files: LoadedFile[];
  readonly writable: boolean;
  readonly readOnlyReason?: string;
}

/**
 * Read-only bundle layers (the built-in libraries) checked once per input:
 * the same bundle object over the same registry and checkers gives the same
 * items and registry, so a provider rebuilt for every request doesn't re-check
 * thousands of built-in items. Writable and file-backed layers are always
 * checked afresh.
 */
const ABSENT: object = {};
type CheckedLayer = { readonly items: readonly LibraryItem[]; readonly registry: Registry };
const checkedLayers = new WeakMap<object, unknown>();
function layerCacheSlot(keys: readonly object[]): { get(): CheckedLayer | undefined; set(v: CheckedLayer): void } {
  let map = checkedLayers;
  for (const key of keys.slice(0, -1)) {
    let next = map.get(key) as WeakMap<object, unknown> | undefined;
    if (!next) {
      next = new WeakMap<object, unknown>();
      map.set(key, next);
    }
    map = next;
  }
  const last = keys[keys.length - 1] as object;
  return { get: () => map.get(last) as CheckedLayer | undefined, set: (v) => void map.set(last, v) };
}

/** The checked items that are this file's own, in checked order. */
function ownItems(checked: readonly LibraryItem[], own: readonly LibraryItem[]): LibraryItem[] {
  const ids = new Set(own.map((it) => it.body.id));
  return checked.filter((it) => ids.has(it.body.id));
}

/** Read-only bundle sources parsed once per bundle object. */
const parsedBundles = new WeakMap<object, { readonly header: LibraryBundle; readonly items: readonly LibraryItem[] }>();

function layerKindOf(kind: LibraryScope["kind"]): LayerKind {
  return kind === "file" ? "firm" : kind;
}

function joinPath(folder: string, name: string): string {
  return folder.endsWith("/") ? `${folder}${name}` : `${folder}/${name}`;
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "library";
}

function emptyHeader(scope: LibraryScope): LibraryBundle {
  return {
    format: LIBRARY_FORMAT,
    version: LIBRARY_FORMAT_VERSION,
    id: `${slug(scope.id)}-published`,
    name: scope.name,
    publisher: scope.name,
    revision: 1,
    units: [],
    classes: [],
    fields: [],
    formulas: [],
    relationships: [],
    scheduleTemplates: [],
    tagTypes: [],
    disciplines: [],
    partTypes: [],
    scripts: [],
    designLimits: [],
    lookupTables: [],
    elementTypes: [],
    titleBlocks: [],
    keynoteTables: [],
  };
}

function summaryOf(item: LibraryItem, scope: string): LibraryItemSummary {
  const body = item.body;
  const name = "name" in body ? body.name : body.label;
  return { id: body.id, type: item.type, key: body.key, name, revision: body.revision, contentHash: body.contentHash ?? "", scope, deprecated: body.deprecated ?? false };
}

function stored(item: LibraryItem, scope: string): StoredLibraryItem {
  return { ...item, scope };
}

function problemsText(problems: readonly LibraryProblem[]): string {
  return problems.map((p) => (p.line === undefined ? p.message : `Line ${p.line}: ${p.message}`)).join("\n");
}

export class FileLibraryProvider implements LibraryProvider {
  private readonly opts: FileLibraryProviderOptions;
  private states: ScopeState[] = [];
  private ready: Promise<void> | undefined;
  private readonly history = new Map<string, Map<number, StoredLibraryItem>>();
  private readonly watchers = new Map<string, Set<(change: LibraryChange) => void>>();
  private resolvedCache: { resolved: ResolvedLibrary; registry: Registry } | undefined;

  constructor(opts: FileLibraryProviderOptions) {
    const ids = new Set<string>();
    let rank = 0;
    for (const s of opts.sources) {
      if (ids.has(s.scope.id)) throw new LibraryError("invalid", `Two library sources use the scope id ${s.scope.id}.`);
      ids.add(s.scope.id);
      const r = LAYER_KINDS.indexOf(layerKindOf(s.scope.kind));
      if (r < rank) throw new LibraryError("invalid", `List library sources project first, then firm, then built in: ${s.scope.name} is out of order.`);
      rank = r;
    }
    this.opts = opts;
  }

  /** Loads every source now; calls do this on first use. Throws `LibraryError` naming each problem. */
  load(): Promise<void> {
    this.ready ??= this.loadAll().catch((err: unknown) => {
      this.ready = undefined;
      throw err;
    });
    return this.ready;
  }

  async scopes(): Promise<readonly LibraryScope[]> {
    await this.load();
    return this.states.map((s) => s.source.scope);
  }

  async list(scope: string, query: LibraryQuery = {}): Promise<readonly LibraryItemSummary[]> {
    const state = await this.scope(scope);
    const text = query.text?.trim().toLowerCase();
    const out: LibraryItemSummary[] = [];
    for (const file of state.files) {
      for (const item of file.items) {
        if (query.type !== undefined && item.type !== query.type) continue;
        if (!query.includeDeprecated && item.body.deprecated) continue;
        const summary = summaryOf(item, scope);
        if (text && !summary.key.toLowerCase().includes(text) && !summary.name.toLowerCase().includes(text)) continue;
        out.push(summary);
      }
    }
    return out;
  }

  async get(id: string, revision?: number): Promise<StoredLibraryItem> {
    await this.load();
    if (revision !== undefined) {
      const past = this.history.get(id)?.get(revision);
      if (past) return past;
      throw new LibraryError("not_found", `There is no revision ${revision} of library item ${id}.`);
    }
    for (const state of this.states) {
      for (const file of state.files) {
        const item = file.items.find((i) => i.body.id === id);
        if (item) return stored(item, state.source.scope.id);
      }
    }
    throw new LibraryError("not_found", `There is no library item ${id}.`);
  }

  async capabilities(scope: string): Promise<ScopeCapabilities> {
    const state = await this.scope(scope);
    return state.writable ? { read: true, publish: true } : { read: true, publish: false, reason: state.readOnlyReason ?? `${state.source.scope.name} is read-only.` };
  }

  async publish(scope: string, item: LibraryItem, baseRevision: number): Promise<PublishResult> {
    const state = await this.scope(scope);
    if (!state.writable) return { ok: false, code: "read_only", message: state.readOnlyReason ?? `${state.source.scope.name} is read-only.` };
    const parsed = parseItem(item);
    if (!parsed.ok) {
      return { ok: false, code: "invalid", message: `The ${item.type.replace(/_/g, " ")} isn't valid: ${parsed.issues.map((i) => `${i.path.join(".") || "item"} ${i.message}`).join("; ")}.` };
    }
    const id = parsed.item.body.id;
    const holder = state.files.find((f) => f.items.some((i) => i.body.id === id));
    const current = holder?.items.find((i) => i.body.id === id);
    const currentRevision = current?.body.revision ?? 0;
    if (current && current.type !== parsed.item.type) {
      return { ok: false, code: "invalid", message: `Item ${id} is a ${current.type.replace(/_/g, " ")} here; it can't be published as a ${parsed.item.type.replace(/_/g, " ")}.` };
    }
    if (baseRevision !== currentRevision) {
      return {
        ok: false,
        code: "conflict",
        currentRevision,
        message: currentRevision === 0 ? `Item ${id} is not in ${state.source.scope.name} yet, so publish it from revision 0.` : `${parsed.item.body.key} was changed to revision ${currentRevision} since you started from revision ${baseRevision}. Review the newer version first.`,
      };
    }
    const next = withContentHash(makeItem(parsed.item.type, { ...parsed.item.body, revision: currentRevision + 1 }));
    const target = holder ?? this.publishTarget(state);
    const before = { header: target.header, items: target.items };
    const beforeText = target.text;
    target.items = holder ? target.items.map((i) => (i.body.id === id ? next : i)) : [...target.items, next];
    delete target.text;
    target.header = { ...target.header, revision: target.header.revision + 1 };
    if (!state.files.includes(target)) state.files.push(target);
    const problems = this.validateAll();
    if (problems.length > 0) {
      target.header = before.header;
      target.items = before.items;
      if (beforeText !== undefined) target.text = beforeText;
      if (target.items.length === 0 && !holder) state.files.splice(state.files.indexOf(target), 1);
      this.validateAll();
      return { ok: false, code: "invalid", message: `Not published: ${problemsText(problems)}`, problems };
    }
    if (target.path !== undefined && this.opts.fs?.writeText) {
      await this.opts.fs.writeText(target.path, `${JSON.stringify(bundleWithItems(target.header, target.items), null, 2)}\n`);
    }
    this.remember(next, scope);
    const summary = summaryOf(next, scope);
    for (const notify of this.watchers.get(scope) ?? []) notify({ scope, summary });
    return { ok: true, summary };
  }

  watch(scope: string, onChange: (change: LibraryChange) => void): Unsubscribe {
    let set = this.watchers.get(scope);
    if (!set) {
      set = new Set();
      this.watchers.set(scope, set);
    }
    set.add(onChange);
    return () => {
      set?.delete(onChange);
    };
  }

  /** A scope as one bundle (every file merged), ready to save or hand to another host. */
  async exportScope(scope: string): Promise<string> {
    const state = await this.scope(scope);
    const items = state.files.flatMap((f) => f.items);
    const first = state.files[0]?.header ?? emptyHeader(state.source.scope);
    const header: LibraryBundle = { ...first, id: slug(state.source.scope.id), name: state.source.scope.name };
    return `${JSON.stringify(bundleWithItems(header, items), null, 2)}\n`;
  }

  /** Every scope resolved together and the registry it produces: what a model being drawn with these libraries reads. */
  async resolved(): Promise<{ readonly resolved: ResolvedLibrary; readonly registry: Registry }> {
    await this.load();
    if (!this.resolvedCache) throw new LibraryError("unavailable", "The library has not finished loading.");
    return this.resolvedCache;
  }

  private async scope(id: string): Promise<ScopeState> {
    await this.load();
    const state = this.states.find((s) => s.source.scope.id === id);
    if (!state) throw new LibraryError("unknown_scope", `There is no library scope ${id}.`);
    return state;
  }

  private publishTarget(state: ScopeState): LoadedFile {
    const src = state.source;
    if (src.kind === "folder") {
      const path = joinPath(src.path, `${slug(src.scope.id)}-published${LIBRARY_FILE_SUFFIX}`);
      return state.files.find((f) => f.path === path) ?? { path, header: emptyHeader(src.scope), items: [] };
    }
    const only = state.files[0];
    if (only) return only;
    return { ...(src.kind === "file" ? { path: src.path } : {}), header: emptyHeader(src.scope), items: [] };
  }

  private remember(item: LibraryItem, scope: string): void {
    let revs = this.history.get(item.body.id);
    if (!revs) {
      revs = new Map();
      this.history.set(item.body.id, revs);
    }
    if (!revs.has(item.body.revision)) revs.set(item.body.revision, stored(item, scope));
  }

  private async loadAll(): Promise<void> {
    const states: ScopeState[] = [];
    const problems: LibraryProblem[] = [];
    for (const source of this.opts.sources) {
      try {
        states.push(await this.readSource(source, problems));
      } catch (err) {
        if (err instanceof LibraryError) {
          problems.push(...(err.problems.length > 0 ? err.problems : [{ message: err.message }]));
          continue;
        }
        throw err;
      }
    }
    if (problems.length > 0) throw new LibraryError("invalid", `The library could not be loaded:\n${problemsText(problems)}`, problems);
    this.states = states;
    const checked = this.validateAll();
    if (checked.length > 0) {
      this.states = [];
      throw new LibraryError("invalid", `The library could not be loaded:\n${problemsText(checked)}`, checked);
    }
    for (const s of states) for (const f of s.files) for (const item of f.items) this.remember(item, s.source.scope.id);
  }

  private async readSource(source: FileLibrarySource, problems: LibraryProblem[]): Promise<ScopeState> {
    const fs = this.opts.fs;
    const where = (label: string, ps: readonly LibraryProblem[]) => ps.map((p) => ({ ...p, message: `${label}: ${p.message}` }));
    const parse = (input: unknown, label: string, path?: string): LoadedFile | undefined => {
      const parsed = parseBundle(input);
      if (!parsed.ok) {
        problems.push(...where(label, parsed.problems));
        return undefined;
      }
      return { ...(path === undefined ? {} : { path }), ...(typeof input === "string" ? { text: input } : {}), header: parsed.bundle, items: bundleItems(parsed.bundle) };
    };
    switch (source.kind) {
      case "bundle": {
        const key = typeof source.bundle === "object" && source.bundle !== null && !source.writable ? source.bundle : null;
        const seen = key ? parsedBundles.get(key) : undefined;
        const file = seen ? { header: seen.header, items: [...seen.items] } : parse(source.bundle, source.scope.name);
        if (key && file && !seen) parsedBundles.set(key, { header: file.header, items: file.items });
        return { source, files: file ? [file] : [], writable: source.writable === true, ...(source.writable ? {} : { readOnlyReason: `${source.scope.name} is built in and can't be changed. Save a copy to your firm's library instead.` }) };
      }
      case "url": {
        const fetchFn = this.opts.fetch ?? (globalThis.fetch as FetchLike | undefined);
        if (!fetchFn) throw new LibraryError("unavailable", `Can't download ${source.url}: this host has no way to fetch files.`);
        const res = await fetchFn(source.url);
        if (!res.ok) throw new LibraryError("unavailable", `Downloading ${source.url} failed (HTTP ${res.status}).`);
        const file = parse(await res.text(), source.url);
        return { source, files: file ? [file] : [], writable: false, readOnlyReason: `${source.scope.name} comes from a web address, so it is read-only. Export it to a folder to edit it.` };
      }
      case "file": {
        if (!fs) throw new LibraryError("unavailable", `Can't open ${source.path}: this host has no file access.`);
        const file = parse(await fs.readText(source.path), source.path, source.path);
        const writable = await this.canWrite(source.path);
        return { source, files: file ? [file] : [], writable, ...(writable ? {} : { readOnlyReason: `${source.path} can't be written to. Check the file's permissions, or export a copy.` }) };
      }
      case "folder": {
        if (!fs) throw new LibraryError("unavailable", `Can't open ${source.path}: this host has no file access.`);
        const names = (await fs.listDir(source.path)).filter((n) => n.endsWith(LIBRARY_FILE_SUFFIX)).sort();
        const files: LoadedFile[] = [];
        for (const name of names) {
          const path = joinPath(source.path, name);
          const file = parse(await fs.readText(path), path, path);
          if (file) files.push(file);
        }
        const writable = await this.canWrite(source.path);
        return { source, files, writable, ...(writable ? {} : { readOnlyReason: `The folder ${source.path} can't be written to.` }) };
      }
    }
  }

  private async canWrite(path: string): Promise<boolean> {
    const fs = this.opts.fs;
    if (!fs?.writeText) return false;
    return fs.canWrite ? fs.canWrite(path) : true;
  }

  /** Re-checks every scope bottom-up against the scopes below it; caches the result when clean. */
  private validateAll(): LibraryProblem[] {
    const problems: LibraryProblem[] = [];
    let registry = this.opts.env.registry ?? builtinRegistry();
    const lowerLayers: LibraryLayer[] = [];
    // Only the bottom run of read-only bundles is cached: a layer's check depends on every layer under it.
    let cacheable = true;
    for (let i = this.states.length - 1; i >= 0; i--) {
      const state = this.states[i];
      if (!state) continue;
      const items = state.files.flatMap((f) => f.items);
      const ids = new Set<string>();
      for (const item of items) {
        if (ids.has(item.body.id)) problems.push({ itemId: item.body.id, message: `${state.source.scope.name}: item ${item.body.id} is in more than one file.` });
        ids.add(item.body.id);
      }
      const env = this.opts.env;
      const slot =
        state.source.kind === "bundle" && !state.writable && cacheable && typeof state.source.bundle === "object" && state.source.bundle !== null
          ? layerCacheSlot([state.source.bundle, registry, env.formula as object, env.units as object, env.checkScheduleTemplate ?? ABSENT, env.checkTagType ?? ABSENT])
          : null;
      const hit = slot?.get();
      if (hit) {
        registry = hit.registry;
        for (const file of state.files) file.items = ownItems(hit.items, file.items);
        lowerLayers.unshift({ kind: layerKindOf(state.source.scope.kind), scope: state.source.scope.id, items: [...hit.items] });
        continue;
      }
      if (!slot) cacheable = false;
      const lower = resolveLayers(lowerLayers);
      const header = state.files[0]?.header ?? emptyHeader(state.source.scope);
      const loaded = loadBundle(bundleWithItems(header, items), { ...env, registry, lower });
      if (!loaded.ok) {
        for (const p of loaded.problems) {
          const file = p.itemId === undefined ? undefined : state.files.find((f) => f.items.some((it) => it.body.id === p.itemId));
          const located = file?.text === undefined ? p : locateIn(file.text, p);
          problems.push({ ...located, message: `${file?.path ?? state.source.scope.name}: ${p.message}` });
        }
        continue;
      }
      registry = loaded.registry;
      slot?.set({ items: loaded.items, registry: loaded.registry });
      for (const file of state.files) file.items = ownItems(loaded.items, file.items);
      lowerLayers.unshift({ kind: layerKindOf(state.source.scope.kind), scope: state.source.scope.id, items: loaded.items });
    }
    if (problems.length === 0) this.resolvedCache = { resolved: resolveLayers(lowerLayers), registry };
    return problems;
  }
}
