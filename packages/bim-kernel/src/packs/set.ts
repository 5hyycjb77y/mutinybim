/**
 * The set of packs one model uses: an immutable value, built once when the
 * model opens and bound to that model (`scope.ts`). It replaces the global
 * registries: a firm's pack on the model server reaches only that firm's
 * models, never every model in the process.
 *
 * Built-in rows come from each extension point's `builtins`; pack rows
 * follow, in pack order. A set that breaks the contract (two packs with one
 * namespace, an unmet `requires`, a pack written for another contract or
 * point major, a duplicate id) is refused with every problem listed.
 */
import { PACK_CONTRACT_VERSION, satisfies, type ErasedContribution, type ExtensionPoint, type Pack } from "./contract";
import { FIRST_PARTY_PACK_IDS, firstPartyPackName, isFirstPartyPackId, type FirstPartyPackId } from "./first-party/manifests";
import { needsAddonWords, type OutsidePackPin, type PackPin } from "./pin";
import { packTrustOf, type InstallReview } from "./trust";

// The always-installed first-party add-ons: the base under every set. Set once
// per process by the host (`installFirstPartyPacks`); `baseRevision` changes
// when it does, so a set's cached tables are rebuilt.
let firstPartyBase: readonly Pack[] = [];
let baseRevision = 0;

/** The installed first-party packs, in first-party order. */
export function installedFirstPartyPacks(): readonly Pack[] {
  return firstPartyBase;
}

/** Changes each time the first-party install changes; a cheap guard for tables cached outside a set. */
export function firstPartyBaseRevision(): number {
  return baseRevision;
}

/** The installed first-party pack that contributes the row with this id at a point, for listing; null for any other row. */
export function firstPartyOwnerOf<T>(point: ExtensionPoint<T>, id: string): FirstPartyPackId | null {
  for (const pack of firstPartyBase) {
    const owner = pack.manifest.id;
    if (!isFirstPartyPackId(owner)) continue;
    for (const c of pack.contributions) if (c.pointId === point.id && c.idOf && c.items.some((item) => c.idOf?.(item) === id)) return owner;
  }
  return null;
}

/**
 * Install the always-on first-party add-ons (`FIRST_PARTY_PACK_IDS`) as the
 * base of every pack set: outside any scope and under
 * every per-model set. Idempotent for the same pack objects. Refuses, loudly,
 * a pack that isn't first-party and a second, different pack for an id
 * already installed. Their rows join each point after its built-in rows, in
 * first-party order whatever order they're passed in.
 */
export function installFirstPartyPacks(packs: readonly Pack[]): void {
  installBase(packs, false);
}

/**
 * The kernel's own transitional first-party packs, installed when the kernel
 * entry loads so a process with no host (a script, a kernel test) reads the
 * trades as before. Provisional: a host's `installFirstPartyPacks` replaces
 * them; this never replaces a host's install.
 */
export function installProvisionalFirstPartyPacks(packs: readonly Pack[]): void {
  installBase(
    packs.filter((p) => !firstPartyBase.some((had) => had.manifest.id === p.manifest.id)),
    true,
  );
}

/** Ids installed provisionally; a host's install may replace exactly these. */
const provisionalIds = new Set<string>();

