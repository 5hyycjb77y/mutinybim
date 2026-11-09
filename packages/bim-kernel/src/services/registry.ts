import { isRegistryIdShape, rawRegistryWords, REGISTRY_ID_MAX_LENGTH, REGISTRY_ID_PATTERN } from "../ids";
import { disciplineAncestors } from "../disciplines/registry";
import { defineExtensionPoint } from "../packs/contract";
import type { FirstPartyPackId } from "../packs/first-party/manifests";
import { activePackSet } from "../packs/scope";
import { BUILTIN_PACK_SET, firstPartyBaseRevision, firstPartyOwnerOf, packSetReadsRecorded, type PackSet } from "../packs/set";
import type { Discipline } from "../types";
import { BUILTIN_LOAD_SERVICE_IDS, BUILTIN_SERVICES, BUILTIN_SYSTEM_KIND_IDS, LEGACY_SYSTEM_KIND_IDS, REGISTRY_SYSTEM_KIND_IDS, type ServiceFlowUnit, type ServicePipeFamily, type ServiceRow } from "./builtin";
import { KNOWN_SERVICE_CONNECTORS, KNOWN_SERVICE_REGIMES, type ServiceAdapterId, type ServiceConnector, type ServiceId } from "./types";

/**
 * One list of what flows (KERNEL-FOUNDATION §3.5). The system kinds, the load
 * services and the connector domains are views of these rows; their strings
 * are row ids and never change.
 *
 * A registry is an immutable value built from rows, so a firm's or a later
 * trade's services layer in as library data (`withFirmServices`) with no code
 * change and no global state: the host builds the firm registry once and
 * passes it to whatever reads services. Every function takes the registry to
 * read, defaulting to the built-in one.
 *
 * Readers tolerate ids they don't know (a newer peer's row, a firm row this
 * host hasn't loaded): lookups answer null and labels fall back to the raw id
 * in words. Writers validate against the registry at command time
 * (`services/write-gate.ts`).
 */

export interface ServiceRegistry {
  readonly rows: readonly ServiceRow[];
  readonly byId: ReadonlyMap<ServiceId, ServiceRow>;
  /** Rows a drawn system or a connector can carry, in view order. */
  readonly systemKindIds: readonly ServiceId[];
  /** Rows a load can need, in view order. */
  readonly loadServiceIds: readonly ServiceId[];
  /** What drawn services connect to ("duct", "pipe", "electrical"), first-seen order. */
  readonly connectorIds: readonly Exclude<ServiceConnector, "none">[];
}

/** A row id in the one registry id grammar (`ids.ts`): bare built-ins, `firm:<slug>`, `<namespace>.<name>`. Readers accept any id this shape. */
export const SERVICE_ID_PATTERN = REGISTRY_ID_PATTERN;
export const SERVICE_ID_MAX = REGISTRY_ID_MAX_LENGTH;

export function isServiceIdShape(id: unknown): id is ServiceId {
  return isRegistryIdShape(id);
}

/** A regime and connector this release walks. A row outside them is listed (labels, pickers, IFC), never walked by an adapter. */
export function isWalkedService(row: ServiceRow): boolean {
  return walkable(row);
}

function walkable(row: ServiceRow): boolean {
  return (KNOWN_SERVICE_REGIMES as readonly string[]).includes(row.regime) && (KNOWN_SERVICE_CONNECTORS as readonly string[]).includes(row.connector);
}

export interface ViewOrder {
  /** Ids listed first, in this order, then the other rows in row order. */
  readonly system?: readonly ServiceId[];
  readonly load?: readonly ServiceId[];
  /** Rows with these ids first, in this order, then the rest as given (so the connector domains' first-seen order holds too). */
  readonly rows?: readonly ServiceId[];
}

function rowsInOrder(rows: readonly ServiceRow[], first: readonly ServiceId[]): readonly ServiceRow[] {
  const rank = new Map(first.map((id, i) => [id, i] as const));
  const head = rows.filter((r) => rank.has(r.id)).sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
  if (head.length === 0) return rows;
  const out = [...head, ...rows.filter((r) => !rank.has(r.id))];
  return out.every((r, i) => r === rows[i]) ? rows : out;
}

function ordered(ids: readonly ServiceId[], first: readonly ServiceId[] | undefined): ServiceId[] {
  if (!first) return [...ids];
  const present = new Set(ids);
  const head = first.filter((id) => present.has(id));
  const listed = new Set(head);
  return [...head, ...ids.filter((id) => !listed.has(id))];
}

