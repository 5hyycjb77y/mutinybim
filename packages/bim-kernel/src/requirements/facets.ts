import { QUANTITY_BINDINGS } from "@permitzip/bim-units";
import { CATALOG_TRADES, connectionTypeTrade, type CatalogTrade, type ConnectionTypeEntry } from "../catalog/types";
import { QUANTITIES, quantityValueLabel, totalsOf, type QuantityKey, type QuantityTotals } from "../quantities";
import type { Kind, UnitCode } from "../registry/units";
import type { LoadService } from "./types";
import { isRegistryIdShape, rawRegistryWords } from "../ids";
import { defineExtensionPoint } from "../packs/contract";
import { activePackSet } from "../packs/scope";
import { packSetReadsRecorded, type PackSet } from "../packs/set";
import type { ClassDiscipline } from "../registry/types";

/**
 * One shared `QuantityBag`, read in per-trade sections (KERNEL-REQUIREMENTS-MODEL
 * §3.5, "facets"): the fryer's connection type is one record whose bag holds
 * its power, its fuel input and its waste; shown in three sections. The bag stays the
 * storage and the one thing every total adds; sections are a derived view, so
 * no record changes shape and an old record reads as the sections its values
 * fill.
 *
 * Which sections exist, the quantities each groups, the trade it counts in
 * and the services that name it are rows (`LOAD_SECTION_POINT`, round 12),
 * one per trade, contributed by that trade's add-on.
 */

/** A load section's id (its row's `id`). */
export type LoadSection = string;

export interface LoadSectionRow {
  /** Stored nowhere; a first-party row keeps its bare id, another add-on's is `<pack>.<name>`. */
  readonly id: string;
  /** As printed ("Water"). */
  readonly label: string;
  /** Sections print in this order. */
  readonly order: number;
  /** The quantities it groups, in print order. */
  readonly quantities: readonly QuantityKey[];
  /** The catalog trade a load filling it counts in (where its pickers list it). */
  readonly trade: CatalogTrade;
  /** The services a load row names that count in this trade. */
  readonly services?: readonly LoadService[];
  /** For a quantity more than one row groups: whether this row reads it given the rest of the load. Absent: always (the last such row should leave it absent). */
  takesShared?(totals: QuantityTotals): boolean;
  /** A load row that names no service and fills no section counts in this row's trade (one row says so). */
  readonly unclaimedLoads?: boolean;
  /** A connection type's totals as this section reads them (a record's own field standing in for an empty bag value). */
  connectionTotals?(entry: ConnectionTypeEntry, totals: QuantityTotals): QuantityTotals;
  /** This section's view of a connection type when it reads differently from its quantities (a summary line); null: the ordinary view. */
  connectionView?(entry: ConnectionTypeEntry, totals: QuantityTotals): LoadSectionView | null;
}

/** Load sections (v1, round 12): the sections a load's quantities read in. */
export const LOAD_SECTION_POINT = defineExtensionPoint<LoadSectionRow>({
  id: "kernel.load_section",
  version: 1,
  label: "Load sections",
  idOf: (row) => row.id,
});

/** Problems with load section rows (pack conformance), in words. */
export function loadSectionRowProblems(rows: readonly LoadSectionRow[]): string[] {
  const out: string[] = [];
  for (const row of rows) {
    if (row.label.trim().length === 0) out.push(`load section ${row.id} has no label`);
    if (!Number.isFinite(row.order)) out.push(`load section ${row.id}: order must be a finite number`);
    if (row.quantities.length === 0) out.push(`load section ${row.id} groups no quantities`);
    for (const q of row.quantities) if (!(q in QUANTITIES)) out.push(`load section ${row.id}: "${q}" isn't a quantity`);
  }
  return out;
}

/** The set's rows, in print order. */
export function loadSectionRows(): readonly LoadSectionRow[] {
  return activePackSet().memo("kernel.load_section#rows", (set) => [...set.items(LOAD_SECTION_POINT)].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)));
}

/** Which section a quantity reads in, given the rest of the load (a quantity two rows group goes to the first that takes it). */
export function sectionOfQuantity(key: QuantityKey, totals?: QuantityTotals): LoadSection {
  const rows = loadSectionRows().filter((r) => r.quantities.includes(key));
  const only = rows.length === 1 ? rows[0] : undefined;
  if (only) return only.id;
  for (const row of rows) if (!row.takesShared || (totals !== undefined && row.takesShared(totals))) return row.id;
  throw new Error(`Quantity ${key} has no load section`);
}

