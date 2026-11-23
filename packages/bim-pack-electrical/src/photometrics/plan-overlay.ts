import { z } from "zod";
import {
  VIEW_ANALYSIS_OVERLAY_FEATURE,
  peerReads,
  type Primitive,
  type Vec2,
  type ViewElement,
  type ViewGraphicsContext,
  type ViewGraphicsRow,
} from "@permitzip/bim-kernel";
import {
  evaluateEgressPhotometrics,
  evaluateNormalPhotometrics,
  type PhotometricGridPoint,
} from "./calc";

/**
 * 2D plan-graphics overlay (`VIEW_GRAPHICS_POINT`) for footcandle point grids,
 * marching-squares iso-contour lines, and sub-threshold fail highlights on
 * Lighting (`E-201`) and Life-Safety / Egress (`E-202`) plans.
 */

export const PHOTOMETRICS_OVERLAY_MODES = ["off", "normal", "egress"] as const;
export type PhotometricsOverlayMode = (typeof PHOTOMETRICS_OVERLAY_MODES)[number];

export interface PhotometricsViewProps {
  readonly photometricsMode?: PhotometricsOverlayMode;
  /** Draw iso-contour lines (default true). */
  readonly showContours?: boolean;
  /** Draw numeric footcandle grid labels (default true). */
  readonly showGridValues?: boolean;
  /** Highlight sub-threshold failing points in bold crimson (default true). */
  readonly showFailingHighlights?: boolean;
  /** Grid spacing override in feet (default 2 ft). */
  readonly gridSpacingFt?: number;
  /** Workplane elevation override in inches (default 30" normal / 0" egress). */
  readonly workplaneHeightIn?: number;
  /** Custom iso-contour footcandle thresholds (defaults: [10, 20, 30, 50] normal, [0.1, 1.0] egress). */
  readonly contourLevels?: readonly number[];
}

declare module "@permitzip/bim-kernel" {
  interface ViewGraphicsHints {
    /** Plans: photometric footcandle point grid, iso-contours, and egress pass/fail highlights. */
    readonly photometrics?: PhotometricsViewProps;
  }
}

export const photometricsViewPropsSchema = z
  .object({
    photometricsMode: z.enum(PHOTOMETRICS_OVERLAY_MODES).optional(),
    showContours: z.boolean().optional(),
    showGridValues: z.boolean().optional(),
    showFailingHighlights: z.boolean().optional(),
    gridSpacingFt: z.number().finite().min(0.5).max(20).optional(),
    workplaneHeightIn: z.number().finite().min(0).max(120).optional(),
    contourLevels: z.array(z.number().finite().positive().max(10000)).min(1).max(12).readonly().optional(),
  })
  .strict();

export function photometricsViewRefusal(hints: object, viewType: ViewElement["viewType"]): string | null {
  if (viewType !== "floor_plan" && viewType !== "ceiling_plan") {
    return "Photometric overlays draw on floor and ceiling plans. Set them on a floor or ceiling plan.";
  }
  const p = hints as PhotometricsViewProps;
  if (p.photometricsMode !== undefined && p.photometricsMode !== "off" && !peerReads(VIEW_ANALYSIS_OVERLAY_FEATURE)) {
    return "Photometric plan overlays can't be saved yet: the model server this model is open on is an older version.";
  }
  return null;
}

const DEFAULT_NORMAL_CONTOURS = [10, 20, 30, 50] as const;
const DEFAULT_EGRESS_CONTOURS = [0.1, 1.0] as const;

const NORMAL_CONTOUR_COLORS: readonly string[] = ["#64748b", "#0284c7", "#0d9488", "#16a34a"];
const EGRESS_CONTOUR_STYLES: readonly { readonly color: string; readonly dash?: readonly number[] }[] = [
  { color: "#dc2626" }, // 0.1 fc minimum threshold (solid crimson)
  { color: "#0284c7", dash: [1.6, 1.0] }, // 1.0 fc average threshold (dashed cyan-blue)
  { color: "#0d9488", dash: [0.8, 0.8] },
];

interface GridZoneInput {
  readonly gridCols: number;
  readonly gridRows: number;
  readonly gridPoints: readonly PhotometricGridPoint[];
}

export interface ContourSegment {
  readonly a: Vec2;
  readonly b: Vec2;
}

/**
 * Marching-squares iso-contour segment extraction on a single zone's sparse
 * rectangular calculation grid (coordinates in model mm).
 */