function installBase(packs: readonly Pack[], asProvisional: boolean): void {
  const problems: string[] = [];
  const next = new Map(firstPartyBase.map((p) => [p.manifest.id, p] as const));
  const nowProvisional = new Set(provisionalIds);
  let changed = false;
  for (const pack of packs) {
    const { id, firstParty } = pack.manifest;
    if (firstParty !== true || !isFirstPartyPackId(id)) {
      problems.push(`pack ${id} isn't a first-party add-on; load it per model instead`);
      continue;
    }
    const had = next.get(id);
    if (had === pack) {
      if (!asProvisional) nowProvisional.delete(id);
      continue;
    }
    if (had && !asProvisional && nowProvisional.has(id)) {
      next.set(id, pack);
      nowProvisional.delete(id);
      changed = true;
      continue;
    }
    if (had) {
      problems.push(`${firstPartyPackName(id) ?? id} is already installed (${had.manifest.version}); a second, different ${id} pack ${pack.manifest.version} was refused`);
      continue;
    }
    next.set(id, pack);
    if (asProvisional) nowProvisional.add(id);
    changed = true;
  }
  if (problems.length > 0) {
    const error = new PackSetError(problems);
    console.error("[bim-kernel/packs] installFirstPartyPacks refused", error.problems);
    throw error;
  }
  provisionalIds.clear();
  for (const id of nowProvisional) provisionalIds.add(id);
  if (!changed) return;
  const ordered = FIRST_PARTY_PACK_IDS.flatMap((id) => {
    const p = next.get(id);
    return p ? [p] : [];
  });
  PackSet.create(ordered);
  firstPartyBase = Object.freeze(ordered);
  baseRevision++;
}

// ── Read recording (round 9 lane K9) ────────────────────────────────────────
// Validation records which add-on contributions each check reads, so a switch
// re-runs only the checks that read a contribution the switch changed. Reads
// are recorded here, at the set, not declared by the checks.

/** How a check read a set: the rows at one point through one accessor, or a pack looked up by id. */
export const PACK_SET_READ = { items: 0, packItems: 1, firstPartyItems: 2, firmItems: 3, pack: 4 } as const;
export type PackSetReadKind = (typeof PACK_SET_READ)[keyof typeof PACK_SET_READ];

/** Told of every read of any set while it is installed (`recordPackSetReads`). */
export interface PackSetReadRecorder {
  /** `target` is the extension point, or the pack id for `PACK_SET_READ.pack`. */
  note(kind: PackSetReadKind, target: RecordedPoint | string): void;
  /** A memo hit's reads at once (the same list object every hit), when the recorder can take them faster than one by one. */
  noteAll?(reads: readonly PackSetRead[]): void;
}

/** One recorded read. */
export interface PackSetRead {
  readonly kind: PackSetReadKind;
  readonly target: RecordedPoint | string;
}

/** What a recorder is told of a point: the point itself (compare by identity). */
export interface RecordedPoint {
  readonly id: string;
}

let readRecorder: PackSetReadRecorder | null = null;

/** Install `recorder` (null: none) and return the one it replaces; the caller puts that back. Synchronous use only. */
export function swapPackSetReadRecorder(recorder: PackSetReadRecorder | null): PackSetReadRecorder | null {
  const previous = readRecorder;
  readRecorder = recorder;
  return previous;
}

/**
 * True while a recorder is installed. A cache of a set's table kept outside
 * the set (a `last` holder compared with the set in force) is skipped then, so the read reaches the set
 * and is recorded (`memo` replays what the table was built from).
 */
export function packSetReadsRecorded(): boolean {
  return readRecorder !== null;
}

/** Run `fn` with `recorder` told of every set read it makes. */
export function recordPackSetReads<R>(recorder: PackSetReadRecorder | null, fn: () => R): R {
  const previous = swapPackSetReadRecorder(recorder);
  try {
    return fn();
  } finally {
    readRecorder = previous;
  }
}