export interface LoadSectionQuantity {
  readonly key: QuantityKey;
  readonly label: string;
  readonly value: number;
  /** Typed unit for display and conversion (bim-units). */
  readonly kind: Kind;
  readonly unit: UnitCode;
  /** "12 gph", "min inlet 7 in. w.c. (0.253 psi)". */
  readonly text: string;
}

export interface LoadSectionView {
  readonly section: LoadSection;
  readonly label: string;
  readonly quantities: readonly LoadSectionQuantity[];
  /** One line: the quantities' texts, joined ("1 gpm, 12 gph"). */
  readonly summary: string;
}

/** Units that count each side say which side they are: "1.5 WSFU cold". */
const SIDE_WORD: Partial<Record<QuantityKey, string>> = { wsfu_cold: " cold", wsfu_hot: " hot", wsfu_total: " total" };

function quantity(key: QuantityKey, value: number): LoadSectionQuantity {
  const b = QUANTITY_BINDINGS[key];
  return { key, label: QUANTITIES[key].label, value, kind: b.kind, unit: b.unit, text: `${quantityValueLabel(key, value)}${SIDE_WORD[key] ?? ""}` };
}

/**
 * The sections a load fills, without building display text: the same rule as
 * `loadSections` (a section counts when one of its quantities is non-zero and
 * belongs to it), cheap enough to run for every load of a 250k model.
 */
export function loadSectionsPresent(totals: QuantityTotals): LoadSection[] {
  const out: LoadSection[] = [];
  for (const row of loadSectionRows()) {
    for (const key of row.quantities) {
      if (totals[key] !== 0 && sectionOfQuantity(key, totals) === row.id) {
        out.push(row.id);
        break;
      }
    }
  }
  return out;
}

/** The sections a set of totals fills, in row order; empty sections are left out. */
export function loadSections(totals: QuantityTotals): LoadSectionView[] {
  const out: LoadSectionView[] = [];
  for (const row of loadSectionRows()) {
    const quantities: LoadSectionQuantity[] = [];
    for (const key of row.quantities) {
      const v = totals[key];
      if (v === 0 || sectionOfQuantity(key, totals) !== row.id) continue;
      quantities.push(quantity(key, v));
    }
    if (quantities.length === 0) continue;
    out.push({ section: row.id, label: row.label, quantities, summary: quantities.map((q) => q.text).join(", ") });
  }
  return out;
}

/**
 * A connection type's sections: its bag, as each row reads the record (a
 * row may stand a record's own field in for an empty bag value), and any
 * row's own view of it first (a summary line instead of the bare quantity).
 */
export function connectionTypeSections(entry: ConnectionTypeEntry): LoadSectionView[] {
  const rows = loadSectionRows();
  let totals = totalsOf(entry.quantities);
  for (const row of rows) if (row.connectionTotals) totals = row.connectionTotals(entry, totals);
  const sections = loadSections(totals);
  const views: LoadSectionView[] = [];
  for (const row of rows) {
    const view = row.connectionView?.(entry, totals);
    if (view) views.push(view);
  }
  if (views.length === 0) return sections;
  return [...views, ...sections.filter((s) => !views.some((v) => v.section === s.section))];
}

/** The catalog trade a section counts in, from its row. */
function sectionTrade(section: LoadSection): CatalogTrade | null {
  return loadSectionRows().find((r) => r.id === section)?.trade ?? null;
}

/**
 * The trades a load counts in for progress ("Water: 5 of 35 piped"): the
 * service it names, plus every trade its
 * values fill, plus its connection type's trade. A load that counts in more
 * than one section counts in each of their trades. A row that says nothing
 * yet (no service, no values, no connection type: 7329's dipper wells and ice
 * bin) counts in the trade of the row that takes unclaimed loads, as every
 * load row did before trades.
 */
export function loadTradesOf(service: LoadService | undefined, value: QuantityTotals, connectionTrade?: CatalogTrade): CatalogTrade[] {
  const rows = loadSectionRows();
  const out = new Set<CatalogTrade>();
  if (service) {
    const row = rows.find((r) => r.services?.includes(service));
    if (row) out.add(row.trade);
  }
  if (connectionTrade) out.add(connectionTrade);
  for (const section of loadSectionsPresent(value)) {
    const t = sectionTrade(section);
    if (t) out.add(t);
  }
  if (out.size === 0) {
    const unclaimed = rows.find((r) => r.unclaimedLoads);
    if (unclaimed) out.add(unclaimed.trade);
  }
  return CATALOG_TRADES.filter((t) => out.has(t));
}