export function extractIsoContours(zone: GridZoneInput, level: number): ContourSegment[] {
  const { gridCols, gridRows, gridPoints } = zone;
  if (gridCols < 2 || gridRows < 2 || gridPoints.length < 4) return [];

  const grid = new Array<PhotometricGridPoint | undefined>(gridCols * gridRows);
  for (const pt of gridPoints) {
    if (pt.col >= 0 && pt.col < gridCols && pt.row >= 0 && pt.row < gridRows) {
      grid[pt.row * gridCols + pt.col] = pt;
    }
  }

  const interp = (p1: PhotometricGridPoint, p2: PhotometricGridPoint): Vec2 => {
    const dv = p2.fc - p1.fc;
    const t = Math.abs(dv) > 1e-6 ? Math.max(0, Math.min(1, (level - p1.fc) / dv)) : 0.5;
    return { x: p1.xMm + (p2.xMm - p1.xMm) * t, y: p1.yMm + (p2.yMm - p1.yMm) * t };
  };

  // Marching squares lookup table: edges 0=bottom(p0-p1), 1=right(p1-p2), 2=top(p2-p3), 3=left(p3-p0)
  // Corners: p0=(c,r) bit 1, p1=(c+1,r) bit 2, p2=(c+1,r+1) bit 4, p3=(c,r+1) bit 8
  const TABLE: readonly (readonly (readonly [number, number])[])[] = [
    [],
    [[3, 0]],
    [[0, 1]],
    [[3, 1]],
    [[1, 2]],
    [[3, 0], [1, 2]],
    [[0, 2]],
    [[3, 2]],
    [[2, 3]],
    [[0, 2]],
    [[0, 1], [2, 3]],
    [[1, 2]],
    [[3, 1]],
    [[0, 1]],
    [[3, 0]],
    [],
  ];

  const segments: ContourSegment[] = [];
  for (let r = 0; r < gridRows - 1; r++) {
    for (let c = 0; c < gridCols - 1; c++) {
      const p0 = grid[r * gridCols + c];
      const p1 = grid[r * gridCols + (c + 1)];
      const p2 = grid[(r + 1) * gridCols + (c + 1)];
      const p3 = grid[(r + 1) * gridCols + c];
      if (!p0 || !p1 || !p2 || !p3) continue;

      let idx = 0;
      if (p0.fc >= level) idx |= 1;
      if (p1.fc >= level) idx |= 2;
      if (p2.fc >= level) idx |= 4;
      if (p3.fc >= level) idx |= 8;
      const pairs = TABLE[idx]!;
      if (pairs.length === 0) continue;

      const edgePoint = (edge: number): Vec2 => {
        switch (edge) {
          case 0:
            return interp(p0, p1);
          case 1:
            return interp(p1, p2);
          case 2:
            return interp(p2, p3);
          default:
            return interp(p3, p0);
        }
      };

      for (const [eA, eB] of pairs) {
        segments.push({ a: edgePoint(eA), b: edgePoint(eB) });
      }
    }
  }
  return segments;
}

function insideWindow(p: Vec2, w: { readonly min: Vec2; readonly max: Vec2 }, margin = 0.5): boolean {
  return p.x >= w.min.x + margin && p.x <= w.max.x - margin && p.y >= w.min.y + margin && p.y <= w.max.y - margin;
}

/** Liang-Barsky clip of segment a-b to paper window w. */
function clipLine(a: Vec2, b: Vec2, w: { readonly min: Vec2; readonly max: Vec2 }): readonly [Vec2, Vec2] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const checks: readonly (readonly [number, number])[] = [
    [-dx, a.x - w.min.x],
    [dx, w.max.x - a.x],
    [-dy, a.y - w.min.y],
    [dy, w.max.y - a.y],
  ];
  for (const [p, q] of checks) {
    if (Math.abs(p) < 1e-9) {
      if (q < 0) return null;
    } else {
      const r = q / p;
      if (p < 0) {
        if (r > t1) return null;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return null;
        if (r < t1) t1 = r;
      }
    }
  }
  return [
    { x: a.x + t0 * dx, y: a.y + t0 * dy },
    { x: a.x + t1 * dx, y: a.y + t1 * dy },
  ];
}

function formatFcValue(fc: number, mode: "normal" | "egress"): string {
  if (mode === "egress" && fc < 10) return fc.toFixed(2);
  if (fc < 10) return fc.toFixed(1);
  return fc >= 100 ? Math.round(fc).toString() : fc.toFixed(1);
}

