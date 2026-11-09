import { z } from "zod";
import { sizeLabel } from "./rules";
import type { RunSize } from "./types";

/**
 * Run insulation: a wrap outside, or a liner inside.
 *
 * A run's `size` is always the sheet-metal size, the duct that is bought and
 * hung. Insulation goes on one side of that metal:
 *
 * - wrap: outside. The air sees the bare duct; the envelope that has to clear
 *   structure and other trades is the metal plus the wrap on every side.
 * - liner: inside. The envelope is the metal; the air passes through the metal
 *   less the liner on every side, over a rougher surface.
 *
 * Fittings carry the insulation of the run they join, written by the same
 * edits that set it on the segments.
 *
 * Pipe takes a wrap only, outside the pipe's outside diameter; `size` stays
 * the pipe's nominal size. The thickness by system and size comes from the
 * project's pipe insulation schedule (pipe/plumbing-settings.ts) or is set
 * per run.
 */

export const RUN_INSULATION_KINDS = ["wrap", "liner"] as const;
export type RunInsulationKind = (typeof RUN_INSULATION_KINDS)[number];

/** What the air runs over inside a liner: a smooth facing, or the rougher spray-coated surface. */
export const LINER_SURFACES = ["faced", "spray_coated"] as const;
export type LinerSurface = (typeof LINER_SURFACES)[number];

/** Absolute roughness of fibrous glass liner by its air-side surface, mm (ASHRAE Fundamentals, Duct Design: 1.5 faced, 4.5 spray coated). */
export const LINER_ROUGHNESS_MM: Readonly<Record<LinerSurface, number>> = { faced: 1.5, spray_coated: 4.5 };

/** A liner's surface; absent means faced. */
export function linerSurface(insulation: RunInsulation | undefined): LinerSurface | null {
  return insulation?.kind === "liner" ? (insulation.surface ?? "faced") : null;
}

export interface RunInsulation {
  readonly kind: RunInsulationKind;
  readonly thicknessMm: number;
  /** As the spec names it ("fiberglass blanket", "elastomeric"). */
  readonly material?: string;
  /** Installed R-value (h·ft²·°F/Btu). */
  readonly rValue?: number;
  /** Liner only; absent: faced. */
  readonly surface?: LinerSurface;
}

const MM_PER_IN = 25.4;
/** Thinnest and thickest insulation a run takes: 1/4" to 6". */
const MIN_THICKNESS_MM = 6.35;
const MAX_THICKNESS_MM = 152.4;
/** A liner has to leave at least this much clear inside, each way. */
const MIN_CLEAR_MM = 2 * MM_PER_IN;

export const runInsulationSchema = z
  .object({
    kind: z.enum(RUN_INSULATION_KINDS),
    thicknessMm: z.number().finite().min(MIN_THICKNESS_MM).max(MAX_THICKNESS_MM),
    material: z.string().trim().min(1).max(60).optional(),
    rValue: z.number().finite().positive().max(60).optional(),
    surface: z.enum(LINER_SURFACES).optional(),
  })
  .strict();

/** What a size suggestion aims for. Every field is optional; the system kind's typical value fills the gap. */
export interface RunSizingCriteria {
  /** Friction rate the suggestion stays at or under, inches of water per 100 ft. */
  readonly frictionInPer100Ft?: number;
  /** Fastest the air may go, feet per minute. */
  readonly maxVelocityFpm?: number;
  /** Widest rectangle allowed, width over height (4 means 4:1). */
  readonly maxAspectRatio?: number;
}

export const runSizingCriteriaSchema = z
  .object({
    frictionInPer100Ft: z.number().finite().min(0.01).max(1).optional(),
    maxVelocityFpm: z.number().finite().min(100).max(6000).optional(),
    maxAspectRatio: z.number().finite().min(1).max(10).optional(),
  })
  .strict();

/** The thicknesses offered first in pickers: 1", 1-1/2" and 2". */
export const COMMON_INSULATION_THICKNESS_IN = [1, 1.5, 2] as const;

export function sameInsulation(a: RunInsulation | undefined, b: RunInsulation | undefined): boolean {
  if (!a || !b) return a === b;
  return a.kind === b.kind && Math.abs(a.thicknessMm - b.thicknessMm) < 0.01 && a.material === b.material && a.rValue === b.rValue && linerSurface(a) === linerSurface(b);
}

/** To the micron, so 24" less a 1" liner each side is 558.8 and not 558.7999999. */
const um = (v: number) => Math.round(v * 1000) / 1000;

function grow(size: RunSize, by: number): RunSize {
  switch (size.shape) {
    case "rect":
    case "oval":
      return { ...size, width: um(size.width + 2 * by), height: um(size.height + 2 * by) };
    case "round":
      return { ...size, diameter: um(size.diameter + 2 * by) };
    default:
      return size;
  }
}

/** Where the air goes: the sheet-metal size less a liner on every side; the metal itself otherwise. */
export function runAirway(size: RunSize, insulation: RunInsulation | undefined): RunSize {
  return insulation?.kind === "liner" ? grow(size, -insulation.thicknessMm) : size;
}