function sameRows(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * True when `a` and `b` answer one recorded read identically: the same rows
 * contributed at the point (`id`, by point id; built-in rows are the
 * release's, the same under every set), or the same pack (`id`, a pack id).
 * By id, so a read recorded in another process (a persisted validation
 * state) compares too.
 */
export function samePackSetRead(a: PackSet, b: PackSet, kind: PackSetReadKind, id: string): boolean {
  if (a === b) return true;
  const previous = swapPackSetReadRecorder(null);
  try {
    if (kind === PACK_SET_READ.pack) return a.pack(id) === b.pack(id);
    return sameRows(a.contributedRows(kind, id), b.contributedRows(kind, id));
  } finally {
    readRecorder = previous;
  }
}

/** The refusal for content whose owning add-on isn't loaded ("This model uses <add-on>, which isn't loaded here"), by the add-on's display name. */
export function packNotLoadedMessage(packId: string): string {
  return `This model uses ${firstPartyPackName(packId) ?? packId}, which isn't loaded here`;
}

/** Peers that read and store `ModelSettings.packs`. A writer emits pins only to a peer that lists it. */
export const PACKS_PINS_FEATURE = "packs:pins";

/** What a model stores to say which packs it uses (`ModelSettings.packs`); round 11 adds the digest and tier (`pin.ts`). */
export type { PackPin } from "./pin";

/** One pack's items at one point, for listing (Settings › MutinyBIM library). */
export interface PointContributor {
  readonly packId: string;
  readonly packName: string;
  readonly version: string;
  readonly count: number;
}

export class PackSetError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`MutinyBIM pack set refused: ${problems.join("; ")}`);
    this.name = "PackSetError";
    this.problems = problems;
  }
}

export interface PackSetOptions {
  /** The contract version to check `manifest.kernel` against. Default: this release's. */
  readonly contractVersion?: string;
  /**
   * The firm library's rows at extension points (a firm's disciplines), as
   * contributions. Ids must be `firm:<slug>`; they join each point after the
   * packs' rows. A firm is not a pack: it has no manifest and no namespace
   * of its own beyond `firm:`.
   */
  readonly firm?: readonly ErasedContribution[];
}

const FIRM_ROW_ID = /^firm:[a-z0-9][a-z0-9_]*$/;

/** Problems with firm rows: every id must be `firm:<slug>`, once per point. */
function firmProblems(firm: readonly ErasedContribution[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const c of firm) {
    if (!c.idOf) continue;
    for (const item of c.items) {
      const id = c.idOf(item);
      if (!FIRM_ROW_ID.test(id)) problems.push(`the firm library's ${c.pointLabel} id "${id}" must be "firm:<name>" (lower case letters, digits and underscores)`);
      const key = `${c.pointId}\u0000${id}`;
      if (seen.has(key)) problems.push(`the firm library has ${c.pointLabel} "${id}" twice`);
      seen.add(key);
    }
  }
  return problems;
}

export class PackSet {
  readonly packs: readonly Pack[];
  /** Changes when the set's packs or versions change; a cache key for derived tables. */
  readonly revision: string;
  private readonly byPoint: ReadonlyMap<string, readonly ErasedContribution[]>;
  /** Each memo's table and the reads it was built from: one lookup per hit (a recorded pass hits memos once per check). */
  private readonly memos = new Map<string, { readonly value: unknown; readonly reads: readonly PackSetRead[] }>();
  private readonly itemCache = new Map<string, readonly unknown[]>();
  private readonly itemBuiltins = new Map<string, readonly unknown[]>();
  private seenBase = -1;
  private base: readonly Pack[] = [];

  /** The installed first-party packs this set doesn't list itself; caches drop when the install changes. */
  private baseUnder(): readonly Pack[] {
    if (this.seenBase !== baseRevision) {
      this.seenBase = baseRevision;
      this.base = firstPartyBase.filter((p) => !this.packs.some((own) => own.manifest.id === p.manifest.id));
      this.memos.clear();
      this.itemCache.clear();
      this.itemBuiltins.clear();
    }
    return this.base;
  }

  /** The firm library's rows per point (`PackSetOptions.firm`), after the packs'. */
  private readonly firmByPoint: ReadonlyMap<string, readonly ErasedContribution[]>;

  private constructor(packs: readonly Pack[], byPoint: ReadonlyMap<string, readonly ErasedContribution[]>, firm: readonly ErasedContribution[] = []) {
    this.packs = packs;
    this.byPoint = byPoint;
    const firmByPoint = new Map<string, ErasedContribution[]>();
    for (const c of firm) firmByPoint.set(c.pointId, [...(firmByPoint.get(c.pointId) ?? []), c]);
    this.firmByPoint = firmByPoint;
    const firmIds = firm.flatMap((c) => (c.idOf ? c.items.map((item) => `${c.pointId}:${c.idOf?.(item) ?? ""}`) : [`${c.pointId}#${c.items.length}`]));
    const packsRevision = packs.map((p) => `${p.manifest.id}@${p.manifest.version}`).join(",") || "builtins";
    this.revision = firmIds.length > 0 ? `${packsRevision}|firm:${firmIds.join(",")}` : packsRevision;
  }