/** Build a registry from rows. Throws on a duplicate id, a malformed id or a `carriedBy` that names no system row: a broken list must never ship. */
export function createServiceRegistry(given: readonly ServiceRow[], order: ViewOrder = {}): ServiceRegistry {
  const rows = order.rows ? rowsInOrder(given, order.rows) : given;
  const byId = new Map<ServiceId, ServiceRow>();
  for (const row of rows) {
    if (!isServiceIdShape(row.id)) throw new Error(`[services] "${row.id}" isn't a service id (lower snake case, firm: or namespace. prefixed, at most ${SERVICE_ID_MAX} characters)`);
    if (byId.has(row.id)) throw new Error(`[services] two rows are both "${row.id}"`);
    byId.set(row.id, row);
  }
  for (const row of rows) {
    if (row.carriedBy === undefined) continue;
    const carrier = byId.get(row.carriedBy);
    if (!carrier?.asSystem) throw new Error(`[services] "${row.id}" is carried by "${row.carriedBy}", which is not a system row`);
  }
  const connectorIds: Exclude<ServiceConnector, "none">[] = [];
  for (const row of rows) if (row.asSystem && row.connector !== "none" && !connectorIds.includes(row.connector)) connectorIds.push(row.connector);
  return {
    rows,
    byId,
    systemKindIds: ordered(rows.filter((r) => r.asSystem).map((r) => r.id), order.system),
    loadServiceIds: ordered(rows.filter((r) => r.asLoad).map((r) => r.id), order.load),
    connectorIds,
  };
}

export interface ServiceRowsOptions {
  /** Who adds them: a firm's library (`firm:<slug>` ids) or a discipline pack (`<namespace>.<name>` ids). */
  readonly source: "firm" | "pack";
}

/** Whether `id` is the shape `source` may add: firm rows `firm:<slug>`, pack rows `<namespace>.<name>`. Bare ids are the kernel's built-ins, reserved. */
function addableId(id: string, source: ServiceRowsOptions["source"]): boolean {
  if (!isRegistryIdShape(id)) return false;
  return source === "firm" ? /^firm:[a-z0-9][a-z0-9_]*$/.test(id) : /^[a-z][a-z0-9_]*\.[a-z0-9][a-z0-9_.]*$/.test(id);
}

/**
 * The seam for firm and pack rows: the base registry with `rows` after it.
 * Bare ids are reserved for built-ins (a firm or pack can't redefine one, so
 * every model's built-in strings mean the same everywhere). Their system and
 * load views come after the base's. Pure data in, a new registry out.
 */
export function withServiceRows(base: ServiceRegistry, rows: readonly ServiceRow[], opts: ServiceRowsOptions): ServiceRegistry {
  for (const row of rows) {
    if (!addableId(row.id, opts.source)) {
      const want = opts.source === "firm" ? "a firm: id (firm:kitchen_exhaust)" : "a namespaced id (fp.sprinkler_wet)";
      throw new Error(`[services] a ${opts.source} row needs ${want}; "${row.id}" ${isRegistryIdShape(row.id) && !/[.:]/.test(row.id) ? "would redefine a built-in service" : "isn't one"}`);
    }
  }
  return createServiceRegistry([...base.rows, ...rows], { system: base.systemKindIds, load: base.loadServiceIds });
}

/** A firm's library rows (`firm:` ids): `withServiceRows` with source "firm". */
export function withFirmServices(base: ServiceRegistry, firmRows: readonly ServiceRow[]): ServiceRegistry {
  return withServiceRows(base, firmRows, { source: "firm" });
}

/** The load services that are no system kind, in the load view's order. */
const LOAD_ONLY_IDS: readonly ServiceId[] = BUILTIN_LOAD_SERVICE_IDS.filter((id) => !(BUILTIN_SYSTEM_KIND_IDS as readonly string[]).includes(id));

/**
 * The built-in views' frozen order: the stored system kinds and load services
 * in the order every deployed reader lists them, and the rows themselves in
 * round 13's order (legacy system kinds, load-only services, the registry's
 * kinds), whichever first-party add-on supplies them in whatever install order.
 */
export const BUILTIN_VIEW_ORDER: ViewOrder = { system: BUILTIN_SYSTEM_KIND_IDS, load: BUILTIN_LOAD_SERVICE_IDS, rows: [...LEGACY_SYSTEM_KIND_IDS, ...LOAD_ONLY_IDS, ...REGISTRY_SYSTEM_KIND_IDS] };

/** A built-in registry from rows in any order: the views come out in the frozen order (`BUILTIN_VIEW_ORDER`). */
export function builtinServiceRegistry(rows: readonly ServiceRow[]): ServiceRegistry {
  return createServiceRegistry(rows, BUILTIN_VIEW_ORDER);
}