/** The envelope other work has to clear: the metal plus a wrap on every side; the metal itself otherwise. */
export function runOuterSize(size: RunSize, insulation: RunInsulation | undefined): RunSize {
  return insulation?.kind === "wrap" ? grow(size, insulation.thicknessMm) : size;
}

/** Null when this insulation fits this size; else why not, starting with a capital. */
export function insulationIssue(size: RunSize, insulation: RunInsulation): string | null {
  if (size.shape === "pipe") {
    if (insulation.kind === "liner") return "Pipe takes insulation outside (a wrap); a liner goes inside duct";
    return insulation.surface ? "A surface (faced or spray-coated) applies to a duct liner" : null;
  }
  if (size.shape !== "rect" && size.shape !== "round" && size.shape !== "oval") return "Insulation goes on duct and pipe";
  if (insulation.kind !== "liner") return insulation.surface ? "A surface (faced or spray-coated) applies to a liner; a wrap is outside the air" : null;
  const inner = runAirway(size, insulation);
  const least = inner.shape === "round" ? inner.diameter : inner.shape === "rect" || inner.shape === "oval" ? Math.min(inner.width, inner.height) : 0;
  if (least < MIN_CLEAR_MM - 0.01) {
    return `A ${thicknessLabel(insulation.thicknessMm)} liner leaves ${sizeLabel(inner).replace(/ oval$/, "")} clear inside ${sizeLabel(size)} duct; a liner has to leave at least 2" each way. Use a bigger duct or wrap it outside instead`;
  }
  return null;
}

/** 1", 1½", ¾": to the nearest 1/8 inch. */
export function thicknessLabel(mm: number): string {
  const v = Math.round((mm / MM_PER_IN) * 8) / 8;
  const whole = Math.floor(v);
  const frac = v - whole;
  const fractions: Readonly<Record<string, string>> = { "0.125": "⅛", "0.25": "¼", "0.375": "⅜", "0.5": "½", "0.625": "⅝", "0.75": "¾", "0.875": "⅞" };
  const f = fractions[String(frac)] ?? "";
  return whole === 0 && f ? `${f}"` : `${whole}${f}"`;
}

const KIND_WORD: Readonly<Record<RunInsulationKind, string>> = { wrap: "wrap", liner: "liner" };

/** "1" liner", "2" wrap R-6"; "No insulation" when there is none. */
export function insulationLabel(insulation: RunInsulation | undefined): string {
  if (!insulation) return "No insulation";
  return `${thicknessLabel(insulation.thicknessMm)} ${KIND_WORD[insulation.kind]}${linerSurface(insulation) === "spray_coated" ? ", spray-coated" : ""}${insulation.rValue !== undefined ? ` R-${Math.round(insulation.rValue * 10) / 10}` : ""}`;
}

/** The size tag with its insulation: "24"x12" (1" liner)", pipe "2" (1" ins.)"; the bare size when there is none. */
export function insulatedSizeLabel(size: RunSize, insulation: RunInsulation | undefined): string {
  if (!insulation) return sizeLabel(size);
  return `${sizeLabel(size)} (${thicknessLabel(insulation.thicknessMm)} ${size.shape === "pipe" ? "ins." : KIND_WORD[insulation.kind]})`;
}

/**
 * The insulation edits' shapes (`set_run_insulation`, `set_pipe_insulation`):
 * stored in model history, so every host parses them whether or not the
 * Mechanical add-on that runs them is loaded (it contributes them at
 * `kernel.command`).
 */
export const runInsulationCommandSchemas = [
  z.object({
    type: z.literal("set_run_insulation"),
    elementId: z.string().min(1).max(200),
    /** Null takes it off. */
    insulation: runInsulationSchema.nullable(),
    scope: z.enum(["piece", "run", "system"]),
  }),
  z.object({
    type: z.literal("set_pipe_insulation"),
    systemId: z.string().min(1).max(200),
    /** What the edit does, in words, for the approval card and history. */
    label: z.string().trim().min(1).max(160).optional(),
    pieces: z
      .array(z.object({ segmentId: z.string().min(1).max(200), insulation: runInsulationSchema.nullable() }))
      .min(1)
      .max(2000),
  }),
] as const;

export const runInsulationCommandSchema = z.discriminatedUnion("type", [...runInsulationCommandSchemas]);
export type RunInsulationCommand = z.infer<typeof runInsulationCommandSchema>;

export function isRunInsulationCommand(command: { type: string }): command is RunInsulationCommand {
  return command.type === "set_run_insulation" || command.type === "set_pipe_insulation";
}

/** @deprecated Round 14 names; use the run names above. Kept for one round so other packages move at their own pace. */
export type DuctInsulation = RunInsulation;
/** @deprecated */
export const ductInsulationSchema = runInsulationSchema;
/** @deprecated */
export type DuctSizingCriteria = RunSizingCriteria;
/** @deprecated */
export const ductSizingCriteriaSchema = runSizingCriteriaSchema;
/** @deprecated */
export const ductAirway = runAirway;
/** @deprecated */
export const ductOuterSize = runOuterSize;
/** @deprecated */
export const ductDesignCommandSchemas = runInsulationCommandSchemas;
/** @deprecated */
export type DuctDesignCommand = RunInsulationCommand;
/** @deprecated */
export const isDuctDesignCommand = isRunInsulationCommand;