  /** The firm library's rows at a point (`PackSetOptions.firm`), for listing. */
  firmItems<T>(point: ExtensionPoint<T>): readonly T[] {
    readRecorder?.note(PACK_SET_READ.firmItems, point);
    const list = this.firmByPoint.get(point.id);
    if (!list) return [];
    for (const c of list) if (c.pointVersion !== point.version) throw new PackSetError([`the firm library was written for ${point.label} v${c.pointVersion}; this release reads v${point.version}`]);
    // Items of a contribution to this point, checked against its version above.
    return list.flatMap((c) => c.items) as readonly T[];
  }

  /** Build a set; throws `PackSetError` listing every problem. */
  static create(packs: readonly Pack[], options: PackSetOptions = {}): PackSet {
    const contract = options.contractVersion ?? PACK_CONTRACT_VERSION;
    const problems: string[] = [];
    const ids = new Map<string, Pack>();
    for (const pack of packs) {
      const { id, version, kernel } = pack.manifest;
      if (ids.has(id)) problems.push(`two packs use the namespace "${id}"`);
      ids.set(id, pack);
      if (!satisfies(contract, kernel)) problems.push(`pack ${id} ${version} was written for contract ${kernel}; this release is ${contract}`);
    }
    for (const pack of packs) {
      for (const req of pack.manifest.requires ?? []) {
        const dep = ids.get(req.id) ?? firstPartyBase.find((p) => p.manifest.id === req.id);
        if (!dep) problems.push(`pack ${pack.manifest.id} needs pack ${req.id} ${req.range}, which this model doesn't use`);
        else if (!satisfies(dep.manifest.version, req.range)) problems.push(`pack ${pack.manifest.id} needs ${req.id} ${req.range}; this model uses ${dep.manifest.version}`);
      }
    }
    const byPoint = new Map<string, ErasedContribution[]>();
    const pointVersion = new Map<string, { version: number; by: string }>();
    const itemOwner = new Map<string, string>();
    for (const pack of packs) {
      for (const c of pack.contributions) {
        const seen = pointVersion.get(c.pointId);
        if (seen && seen.version !== c.pointVersion) problems.push(`packs ${seen.by} and ${pack.manifest.id} were written for different versions of ${c.pointLabel} (v${seen.version}, v${c.pointVersion})`);
        if (!seen) pointVersion.set(c.pointId, { version: c.pointVersion, by: pack.manifest.id });
        if (c.idOf) {
          for (const item of c.items) {
            const key = `${c.pointId}\u0000${c.idOf(item)}`;
            const owner = itemOwner.get(key);
            if (owner) problems.push(`${c.pointLabel} "${c.idOf(item)}" comes from both ${owner} and ${pack.manifest.id}`);
            itemOwner.set(key, pack.manifest.id);
          }
        }
        const list = byPoint.get(c.pointId) ?? [];
        list.push(c);
        byPoint.set(c.pointId, list);
      }
    }
    problems.push(...firmProblems(options.firm ?? []));
    if (problems.length > 0) throw new PackSetError(problems);
    return new PackSet(Object.freeze([...packs]), byPoint, options.firm ?? []);
  }

  /** The pack with this namespace, or null. */
  pack(id: string): Pack | null {
    readRecorder?.note(PACK_SET_READ.pack, id);
    return this.packs.find((p) => p.manifest.id === id) ?? this.baseUnder().find((p) => p.manifest.id === id) ?? null;
  }

  has(id: string): boolean {
    return this.pack(id) !== null;
  }