/** The kernel's own rows only (Other). Every trade's rows are its first-party add-on's: read `activeServiceRegistry()`, or `firstPartyServiceRegistry()` for every model's base. */
export const BUILTIN_SERVICE_REGISTRY: ServiceRegistry = builtinServiceRegistry(BUILTIN_SERVICES);

/** Services (v1): what flows. A first-party add-on's rows keep their stored bare ids; any other pack's are `<pack>.<name>` (`struct.gravity_load`). */
export const SERVICE_POINT = defineExtensionPoint<ServiceRow>({
  id: "kernel.service",
  version: 1,
  label: "Services",
  idOf: (row) => row.id,
  builtins: () => BUILTIN_SERVICE_REGISTRY.rows,
});

/** Whether two rows are the same row byte for byte. */
function sameServiceRow(a: ServiceRow, b: ServiceRow): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** `rows` without the rows `base` already holds unchanged; a first-party row that differs from one is refused. */
function addedServiceRows(base: ServiceRegistry, rows: readonly ServiceRow[]): readonly ServiceRow[] {
  const out: ServiceRow[] = [];
  for (const row of rows) {
    const had = base.byId.get(row.id);
    if (!had) {
      out.push(row);
      continue;
    }
    // The kernel's own row byte for byte: the same row, nothing added.
    if (sameServiceRow(had, row)) continue;
    // Another add-on redefining a built-in: kept so `withServiceRows` refuses it in words.
    if (firstPartyOwnerOf(SERVICE_POINT, row.id) === null) {
      out.push(row);
      continue;
    }
    const message = `[services] the ${firstPartyOwnerOf(SERVICE_POINT, row.id)} add-on's "${row.id}" row differs from the built-in row it replaces; a built-in service's meaning can't change`;
    console.error(message, { id: row.id });
    throw new Error(message);
  }
  return out.length === rows.length ? rows : out;
}

/** The installed first-party add-on a bare-id row comes from, for listing; null for the kernel's own rows and any other pack's. */
export function serviceRowOwner(row: Pick<ServiceRow, "id">): FirstPartyPackId | null {
  return /[.:]/.test(row.id) ? null : firstPartyOwnerOf(SERVICE_POINT, row.id);
}

/** The kernel's rows with every installed first-party add-on's: the services every model has before its own add-ons. */
export function firstPartyServiceRegistry(): ServiceRegistry {
  return BUILTIN_PACK_SET.memo("kernel.service.registry", registryOf);
}

/**
 * `base` with a pack set's service rows after it; `base` itself when the set
 * adds none. A first-party add-on's bare-id row `base` doesn't hold (installed
 * or only in this set) joins as a built-in, in the frozen order (`BUILTIN_VIEW_ORDER`);
 * every other row is a pack row (`withServiceRows`, source "pack").
 */
export function withPackServices(base: ServiceRegistry, set: PackSet = activePackSet()): ServiceRegistry {
  const rows = addedServiceRows(base, set.packItems(SERVICE_POINT));
  if (rows.length === 0) return base;
  // Only a first-party add-on keeps bare ids (`definePack` refuses any other), installed or only in this set.
  const builtins = rows.filter((r) => !/[.:]/.test(r.id));
  const withBuiltins = builtins.length === 0 ? base : createServiceRegistry([...base.rows, ...builtins], BUILTIN_VIEW_ORDER);
  const packRows = builtins.length === 0 ? rows : rows.filter((r) => !builtins.includes(r));
  return packRows.length === 0 ? withBuiltins : withServiceRows(withBuiltins, packRows, { source: "pack" });
}

/**
 * The registry readers use when none is passed: the built-in rows plus the
 * rows of the pack set in force, built once per set. Outside any pack scope
 * it is `firstPartyServiceRegistry()`. A host with firm rows composes
 * `withFirmServices(withPackServices(BUILTIN_SERVICE_REGISTRY, set), rows)`.
 */
let last: { readonly set: PackSet; readonly revision: number; readonly registry: ServiceRegistry } | null = null;

const registryOf = (set: PackSet): ServiceRegistry => withPackServices(BUILTIN_SERVICE_REGISTRY, set);

export function activeServiceRegistry(): ServiceRegistry {
  const set = activePackSet();
  const revision = firstPartyBaseRevision();
  if (last !== null && last.set === set && last.revision === revision && !packSetReadsRecorded()) return last.registry;
  const registry = set.memo("kernel.service.registry", registryOf);
  // A recorded pass comes through here once per check: keep the holder when nothing changed.
  if (last === null || last.registry !== registry || last.set !== set || last.revision !== revision) last = { set, revision, registry };
  return registry;
}

