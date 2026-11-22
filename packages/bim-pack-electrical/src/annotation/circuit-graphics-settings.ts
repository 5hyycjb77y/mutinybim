import { z } from "zod";
import { VIEW_HASH_MARKS_FEATURE, VIEW_LINK_ROUTING_FEATURE, VIEW_TYP_LABELS_FEATURE, peerReads, type Vec2, type ViewElement } from "@permitzip/bim-kernel";

/**
 * A plan's circuit settings (moved from the kernel's `documents.ts` in round
 * 13): the record the view keeps under `ViewProps.circuitGraphics`, its strict
 * writer, and when it can be saved. The kernel never reads inside it; it asks
 * the view graphics row (`CIRCUIT_GRAPHICS_ROW.hintsSchema` / `hintsRefusal`).
 */

/** arcs / orthogonal: lines joining each circuit's devices. numbers: the circuit number beside each device (multifamily). off: nothing drawn. */
export const CIRCUIT_GRAPHIC_STYLES = ["arcs", "orthogonal", "numbers", "off"] as const;
export type CircuitGraphicStyle = (typeof CIRCUIT_GRAPHIC_STYLES)[number];

/** off; the hots long and the neutral short; the same plus the ground (a long mark with a foot). */
export const HASH_MARK_STYLES = ["off", "hots_neutral", "hots_neutral_ground"] as const;
export type HashMarkStyle = (typeof HASH_MARK_STYLES)[number];

/** Where wire hash marks draw: home runs only (default), home runs + switch legs, or every branch wire span (Revit "Always"). */
export const HASH_MARK_LOCATIONS = ["home_runs", "home_runs_and_switch_legs", "all_runs"] as const;
export type HashMarkLocation = (typeof HASH_MARK_LOCATIONS)[number];

/**
 * Editable home-run overrides for one circuit in one view. Offsets are stored
 * relative to the host member's anchor (model mm) so dragging the device moves
 * its home run arrow, curve and label along with it automatically.
 */
export interface HomeRunHint {
  /** Attach the home run to a different member on the circuit. */
  readonly memberId?: string;
  /** Vector from the host member's wire anchor to the arrow tip (model mm). */
  readonly tipOffset?: Vec2;
  /** Optional mid-shaft bend offset from the host member's wire anchor (model mm) for a curved home run. */
  readonly bendOffset?: Vec2;
  /** Optional offset from the arrow tip to the circuit label position (model mm). */
  readonly labelOffset?: Vec2;
}

/** A person's adjustments to one circuit's or switch leg's drawing in one view; the lines themselves are re-derived from the model every time. */
export interface CircuitGraphicHint {
  /** Single pinned bend point (model mm) by sorted `"<idA>|<idB>"` pair (legacy single-vertex form). */
  readonly bends?: Readonly<Record<string, Vec2>>;
  /** Multi-vertex control points (model mm) by sorted `"<idA>|<idB>"` pair: 1 point = arc, 2+ points = smooth spline. */
  readonly waypoints?: Readonly<Record<string, readonly Vec2[]>>;
  /** Flip the automatic arc bulge direction on a `"<idA>|<idB>"` span. */
  readonly flipArc?: Readonly<Record<string, boolean>>;
  /** Movable home-run direction, length, curve, host member, and label offset. */
  readonly homeRun?: HomeRunHint;
  /** Per-member relative model-mm offsets for movable switch-leg designations ("a", "b") or circuit numbers. */
  readonly memberLabelOffsets?: Readonly<Record<string, Vec2>>;
  /** Multi-wire branch circuit (MWBC, NEC 210.4) shared-neutral group id: circuits sharing a group on the same panel combine into one multi-arrowhead home run with shared neutral hash marks. */
  readonly mwbcGroup?: string;
  /** Higher draws unbroken where it crosses a lower one, which gets the gap. Absent: feeders 3, circuits 2, switch legs 0. */
  readonly priority?: number;
}

export interface CircuitGraphicsProps {
  readonly style?: CircuitGraphicStyle;
  /** Draw branch circuit lines & home runs. Set `false` with `switchLegs: true` for a dedicated lighting controls schematic plan. Absent: on. */
  readonly showCircuits?: boolean;
  /** The arrow and `<panel>-<circuit>` tag on the device nearest the panel. Absent: on. */
  readonly homeRuns?: boolean;
  /** Dashed switch legs and control wiring from switches/dimmers/sensors to controlled fixtures & receptacles. Absent: on. */
  readonly switchLegs?: boolean;
  /** Lowercase switch-leg designations ("a", "b") beside switches and controlled fixtures. Absent: on. */
  readonly switchLegLabels?: boolean;
  /** Typicals: draw the circuiting on every copy, not only the original (which then reads "TYP."). Absent: off. */
  readonly allCopies?: boolean;
  /** Per service link id (or `"switch:<leg>"` for switch legs). */
  readonly hints?: Readonly<Record<string, CircuitGraphicHint>>;
  /** Round 12: marks across each home run, one per wire (`HASH_MARK_STYLES`). Absent: off. Written only when every peer advertises `VIEW_HASH_MARKS_FEATURE`. */
  readonly hashMarks?: HashMarkStyle;
  /** Where wire hash marks draw: home runs only (default) or all branch wire spans too. */
  readonly hashMarksOn?: HashMarkLocation;
  /** Round 13: with copies drawn, a home run repeated identically on every copy is labelled once, "(3) TYP.", on the first. Absent: on. Written only when every peer advertises `VIEW_TYP_LABELS_FEATURE`. */
  readonly typLabelsOnce?: boolean;
}

