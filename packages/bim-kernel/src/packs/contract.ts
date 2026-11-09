/**
 * The MutinyBIM add-on (pack) contract, version PACK_CONTRACT_VERSION.
 *
 * A pack is a namespace plus contributions to versioned extension points:
 * classes, parameter sets, services, network adapters, derived-zone rules,
 * zone purposes, facets, calcs and code editions, lint rules, space-use
 * rates, symbols, categories, schedule templates, IFC mappings and agent-tool
 * descriptors. Each extension point is declared once, by the layer that
 * consumes it (`defineExtensionPoint`), and carries its own major version, so
 * a pack written for an older shape is refused loudly instead of misread.
 *
 * Internal promise (Product decision, Oct 29 2026): additive changes only within a
 * major version of a point or of this contract; a breaking change bumps the
 * major and is listed in the contract changelog. Not yet a public
 * promise; it becomes one when MutinyBIM is open-sourced.
 *
 * Imports only `ids.ts`, `version.ts` and the first-party manifests (data),
 * so every layer may read it.
 */
import { REGISTRY_ID_MAX_LENGTH, isRegistryIdShape } from "../ids";
import { FIRST_PARTY_PACK_IDS } from "./first-party/manifests";

export { PACK_CONTRACT_VERSION } from "./version";

/** Namespaces no pack may take: built-in rows are bare, firm rows are `firm:`. */
export const RESERVED_PACK_NAMESPACES: readonly string[] = ["firm", "core", "kernel", "builtin", "project", "user"];

const PACK_NAMESPACE_PATTERN = /^[a-z][a-z0-9_]{1,23}$/;
const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;

/**
 * One place packs plug in. `T` is what a pack contributes there.
 * Declared by the consuming layer, never by a pack.
 */
export interface ExtensionPoint<T> {
  /** Stable id, `<layer>.<name>` ("kernel.network_adapter", "lint.rule"). */
  readonly id: string;
  /** Major version of the item shape. A pack contributing to another major is refused. */
  readonly version: number;
  /** What the point holds, in words ("Network adapters"). */
  readonly label: string;
  /**
   * The registry id of an item, when items are stored by id. Pack items must
   * then be namespaced `<pack>.<name>` and unique across the set.
   */
  readonly idOf?: (item: T) => string;
  /**
   * Whether item ids must carry the contributing pack's namespace. Default
   * true when `idOf` is given. False for points whose ids are not stored
   * (an adapter id that names a solver family, a unit kind code).
   */
  readonly namespaced?: boolean;
  /** Built-in rows this release ships, read lazily (after every module has loaded). */
  readonly builtins?: () => readonly T[];
}

export function defineExtensionPoint<T>(point: ExtensionPoint<T>): ExtensionPoint<T> {
  if (!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(point.id)) throw new PackDefinitionError([`extension point id "${point.id}" must be "<layer>.<name>" in lower case`]);
  if (!Number.isInteger(point.version) || point.version < 1) throw new PackDefinitionError([`extension point ${point.id}: version must be a whole number from 1`]);
  return point;
}

export interface PackRequirement {
  /** Another pack's namespace. */
  readonly id: string;
  /** Semver range of that pack ("^1.0.0"). */
  readonly range: string;
}

export interface PackManifest {
  /** The pack's namespace: every id it contributes starts with `<id>.` ("struct", "civil"). */
  readonly id: string;
  /** Display name ("Structural"). */
  readonly name: string;
  /** The pack's own semver ("1.0.0"). */
  readonly version: string;
  /** The contract range it was written for ("^1.0.0"). */
  readonly kernel: string;
  readonly description?: string;
  /** Other packs it builds on. */
  readonly requires?: readonly PackRequirement[];
  /** Shipped by PermitZIP. Listed first in settings; still goes through this contract. */
  readonly firstParty?: boolean;
}

/** One pack's items for one extension point. Built with `contribute`. */
export interface Contribution<T> {
  readonly point: ExtensionPoint<T>;
  readonly items: readonly T[];
}

/**
 * A contribution with its item type erased, so one pack can carry items of
 * many points. Only `PackSet.items(point)` reads it back, keyed by the same
 * point object the items were checked against in `contribute`.
 */
export interface ErasedContribution {
  readonly pointId: string;
  readonly pointVersion: number;
  readonly pointLabel: string;
  readonly items: readonly unknown[];
  readonly idOf: ((item: unknown) => string) | null;
  readonly namespaced: boolean;
}

export function contribute<T>(point: ExtensionPoint<T>, items: readonly T[]): ErasedContribution {
  const idOf = point.idOf;
  return {
    pointId: point.id,
    pointVersion: point.version,
    pointLabel: point.label,
    items,
    // Called only on items of this contribution, which `contribute` typed as T.
    idOf: idOf ? (item: unknown) => idOf(item as T) : null,
    namespaced: point.namespaced ?? Boolean(idOf),
  };
}

export interface Pack {
  readonly manifest: PackManifest;
  readonly contributions: readonly ErasedContribution[];
}

/** A pack whose manifest or items break the contract. Lists every problem, not the first. */
export class PackDefinitionError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`MutinyBIM pack contract: ${problems.join("; ")}`);
    this.name = "PackDefinitionError";
    this.problems = problems;
  }
}

