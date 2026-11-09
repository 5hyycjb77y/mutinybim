import type { BimElement, ModelState } from "@permitzip/bim-kernel/types";
import { frameSupportsOf } from "./frame";
import { supportBearings } from "./load-path";

/**
 * `struct.footing_unsupported`: a column that bears on nothing (no footing
 * under its base and no column whose top meets it), so its load reaches no
 * foundation. Findings have the same shape as bim-lint's `Finding`, so the
 * lint point can carry the rule unchanged once it is open to packs.
 */

export const FOOTING_UNSUPPORTED_RULE_ID = "struct.footing_unsupported";
export const FOOTING_UNSUPPORTED_RULE_VERSION = 1;

export interface StructFinding {
  readonly id: string;
  readonly rule: string;
  readonly severity: "error" | "warning" | "info";
  readonly elementIds: readonly string[];
  readonly at: { readonly level: string; readonly x_ft: number; readonly y_ft: number; readonly z_ft: number };
  /** Plain words, at most 160 characters. */
  readonly message: string;
  readonly fix?: { readonly tool: string; readonly hint: string };
}

const FT = 304.8;

/** The finding for one column, or null when it bears on a footing or a column below. */
export function footingUnsupported(model: ModelState, el: BimElement): StructFinding | null {
  if (el.kind !== "column") return null;
  const supports = frameSupportsOf(model);
  const column = supports.columnById.get(el.id);
  if (!column || supportBearings(supports).get(column.id)) return null;
  const level = model.elements[column.levelId];
  const levelName = level?.kind === "level" ? level.name : column.levelId;
  const message = `${column.label} has no footing below it, so its load reaches no foundation`.slice(0, 160);
  return {
    id: `${FOOTING_UNSUPPORTED_RULE_ID}:${column.id}`,
    rule: FOOTING_UNSUPPORTED_RULE_ID,
    severity: "error",
    elementIds: [column.id],
    at: { level: levelName, x_ft: column.position.x / FT, y_ft: column.position.y / FT, z_ft: column.baseZMm / FT },
    message,
    fix: { tool: "bim_place", hint: "Place a pad footing under the column, or stand it on a column or beam that carries it" },
  };
}

/** Every unsupported column in a model, for a full run. */
export function footingUnsupportedAll(model: ModelState): StructFinding[] {
  const out: StructFinding[] = [];
  for (const c of frameSupportsOf(model).columns) {
    const el = model.elements[c.id];
    const f = el ? footingUnsupported(model, el) : null;
    if (f) out.push(f);
  }
  return out;
}
