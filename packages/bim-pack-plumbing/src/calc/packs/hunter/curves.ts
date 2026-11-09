import type { Citation } from "@permitzip/bim-calc";
import { hunterStyleGpm, interpolateTable } from "../../../routing/pipe/hydraulics";

/**
 * Demand curves: water supply fixture units to design flow (gpm).
 *
 * The four ASHRAE modified Hunter curves are read off the chart PermitZIP
 * prints on its plumbing load sheets (issued set for project 7492, Sample Market
 * Community Market, sheet P1, "ASHRAE modified Hunter's curve"), digitized
 * 2026-10-23 at about ±1 gpm (the printed line is about 0.6 gpm thick). Near
 * the restaurant operating point the sheet annotates (43.25 WSFU, 48 gpm),
 * Curve A's points were moved by at most 1.6 gpm so the curve passes through
 * the engineer's printed reading; the chart's own range ends at 400 WSFU
 * (Curve A at 250, where it leaves the chart at 100 gpm).
 *
 * IPC Appendix E (Table E103.3(3), flush tank / flushometer) is not in the
 * code library; a firm imports it as `firm` points. The kernel's built-in
 * power fit (1.47 FU^0.735) stays available as `legacy_fit` for comparison
 * only: it reads 23.4 gpm at 43.25 WSFU where Curve A reads 48.
 */

export type DemandCurveId = "ashrae_a" | "ashrae_b" | "ashrae_c" | "ashrae_d" | "ipc_e_tank" | "ipc_e_valve" | "firm" | "legacy_fit";

export interface CurvePoint {
  readonly wsfu: number;
  readonly gpm: number;
}

export interface DemandCurve {
  readonly id: DemandCurveId;
  readonly label: string;
  /** Building types the curve is drawn for. */
  readonly appliesTo: readonly string[];
  readonly points: readonly CurvePoint[];
  readonly cite: Citation;
}

const SHEET_SOURCE = "ASHRAE modified Hunter curves, digitized from PermitZIP's issued load sheet (project 7492 sheet P1), ±1 gpm reading tolerance";

function sheetCite(curve: string): Citation {
  return { source: "method", code: "ASHRAE modified Hunter curve", edition: null, clause: curve, detail: "digitized from PermitZIP's issued load sheet (7492, P1)", text: `ASHRAE modified Hunter ${curve} (${SHEET_SOURCE})` };
}

const pts = (rows: ReadonlyArray<readonly [number, number]>): CurvePoint[] => rows.map(([wsfu, gpm]) => ({ wsfu, gpm }));

export const ASHRAE_CURVES: Readonly<Record<"ashrae_a" | "ashrae_b" | "ashrae_c" | "ashrae_d", DemandCurve>> = {
  ashrae_a: {
    id: "ashrae_a",
    label: "Curve A: restaurants",
    appliesTo: ["restaurant"],
    points: pts([
      [0, 21.5], [5, 24.1], [10, 27.2], [15, 30.4], [20, 33.8], [25, 37.5], [30, 40.3], [35, 43.2], [40, 46.0], [43.25, 48.0], [45, 48.8], [50, 50.8],
      [60, 54.8], [70, 58.3], [75, 59.6], [80, 61.1], [90, 64.3], [100, 67.4], [110, 70.5], [125, 74.7], [150, 79.7], [175, 84.9], [200, 89.8], [225, 94.8], [250, 99.6],
    ]),
    cite: sheetCite("Curve A (restaurants)"),
  },
  ashrae_b: {
    id: "ashrae_b",
    label: "Curve B: hospitals, nursing homes, nurses' residences, dormitories, hotels and motels",
    appliesTo: ["hospital", "nursing_home", "dormitory", "hotel", "motel"],
    points: pts([
      [0, 10.3], [10, 13.1], [20, 16.2], [25, 17.6], [30, 19.0], [40, 22.3], [50, 25.0], [60, 26.8], [70, 28.9], [75, 29.9], [80, 31.0], [90, 32.7], [100, 34.2],
      [125, 38.3], [150, 41.1], [175, 43.9], [200, 46.0], [225, 48.1], [250, 50.3], [275, 52.6], [300, 54.7], [325, 57.1], [350, 59.2], [375, 62.2], [400, 64.3],
    ]),
    cite: sheetCite("Curve B (hospitals, nursing homes, dormitories, hotels and motels)"),
  },
  ashrae_c: {
    id: "ashrae_c",
    label: "Curve C: apartment houses",
    appliesTo: ["apartment"],
    points: pts([
      [0, 7.8], [5, 8.8], [10, 9.4], [15, 11.2], [20, 12.0], [25, 13.5], [30, 14.2], [35, 15.3], [40, 16.5], [45, 17.6], [50, 18.5], [60, 20.3], [70, 21.9], [80, 23.5], [90, 24.9], [100, 26.0],
      [125, 29.0], [150, 31.1], [175, 33.3], [200, 35.2], [225, 37.1], [250, 38.9], [275, 40.6], [300, 42.1], [325, 43.4], [350, 44.5], [375, 45.6], [400, 46.4],
    ]),
    cite: sheetCite("Curve C (apartment houses)"),
  },
  ashrae_d: {
    id: "ashrae_d",
    label: "Curve D: office buildings, elementary and high schools",
    appliesTo: ["office", "school"],
    points: pts([
      [0, 5.1], [5, 5.8], [10, 6.6], [15, 7.4], [20, 8.2], [25, 8.6], [35, 10.7], [40, 11.0], [45, 11.4], [50, 12.5], [60, 13.3], [70, 14.2], [80, 15.0], [90, 15.8], [100, 16.6],
      [125, 18.8], [150, 20.7], [175, 22.0], [200, 23.5], [225, 24.9], [250, 26.2], [275, 27.1], [300, 28.1], [325, 29.1], [350, 29.8], [375, 30.4], [400, 31.0],
    ]),
    cite: sheetCite("Curve D (office buildings, elementary and high schools)"),
  },
};

