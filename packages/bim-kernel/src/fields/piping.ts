import { segmentLength3 } from "../routing/geometry";
import { slopeInPerFt } from "../routing/pipe/gravity";
import { pipeDims } from "../routing/pipe/specs";
import { nominalSizeText, sizeLabel, systemRules } from "../routing/rules";
import type { RunSegment } from "../routing/types";
import type { BimElement } from "../types";
import type { FieldPathInfo, FieldScalar } from "./resolver";

/**
 * Field paths on a pipe (a run segment, or a fitting read through the segment
 * it joins): size, length, slope, inverts and what it carries, as risers,
 * isometrics, tags and schedules print them. One resolver for all of them, so
 * a riser label and a pipe tag never disagree.
 */

type Elements = Readonly<Record<string, BimElement>>;

const FT = 304.8;
const IN = 25.4;

export const PIPE_FIELD_PATHS: readonly FieldPathInfo[] = [
  { path: "pipe.size", label: "Pipe nominal size", on: "pipe", example: '1½"' },
  { path: "pipe.size_full", label: "Pipe size, spec and material", on: "pipe", example: '1½" Type L Copper' },
  { path: "pipe.length_ft", label: "Pipe length (ft)", on: "pipe", example: "93.4" },
  { path: "pipe.length_lf", label: "Pipe length, as tagged", on: "pipe", example: "94 LF" },
  { path: "pipe.slope", label: "Pipe slope (in/ft)", on: "pipe", example: '⅛"/FT' },
  { path: "pipe.invert_start", label: "Invert at the start (ft)", on: "pipe", example: "-2.17'" },
  { path: "pipe.invert_end", label: "Invert at the end (ft)", on: "pipe", example: "-2.42'" },
  { path: "pipe.flow", label: "What the pipe carries (fixture units, gpm or MBH)", on: "pipe", example: "59 DFU" },
  { path: "pipe.system", label: "Pipe system", on: "pipe", example: "Sanitary" },
];

const SLOPE_TEXT: ReadonlyArray<readonly [number, string]> = [
  [1 / 16, '1/16"/FT'],
  [1 / 8, '1/8"/FT'],
  [1 / 4, '1/4"/FT'],
  [1 / 2, '1/2"/FT'],
];

/** `1/8"/FT` for the slopes plumbers draw, else the decimal. */
export function slopeText(inPerFt: number): string {
  for (const [v, t] of SLOPE_TEXT) if (Math.abs(inPerFt - v) < 0.004) return t;
  return `${Math.round(inPerFt * 1000) / 1000}"/FT`;
}

/** Feet to two places, with the sign: `-2.17'`. */
export function feetText(ft: number): string {
  return `${(Math.round(ft * 100) / 100).toFixed(2)}'`;
}

/** The segment a pipe path reads: the segment itself, or the first segment a fitting joins. */
export function pipeSegmentOf(elements: Elements, id: string): RunSegment | null {
  const el = elements[id];
  if (el?.kind === "run_segment") return el.domain === "pipe" ? el : null;
  if (el?.kind !== "run_fitting" || el.domain !== "pipe") return null;
  const host = el.host ? elements[el.host.segmentId] : undefined;
  if (host?.kind === "run_segment") return host;
  for (const p of el.ports) {
    const s = p.link ? elements[p.link.elementId] : undefined;
    if (s?.kind === "run_segment") return s;
  }
  return null;
}

/** Height above the project's zero (mm) of a point on a run: its level's elevation plus its z. */
export function runHeightMm(elements: Elements, levelId: string, z: number): number {
  const lvl = elements[levelId];
  return (lvl?.kind === "level" ? lvl.elevationMm : 0) + z;
}

function invertFt(elements: Elements, seg: RunSegment, end: "start" | "end"): number | null {
  if (seg.size.shape !== "pipe") return null;
  return (runHeightMm(elements, seg.levelId, seg[end].z) - pipeDims(seg.size).idMm / 2) / FT;
}

const out = (value: FieldScalar, text: string) => ({ value, text });

/** A `pipe.*` path on a pipe; null when the path is not a pipe path (the general resolver answers). */
export function resolvePipingField(elements: Elements, elementId: string, path: string): { value: FieldScalar; text: string } | null {
  if (!path.startsWith("pipe.")) return null;
  const seg = pipeSegmentOf(elements, elementId);
  if (!seg) return out(null, "");
  const lengthFt = segmentLength3(seg) / FT;
  switch (path.slice("pipe.".length)) {
    case "size":
      return out(seg.size.shape === "pipe" ? Math.round((seg.size.nominalMm / IN) * 1000) / 1000 : nominalSizeText(seg.size), nominalSizeText(seg.size));
    case "size_full":
      return out(sizeLabel(seg.size), sizeLabel(seg.size));
    case "length_ft":
      return out(Math.round(lengthFt * 10) / 10, String(Math.round(lengthFt * 10) / 10));
    case "length_lf": {
      const lf = Math.max(1, Math.round(lengthFt));
      return out(lf, `${lf} LF`);
    }
    case "slope": {
      const horizontal = Math.hypot(seg.end.x - seg.start.x, seg.end.y - seg.start.y);
      if (horizontal < 1) return out(null, "");
      const s = slopeInPerFt(seg);
      return out(Math.round(s * 10000) / 10000, s > 0 ? slopeText(s) : "");
    }
    case "invert_start":
    case "invert_end": {
      const v = invertFt(elements, seg, path.endsWith("start") ? "start" : "end");
      return v === null ? out(null, "") : out(Math.round(v * 100) / 100, feetText(v));
    }
    case "flow": {
      const system = elements[seg.systemId];
      const unit = system?.kind === "mep_system" ? systemRules(system.systemKind).flowUnit : "";
      const v = Math.round(seg.flow * 100) / 100;
      return out(v, v > 0 ? `${v}${unit ? ` ${unit}` : ""}` : "");
    }
    case "system": {
      const system = elements[seg.systemId];
      return system?.kind === "mep_system" ? out(system.name, system.name) : out(null, "");
    }
    default:
      return out(null, "");
  }
}
