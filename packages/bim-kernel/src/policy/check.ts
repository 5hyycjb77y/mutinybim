import { fromSI, isUnitCode, kindsOfUnit, toSI, type UnitCode } from "@permitzip/bim-units";
import { defineExtensionPoint } from "../packs/contract";
import { activePackSet } from "../packs/scope";
import type { ElementId, ModelState } from "../types";
import { DESIGN_LIMIT_DEFAULT_POINT, designLimitsFor, outsideBand, type DesignLimit, type DesignLimitLayer, type DesignLimitSelector, type DesignLimitSources, type ResolvedDesignLimit } from "./design-limits";

/**
 * Checking values against design limits. One value is checked against the
 * most specific limit that binds it (`designLimitsFor`'s first row): a
 * project's hot-water limit replaces the firm's general water limit for hot
 * water, so the general one never fires a second finding for the same pipe.
 *
 * The words name the value, the limit, its layer and who set it: "Velocity
 * 9.2 ft/s over the firm's 8 ft/s (set by J. Rao)".
 */

/** One value an add-on measured on the model (a run's velocity, a board's spare capacity). */
export interface DesignLimitMeasurement {
  /** The element it was measured on (the finding's subject). */
  readonly elementId: ElementId;
  /** What a person calls the value ("Velocity", "Spare capacity"). */
  readonly label: string;
  readonly selector: DesignLimitSelector;
  readonly value: number;
  /** A `bim-units` code; the check converts to the limit's unit. */
  readonly unit: string;
}

/**
 * Values an add-on measures for design limits (`kernel.design_limit_measure` v1,
 * contract 1.10.0 additive, lane S12). `measure` with `ids` measures only
 * those elements (and whatever they decide, e.g. a run whose flow a changed
 * end feeds), so one edit re-checks what it touched, never the model.
 */
export interface DesignLimitMeasureRow {
  /** `<pack>.<name>`. */
  readonly id: string;
  readonly label: string;
  /** The quantity kinds it measures (a limit of another quantity never asks it). */
  readonly quantities: readonly string[];
  measure(model: ModelState, ids?: ReadonlySet<string>): readonly DesignLimitMeasurement[];
}

export const DESIGN_LIMIT_MEASURE_POINT = defineExtensionPoint<DesignLimitMeasureRow>({
  id: "kernel.design_limit_measure",
  version: 1,
  label: "Design limit measures",
  idOf: (row) => row.id,
});

/** Problems with measure rows (pack conformance), in words. */
export function designLimitMeasureProblems(rows: readonly DesignLimitMeasureRow[]): string[] {
  const out: string[] = [];
  for (const row of rows) {
    if (row.label.trim().length === 0) out.push(`design limit measure ${row.id} has no label`);
    if (row.quantities.length === 0) out.push(`design limit measure ${row.id} lists no quantity`);
    if (typeof row.measure !== "function") out.push(`design limit measure ${row.id}: measure must be a function`);
  }
  return out;
}

export function designLimitMeasures(): readonly DesignLimitMeasureRow[] {
  return activePackSet().items(DESIGN_LIMIT_MEASURE_POINT);
}

export interface DesignLimitCheck {
  /** null: the check couldn't run (no limit set, units that don't compare); `words` says what to add. */
  readonly pass: boolean | null;
  readonly limit: ResolvedDesignLimit | null;
  /** The value in the limit's unit (as the words print it). */
  readonly valueInLimitUnit: number | null;
  readonly side: "below" | "above" | null;
  readonly words: string;
}

const LAYER_WORDS: Readonly<Record<DesignLimitLayer, string>> = { project: "the project's", firm: "the firm's", addon: "the default" };

