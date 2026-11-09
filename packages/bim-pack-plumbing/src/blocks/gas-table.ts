import { gasIndex } from "../fields/providers/gas";
import { requirementsEngineOf, devicePartOf, loadAnchorOf, type LoadRecord, PIPE_DESIGN_DEFAULTS, gasProperties, mergePipeDesign, elementsOfKind, GAS_TABLE_ZONE_REFUSAL, type GasTableSpec } from "@permitzip/bim-kernel";
import type { BimElement, ElementId, ModelState, RenderedBlock } from "@permitzip/bim-kernel";

/**
 * The live gas schedule (7329 Corner Cafe: five gas rows before any pipe is
 * drawn): one line per gas load, its input, what it adds to the project
 * total (an estimate a device has outgrown adds nothing), and that as gas
 * flow at the gas system's heating value, then the counted total the meter
 * is sized for. Reads the requirements engine (one load concept, counted the
 * way every Loads list counts) and, once gas pipe is drawn, the gas walk's
 * outlets that stand for no load row. Returns a `RenderedBlock`, so hashing,
 * freeze-at-issue and "changed since" are the same as every block.
 */

type Elements = Readonly<Record<string, BimElement>>;

/** The same scopes as the other tables; a zone is refused when placed (blockTableProblem): loads standing on devices have no zone to read. */
export const GAS_TABLE_TITLE = "GAS SCHEDULE";
export const GAS_TABLE_MAX_ROWS = 60;
export const GAS_TABLE_HEADER = "Mark | Item | Input (MBH) | Counted (MBH) | Gas flow (cfh)";

const MBH = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const CFH = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const collator = new Intl.Collator("en-US", { numeric: true, sensitivity: "base" });

/** Btu per cubic foot the model's natural gas converts at: its gas system's, else the kernel default (1,000). */
export function gasTableHeatingValue(elements: Elements): { readonly value: number; readonly systemId: ElementId | null } {
  for (const s of elementsOfKind(elements, "mep_system")) {
    if (s.systemKind === "natural_gas") return { value: gasProperties(mergePipeDesign(undefined, s.design?.pipe)).heatingValueBtuPerCf, systemId: s.id };
  }
  return { value: PIPE_DESIGN_DEFAULTS.heatingValueBtuPerCf, systemId: null };
}

/** The level a load sits on, for a level-scoped table; null when it has none (a typed row, a zone estimate). */
function levelOfLoad(elements: Elements, lp: LoadRecord): ElementId | null {
  const a = loadAnchorOf(lp);
  if (a.kind === "point") return a.levelId;
  if (a.kind === "space") {
    const sp = elements[a.id];
    return sp?.kind === "space" ? (sp.levelId ?? null) : null;
  }
  const id = a.kind === "run_end" ? a.hostId : devicePartOf(lp);
  const el = id ? elements[id] : undefined;
  if (el?.kind === "run_segment" || el?.kind === "run_fitting") return el.levelId;
  if (el?.kind === "part") return el.levelId;
  return null;
}

function nameOf(elements: Elements, id: ElementId | null): string | null {
  const el = id ? elements[id] : undefined;
  if (el?.kind !== "part") return null;
  return el.mark.trim() || null;
}

interface Row {
  readonly mark: string;
  readonly item: string;
  readonly input: number;
  readonly counted: number;
  readonly reads: readonly ElementId[];
}

export interface GasTable {
  readonly rows: readonly Row[];
  readonly countedMbh: number;
  readonly heatingValue: number;
  readonly empty: string | null;
  readonly dependsOn: readonly ElementId[];
}

