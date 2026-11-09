import { defineExtensionPoint } from "../packs/contract";
import { activePackSet } from "../packs/scope";
import type { PackSet } from "../packs/set";

/**
 * One confidence scale for any value (round 11 D4, `kernel.value_basis` v1).
 *
 * Five ladders said "how sure / how far along" in five ways: a load's stage,
 * a price list's basis, a product's layer, a determination's confidence and a
 * rule's verification. One basis replaces them as what every reader shows:
 * how far along the value is (an open ladder of rungs, `BASIS_POINT`), where
 * it came from, and an optional high / medium / low. Old records keep their
 * stored fields; `readBasis` (basis/read.ts) maps each old ladder onto this
 * scale on read and writes nothing. A record with none of them reads
 * "not recorded".
 *
 * Stored on a record as `provenance.basis` (the whole record) and
 * `valueBasis[key]` (one value). Both fields' names and the rung ids are
 * stored forever; readers keep a rung, a source kind or a confidence this
 * release doesn't know.
 */

/** Peers read and store `provenance.basis` and `valueBasis`. A writer stores either only when every peer advertises it. */
export const VALUES_BASIS_FEATURE = "values:basis";

/** A rung on the maturity ladder (`BASIS_POINT` id). Open: a pack's own rung (`<pack>.<name>`) is kept. */
export type BasisId = string;

/** Where a value came from. Open: a pack's own kind is kept. */
export type BasisSourceKind = "person" | "agent" | "calc" | "vendor_doc" | "survey" | "lidar" | "old_drawings" | (string & {});

export const KNOWN_BASIS_SOURCE_KINDS: readonly BasisSourceKind[] = ["person", "agent", "calc", "vendor_doc", "survey", "lidar", "old_drawings"];

export type BasisConfidence = "high" | "medium" | "low" | (string & {});

export const KNOWN_BASIS_CONFIDENCES: readonly BasisConfidence[] = ["high", "medium", "low"];

export interface ValueBasis {
  /** How far along: a `BASIS_POINT` rung. */
  readonly maturity: BasisId;
  /** Where it came from; `ref` is opaque (a calc id, a document, a person's name). */
  readonly source?: { readonly kind: BasisSourceKind; readonly ref?: string };
  readonly confidence?: BasisConfidence;
  /** ISO 8601. */
  readonly at?: string;
}

/**
 * The ladders that came before this scale, by name. Each keeps its stored
 * field; a `BASIS_POINT` row says which of its values read as that rung.
 * Open: a pack maps its own ladder (`<pack>.<name>`).
 */
export type BasisLadder = "load_stage" | "cost_basis" | "product_layer" | "determination_confidence" | "rule_verification" | (string & {});

export const KNOWN_BASIS_LADDERS: readonly BasisLadder[] = ["load_stage", "cost_basis", "product_layer", "determination_confidence", "rule_verification"];

/** One old ladder value that reads as a rung (and, optionally, as a confidence or a source). */
export interface BasisLadderMap {
  readonly ladder: BasisLadder;
  readonly value: string;
  /** What the old value also says about confidence ("invalidated" reads low). */
  readonly confidence?: BasisConfidence;
  /** What the old value also says about the source ("agent_found" came from an agent). */
  readonly sourceKind?: BasisSourceKind;
}

/** One rung (v1). Built-in rungs have bare ids; a pack's are `<pack>.<name>`. */
export interface BasisRow {
  readonly id: BasisId;
  /** What a person reads in a confidence column ("Calculated"). */
  readonly label: string;
  /** Lower is earlier. Rungs sort by it; two rungs may share a number. */
  readonly order: number;
  /** Old ladder values that read as this rung. */
  readonly maps?: readonly BasisLadderMap[];
}

/** A determination's confidence is its own field, not a rung: it reads as `confidence`, at this rung. */
const DETERMINATION = (value: string): BasisLadderMap => ({ ladder: "determination_confidence", value, confidence: value });

/**
 * The built-in rungs, earliest first (D4), with the five old ladders mapped:
 *
 *   load_stage        estimate → rule of thumb, concentrated → calculated, device → selected
 *   cost_basis        estimate → calculated, budget → selected, contract and change_order →
 *                     submitted, actual → measured
 *   product_layer     design_basis → selected, submittal → submitted, field → installed
 *   determination     a recorded judgment is "selected"; its high / medium / low is the confidence
 *   rule_verification agent_found → assumed (from an agent), proposed → rule of thumb,
 *                     verified → calculated, invalidated → assumed (low)
 */