/** The row, or null for an id this registry doesn't know. */
export function serviceById(id: string, registry: ServiceRegistry = activeServiceRegistry()): ServiceRow | null {
  return registry.byId.get(id) ?? null;
}

export function systemKindIds(registry: ServiceRegistry = activeServiceRegistry()): readonly ServiceId[] {
  return registry.systemKindIds;
}

export function loadServiceIds(registry: ServiceRegistry = activeServiceRegistry()): readonly ServiceId[] {
  return registry.loadServiceIds;
}

export function connectorDomainIds(registry: ServiceRegistry = activeServiceRegistry()): readonly Exclude<ServiceConnector, "none">[] {
  return registry.connectorIds;
}

export function isKnownSystemKind(id: string, registry: ServiceRegistry = activeServiceRegistry()): boolean {
  return registry.byId.get(id)?.asSystem === true;
}

export function isKnownLoadService(id: string, registry: ServiceRegistry = activeServiceRegistry()): boolean {
  return registry.byId.get(id)?.asLoad === true;
}

/** The system row that carries a load service: `cold_water` → domestic cold water, `sanitary` → sanitary. Null when it is carried by no drawn system (`heat_gain`) or unknown. */
export function serviceForLoad(loadService: string, registry: ServiceRegistry = activeServiceRegistry()): ServiceRow | null {
  const row = registry.byId.get(loadService);
  if (!row?.asLoad) return null;
  if (row.asSystem) return row;
  return row.carriedBy ? (registry.byId.get(row.carriedBy) ?? null) : null;
}

/** "grease_waste" → "Grease waste", "fp.sprinkler_wet" → "Sprinkler wet": how an id nobody registered still reads to a person. */
export function rawServiceLabel(id: string): string {
  return id.trim() === "" ? "Other" : rawRegistryWords(id);
}

/** What a person reads for a service id: its row's label, or the raw id in words when this reader doesn't know it. */
export function serviceLabel(id: string, registry: ServiceRegistry = activeServiceRegistry()): string {
  return registry.byId.get(id)?.label ?? rawServiceLabel(id);
}

/** The system rows a network adapter walks, in view order. */
const KINDS_BY_ADAPTER = new WeakMap<ServiceRegistry, Map<ServiceAdapterId, readonly ServiceId[]>>();

/** The walked system kinds a trade adapter carries, in view order; the same array for the same registry, so a reader may key a cache on it. */
export function systemKindsWithAdapter(adapter: ServiceAdapterId, registry: ServiceRegistry = activeServiceRegistry()): readonly ServiceId[] {
  let byAdapter = KINDS_BY_ADAPTER.get(registry);
  if (!byAdapter) KINDS_BY_ADAPTER.set(registry, (byAdapter = new Map()));
  let kinds = byAdapter.get(adapter);
  if (!kinds) {
    kinds = registry.systemKindIds.filter((id) => {
      const r = registry.byId.get(id);
      return r !== undefined && r.adapter === adapter && walkable(r);
    });
    byAdapter.set(adapter, kinds);
  }
  return kinds;
}

/** The system rows a source node role serves (a water heater: domestic hot water). */
export function systemKindsServedBy(role: string, registry: ServiceRegistry = activeServiceRegistry()): readonly ServiceId[] {
  return registry.systemKindIds.filter((id) => {
    const r = registry.byId.get(id);
    return r !== undefined && r.sourceRoles?.includes(role) === true && walkable(r);
  });
}

const DRAINS_BY_REGISTRY = new WeakMap<ServiceRegistry, ReadonlySet<ServiceId>>();

/** Gravity liquid pipe systems: what diagrams draw toward an outfall and drainage sizes by fixture units (sanitary, storm, condensate, grease and indirect waste). Vent is gravity air, not a drain. */
export function drainSystemKinds(registry: ServiceRegistry = activeServiceRegistry()): ReadonlySet<ServiceId> {
  let drains = DRAINS_BY_REGISTRY.get(registry);
  if (!drains) {
    drains = new Set(registry.systemKindIds.filter((id) => {
      const r = registry.byId.get(id);
      return r !== undefined && r.regime === "gravity" && r.medium === "liquid" && r.connector === "pipe";
    }));
    DRAINS_BY_REGISTRY.set(registry, drains);
  }
  return drains;
}

/** A system row's pipe hydraulics family; null for ducts, wires and pipe nobody sizes (refrigerant, fire protection, unknown ids). */
export function pipeFamilyOf(kind: string, registry: ServiceRegistry = activeServiceRegistry()): ServicePipeFamily | null {
  const row = registry.byId.get(kind);
  return row?.asSystem && row.connector === "pipe" ? (row.pipeFamily ?? null) : null;
}