/** The gas loads a scope covers, sorted by mark (deterministic for the same elements). */
export function gasTableOf(model: Pick<ModelState, "elements">, spec: GasTableSpec): GasTable {
  const elements = model.elements;
  const hv = gasTableHeatingValue(elements);
  if (spec.scope.kind === "zone") return { rows: [], countedMbh: 0, heatingValue: hv.value, empty: GAS_TABLE_ZONE_REFUSAL, dependsOn: [spec.scope.zoneId] };
  const engine = requirementsEngineOf(elements);
  const deps = new Set<ElementId>();
  const scopeLevelId = spec.scope.kind === "level" ? spec.scope.levelId : null;
  if (scopeLevelId) deps.add(scopeLevelId);
  const inScope = (levelId: ElementId | null) => scopeLevelId === null || levelId === scopeLevelId;
  const rows: Row[] = [];
  const covered = new Set<ElementId>();
  for (const lp of elementsOfKind(elements, "load_point")) {
    const value = engine.valueOf(model, lp.id)?.mbh ?? 0;
    if (!(value > 0)) continue;
    if (!inScope(levelOfLoad(elements, lp))) continue;
    const part = devicePartOf(lp);
    if (part) covered.add(part);
    const reads: ElementId[] = [lp.id, ...(part ? [part] : [])];
    const anchor = loadAnchorOf(lp);
    if (anchor.kind === "space" || anchor.kind === "zone") reads.push(anchor.id);
    const mark = lp.mark?.trim() || nameOf(elements, part) || lp.id;
    const item = lp.note?.trim() || lp.connectionType.trim() || (anchor.kind === "space" || anchor.kind === "zone" ? "Estimate" : "Gas load");
    rows.push({ mark, item, input: value, counted: engine.countedOf(model, lp.id)?.mbh ?? 0, reads });
  }
  // Drawn gas outlets no load row stands for (an appliance piped before its load was typed): counted at their own input.
  for (const [id, row] of gasIndex(elements).rows) {
    if (row.source !== "part" || covered.has(id)) continue;
    const part = elements[id];
    if (part?.kind !== "part" || !inScope(part.levelId)) continue;
    if (!(row.inputMbh > 0)) continue;
    rows.push({ mark: row.mark || id, item: `${row.description || "Gas appliance"} (piped)`, input: row.inputMbh, counted: row.inputMbh, reads: [id, part.typeId, row.systemId] });
  }
  rows.sort((a, b) => collator.compare(a.mark, b.mark) || collator.compare(a.item, b.item));
  for (const r of rows) for (const id of r.reads) deps.add(id);
  if (hv.systemId) deps.add(hv.systemId);
  const countedMbh = rows.reduce((sum, r) => sum + r.counted, 0);
  const empty = rows.length > 0 ? null : spec.scope.kind === "level" ? "No gas loads on this level yet. Add them in the Loads list or place gas equipment." : "No gas loads yet. Add them in the Loads list or place gas equipment.";
  return { rows, countedMbh, heatingValue: hv.value, empty, dependsOn: [...deps].sort() };
}

const cfh = (mbh: number, heatingValue: number) => (mbh * 1000) / heatingValue;

/** The table as printed lines. */
export function gasTableLines(table: GasTable): string[] {
  if (table.empty) return [table.empty];
  const lines = [GAS_TABLE_HEADER];
  const shown = table.rows.slice(0, GAS_TABLE_MAX_ROWS);
  for (const r of shown) lines.push(`${r.mark} | ${r.item} | ${MBH.format(r.input)} | ${MBH.format(r.counted)} | ${CFH.format(cfh(r.counted, table.heatingValue))}`);
  if (table.rows.length > shown.length) lines.push(`… and ${table.rows.length - shown.length} more. Use the Loads list for the whole list.`);
  lines.push(`Total counted: ${MBH.format(table.countedMbh)} MBH = ${CFH.format(cfh(table.countedMbh, table.heatingValue))} cfh at ${CFH.format(table.heatingValue)} Btu/cf`);
  return lines;
}

export function renderGasTable(model: Pick<ModelState, "elements">, spec: GasTableSpec): RenderedBlock {
  const table = gasTableOf(model, spec);
  return { text: gasTableLines(table).join("\n"), unresolved: [], dependsOn: table.dependsOn };
}