function drawPhotometricOverlay(ctx: ViewGraphicsContext, rawHints: unknown): void {
  const hints = (rawHints ?? {}) as PhotometricsViewProps;
  const mode = hints.photometricsMode ?? "off";
  if (mode === "off") return;

  const showContours = hints.showContours ?? true;
  const showGridValues = hints.showGridValues ?? true;
  const showFailingHighlights = hints.showFailingHighlights ?? true;
  const gridSpacingFt = hints.gridSpacingFt ?? 2;
  const levelFilter = ctx.view.props?.level;

  const zones: GridZoneInput[] = [];
  let legendTitle = "";
  let legendMetrics = "";
  let overallPass = false;

  if (mode === "egress") {
    const res = evaluateEgressPhotometrics(ctx.model, {
      ...(levelFilter ? { level: levelFilter } : {}),
      gridSpacingFt,
      workplaneHeightIn: hints.workplaneHeightIn ?? 0,
    });
    // Draw stair zones first so true 3D stair tread readings always take label priority over adjacent room boundaries
    for (const p of res.paths) if (p.kind === "stair") zones.push(p);
    for (const p of res.paths) if (p.kind !== "stair") zones.push(p);
    overallPass = res.pass;
    legendTitle = `EGRESS LIGHTING (NFPA 101) — ${res.pass ? "PASS" : "FAIL"}`;
    legendMetrics = `INIT ${res.overallAvgFc.toFixed(1)} AVG / ${res.overallMinFc.toFixed(2)} MIN FC | 90-MIN ${res.overallAvgFc90Min.toFixed(1)} / ${res.overallMinFc90Min.toFixed(2)} FC`;
  } else {
    const res = evaluateNormalPhotometrics(ctx.model, {
      ...(levelFilter ? { level: levelFilter } : {}),
      gridSpacingFt,
      includeTaskSurfaces: true,
      ...(hints.workplaneHeightIn !== undefined ? { workplaneHeightIn: hints.workplaneHeightIn } : {}),
    });
    // Include 3D stair tread summaries on the normal photometrics plan so stairs are never left blank!
    for (const st of res.stairSummaries) {
      zones.push({
        gridCols: 1,
        gridRows: 1,
        gridPoints: st.gridPoints,
      });
    }
    for (const s of res.spaces) zones.push(s);
    overallPass = res.pass;
    legendTitle = `PHOTOMETRICS (NORMAL) — ${res.pass ? "PASS" : "FAIL"}`;
    legendMetrics = `AVG ${res.overallAvgFc.toFixed(1)} FC | MIN ${res.overallMinFc.toFixed(1)} FC | LPD ${res.overallLpdWPerSqFt.toFixed(2)} W/SF`;
  }

  if (zones.length === 0) return;

  const prims: Primitive[] = ctx.prims;

  // 1. Iso-contour lines (marching squares)
  if (showContours) {
    const levels = hints.contourLevels ?? (mode === "egress" ? DEFAULT_EGRESS_CONTOURS : DEFAULT_NORMAL_CONTOURS);
    for (let li = 0; li < levels.length; li++) {
      const level = levels[li]!;
      const style =
        mode === "egress"
          ? (EGRESS_CONTOUR_STYLES[li % EGRESS_CONTOUR_STYLES.length] ?? { color: "#0284c7" })
          : { color: NORMAL_CONTOUR_COLORS[li % NORMAL_CONTOUR_COLORS.length] ?? "#0284c7", dash: li % 2 === 1 ? ([1.5, 1.0] as const) : undefined };

      for (const zone of zones) {
        const segments = extractIsoContours(zone, level);
        let labelPlaced = false;
        for (const seg of segments) {
          const pa = ctx.toPaper(seg.a);
          const pb = ctx.toPaper(seg.b);
          const clipped = clipLine(pa, pb, ctx.window);
          if (!clipped) continue;
          prims.push({
            kind: "line",
            a: clipped[0],
            b: clipped[1],
            pen: mode === "egress" && li === 0 ? "medium" : "thin",
            color: style.color,
            ...(style.dash ? { dash: style.dash } : {}),
          });
          // Place one crisp contour value label per zone per contour level
          if (!labelPlaced) {
            const mid = { x: (clipped[0].x + clipped[1].x) * 0.5, y: (clipped[0].y + clipped[1].y) * 0.5 };
            if (insideWindow(mid, ctx.window, 3)) {
              prims.push({
                kind: "text",
                at: mid,
                text: `${level} fc`,
                size: 1.3,
                anchor: "middle",
                bold: true,
                color: style.color,
                mask: true,
              });
              labelPlaced = true;
            }
          }
        }
      }
    }
  }

  // 2. Footcandle grid point values & sub-threshold fail highlights
  // Calculate adaptive stride so adjacent grid numbers never collide on paper (min 6.2 mm centre spacing)
  const spacingModelMm = gridSpacingFt * 304.8;
  const paperStepMm = spacingModelMm / Math.max(1, ctx.scale);
  const labelStride = Math.max(1, Math.ceil(6.2 / Math.max(0.5, paperStepMm)));
  const textCapMm = Math.max(1.2, Math.min(1.65, paperStepMm * 0.24));
  // Track placed paper text centres with generous label bounding box clearance so adjacent numbers never overlap (even on dense stair treads)
  const placedLabels: Vec2[] = [];
  const labelCollides = (p: Vec2): boolean => {
    for (let i = 0; i < placedLabels.length; i++) {
      const q = placedLabels[i]!;
      if (Math.abs(p.x - q.x) < 6.4 && Math.abs(p.y - q.y) < 3.0) return true;
    }
    return false;
  };

  for (const zone of zones) {
    for (const pt of zone.gridPoints) {
      const p = ctx.toPaper({ x: pt.xMm, y: pt.yMm });
      if (!insideWindow(p, ctx.window, 1.5)) continue;

      if (pt.fail && showFailingHighlights) {
        // Bold crimson highlight box + subtle tinted fill behind sub-threshold point
        const half = Math.max(1.4, Math.min(2.4, paperStepMm * 0.38));
        prims.push({
          kind: "fill",
          points: [
            { x: p.x - half, y: p.y - half },
            { x: p.x + half, y: p.y - half },
            { x: p.x + half, y: p.y + half },
            { x: p.x - half, y: p.y + half },
          ],
          grey: 0.88,
          color: "#fee2e2",
        });
        prims.push({
          kind: "rect",
          at: { x: p.x - half, y: p.y - half },
          size: { x: half * 2, y: half * 2 },
          pen: "medium",
          color: "#dc2626",
        });
      }

      if (showGridValues) {
        // Always print failing points; apply clean adaptive stride + collision guard to passing points
        const shouldDrawText = pt.fail || (pt.col % labelStride === 0 && pt.row % labelStride === 0 && !labelCollides(p));
        if (shouldDrawText) {
          placedLabels.push(p);
          prims.push({
            kind: "text",
            at: { x: p.x, y: p.y + textCapMm * 0.35 },
            text: formatFcValue(pt.fc, mode),
            size: textCapMm,
            anchor: "middle",
            bold: pt.fail,
            color: pt.fail ? "#b91c1c" : mode === "egress" ? "#0369a1" : "#334155",
            mask: !pt.fail,
          });
        }
      }
    }
  }

  // 3. Compact status badge tucked inside the top-right margin of the view window
  const badgeW = Math.min(ctx.window.max.x - ctx.window.min.x - 4, 78);
  const badgeH = 7.8;
  if (badgeW >= 36 && ctx.window.max.y - ctx.window.min.y >= 20) {
    const bx = ctx.window.max.x - badgeW - 2.0;
    const by = ctx.window.min.y + 1.5;
    const accent = overallPass ? "#0f766e" : "#dc2626";
    prims.push({
      kind: "fill",
      points: [
        { x: bx, y: by },
        { x: bx + badgeW, y: by },
        { x: bx + badgeW, y: by + badgeH },
        { x: bx, y: by + badgeH },
      ],
      grey: 0.96,
      color: "#ffffff",
    });
    prims.push({
      kind: "rect",
      at: { x: bx, y: by },
      size: { x: badgeW, y: badgeH },
      pen: "thin",
      color: accent,
    });
    prims.push({
      kind: "text",
      at: { x: bx + 1.8, y: by + 3.1 },
      text: legendTitle,
      size: 1.6,
      anchor: "start",
      bold: true,
      color: accent,
    });
    prims.push({
      kind: "text",
      at: { x: bx + 1.8, y: by + 6.0 },
      text: legendMetrics,
      size: 1.25,
      anchor: "start",
      color: "#334155",
    });
  }
}

export const PHOTOMETRIC_GRID_ROW: ViewGraphicsRow = {
  id: "electrical.photometric_grid",
  label: "Photometric grid & contours",
  hintsKey: "photometrics",
  layer: "over_parts",
  order: 45,
  draw: drawPhotometricOverlay,
  hintsSchema: photometricsViewPropsSchema,
  hintsRefusal: photometricsViewRefusal,
};