/** Check a manifest's shape. Returns problems in plain words; empty when it is valid. */
export function manifestProblems(manifest: PackManifest): string[] {
  const problems: string[] = [];
  if (!PACK_NAMESPACE_PATTERN.test(manifest.id)) problems.push(`pack id "${manifest.id}" must be 2–24 lower-case letters, digits or underscores, starting with a letter`);
  if (RESERVED_PACK_NAMESPACES.includes(manifest.id)) problems.push(`pack id "${manifest.id}" is reserved`);
  if (!manifest.name.trim()) problems.push(`pack ${manifest.id}: name is empty`);
  if (!SEMVER_PATTERN.test(manifest.version)) problems.push(`pack ${manifest.id}: version "${manifest.version}" is not semver (1.2.3)`);
  if (!isRangeShape(manifest.kernel)) problems.push(`pack ${manifest.id}: kernel range "${manifest.kernel}" is not a supported range (^1.0.0, ~1.2.0, >=1.0.0 <2.0.0, 1.2.3, *)`);
  for (const req of manifest.requires ?? []) {
    if (!PACK_NAMESPACE_PATTERN.test(req.id)) problems.push(`pack ${manifest.id}: requires "${req.id}", which is not a pack id`);
    if (!isRangeShape(req.range)) problems.push(`pack ${manifest.id}: requires ${req.id} "${req.range}", which is not a supported range`);
  }
  return problems;
}

/**
 * Whether a pack keeps bare ids at namespaced points: only a `firstParty`
 * pack whose id is a reserved first-party id (models have stored its rows'
 * bare ids since before packs). Any other pack namespaces its ids.
 */
export function keepsBareIds(manifest: Pick<PackManifest, "id" | "firstParty">): boolean {
  return manifest.firstParty === true && FIRST_PARTY_PACK_IDS.includes(manifest.id);
}

/** A first-party row's stored id from before registry ids (lint rules are `zone-pressure-off-target`): hyphens allowed. */
const STORED_BARE_ID = /^[a-z][a-z0-9_-]*(?:[.:][a-z0-9][a-z0-9_-]*)*$/;

function isStoredBareId(id: string): boolean {
  return id.length <= REGISTRY_ID_MAX_LENGTH && STORED_BARE_ID.test(id);
}

/** Check one contribution's item ids against the pack namespace. `bareIds`: the pack `keepsBareIds`. */
export function contributionProblems(packId: string, c: ErasedContribution, bareIds = false): string[] {
  if (!c.idOf) return [];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const item of c.items) {
    const id = c.idOf(item);
    if (!isRegistryIdShape(id) && !(bareIds && isStoredBareId(id))) problems.push(`pack ${packId}: ${c.pointLabel} id "${id}" is not a registry id (lower case, dots or colons, at most ${REGISTRY_ID_MAX_LENGTH} characters)`);
    else if (c.namespaced && !bareIds && !id.startsWith(`${packId}.`)) problems.push(`pack ${packId}: ${c.pointLabel} id "${id}" must start with "${packId}."`);
    if (seen.has(id)) problems.push(`pack ${packId}: ${c.pointLabel} id "${id}" is contributed twice`);
    seen.add(id);
  }
  return problems;
}

/** Define a pack. Throws `PackDefinitionError` listing every problem. */
export function definePack(manifest: PackManifest, contributions: readonly ErasedContribution[]): Pack {
  const bare = keepsBareIds(manifest);
  const problems = [...manifestProblems(manifest), ...contributions.flatMap((c) => contributionProblems(manifest.id, c, bare))];
  if (problems.length > 0) throw new PackDefinitionError(problems);
  return Object.freeze({ manifest: Object.freeze({ ...manifest }), contributions: Object.freeze([...contributions]) });
}

// ---------------------------------------------------------------------------
// Semver, the small subset packs use.

interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

export function parseVersion(text: string): Version | null {
  const m = SEMVER_PATTERN.exec(text.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function compare(a: Version, b: Version): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

type Comparator = { readonly op: ">=" | ">" | "<=" | "<" | "="; readonly v: Version };

function comparators(range: string): Comparator[] | null {
  const r = range.trim();
  if (r === "*" || r === "") return [];
  const out: Comparator[] = [];
  for (const part of r.split(/\s+/)) {
    const caret = /^\^(.+)$/.exec(part);
    const tilde = /^~(.+)$/.exec(part);
    const op = /^(>=|<=|>|<|=)?(.+)$/.exec(part);
    if (caret?.[1]) {
      const v = parseVersion(caret[1]);
      if (!v) return null;
      const upper: Version = v.major > 0 ? { major: v.major + 1, minor: 0, patch: 0 } : { major: 0, minor: v.minor + 1, patch: 0 };
      out.push({ op: ">=", v }, { op: "<", v: upper });
    } else if (tilde?.[1]) {
      const v = parseVersion(tilde[1]);
      if (!v) return null;
      out.push({ op: ">=", v }, { op: "<", v: { major: v.major, minor: v.minor + 1, patch: 0 } });
    } else if (op?.[2]) {
      const v = parseVersion(op[2]);
      if (!v) return null;
      out.push({ op: (op[1] as Comparator["op"] | undefined) ?? "=", v });
    } else return null;
  }
  return out;
}

export function isRangeShape(range: string): boolean {
  return comparators(range) !== null;
}

/** Whether `version` falls in `range`. An unreadable version or range never satisfies. */
export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version);
  const cs = comparators(range);
  if (!v || !cs) return false;
  return cs.every(({ op, v: bound }) => {
    const c = compare(v, bound);
    return op === ">=" ? c >= 0 : op === ">" ? c > 0 : op === "<=" ? c <= 0 : op === "<" ? c < 0 : c === 0;
  });
}