/** The one quantity a load on a run of this system adds (`load.dfu` → "dfu"); null when it carries nothing to size or is unknown. */
export function primaryQuantityKeyOf(kind: string, registry: ServiceRegistry = activeServiceRegistry()): string | null {
  const first = registry.byId.get(kind)?.quantities[0];
  return first ? first.replace(/^load\./, "") : null;
}

/** A system row's routing rules as plain data: what `routing/rules.ts` `systemRules(kind)` answers, derived from the row. */
export interface ServiceRoutingRules {
  readonly domain: "duct" | "pipe" | "conduit";
  /** One of the six drawn disciplines. A row of another discipline routes under its nearest drawn ancestor, else as mechanical, as an unknown kind does. */
  readonly discipline: Discipline;
  readonly label: string;
  readonly branch: "tap" | "tee" | "wye";
  readonly flowUnit: ServiceFlowUnit;
  readonly branchMayEqualTrunk: boolean;
}

const DRAWN_DISCIPLINES: readonly string[] = ["architecture", "structure", "mechanical", "plumbing", "electrical", "fire_protection"] satisfies readonly Discipline[];

function isDrawnDiscipline(d: string): d is Discipline {
  return DRAWN_DISCIPLINES.includes(d);
}

/**
 * A row's discipline as one of the six drawn disciplines: itself, else its
 * nearest registered ancestor that is one (a fire alarm row draws as fire
 * protection); any other reads as mechanical (the fallback unknown kinds
 * already use).
 */
export function drawnDiscipline(d: ServiceRow["discipline"]): Discipline {
  if (isDrawnDiscipline(d)) return d;
  return disciplineAncestors(d).find(isDrawnDiscipline) ?? "mechanical";
}

/** Routing rules for a system id; an unknown id routes as "Other" pipe under its own words, so a reader never crashes on a newer peer's kind. */
export function serviceRoutingRules(kind: string, registry: ServiceRegistry = activeServiceRegistry()): ServiceRoutingRules {
  const row = registry.byId.get(kind);
  if (!row?.asSystem) return { domain: "pipe", discipline: "mechanical", label: rawServiceLabel(kind), branch: "tee", flowUnit: "", branchMayEqualTrunk: true };
  // Listed, not walked: a connector or regime this release doesn't route still reads, as Other pipe under its own label.
  if (!walkable(row) || (row.connector !== "duct" && row.connector !== "pipe" && row.connector !== "electrical")) return { domain: "pipe", discipline: drawnDiscipline(row.discipline), label: row.label, branch: "tee", flowUnit: "", branchMayEqualTrunk: true };
  const domain = row.connector === "duct" ? "duct" : row.connector === "electrical" ? "conduit" : "pipe";
  return {
    domain,
    discipline: drawnDiscipline(row.discipline),
    label: row.label,
    branch: domain === "duct" ? "tap" : row.regime === "gravity" ? "wye" : "tee",
    flowUnit: row.flowUnit ?? "",
    branchMayEqualTrunk: domain !== "duct",
  };
}

/** What a Route tool offers for one connector: every system row on it, legacy rows first, then new and firm rows the peer can store. */
export function routeServiceChoices(connector: Exclude<ServiceConnector, "none">, canWrite: (row: ServiceRow) => boolean = () => true, registry: ServiceRegistry = activeServiceRegistry()): readonly { readonly kind: ServiceId; readonly label: string }[] {
  const out: { kind: ServiceId; label: string }[] = [];
  for (const id of registry.systemKindIds) {
    const row = registry.byId.get(id);
    if (row && row.connector === connector && id !== "other" && canWrite(row)) out.push({ kind: id, label: row.label });
  }
  return out;
}

const LEGACY_SYSTEM: ReadonlySet<string> = new Set(LEGACY_SYSTEM_KIND_IDS);
const LEGACY_LOAD: ReadonlySet<string> = new Set(BUILTIN_LOAD_SERVICE_IDS);

/**
 * The protocol feature a peer must advertise before this id may be written in
 * this view, or null when every deployed reader already reads it. A row's
 * `feature` gates only the views it is new to: grease waste has always been a
 * load service (no gate there) and is a system kind only from this release.
 */
export function serviceWriteFeature(id: string, view: "system" | "load", registry: ServiceRegistry = activeServiceRegistry()): string | null {
  if ((view === "system" ? LEGACY_SYSTEM : LEGACY_LOAD).has(id)) return null;
  return registry.byId.get(id)?.feature ?? null;
}
