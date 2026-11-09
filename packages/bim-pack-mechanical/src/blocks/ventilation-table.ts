import { convert, to, type Quantity } from "@permitzip/bim-units";
import {
  elementsOfKind,
  registeredVentilationReader,
  spacesOfZone,
  spacesOnLevel,
  VENTILATION_NOT_LOADED,
  VENTILATION_STANDARD_IDS,
  zonesOfSpace,
  type BimElement,
  type ElementId,
  type GoverningStandard,
  type ModelState,
  type RenderedBlock,
  type Space,
  type SpaceVentilation,
  type VentilationReader,
  type VentilationStandardId,
  type VentilationTableSpec,
  type Zone,
  type ZoneVentilation,
} from "@permitzip/bim-kernel";

/**
 * The live ventilation table (ROADMAP M1, KERNEL-REQUIREMENTS-MODEL §3.6): one
 * row per space (use, people, area, Rp, Ra, Vbz, Ez, Voz, exhaust, both
 * standards), then each zone's total against its serving unit. The same rows
 * feed the Ventilation panel, the sheet block and the agent.
 *
 * `renderVentilationTable` returns a `RenderedBlock` (text, unresolved,
 * dependsOn), so k4's hash, freeze-at-issue and "changed since" work on it
 * unchanged. Field blocks are text templates read from one subject and can't
 * repeat a line per space; this renderer is the table they lack. Until the
 * block spec can name a table, `ZONE_VENTILATION_TEMPLATE` prints one zone's
 * summary through the ordinary field block.
 */

type Elements = Readonly<Record<string, BimElement>>;

export type VentilationScope = { readonly kind: "model" } | { readonly kind: "level"; readonly levelId: ElementId } | { readonly kind: "zone"; readonly zoneId: ElementId };

/** The zone purposes a ventilation table lists (ASHRAE 62.1 ventilation zones; HVAC thermal zones served by a unit). */
export const VENTILATION_ZONE_PURPOSES: ReadonlySet<Zone["purpose"]> = new Set(["ventilation", "thermal"]);

export interface VentilationTotals {
  readonly voz: Quantity<"flow_air"> | null;
  readonly exhaust: Quantity<"flow_air"> | null;
  /** Spaces that couldn't be calculated under this standard. */
  readonly missing: number;
}

export interface VentilationTable {
  readonly scope: VentilationScope;
  readonly governing: GoverningStandard | null;
  readonly spaces: readonly SpaceVentilation[];
  readonly zones: readonly ZoneVentilation[];
  /** Σ over the spaces. `voz` null when any space is missing (never a partial total). */
  readonly totals: Readonly<Record<VentilationStandardId, VentilationTotals>>;
  /** Set when there is nothing to show, in words. */
  readonly empty: string | null;
}

const collator = new Intl.Collator("en-US", { numeric: true, sensitivity: "base" });
const bySpace = (a: Space, b: Space): number => collator.compare(a.number, b.number) || collator.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const byZone = (a: Zone, b: Zone): number => collator.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The spaces and zones a scope covers, read from the space index (no model scan beyond the kind index). */
export function ventilationScopeMembers(elements: Elements, scope: VentilationScope): { readonly spaces: readonly Space[]; readonly zones: readonly Zone[] } {
  let spaces: Space[];
  let zones: Zone[];
  switch (scope.kind) {
    case "model":
      spaces = elementsOfKind(elements, "space");
      zones = elementsOfKind(elements, "zone").filter((z) => VENTILATION_ZONE_PURPOSES.has(z.purpose));
      break;
    case "level": {
      spaces = spacesOnLevel(elements, scope.levelId);
      const seen = new Map<ElementId, Zone>();
      for (const s of spaces) for (const z of zonesOfSpace(elements, s.id)) if (VENTILATION_ZONE_PURPOSES.has(z.purpose)) seen.set(z.id, z);
      zones = [...seen.values()];
      break;
    }
    case "zone": {
      const z = elements[scope.zoneId];
      zones = z?.kind === "zone" ? [z] : [];
      spaces = z?.kind === "zone" ? spacesOfZone(elements, z.id) : [];
      break;
    }
  }
  return { spaces: [...spaces].sort(bySpace), zones: [...zones].sort(byZone) };
}