export const BUILDING_TYPES = ["restaurant", "hospital", "nursing_home", "dormitory", "hotel", "motel", "apartment", "office", "school", "other"] as const;
export type BuildingType = (typeof BUILDING_TYPES)[number];

/** The default demand curve for a building type (editable per project), or null where the engineer must choose. */
export function defaultDemandCurve(buildingType: BuildingType): "ashrae_a" | "ashrae_b" | "ashrae_c" | "ashrae_d" | null {
  for (const c of Object.values(ASHRAE_CURVES)) if (c.appliesTo.includes(buildingType)) return c.id as "ashrae_a" | "ashrae_b" | "ashrae_c" | "ashrae_d";
  return null;
}

export const LEGACY_FIT_CITE: Citation = { source: "method", code: "Hunter-style power fit", edition: null, clause: "Q = 1.47 FU^0.735", detail: "general approximation, not a code table", text: "Hunter-style power fit Q = 1.47 FU^0.735 (the model's old default; a general approximation, not a code table)" };

export function firmCurve(id: "firm" | "ipc_e_tank" | "ipc_e_valve", points: readonly CurvePoint[], sourceNote: string): DemandCurve {
  const label = id === "ipc_e_tank" ? "IPC Appendix E, flush tanks (firm import)" : id === "ipc_e_valve" ? "IPC Appendix E, flushometer valves (firm import)" : "Firm demand table";
  const clause = id === "ipc_e_tank" ? "Table E103.3(3), flush tanks" : id === "ipc_e_valve" ? "Table E103.3(3), flushometer valves" : "firm demand table";
  return {
    id,
    label,
    appliesTo: [],
    points: [...points].sort((a, b) => a.wsfu - b.wsfu),
    cite: { source: id === "firm" ? "design_criteria" : "code", code: id === "firm" ? "Firm demand table" : "IPC", edition: null, clause, detail: sourceNote, text: `${label}: ${sourceNote}` },
  };
}

export interface DemandReading {
  readonly gpm: number;
  /** True when the fixture units are past the curve's last point (the value is held at the end, and the caller must warn). */
  readonly beyondRange: boolean;
  readonly maxWsfu: number;
}

export function readCurve(curve: DemandCurve, wsfu: number): DemandReading {
  if (curve.id === "legacy_fit") return { gpm: hunterStyleGpm(wsfu), beyondRange: false, maxWsfu: Number.POSITIVE_INFINITY };
  const last = curve.points[curve.points.length - 1];
  const maxWsfu = last?.wsfu ?? 0;
  const gpm = wsfu <= 0 ? 0 : (interpolateTable(curve.points.map((p) => ({ x: p.wsfu, y: p.gpm })), wsfu) ?? 0);
  return { gpm, beyondRange: wsfu > maxWsfu + 1e-9, maxWsfu };
}

export const LEGACY_FIT: DemandCurve = { id: "legacy_fit", label: "Hunter-style power fit (old default)", appliesTo: [], points: [], cite: LEGACY_FIT_CITE };