  /** What a model stores to reopen with this set. */
  pins(): readonly PackPin[] {
    return this.packs.map((p) => ({ id: p.manifest.id, version: p.manifest.version }));
  }

  /** The installed first-party packs' items here (those this set doesn't list itself), in first-party order. */
  firstPartyItems<T>(point: ExtensionPoint<T>): readonly T[] {
    readRecorder?.note(PACK_SET_READ.firstPartyItems, point);
    return this.cached(`fp\u0000${point.id}`, () => {
      const out: unknown[] = [];
      for (const pack of this.baseUnder()) {
        for (const c of pack.contributions) {
          if (c.pointId !== point.id) continue;
          if (c.pointVersion !== point.version) throw new PackSetError([`${pack.manifest.name} was written for ${point.label} v${c.pointVersion}; this release reads v${point.version}`]);
          out.push(...c.items);
        }
      }
      return out;
    }) as readonly T[];
  }

  /**
   * Pack items for a point: the installed first-party packs' first, then
   * this set's packs in order; without the point's built-ins. The check in
   * `PackSet.create` (or `installFirstPartyPacks`) ran on these items
   * against this point's version.
   */
  packItems<T>(point: ExtensionPoint<T>): readonly T[] {
    readRecorder?.note(PACK_SET_READ.packItems, point);
    return this.packRows(point);
  }

  private packRows<T>(point: ExtensionPoint<T>): readonly T[] {
    return this.cached(`pk\u0000${point.id}`, () => {
      // The caller's read (`items` / `packItems`) already covers the first-party and firm rows; noting them here too
      // would record them only for whichever check happened to fill the cache, so what a check reads would depend on order.
      const outer = swapPackSetReadRecorder(null);
      let base: readonly T[];
      let firm: readonly T[];
      try {
        base = this.firstPartyItems(point);
        firm = this.firmItems(point);
      } finally {
        swapPackSetReadRecorder(outer);
      }
      const list = this.byPoint.get(point.id);
      if (!list && firm.length === 0) return base;
      const out: unknown[] = [...base];
      const reserved = point.idOf && base.length > 0 ? new Set(base.map(point.idOf)) : null;
      for (const c of list ?? []) {
        if (c.pointVersion !== point.version) throw new PackSetError([`a pack was written for ${point.label} v${c.pointVersion}; this release reads v${point.version}`]);
        if (reserved && c.idOf) {
          for (const item of c.items) {
            const id = c.idOf(item);
            if (reserved.has(id)) throw new PackSetError([`${point.label} "${id}" is a first-party row; a pack may not replace it`]);
          }
        }
        out.push(...c.items);
      }
      out.push(...firm);
      return out;
    }) as readonly T[];
  }

  /** Per-set cache of pack-item lists; packs are immutable, the first-party base drops it when it changes. */
  private cached(key: string, compute: () => readonly unknown[]): readonly unknown[] {
    this.baseUnder();
    const hit = this.itemCache.get(key);
    if (hit) return hit;
    const value = Object.freeze(compute());
    this.itemCache.set(key, value);
    return value;
  }

  /**
   * Built-in rows, then first-party rows, then pack rows. A pack row whose id
   * equals a built-in row's is refused: built-in ids are bare and reserved.
   */
  items<T>(point: ExtensionPoint<T>): readonly T[] {
    readRecorder?.note(PACK_SET_READ.items, point);
    const builtins = point.builtins?.() ?? [];
    const extra = this.packRows(point);
    if (extra.length === 0) return builtins;
    if (builtins.length === 0) return extra;
    const key = `it\u0000${point.id}`;
    const hit = this.itemCache.get(key);
    if (hit && this.itemBuiltins.get(key) === builtins) return hit as readonly T[];
    const idOf = point.idOf;
    if (idOf) {
      const builtinIds = new Set(builtins.map(idOf));
      for (const item of extra) if (builtinIds.has(idOf(item))) throw new PackSetError([`${point.label} "${idOf(item)}" is a built-in row; a pack may not replace it`]);
    }
    const all = Object.freeze([...builtins, ...extra]);
    this.itemCache.set(key, all);
    this.itemBuiltins.set(key, builtins);
    return all;
  }

