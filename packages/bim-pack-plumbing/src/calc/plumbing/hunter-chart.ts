import type { ChartData, ChartKind, ModelState } from "@permitzip/bim-kernel";
import { ASHRAE_CURVES, type CurvePoint } from "../packs/hunter/curves";
import { waterDesignPoints } from "./system-sizing";

/**
 * The Hunter curve chart the firm puts on its sheets: the ASHRAE modified
 * curves A–D (and any firm or IPC Appendix E curve a system uses), with each
 * domestic water system's design point (total fixture units at its source,
 * the gpm its curve reads there). Plain data, in chart units; the Plumbing
 * tab draws it on screen and as a printable image.
 */

export interface HunterChartCurve {
  readonly id: string;
  readonly label: string;
  readonly points: readonly CurvePoint[];
  /** A curve some system in the model sizes on. */
  readonly used: boolean;
}

export interface HunterChartPoint {
  readonly systemId: string;
  readonly systemName: string;
  readonly curveId: string;
  readonly wsfu: number;
  readonly gpm: number;
}

export interface HunterChart {
  readonly title: string;
  readonly curves: readonly HunterChartCurve[];
  readonly points: readonly HunterChartPoint[];
  /** Systems that have no curve yet, and what to do. */
  readonly missing: ReadonlyArray<{ readonly systemName: string; readonly reason: string }>;
  readonly axes: { readonly x: string; readonly y: string; readonly xMax: number; readonly yMax: number };
  readonly source: string;
}

const niceCeil = (v: number, step: number) => Math.max(step, Math.ceil(v / step) * step);

export function hunterChart(model: ModelState): HunterChart {
  const systems = waterDesignPoints(model);
  const used = new Set(systems.flatMap((s) => (s.curve ? [s.curve.id] : [])));
  const curves: HunterChartCurve[] = Object.values(ASHRAE_CURVES).map((c) => ({ id: c.id, label: c.label, points: c.points, used: used.has(c.id) }));
  for (const s of systems) {
    if (!s.curve || s.curve.id.startsWith("ashrae") || s.curve.id === "legacy_fit" || curves.some((c) => c.id === s.curve?.id)) continue;
    curves.push({ id: s.curve.id, label: s.curve.label, points: s.curve.points, used: true });
  }
  const points = systems.flatMap((s): HunterChartPoint[] => (s.curve && s.gpm !== null && s.wsfu > 0 ? [{ systemId: s.systemId, systemName: s.systemName, curveId: s.curve.id, wsfu: s.wsfu, gpm: s.gpm }] : []));
  const missing = systems.flatMap((s) => (!s.curve ? [{ systemName: s.systemName, reason: s.curveNote ?? "Choose a demand curve." }] : []));
  const maxX = niceCeil(Math.max(400, ...points.map((p) => p.wsfu)), 100);
  // Tall enough for every curve across the chart, so none runs off the top.
  const maxY = Math.max(100, ...points.map((p) => p.gpm), ...curves.flatMap((c) => c.points.filter((p) => p.wsfu <= maxX).map((p) => p.gpm)));
  return {
    title: "Modified Hunter's curve (estimated demand)",
    curves,
    points,
    missing,
    axes: { x: "Fixture units", y: "Gallons per minute", xMax: niceCeil(maxX, 100), yMax: niceCeil(maxY, 20) },
    source: "ASHRAE modified Hunter curves A (restaurants), B (hospitals, nursing homes, dormitories, hotels), C (apartments), D (offices, schools); digitized from PermitZIP's issued sheet",
  };
}

/** The Hunter chart as sheet chart data: every curve, the ones the model uses heavier, each system's design point marked. `curves` limits it to those curve ids. */
export function hunterChartData(chart: HunterChart, curves?: readonly string[]): ChartData {
  const shown = curves && curves.length > 0 ? chart.curves.filter((c) => curves.includes(c.id)) : chart.curves;
  return {
    title: chart.title,
    x: { label: chart.axes.x, min: 0, max: chart.axes.xMax, step: niceCeil(chart.axes.xMax / 8, 50) },
    y: { label: chart.axes.y, min: 0, max: chart.axes.yMax, step: niceCeil(chart.axes.yMax / 6, 10) },
    series: shown.map((c) => ({ id: c.id, label: c.label, points: c.points.map((p) => ({ x: p.wsfu, y: p.gpm })), emphasis: c.used })),
    markers: chart.points.filter((p) => shown.some((c) => c.id === p.curveId)).map((p) => ({ at: { x: p.wsfu, y: p.gpm }, label: `${p.systemName}: ${p.wsfu} WSFU, ${p.gpm} gpm` })),
    note: chart.source,
  };
}

/** The Hunter curve as a sheet chart kind (`registerChartKind`). Param `curves`: comma-separated curve ids; absent: all. */
export const HUNTER_CHART_KIND: ChartKind = {
  id: "plumbing.hunter_curve",
  label: "Hunter curve (water demand)",
  evaluate: (model, params) => {
    const chart = hunterChart(model);
    const curves = typeof params.curves === "string" ? params.curves.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    if (curves && !curves.some((id) => chart.curves.some((c) => c.id === id))) return { reason: `No demand curve ${curves.join(", ")}; the curves are ${chart.curves.map((c) => c.id).join(", ")}` };
    return hunterChartData(chart, curves);
  },
};

/** Every chart kind bim-calc offers a host to register. */
export const BIM_CALC_CHART_KINDS: readonly ChartKind[] = [HUNTER_CHART_KIND];