/** A number as the words print it: at most two decimals, no float noise. */
export function limitNumber(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function convert(value: number, from: string, to: string): number | null {
  if (from === to) return value;
  if (!isUnitCode(from) || !isUnitCode(to)) return null;
  const shared = kindsOfUnit(from).some((k) => kindsOfUnit(to).includes(k));
  if (!shared) return null;
  return fromSI(toSI(value, from as UnitCode), to as UnitCode);
}

function setByWords(r: ResolvedDesignLimit): string {
  return r.limit.setBy && r.layer !== "addon" ? ` (set by ${r.limit.setBy.name})` : "";
}

/** Check one value against the limits that bind it. */
export function checkDesignLimit(label: string, value: number, unit: string, selector: DesignLimitSelector, stage: string | undefined, sources: DesignLimitSources): DesignLimitCheck {
  const resolved = designLimitsFor(selector, stage, sources)[0] ?? null;
  if (!resolved) return { pass: null, limit: null, valueInLimitUnit: null, side: null, words: `No design limit is set for ${label.toLowerCase()} here. Add one in Library › Design limits.` };
  const limit = resolved.limit;
  const v = convert(value, unit, limit.unit);
  if (v === null) return { pass: null, limit: resolved, valueInLimitUnit: null, side: null, words: `${label} is in ${unit}, but ${limit.label} is in ${limit.unit}; they can't be compared.` };
  const side = outsideBand(limit.band, v);
  const who = LAYER_WORDS[resolved.layer];
  const shown = `${label} ${limitNumber(v)} ${limit.unit}`;
  if (side === "above") return { pass: false, limit: resolved, valueInLimitUnit: v, side, words: `${shown} over ${who} ${limitNumber(limit.band.max as number)} ${limit.unit}${setByWords(resolved)}` };
  if (side === "below") return { pass: false, limit: resolved, valueInLimitUnit: v, side, words: `${shown} under ${who} ${limitNumber(limit.band.min as number)} ${limit.unit} minimum${setByWords(resolved)}` };
  const edge = limit.band.max ?? limit.band.min ?? limit.band.target;
  return { pass: true, limit: resolved, valueInLimitUnit: v, side: null, words: `${shown} within ${who} ${edge === undefined ? "limit" : `${limitNumber(edge)} ${limit.unit}`}` };
}

export interface DesignLimitRow {
  /** The row in force for this id (the highest layer that has it). */
  readonly limit: DesignLimit;
  readonly layer: DesignLimitLayer;
  /** The add-on default it replaced, when a firm or project row has the same id (what "Reset to default" goes back to). */
  readonly fallback: DesignLimit | null;
  /** The layers below that have the id. */
  readonly replaces: readonly DesignLimitLayer[];
}

/** Every limit in force, one row per id (project over firm over add-on default), sorted by label: what Library › Design limits lists. */
export function designLimitRows(sources: DesignLimitSources, defaults: readonly DesignLimit[] = activePackSet().items(DESIGN_LIMIT_DEFAULT_POINT)): DesignLimitRow[] {
  const byId = new Map<string, { limit: DesignLimit; layer: DesignLimitLayer; replaces: DesignLimitLayer[]; fallback: DesignLimit | null }>();
  const layers: ReadonlyArray<readonly [DesignLimitLayer, readonly DesignLimit[]]> = [
    ["project", sources.project ?? []],
    ["firm", sources.firm ?? []],
    ["addon", defaults],
  ];
  for (const [layer, rows] of layers) {
    for (const limit of rows) {
      const held = byId.get(limit.id);
      if (!held) byId.set(limit.id, { limit, layer, replaces: [], fallback: null });
      else {
        if (!held.replaces.includes(layer)) held.replaces.push(layer);
        if (layer === "addon") held.fallback = limit;
      }
    }
  }
  return [...byId.values()].sort((a, b) => a.limit.label.localeCompare(b.limit.label) || a.limit.id.localeCompare(b.limit.id));
}

/** A band in words: "at most 8 ft/s", "at least 25 %", "2 to 8 ft/s, aim for 5". */
export function bandWords(limit: Pick<DesignLimit, "band" | "unit">): string {
  const { min, max, target } = limit.band;
  const u = limit.unit;
  const aim = target !== undefined ? `aim for ${limitNumber(target)} ${u}` : "";
  const edge = min !== undefined && max !== undefined ? `${limitNumber(min)} to ${limitNumber(max)} ${u}` : max !== undefined ? `at most ${limitNumber(max)} ${u}` : min !== undefined ? `at least ${limitNumber(min)} ${u}` : "";
  return [edge, aim].filter((s) => s !== "").join(", ");
}

/** A measurement checked; null when no limit binds it or it passes (a finding is only for a value outside its band). */
export function designLimitViolation(m: DesignLimitMeasurement, stage: string | undefined, sources: DesignLimitSources): DesignLimitCheck | null {
  const check = checkDesignLimit(m.label, m.value, m.unit, m.selector, stage, sources);
  return check.pass === false ? check : null;
}
