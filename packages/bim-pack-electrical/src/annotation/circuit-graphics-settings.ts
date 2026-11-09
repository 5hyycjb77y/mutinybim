import { z } from "zod";
import { VIEW_HASH_MARKS_FEATURE, VIEW_TYP_LABELS_FEATURE, peerReads, type Vec2, type ViewElement } from "@permitzip/bim-kernel";

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

/** A person's adjustments to one circuit's drawing in one view; the lines themselves are re-derived from the model every time. */
export interface CircuitGraphicHint {
  /** Pinned bend points (model mm) by the pair of devices a line joins, `"<idA>|<idB>"` with the ids sorted. */
  readonly bends?: Readonly<Record<string, Vec2>>;
  /** Higher draws unbroken where it crosses a lower one, which gets the gap. Absent: feeders 3, circuits 2, switch legs 0. */
  readonly priority?: number;
}

export interface CircuitGraphicsProps {
  readonly style?: CircuitGraphicStyle;
  /** The arrow and `<panel>-<circuit>` tag on the device nearest the panel. Absent: on. */
  readonly homeRuns?: boolean;
  /** Dashed switch legs from each switch to the fixtures it controls. Absent: on. */
  readonly switchLegs?: boolean;
  /** Typicals: draw the circuiting on every copy, not only the original (which then reads "TYP."). Absent: off. */
  readonly allCopies?: boolean;
  /** Per service link id. */
  readonly hints?: Readonly<Record<string, CircuitGraphicHint>>;
  /** Round 12: marks across each home run, one per wire (`HASH_MARK_STYLES`). Absent: off. Written only when every peer advertises `VIEW_HASH_MARKS_FEATURE`. */
  readonly hashMarks?: HashMarkStyle;
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

/** Strict writer for `circuitGraphics` (round 12's kernel schema, plus `typLabelsOnce`). Replaces the whole setting. */
export const circuitGraphicsSchema = z
  .object({
    style: z.enum(CIRCUIT_GRAPHIC_STYLES).optional(),
    homeRuns: z.boolean().optional(),
    switchLegs: z.boolean().optional(),
    allCopies: z.boolean().optional(),
    /** Per link id: pinned bends by `"<idA>|<idB>"` (sorted), and crossing priority. */
    hints: z.record(id, z.object({ bends: z.record(z.string().min(3).max(401), circuitPoint).optional(), priority: z.number().int().min(-9).max(9).optional() }).strict()).optional(),
    hashMarks: z.enum(HASH_MARK_STYLES).optional(),
    typLabelsOnce: z.boolean().optional(),
  })
  .strict();

const OLDER_SERVER = "the model server this model is open on is an older version. Try again once it is updated.";

/** Why a view can't keep these circuit settings, in words; null when it can. */
export function circuitGraphicsRefusal(hints: object, viewType: ViewElement["viewType"]): string | null {
  if (viewType !== "floor_plan" && viewType !== "ceiling_plan") return "Circuit lines and home runs draw on plans. Set them on a floor or ceiling plan.";
  const p: CircuitGraphicsProps = hints;
  // Mixed versions: an older peer's strict view schema would refuse these switches, so they are saved only when every peer reads them.
  if (p.hashMarks !== undefined && !peerReads(VIEW_HASH_MARKS_FEATURE)) return `Wire hash marks can't be saved yet: ${OLDER_SERVER}`;
  if (p.typLabelsOnce !== undefined && !peerReads(VIEW_TYP_LABELS_FEATURE)) return `"Label repeated typicals once" can't be saved yet: ${OLDER_SERVER}`;
  return null;
}