function sum(values: ReadonlyArray<Quantity<"flow_air"> | null>): Quantity<"flow_air"> | null {
  let total = 0;
  for (const v of values) {
    if (v === null) return null;
    total += v;
  }
  return total as Quantity<"flow_air">;
}

/** The table for a scope, through `reader` (the registered engine by default). */
export function ventilationTableOf(elements: Elements, scope: VentilationScope, reader: VentilationReader | null = registeredVentilationReader()): VentilationTable {
  const members = ventilationScopeMembers(elements, scope);
  const noTotals = Object.fromEntries(VENTILATION_STANDARD_IDS.map((id) => [id, { voz: null, exhaust: null, missing: members.spaces.length }])) as Record<VentilationStandardId, VentilationTotals>;
  if (!reader) return { scope, governing: null, spaces: [], zones: [], totals: noTotals, empty: VENTILATION_NOT_LOADED };
  const spaces = members.spaces.flatMap((s) => {
    const r = reader.space(elements, s.id);
    return r ? [r] : [];
  });
  const zones = members.zones.flatMap((z) => {
    const r = reader.zone(elements, z.id);
    return r ? [r] : [];
  });
  const totals = Object.fromEntries(
    VENTILATION_STANDARD_IDS.map((id) => {
      const rows = spaces.map((s) => s.standards[id]);
      const missing = rows.filter((r) => r.status === "missing").length;
      const exhaust = rows.reduce((t, r) => t + (r.exhaust ?? 0), 0) as Quantity<"flow_air">;
      return [id, { voz: missing > 0 ? null : sum(rows.map((r) => r.voz)), exhaust: rows.some((r) => r.exhaust !== null) ? exhaust : null, missing }];
    }),
  ) as Record<VentilationStandardId, VentilationTotals>;
  const empty = spaces.length > 0 ? null : scope.kind === "zone" ? "This zone has no spaces yet. Add spaces to it in the Spaces panel." : "No spaces yet. Draw, trace or make spaces from rooms in the Spaces panel, then give each a use.";
  return { scope, governing: spaces[0]?.governing ?? zones[0]?.governing ?? null, spaces, zones, totals, empty };
}

// ------------------------------------------------------------------ text

export const VENTILATION_TABLE_TITLE = "VENTILATION: OUTDOOR AIR AND EXHAUST";
/** Rows a sheet block prints before saying how many more there are. */
export const VENTILATION_TABLE_MAX_ROWS = 60;

const n = (v: number | null, digits = 0): string => (v === null ? "—" : v.toLocaleString("en-US", { maximumFractionDigits: digits }));
const cfm = (v: Quantity<"flow_air"> | null | undefined): string => (v === null || v === undefined ? "—" : n(to(v, "cfm")));
const SHORT: Readonly<Record<VentilationStandardId, string>> = { imc: "IMC", ashrae_62_1: "62.1" };

/** One printed line per space: "101 Dining | Restaurant dining rooms | 1,000 ft² | 70 | Rp 7.5 | Ra 0.18 | Vbz 705 | Ez 1 | Voz 705 | Exh — | IMC 705 / 62.1 705". */
export function ventilationRowText(r: SpaceVentilation): string {
  const g = r.standards[r.governing.standard];
  const area = r.areaM2 === null ? null : convert(r.areaM2, "m2", "ft2");
  const head = `${r.label} | ${r.useName ?? "no use"} | ${n(area)} ft² | ${n(r.occupants)}`;
  if (g.status === "missing") return `${head} | can't calculate (${g.label}): ${g.reasons.join(" ")}`;
  const rp = g.rp ? n(to(g.rp.value, "cfm/occ"), 2) : "—";
  const ra = g.ra ? n(to(g.ra.value, "cfm/ft2"), 2) : "—";
  const both = VENTILATION_STANDARD_IDS.map((id) => `${SHORT[id]} ${cfm(r.standards[id].voz)}`).join(" / ");
  return `${head} | Rp ${rp} | Ra ${ra} | Vbz ${cfm(g.vbz)} | Ez ${n(to(g.ez.value, "1"), 2)} | Voz ${cfm(g.voz)} | Exh ${cfm(g.exhaust)} | ${both}`;
}