  /** The rows contributed at a point (by id) that one kind of read sees, without built-ins and unchecked: for comparing two sets only. */
  contributedRows(kind: PackSetReadKind, pointId: string): readonly unknown[] {
    const out: unknown[] = [];
    if (kind !== PACK_SET_READ.firmItems) for (const pack of this.baseUnder()) for (const c of pack.contributions) if (c.pointId === pointId) out.push(...c.items);
    if (kind === PACK_SET_READ.firstPartyItems) return out;
    if (kind !== PACK_SET_READ.firmItems) for (const c of this.byPoint.get(pointId) ?? []) out.push(...c.items);
    for (const c of this.firmByPoint.get(pointId) ?? []) out.push(...c.items);
    return out;
  }

  /**
   * The rows each pack contributes at a point, keyed by the pack: the
   * installed first-party packs first, then this set's packs, in order.
   * Built-ins and firm rows are not included (contract 1.12.0).
   */
  rowsByPack<T>(point: ExtensionPoint<T>): readonly { readonly packId: string; readonly rows: readonly T[] }[] {
    readRecorder?.note(PACK_SET_READ.packItems, point);
    const out: { packId: string; rows: T[] }[] = [];
    const seen = new Set<string>();
    for (const pack of [...this.baseUnder(), ...this.packs]) {
      if (seen.has(pack.manifest.id)) continue;
      seen.add(pack.manifest.id);
      const rows: T[] = [];
      for (const c of pack.contributions) {
        if (c.pointId !== point.id) continue;
        if (c.pointVersion !== point.version) throw new PackSetError([`${pack.manifest.name} was written for ${point.label} v${c.pointVersion}; this release reads v${point.version}`]);
        rows.push(...(c.items as readonly T[]));
      }
      if (rows.length > 0) out.push({ packId: pack.manifest.id, rows });
    }
    return out;
  }

  /** Who contributes to a point, for listing. Built-ins are not listed. */
  contributors(point: Pick<ExtensionPoint<never>, "id">): readonly PointContributor[] {
    const out: PointContributor[] = [];
    for (const pack of this.packs) {
      const count = pack.contributions.filter((c) => c.pointId === point.id).reduce((n, c) => n + c.items.length, 0);
      if (count > 0) out.push({ packId: pack.manifest.id, packName: pack.manifest.name, version: pack.manifest.version, count });
    }
    return out;
  }

  /**
   * A table derived from this set (an adapter map, a rule list), computed
   * once per set. `key` names the table; callers that also read legacy
   * built-in registrations include their own revision in it. `compute` is
   * given this set, so a caller on a per-element path can pass a module-level
   * function rather than a new closure on every hit.
   */
  memo<V>(key: string, compute: (set: PackSet) => V): V {
    this.baseUnder();
    const hit = this.memos.get(key);
    if (hit) {
      // A hit tells the recorder what the table was built from.
      const recorder = readRecorder;
      const reads = hit.reads;
      if (recorder && reads.length > 0) {
        if (recorder.noteAll) recorder.noteAll(reads);
        else for (const r of reads) recorder.note(r.kind, r.target);
      }
      return hit.value as V;
    }
    // Always kept (a table built outside any recording is read inside one later).
    const outer = readRecorder;
    const reads: PackSetRead[] = [];
    readRecorder = {
      note(kind, target) {
        if (!reads.some((r) => r.kind === kind && r.target === target)) reads.push({ kind, target });
        outer?.note(kind, target);
      },
    };
    let value: V;
    try {
      value = compute(this);
    } finally {
      readRecorder = outer;
    }
    this.memos.set(key, { value, reads });
    return value;
  }
}

/** The set a model with no packs uses: built-in rows only. */
export const BUILTIN_PACK_SET: PackSet = PackSet.create([]);