declare module "@permitzip/bim-kernel" {
  interface ViewGraphicsHints {
    /** Plans: how circuits, home runs and switch legs draw. Absent: arcs on electrical plans, none elsewhere. */
    readonly circuitGraphics?: CircuitGraphicsProps;
  }
}

const id = z.string().min(1).max(200);
const circuitPoint = z.object({ x: z.number().finite().min(-1e7).max(1e7), y: z.number().finite().min(-1e7).max(1e7) }).strict();
const homeRunHintSchema = z
  .object({
    memberId: id.optional(),
    tipOffset: circuitPoint.optional(),
    bendOffset: circuitPoint.optional(),
    labelOffset: circuitPoint.optional(),
  })
  .strict();

/** Strict writer for `circuitGraphics`. Replaces the whole setting. */
export const circuitGraphicsSchema = z
  .object({
    style: z.enum(CIRCUIT_GRAPHIC_STYLES).optional(),
    showCircuits: z.boolean().optional(),
    homeRuns: z.boolean().optional(),
    switchLegs: z.boolean().optional(),
    switchLegLabels: z.boolean().optional(),
    allCopies: z.boolean().optional(),
    /** Per link id (or `"switch:<leg>"`): pinned bends/waypoints, arc flips, home run handle overrides, movable label offsets, MWBC group, and crossing priority. */
    hints: z
      .record(
        id,
        z
          .object({
            bends: z.record(z.string().min(3).max(401), circuitPoint).optional(),
            waypoints: z.record(z.string().min(3).max(401), z.array(circuitPoint).min(1).max(16).readonly()).optional(),
            flipArc: z.record(z.string().min(3).max(401), z.boolean()).optional(),
            homeRun: homeRunHintSchema.optional(),
            memberLabelOffsets: z.record(id, circuitPoint).optional(),
            mwbcGroup: z.string().trim().min(1).max(60).optional(),
            priority: z.number().int().min(-9).max(9).optional(),
          })
          .strict(),
      )
      .optional(),
    hashMarks: z.enum(HASH_MARK_STYLES).optional(),
    hashMarksOn: z.enum(HASH_MARK_LOCATIONS).optional(),
    typLabelsOnce: z.boolean().optional(),
  })
  .strict();

const OLDER_SERVER = "the model server this model is open on is an older version (or another open browser tab is older — reload any older tabs and try again).";

function usesRoutingHints(p: CircuitGraphicsProps): boolean {
  if (p.showCircuits !== undefined || p.hashMarksOn !== undefined || p.switchLegLabels !== undefined) return true;
  for (const h of Object.values(p.hints ?? {})) {
    if (
      h.waypoints !== undefined ||
      h.flipArc !== undefined ||
      h.homeRun !== undefined ||
      h.memberLabelOffsets !== undefined ||
      h.mwbcGroup !== undefined
    )
      return true;
  }
  return false;
}

/** Why a view can't keep these circuit settings, in words; null when it can. */
export function circuitGraphicsRefusal(hints: object, viewType: ViewElement["viewType"]): string | null {
  if (viewType !== "floor_plan" && viewType !== "ceiling_plan") return "Circuit lines and home runs draw on plans. Set them on a floor or ceiling plan.";
  const p: CircuitGraphicsProps = hints;
  // Mixed versions: an older peer's strict view schema would refuse these switches, so they are saved only when every peer reads them.
  if (p.hashMarks !== undefined && !peerReads(VIEW_HASH_MARKS_FEATURE)) return `Wire hash marks can't be saved yet: ${OLDER_SERVER}`;
  if (p.typLabelsOnce !== undefined && !peerReads(VIEW_TYP_LABELS_FEATURE)) return `"Label repeated typicals once" can't be saved yet: ${OLDER_SERVER}`;
  if (usesRoutingHints(p) && !peerReads(VIEW_LINK_ROUTING_FEATURE)) return `Spline wire vertices, editable home runs and switch-leg labels can't be saved yet: ${OLDER_SERVER}`;
  return null;
}