export function ventilationZoneText(z: ZoneVentilation): string {
  const g = z.standards[z.governing.standard];
  const both = VENTILATION_STANDARD_IDS.map((id) => `${SHORT[id]} ${cfm(z.standards[id].voz)}`).join(" / ");
  const unit = z.servedBy ? `; ${z.servedBy.mark} outdoor air ${cfm(z.servedBy.outdoorAir)} cfm${z.servedBy.comparison === "meets" ? ", enough" : z.servedBy.comparison === "short" ? ", SHORT" : ""}` : "; no serving unit";
  const missing = g.missing.length > 0 ? ` (${g.missing.length} space${g.missing.length === 1 ? "" : "s"} can't be calculated)` : "";
  return `${z.name}: Σ Voz ${cfm(g.voz)} cfm${missing} (${both})${unit}. ${z.systemNote}`;
}

const HEADER = "Space | Use | Area | People | Rp cfm/person | Ra cfm/ft² | Vbz cfm | Ez | Voz cfm | Exhaust cfm | Voz by standard";

/** The table as printed lines (deterministic for the same elements). */
export function ventilationTableLines(table: VentilationTable): string[] {
  if (table.empty) return [table.empty];
  const lines = [table.governing?.text ?? "", HEADER];
  const shown = table.spaces.slice(0, VENTILATION_TABLE_MAX_ROWS);
  for (const r of shown) lines.push(ventilationRowText(r));
  if (table.spaces.length > shown.length) lines.push(`… and ${table.spaces.length - shown.length} more spaces. Use a schedule of spaces for the whole list.`);
  for (const z of table.zones) lines.push(ventilationZoneText(z));
  const g = table.governing?.standard ?? "imc";
  const t = table.totals[g];
  lines.push(t.voz === null ? `Total: ${t.missing} space${t.missing === 1 ? "" : "s"} can't be calculated yet, so there is no total.` : `Total outdoor air ${cfm(t.voz)} cfm; exhaust ${cfm(t.exhaust)} cfm (${table.spaces[0]?.standards[g].label ?? ""}).`);
  lines.push("Rates: IMC 2021 Table 403.3.1.1 and ASHRAE 62.1-2019 Table 6-1 via the space-use library (not verified against a code library record).");
  return lines.filter((l) => l !== "");
}

function dependencies(elements: Elements, table: VentilationTable, scope: VentilationScope): ElementId[] {
  const out = new Set<ElementId>();
  if (scope.kind === "level") out.add(scope.levelId);
  if (scope.kind === "zone") out.add(scope.zoneId);
  for (const s of table.spaces) {
    out.add(s.spaceId);
    const space = elements[s.spaceId];
    if (space?.kind === "space" && space.bounds.kind === "rooms") for (const r of space.bounds.roomIds) out.add(r);
  }
  for (const z of table.zones) {
    out.add(z.zoneId);
    if (z.servedBy) {
      out.add(z.servedBy.id);
      const unit = elements[z.servedBy.id];
      if (unit?.kind === "part") out.add(unit.typeId);
    }
  }
  return [...out].sort();
}

/** The table as a block value: text, what couldn't be calculated, and every element it read. */
export function renderVentilationTable(model: Pick<ModelState, "elements">, spec: VentilationTableSpec, reader: VentilationReader | null = registeredVentilationReader()): RenderedBlock {
  const table = ventilationTableOf(model.elements, spec.scope, reader);
  const unresolved = table.empty && !reader ? ["ventilation"] : table.spaces.filter((s) => s.standards[s.governing.standard].status === "missing").map((s) => s.label);
  return { text: ventilationTableLines(table).join("\n"), unresolved, dependsOn: dependencies(model.elements, table, spec.scope) };
}

/**
 * One zone's ventilation summary as an ordinary field block (subject: the
 * zone). Renders with k4's existing block machinery once the ventilation
 * field provider is registered.
 */
export const ZONE_VENTILATION_TEMPLATE = [
  "{name}: outdoor air {ventilation.oa_required_cfm} cfm ({ventilation.governing} governs)",
  "IMC {ventilation.imc_oa_cfm} cfm · ASHRAE 62.1 {ventilation.ashrae_oa_cfm} cfm · exhaust {ventilation.exhaust_cfm|—} cfm",
  "{served_by|No serving unit}: outdoor air {ventilation.unit_oa_cfm|—} cfm",
  "{ventilation.basis}",
].join("\n");
export const ZONE_VENTILATION_TITLE = "ZONE VENTILATION";
