import { elementsOfKind, type BimElement, type Command, type ElementId, type ModelState, type RunSegment } from "@permitzip/bim-kernel";
import { checkDesignLimit, designLimitRows, limitNumber, type DesignLimit, type DesignLimitLayer, type DesignLimitMeasureRow, type DesignLimitMeasurement, type DesignLimitSources } from "@permitzip/bim-kernel/policy";
import { pipeSystemReportOf } from "../routing/pipe/hydraulics";

/**
 * Velocity in water piping, checked against the design limit for its system
 * (round 14 P14): each water system has its own band (domestic cold, hot,
 * hot water return), the project's row over the firm's over the add-on's
 * default, the most specific first, each with where it came from. The same
 * limit shape serves sprinkler mains and hydronic water: their add-ons
 * contribute a band for their system and a measure row on the same point.
 *
 * Measured over the pipes an edit touched and the systems they belong to,
 * never the model.
 */

const IN = 25.4;
const LAYER: Readonly<Record<DesignLimitLayer, string>> = { project: "project", firm: "firm", addon: "default" };
/** Nominal pipe sizes, inches: what "a size larger" steps through. */
const NOMINAL_IN = [0.375, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 14, 16, 18, 20, 24] as const;

type Elements = Readonly<Record<string, BimElement>>;

function waterSegment(elements: Elements, id: string): RunSegment | null {
  const el = elements[id];
  return el?.kind === "run_segment" && el.domain === "pipe" ? el : null;
}

/** The water pipes to measure: every pipe of the systems the ids touch (flow anywhere upstream moves with any change), or one system walk per system. */
function velocitiesOf(model: ModelState, ids?: ReadonlySet<string>): DesignLimitMeasurement[] {
  const anchors = new Map<string, ElementId>();
  if (ids) {
    for (const id of ids) {
      const el = model.elements[id];
      if ((el?.kind === "run_segment" || el?.kind === "run_fitting") && el.domain === "pipe" && !anchors.has(el.systemId)) anchors.set(el.systemId, el.id);
      if (el?.kind === "mep_system" && el.domain === "pipe" && el.entryId && !anchors.has(el.id)) anchors.set(el.id, el.entryId);
    }
  } else {
    for (const el of elementsOfKind(model.elements, "mep_system")) if (el.domain === "pipe" && el.entryId) anchors.set(el.id, el.entryId);
  }
  const out: DesignLimitMeasurement[] = [];
  for (const [systemId, anchor] of anchors) {
    const system = model.elements[systemId];
    if (system?.kind !== "mep_system") continue;
    const report = pipeSystemReportOf(model.elements, systemId, {}, anchor);
    if (report?.kind !== "water") continue;
    for (const s of report.segments) {
      if (!waterSegment(model.elements, s.elementId) || s.gpm <= 0) continue;
      out.push({ elementId: s.elementId, label: "Velocity", selector: { quantity: "velocity", discipline: "plumbing", service: system.systemKind, system: system.systemKind }, value: s.velocityFps, unit: "ft/s" });
    }
  }
  return out;
}

/** Plumbing's water velocities for design limits (`kernel.design_limit_measure`). */
export const PIPE_VELOCITY_MEASURE: DesignLimitMeasureRow = {
  id: "plumbing.pipe_velocity",
  label: "Water pipe velocity",
  quantities: ["velocity"],
  measure: velocitiesOf,
};

export interface VelocityFinding {
  readonly elementId: ElementId;
  /** Select: the pipe. */
  readonly selectIds: readonly ElementId[];
  /** "Velocity 9.2 ft/s over the 8 ft/s limit (firm)". */
  readonly words: string;
  /** Where the limit came from, in its author's words. */
  readonly source: string;
  readonly limitId: string;
  readonly layer: DesignLimitLayer;
  /** Fix: one size larger, or null when it is already the largest size we step to. */
  readonly fix: { readonly label: string; readonly command: Command } | null;
}

function nextSize(seg: RunSegment): number | null {
  if (seg.size.shape !== "pipe") return null;
  const now = seg.size.nominalMm / IN;
  const next = NOMINAL_IN.find((n) => n > now + 1e-6);
  return next === undefined ? null : next;
}

/**
 * Water pipes over (or under) their system's velocity band, measured over
 * `ids` (absent: every water system). The words name the value, the band and
 * the layer that set it; Fix makes the pipe one size larger.
 */
export function velocityBandFindings(model: ModelState, sources: DesignLimitSources, options: { readonly ids?: ReadonlySet<string>; readonly stage?: string; readonly measures?: readonly DesignLimitMeasureRow[] } = {}): VelocityFinding[] {
  const measured = (options.measures ?? [PIPE_VELOCITY_MEASURE]).flatMap((row) => {
    try {
      return [...row.measure(model, options.ids)];
    } catch (err) {
      console.error("[bim-pack-plumbing/velocity] a velocity measure failed; its pipes aren't checked this time", { measure: row.id, err });
      return [];
    }
  });
  const out: VelocityFinding[] = [];
  for (const m of measured) {
    const check = checkDesignLimit(m.label, m.value, m.unit, m.selector, options.stage, sources);
    if (check.pass !== false || !check.limit || check.valueInLimitUnit === null) continue;
    const { limit, layer } = check.limit;
    const edge = check.side === "above" ? limit.band.max : limit.band.min;
    if (edge === undefined) continue;
    const words = `${m.label} ${limitNumber(Math.round(check.valueInLimitUnit * 10) / 10)} ${limit.unit} ${check.side === "above" ? "over" : "under"} the ${limitNumber(edge)} ${limit.unit} limit (${LAYER[layer]})`;
    const seg = waterSegment(model.elements, m.elementId);
    const up = seg && check.side === "above" ? nextSize(seg) : null;
    const fix =
      seg && up !== null && seg.size.shape === "pipe"
        ? { label: `Make it ${limitNumber(up)}"`, command: { type: "resize_run", segmentId: seg.id, profile: { ...seg.size, nominalMm: up * IN } } as Command }
        : null;
    out.push({ elementId: m.elementId, selectIds: [m.elementId], words, source: limit.citation.source, limitId: limit.id, layer, fix });
  }
  return out;
}

export interface VelocityBandRow {
  /** The system kind the band is for (`domestic_cold_water`), or null for one that names none. */
  readonly system: string | null;
  readonly limit: DesignLimit;
  readonly layer: DesignLimitLayer;
  /** "at most 8 ft/s (firm)". */
  readonly words: string;
}

/** The velocity band in force for each water system, for Library › Design limits: one row per system a velocity limit names. */
export function velocityBandRows(sources: DesignLimitSources, defaults?: readonly DesignLimit[]): VelocityBandRow[] {
  const rows = defaults ? designLimitRows(sources, defaults) : designLimitRows(sources);
  const out: VelocityBandRow[] = [];
  for (const row of rows) {
    if (row.limit.quantity !== "velocity") continue;
    const { max, min } = row.limit.band;
    const edge = max !== undefined && min !== undefined ? `${limitNumber(min)} to ${limitNumber(max)}` : max !== undefined ? `at most ${limitNumber(max)}` : min !== undefined ? `at least ${limitNumber(min)}` : "no band";
    const words = `${edge} ${row.limit.unit} (${LAYER[row.layer]})`;
    const systems = row.limit.appliesTo.systems ?? [];
    if (systems.length === 0) out.push({ system: null, limit: row.limit, layer: row.layer, words });
    for (const system of systems) out.push({ system, limit: row.limit, layer: row.layer, words });
  }
  return out;
}