/**
 * The trades a connection type serves: the one it was saved under, plus every
 * trade whose section it fills (a record saved under one trade with another
 * trade's values also serves that trade).
 */
export function connectionTypeTrades(entry: ConnectionTypeEntry): CatalogTrade[] {
  const out: CatalogTrade[] = [connectionTypeTrade(entry)];
  for (const s of connectionTypeSections(entry)) {
    const t = sectionTrade(s.section);
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

// ---------------------------------------------------------------- parameter facets (round 5b)

/**
 * The sections an element's parameters read in, wherever they are listed:
 * the Inspector, the equipment list's column groups, a schedule builder's
 * field picker (KERNEL-FOUNDATION §3.2). Facets are data (FOUNDATION
 * adjustments D1): rows with an id, a label and an order, in an immutable
 * registry value built from the built-in rows plus library rows, passed to
 * whatever groups parameters (the built-in registry by default). No global
 * state, so one firm's rows never reach another firm's models (H2).
 *
 * A parameter names its facet through its `group`, matched against facet
 * ids and labels with case and spacing ignored. There is no guessing from
 * keys or units here: a group the registry doesn't know ("Kitchen") is its
 * own section after the known ones, and a parameter with no group reads in
 * "Other", last. A stored facet id this release doesn't know shows its raw
 * words (`rawRegistryWords`).
 */
export interface FacetDef {
  /** Registry id (`isRegistryIdShape`): bare for built-in rows, `firm:<slug>` or `<namespace>.<name>` otherwise. */
  readonly id: string;
  readonly label: string;
  /** Sections sort by this, then by id. */
  readonly order: number;
  readonly discipline?: ClassDiscipline;
}

export interface FacetRegistry {
  readonly rows: readonly FacetDef[];
  readonly byId: ReadonlyMap<string, FacetDef>;
  /** Normalised id and label → row. */
  readonly byWord: ReadonlyMap<string, FacetDef>;
}

export const BUILTIN_FACETS: readonly FacetDef[] = [
  { id: "identity", label: "Identity", order: 10, discipline: "general" },
  { id: "electrical", label: "Electrical", order: 20, discipline: "electrical" },
  { id: "gas", label: "Gas", order: 30, discipline: "plumbing" },
  { id: "water", label: "Water", order: 40, discipline: "plumbing" },
  { id: "drainage", label: "Drainage", order: 50, discipline: "plumbing" },
  { id: "mechanical", label: "Mechanical", order: 60, discipline: "mechanical" },
  { id: "structural", label: "Structural", order: 70, discipline: "structure" },
  { id: "fire_protection", label: "Fire protection", order: 80, discipline: "fire_protection" },
  { id: "architecture", label: "Architecture", order: 90, discipline: "architecture" },
  { id: "civil", label: "Civil", order: 100, discipline: "civil" },
  { id: "construction", label: "Construction", order: 110, discipline: "general_contracting" },
];

/** "Fire protection", "fire_protection" and " FIRE  PROTECTION " are one word. */
export function facetWord(text: string): string {
  return text.trim().toLowerCase().replace(/[\s_-]+/g, " ");
}

/** Build a registry from rows. Throws on a malformed or duplicate id, or two rows answering to the same word: a broken list must never ship. */
export function createFacetRegistry(rows: readonly FacetDef[]): FacetRegistry {
  const byId = new Map<string, FacetDef>();
  const byWord = new Map<string, FacetDef>();
  for (const row of rows) {
    if (!isRegistryIdShape(row.id)) throw new Error(`[facets] "${row.id}" isn't a registry id`);
    if (byId.has(row.id)) throw new Error(`[facets] two rows are both "${row.id}"`);
    byId.set(row.id, row);
    for (const word of new Set([facetWord(row.id), facetWord(row.label)])) {
      const other = byWord.get(word);
      if (other) throw new Error(`[facets] "${row.id}" and "${other.id}" both answer to "${word}"`);
      byWord.set(word, row);
    }
  }
  const sorted = [...rows].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  return { rows: sorted, byId, byWord };
}

export const BUILTIN_FACET_REGISTRY: FacetRegistry = createFacetRegistry(BUILTIN_FACETS);

/** The base registry with library rows after it. Library rows can't reuse a built-in id or word (built-in rows are reserved). */
export function withFacetRows(base: FacetRegistry, rows: readonly FacetDef[]): FacetRegistry {
  return createFacetRegistry([...base.rows, ...rows]);
}

/** Facets (v1): the sections parameters read in. A pack's are `<pack>.<name>`; its words may not repeat a built-in row's. */
export const FACET_POINT = defineExtensionPoint<FacetDef>({
  id: "kernel.facet",
  version: 1,
  label: "Parameter facets",
  idOf: (row) => row.id,
  builtins: () => BUILTIN_FACETS,
});

/** The facets readers use when none is passed: built-ins plus the pack set's rows, built once per set. */
let last: { readonly set: PackSet; readonly registry: FacetRegistry } | null = null;

export function activeFacetRegistry(): FacetRegistry {
  const set = activePackSet();
  if (last !== null && last.set === set && !packSetReadsRecorded()) return last.registry;
  const registry = set.memo("kernel.facet.registry", () => {
    const rows = set.packItems(FACET_POINT);
    return rows.length === 0 ? BUILTIN_FACET_REGISTRY : withFacetRows(BUILTIN_FACET_REGISTRY, rows);
  });
  last = { set, registry };
  return registry;
}

/** The facet a group names, or null for a group the registry doesn't know (or no group). */
export function facetOfGroup(group: string | undefined, registry: FacetRegistry = activeFacetRegistry()): FacetDef | null {
  if (group === undefined || group.trim() === "") return null;
  return registry.byWord.get(facetWord(group)) ?? null;
}

/** A stored facet id as printed: the row's label, else the id's raw words. */
export function facetLabel(id: string, registry: FacetRegistry = activeFacetRegistry()): string {
  return registry.byId.get(id)?.label ?? rawRegistryWords(id);
}

export interface ParameterFacetGroup<T> {
  /** Stable, in the registry id grammar: the facet id, `unknownGroupId(group)` for a group the registry doesn't know, `other:other` for no group. */
  readonly id: string;
  /** The facet row's id; null for an unknown group or no group. */
  readonly facet: string | null;
  /** As printed: the facet's label, or the firm's own group name ("Kitchen"). */
  readonly label: string;
  readonly items: readonly T[];
}

const UNGROUPED_LABEL = "Other";

/** The stored id of a group the registry doesn't know: `other:<words>` in the registry id grammar ("Life safety" → `other:life_safety`). */
export function unknownGroupId(group: string): string {
  const slug = facetWord(group).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(\d)/, "g_$1") || "other";
  return `other:${slug}`.slice(0, 96);
}

/**
 * Parameters in sections: known facets in registry order, then each unknown
 * group in the order it first appears, then the ungrouped rest as "Other".
 * Order inside a section is the order given. Empty sections are left out.
 */
export function groupParametersByFacet<T extends { readonly group?: string }>(items: readonly T[], registry: FacetRegistry = activeFacetRegistry()): ParameterFacetGroup<T>[] {
  const known = new Map<string, T[]>();
  const other = new Map<string, { label: string; items: T[] }>();
  for (const item of items) {
    const facet = facetOfGroup(item.group, registry);
    if (facet) {
      const list = known.get(facet.id) ?? [];
      list.push(item);
      known.set(facet.id, list);
      continue;
    }
    const label = item.group?.trim() || UNGROUPED_LABEL;
    const id = facetWord(label);
    const entry = other.get(id) ?? { label, items: [] };
    entry.items.push(item);
    other.set(id, entry);
  }
  const out: ParameterFacetGroup<T>[] = [];
  for (const row of registry.rows) {
    const list = known.get(row.id);
    if (list && list.length > 0) out.push({ id: row.id, facet: row.id, label: row.label, items: list });
  }
  const unnamed = facetWord(UNGROUPED_LABEL);
  for (const [word, entry] of other) if (word !== unnamed) out.push({ id: unknownGroupId(entry.label), facet: null, label: entry.label, items: entry.items });
  const rest = other.get(unnamed);
  if (rest) out.push({ id: unknownGroupId(UNGROUPED_LABEL), facet: null, label: rest.label, items: rest.items });
  return out;
}
