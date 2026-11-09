import { qty, to, type Quantity } from "@permitzip/bim-units";
import { CIVIL_CLASS } from "./ids";
import type { StormNetworkResult } from "./network";

/**
 * The civil checks, as plain findings over a solved storm network. The lint
 * rules (`pack.ts`) emit these through the lint runner; an agent or a test
 * can read them directly.
 */

export const INLET_OVERLOADED_RULE = "civil.inlet_overloaded";
export const SLOPE_BELOW_MINIMUM_RULE = "civil.slope_below_minimum";

export interface CivilFinding {
  readonly rule: typeof INLET_OVERLOADED_RULE | typeof SLOPE_BELOW_MINIMUM_RULE;
  readonly severity: "warning" | "error";
  /** The element the finding is about first (the inlet; the pipe), then the others it names. */
  readonly elementIds: readonly string[];
  /** Plain words, at most 160 characters. */
  readonly message: string;
  readonly fix: string;
}

const cfs = (q: Quantity<"flow_liquid">): string => to(q, "cfs").toFixed(2);
const feet = (mm: number): string => to(qty("length", mm, "mm"), "ft").toFixed(2);

function clip(text: string): string {
  return text.length <= 160 ? text : `${text.slice(0, 157)}...`;
}

/** An inlet whose catchments send it more than its stated capacity. Inlets with no capacity are not judged. */
export function inletOverloadFindings(net: StormNetworkResult): CivilFinding[] {
  const out: CivilFinding[] = [];
  for (const s of net.site.structures) {
    if (s.classId !== CIVIL_CLASS.stormInlet || s.capacity === null) continue;
    const q = net.surfaceRunoff.get(s.id);
    if (q === undefined || q <= s.capacity) continue;
    const from = net.site.catchments.filter((c) => c.drainsTo === s.id).map((c) => c.id);
    out.push({
      rule: INLET_OVERLOADED_RULE,
      severity: "warning",
      elementIds: [s.id, ...from],
      message: clip(`${s.name} takes ${cfs(q)} cfs of runoff but can take ${cfs(s.capacity)} cfs`),
      fix: "Add an inlet, use a larger grate, or send part of the catchment elsewhere",
    });
  }
  return out;
}

/** A storm pipe that falls less than its minimum slope (or rises). */
export function slopeFindings(net: StormNetworkResult): CivilFinding[] {
  const out: CivilFinding[] = [];
  for (const p of net.pipes) {
    const g = p.gravity;
    if (!g || g.status !== "too_flat" || g.minSlope === null) continue;
    const slopePct = g.slope === null ? "no" : `${(g.slope * 100).toFixed(2)} %`;
    out.push({
      rule: SLOPE_BELOW_MINIMUM_RULE,
      severity: "warning",
      elementIds: [p.id, p.from, p.to],
      message: clip(`Storm pipe ${p.id} runs at ${slopePct} slope; it needs at least ${(g.minSlope * 100).toFixed(2)} % (${feet(g.shortfallMm ?? 0)} ft more fall)`),
      fix: `Lower the invert at ${p.to} or raise it at ${p.from}`,
    });
  }
  return out;
}
