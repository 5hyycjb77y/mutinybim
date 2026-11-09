import { isVerticalLeg, loadPointTotals, sub3, nominalInOf, runLabel, runNeighbours, serviceOf, type BimElement, type Command, type ElementId, type ModelState, type RunSegment } from "@permitzip/bim-kernel";
import { lookupTable, type LookupTable } from "@permitzip/bim-kernel/policy";

/**
 * Wet vents (round 14 P14): a vent pipe that fixtures also drain into. Its
 * size is checked against the drainage units it carries, from the firm's (or
 * the project's) wet vent table — a `lookup_table` in the library with a
 * size column and the most drainage units that size takes. With no table the
 * check says what to add; it never guesses a size.
 *
 * The stretch is the level vent pipe the fixtures drain into: the vent
 * system's pieces reached from a pipe without climbing a vertical leg (a vent
 * stack is not part of the wet vent). Read from the pipe's own links, never
 * the model.
 */

/** The library slot the check asks for: column `size_in` (nominal inches) and `max_dfu`. */
export const WET_VENT_TABLE_SLOT = "plumbing.wet_vent_size";

type Elements = Readonly<Record<string, BimElement>>;
type Sources = { readonly project?: readonly LookupTable[]; readonly firm?: readonly LookupTable[] };

export interface WetVentStretch {
  /** The level vent pieces, in walk order. */
  readonly segmentIds: readonly ElementId[];
  /** The drainage loads that drain into it. */
  readonly loadIds: readonly ElementId[];
  readonly dfu: number;
}

export type WetVentFinding =
  | { readonly kind: "too_small"; readonly segmentId: ElementId; readonly selectIds: readonly ElementId[]; readonly dfu: number; readonly nominalIn: number; readonly maxDfu: number; readonly words: string; readonly source: string; readonly fix: { readonly label: string; readonly command: Command } | null }
  | { readonly kind: "no_table" | "no_row"; readonly segmentId: ElementId; readonly selectIds: readonly ElementId[]; readonly dfu: number; readonly words: string };

const upright = (seg: RunSegment): boolean => isVerticalLeg(sub3(seg.end, seg.start));

function ventSegment(elements: Elements, id: string): RunSegment | null {
  const el = elements[id];
  if (el?.kind !== "run_segment" || el.domain !== "pipe") return null;
  const system = elements[el.systemId];
  return system?.kind === "mep_system" && serviceOf(system.systemKind) === "vent" ? el : null;
}

/** The wet vent stretch a vent pipe belongs to, or null when it is a stack or no drainage load drains into it. */
export function wetVentStretch(elements: Elements, segmentId: string): WetVentStretch | null {
  const first = ventSegment(elements, segmentId);
  if (!first || upright(first)) return null;
  const systemId = first.systemId;
  const seen = new Set<string>([first.id]);
  const queue: string[] = [first.id];
  const segments: ElementId[] = [];
  const loads: ElementId[] = [];
  let dfu = 0;
  while (queue.length > 0) {
    const id = queue.shift() as string;
    const el = elements[id];
    if (el?.kind === "run_segment") {
      if (upright(el)) continue;
      segments.push(el.id);
    }
    for (const n of runNeighbours(elements, id)) {
      if (n.includes("#") || seen.has(n)) continue;
      seen.add(n);
      const next = elements[n];
      if (next?.kind === "load_point") {
        const d = loadPointTotals(elements, next).dfu;
        if (d > 0) {
          loads.push(next.id);
          dfu += d;
        }
        continue;
      }
      if ((next?.kind === "run_segment" || next?.kind === "run_fitting") && next.systemId === systemId) queue.push(n);
    }
  }
  return dfu > 0 ? { segmentIds: segments, loadIds: loads, dfu: Math.round(dfu * 100) / 100 } : null;
}

function rowsOf(table: LookupTable): Array<{ sizeIn: number; maxDfu: number }> {
  const col = (key: string, at: number) => {
    const i = table.columns.findIndex((c) => c.key === key);
    return i >= 0 ? i : at;
  };
  const s = col("size_in", 0);
  const d = col("max_dfu", 1);
  const out: Array<{ sizeIn: number; maxDfu: number }> = [];
  for (const row of table.rows) {
    const size = row[s];
    const max = row[d];
    if (typeof size === "number" && typeof max === "number") out.push({ sizeIn: size, maxDfu: max });
  }
  return out.sort((a, b) => a.sizeIn - b.sizeIn);
}

const IN = 25.4;
const n = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 2 });

/** The wet vent check for the stretch a vent pipe belongs to; null when it isn't a wet vent or it passes. */
export function wetVentCheck(model: Pick<ModelState, "elements">, segmentId: string, sources: Sources, stage?: string): WetVentFinding | null {
  const elements = model.elements;
  const stretch = wetVentStretch(elements, segmentId);
  if (!stretch) return null;
  const selectIds = [...stretch.segmentIds, ...stretch.loadIds];
  const seg = ventSegment(elements, segmentId);
  if (!seg) return null;
  const table = lookupTable(WET_VENT_TABLE_SLOT, stage, sources);
  if (!table) return { kind: "no_table", segmentId: seg.id, selectIds, dfu: stretch.dfu, words: `Can't check the wet vent for ${n(stretch.dfu)} DFU yet: add a wet vent table in Library › Lookup tables` };
  const rows = rowsOf(table);
  const nominalIn = Math.round(nominalInOf(seg.size) * 1000) / 1000;
  const row = rows.find((r) => Math.abs(r.sizeIn - nominalIn) < 0.01);
  if (!row) return { kind: "no_row", segmentId: seg.id, selectIds, dfu: stretch.dfu, words: `The ${table.name} has no ${n(nominalIn)}" row, so the ${runLabel(elements, seg)} isn't checked` };
  if (stretch.dfu <= row.maxDfu + 1e-9) return null;
  const big = rows.find((r) => r.sizeIn > nominalIn && stretch.dfu <= r.maxDfu + 1e-9);
  const fix =
    big && seg.size.shape === "pipe"
      ? { label: `Make it ${n(big.sizeIn)}"`, command: { type: "resize_run", segmentId: seg.id, profile: { ...seg.size, nominalMm: big.sizeIn * IN } } as Command }
      : null;
  const source = table.citation.section ? `${table.citation.source} ${table.citation.section}` : table.citation.source;
  return { kind: "too_small", segmentId: seg.id, selectIds, dfu: stretch.dfu, nominalIn, maxDfu: row.maxDfu, words: `Wet vent too small for ${n(stretch.dfu)} DFU (${n(nominalIn)}" takes ${n(row.maxDfu)} in ${table.name})`, source, fix };
}