export const BUILTIN_BASIS_ROWS: readonly BasisRow[] = Object.freeze([
  {
    id: "assumed",
    label: "Assumed",
    order: 10,
    maps: [
      { ladder: "rule_verification", value: "agent_found", sourceKind: "agent" },
      { ladder: "rule_verification", value: "invalidated", confidence: "low" },
    ],
  },
  {
    id: "rule_of_thumb",
    label: "Rule of thumb",
    order: 20,
    maps: [
      { ladder: "load_stage", value: "estimate" },
      { ladder: "rule_verification", value: "proposed" },
    ],
  },
  {
    id: "calculated",
    label: "Calculated",
    order: 30,
    maps: [
      { ladder: "load_stage", value: "concentrated" },
      { ladder: "cost_basis", value: "estimate" },
      { ladder: "rule_verification", value: "verified" },
    ],
  },
  {
    id: "selected",
    label: "Selected",
    order: 40,
    maps: [{ ladder: "load_stage", value: "device" }, { ladder: "cost_basis", value: "budget" }, { ladder: "product_layer", value: "design_basis" }, DETERMINATION("high"), DETERMINATION("medium"), DETERMINATION("low")],
  },
  {
    id: "submitted",
    label: "Submitted",
    order: 50,
    maps: [
      { ladder: "cost_basis", value: "contract" },
      { ladder: "cost_basis", value: "change_order" },
      { ladder: "product_layer", value: "submittal" },
    ],
  },
  { id: "installed", label: "Installed", order: 60, maps: [{ ladder: "product_layer", value: "field" }] },
  { id: "measured", label: "Measured", order: 70, maps: [{ ladder: "cost_basis", value: "actual" }] },
  { id: "field_verified", label: "Field verified", order: 80 },
]);

export const BASIS_POINT = defineExtensionPoint<BasisRow>({
  id: "kernel.value_basis",
  version: 1,
  label: "Confidence rungs",
  idOf: (row) => row.id,
  builtins: () => BUILTIN_BASIS_ROWS,
});

/** What a confidence column shows for a record with no basis and no old ladder. */
export const BASIS_NOT_RECORDED = "not recorded";

/** The rungs in force and the old-ladder lookup, built once per set. */
export interface BasisTable {
  /** Every rung, earliest first. */
  readonly rows: readonly BasisRow[];
  row(id: BasisId): BasisRow | undefined;
  /** The rung (and what else it says) an old ladder value reads as; undefined when no row maps it. */
  ladder(ladder: BasisLadder, value: string): { readonly row: BasisRow; readonly map: BasisLadderMap } | undefined;
}

const TABLE_KEY = "kernel.value_basis#table";

function buildTable(items: readonly BasisRow[]): BasisTable {
  const byId = new Map<string, BasisRow>();
  const byLadder = new Map<string, { row: BasisRow; map: BasisLadderMap }>();
  for (const row of items) {
    if (byId.has(row.id)) {
      const message = `[bim-kernel/basis] two rows register the confidence rung "${row.id}"`;
      console.error(message);
      throw new Error(message);
    }
    byId.set(row.id, row);
    for (const map of row.maps ?? []) {
      const key = `${map.ladder}\u0000${map.value}`;
      // The first row that maps a value wins: built-ins first, then add-ons in set order.
      if (!byLadder.has(key)) byLadder.set(key, { row, map });
    }
  }
  const rows = [...byId.values()].sort((a, b) => a.order - b.order);
  return { rows, row: (id) => byId.get(id), ladder: (ladder, value) => byLadder.get(`${ladder}\u0000${value}`) };
}

export function basisTable(set: PackSet = activePackSet()): BasisTable {
  return set.memo(TABLE_KEY, () => buildTable(set.items(BASIS_POINT)));
}

/** Problems with rung rows, in words (pack conformance). */
export function basisRowProblems(rows: readonly BasisRow[]): string[] {
  const out: string[] = [];
  for (const row of rows) {
    if (row.label.trim().length === 0) out.push(`confidence rung ${row.id} has no label`);
    if (!Number.isFinite(row.order)) out.push(`confidence rung ${row.id}: order must be a number`);
    for (const m of row.maps ?? []) {
      if (m.ladder.trim().length === 0 || m.value.trim().length === 0) out.push(`confidence rung ${row.id} maps an empty ladder or value`);
    }
  }
  return out;
}

// ── tolerant reader of a stored basis ──────────────────────────────────────

const isText = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

/** A stored `ValueBasis`, checked; unknown fields kept. Null (not "not recorded" guessed) when it isn't one. */
export function readStoredBasis(raw: unknown): ValueBasis | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Readonly<Record<string, unknown>>;
  if (!isText(r.maturity)) return null;
  if (r.source !== undefined) {
    if (typeof r.source !== "object" || r.source === null || !isText((r.source as Readonly<Record<string, unknown>>).kind)) return null;
    const ref = (r.source as Readonly<Record<string, unknown>>).ref;
    if (ref !== undefined && typeof ref !== "string") return null;
  }
  if (r.confidence !== undefined && !isText(r.confidence)) return null;
  if (r.at !== undefined && typeof r.at !== "string") return null;
  return r as unknown as ValueBasis;
}