/**
 * Resolve a model's stored pins against the packs this host has. A pin whose
 * pack or exact version is missing is reported, never silently dropped; the
 * host shows it ("This model uses Civil 1.2.0, which isn't installed"). A pin
 * for an installed first-party add-on is satisfied by the base every set
 * already has (a model that switched Structural on while it was Preview).
 */
export function resolvePackPins(available: readonly Pack[], pins: readonly PackPin[] | undefined, options?: PackSetOptions): { readonly set: PackSet; readonly missing: readonly PackPin[] } {
  const chosen: Pack[] = [];
  const missing: PackPin[] = [];
  for (const pin of pins ?? []) {
    const exact = available.find((p) => p.manifest.id === pin.id && p.manifest.version === pin.version);
    if (exact) chosen.push(exact);
    else if (!firstPartyBase.some((p) => p.manifest.id === pin.id)) missing.push(pin);
  }
  return { set: PackSet.create(chosen, options), missing };
}

// ── Install: outside add-ons (round 11 A11, D5) ─────────────────────────────
// A host hands its outside add-ons here with the pin it installed each at
// (digest and tier) and the firm's review. Only an approved build with the
// pinned digest is available to a model; a yanked one stays available with a
// warning; anything else is blocked in words and the model opens without it,
// its records kept. The host then resolves the model's setup against its own
// add-ons plus `available` (`resolveModelSetup`).

/** One outside add-on a host has installed: the pack its data add-on builds, how it was pinned, and the firm's review. */
export interface InstalledOutsidePack {
  readonly pack: Pack;
  readonly pin: OutsidePackPin;
  readonly review: InstallReview;
  /** Display name for words ("Door library"). Default: the pack's. */
  readonly name?: string;
}

/** One pin a model can't open with, and why, in words a person reads ("This model needs add-on Door library 1.2.0: …"). */
export interface BlockedPin {
  readonly pin: PackPin;
  readonly words: string;
}

export interface OutsidePinResolution {
  /** Packs the model may load, for `resolveModelSetup(setup, [...hostPacks, ...available])`. */
  readonly available: readonly Pack[];
  readonly blocked: readonly BlockedPin[];
  /** Loaded, with something a person should see (a yanked version, a pin from before digests). */
  readonly warnings: readonly string[];
}

/**
 * Which of a model's pins name an outside add-on this host installed, and
 * whether each may load. A pin with a digest loads only the build with that
 * digest; a pin from before digests (or from a setup switch, which stores id
 * and version) loads the firm's approved build of that exact version and says
 * so. Pins this host has no outside add-on for are left alone (the host's own
 * add-ons, or missing: `resolveModelSetup` reports those).
 */
export function outsidePacksForPins(pins: readonly PackPin[], installed: readonly InstalledOutsidePack[]): OutsidePinResolution {
  const available: Pack[] = [];
  const blocked: BlockedPin[] = [];
  const warnings: string[] = [];
  for (const pin of pins) {
    const entry = installed.find((e) => e.pin.id === pin.id && e.pin.version === pin.version);
    if (!entry) continue;
    const name = entry.name ?? entry.pack.manifest.name;
    const digest = pin.digest ?? entry.pin.digest;
    const trust = packTrustOf({ id: pin.id, version: pin.version, digest }, entry.review, name);
    if (trust.use === "block") {
      blocked.push({ pin, words: `${needsAddonWords(pin, name)}: ${trust.reason}` });
      continue;
    }
    if (pin.digest === undefined) warnings.push(`${name} ${pin.version} was pinned before builds were recorded; this model opens with the build this firm approved.`);
    warnings.push(...trust.warnings);
    available.push(entry.pack);
  }
  return { available, blocked, warnings };
}

/** The words for a pin this host has no add-on for at all ("This model needs add-on X v1.2: it isn't installed here …"). */
export function missingPinWords(pin: PackPin): string {
  return `${needsAddonWords(pin, firstPartyPackName(pin.id) ?? undefined)}, which isn't installed here. Its records on this model are kept unchanged.`;
}
