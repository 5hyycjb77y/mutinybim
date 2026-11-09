import { z } from "zod";
import { defineExtensionPoint } from "../packs/contract";
import { activePackSet } from "../packs/scope";

/**
 * Firm design limits (contract 1.10.0). A design limit is a rule of thumb a
 * firm designs to ("velocity at most 8 ft/s in this system", "25 % spare
 * capacity"), with where it came from. Add-ons ship best-practice defaults
 * per discipline and per system (`DESIGN_LIMIT_DEFAULT_POINT`); the firm's
 * library edits them; a project edits the firm's. Editing keeps the id: a
 * firm or project row with the same id replaces the layer below it.
 *
 * `designLimitsFor` answers "which limits bind this value here": every limit
 * whose quantity matches and whose `appliesTo` the selector meets, most
 * specific first, each from the highest layer that has its id. A limit that
 * names a field the selector doesn't know (a system, a material) doesn't
 * apply, so a generic limit is never shadowed by a guess.
 */

export type DesignLimitSeverity = "error" | "warning" | "info";
export const DESIGN_LIMIT_SEVERITIES: readonly DesignLimitSeverity[] = ["error", "warning", "info"];

/** Where a limit came from, highest first. */
export type DesignLimitLayer = "project" | "firm" | "addon";
export const DESIGN_LIMIT_LAYERS: readonly DesignLimitLayer[] = ["project", "firm", "addon"];

export interface DesignLimitBand {
  readonly min?: number;
  readonly max?: number;
  /** What to design to inside the band (a sizing aim); not a pass / fail edge. */
  readonly target?: number;
}

/** What a limit applies to. Every field given must match; absent fields match anything. */
export interface DesignLimitAppliesTo {
  /** `DISCIPLINE_POINT` id. */
  readonly discipline?: string;
  /** Service ids (`SERVICE_POINT`). */
  readonly services?: readonly string[];
  /** System kind or system type ids, in the add-on's words. */
  readonly systems?: readonly string[];
  readonly materials?: readonly string[];
  /** Element classes (`CLASS_POINT` ids). */
  readonly elementClasses?: readonly string[];
}

/** Where a limit came from, in our own words ("PermitZIP practice, design review Oct 2026"). Shown wherever the limit is. */
export interface DesignLimitCitation {
  readonly source: string;
  readonly note?: string;
}

export interface DesignLimit {
  /** Stable across layers: a firm or project row with this id replaces the default. Add-on defaults are `<pack>.<name>`. */
  readonly id: string;
  /** What a person calls it ("Domestic cold water velocity"). */
  readonly label: string;
  /** The quantity kind (`bim-units` kind: "velocity", "pressure", "ratio"). */
  readonly quantity: string;
  /** The unit the band is written in (a `bim-units` unit code). */
  readonly unit: string;
  readonly appliesTo: DesignLimitAppliesTo;
  readonly band: DesignLimitBand;
  readonly severity: DesignLimitSeverity;
  readonly citation: DesignLimitCitation;
  /** The stages it applies at (`LIFECYCLE_STAGE_POINT` ids); absent: every stage. */
  readonly stages?: readonly string[];
  /** Who set it and when, for firm and project rows (a person's name, ISO time). */
  readonly setBy?: { readonly name: string; readonly at: string };
}

const ids = z.array(z.string().min(1)).max(200);

/** The strict writer shape (library items, settings screens). Readers stay tolerant. */
export const designLimitSchema = z
  .object({
    id: z.string().min(1).max(200),
    label: z.string().trim().min(1).max(200),
    quantity: z.string().min(1).max(100),
    unit: z.string().min(1).max(50),
    appliesTo: z
      .object({ discipline: z.string().min(1).optional(), services: ids.optional(), systems: ids.optional(), materials: ids.optional(), elementClasses: ids.optional() })
      .strict(),
    band: z
      .object({ min: z.number().finite().optional(), max: z.number().finite().optional(), target: z.number().finite().optional() })
      .strict()
      .refine((b) => b.min !== undefined || b.max !== undefined || b.target !== undefined, "set a minimum, a maximum or a target")
      .refine((b) => b.min === undefined || b.max === undefined || b.min <= b.max, "the minimum is above the maximum"),
    severity: z.enum(["error", "warning", "info"]),
    citation: z.object({ source: z.string().trim().min(1).max(500), note: z.string().max(2000).optional() }).strict(),
    stages: ids.optional(),
    setBy: z.object({ name: z.string().min(1).max(200), at: z.string().min(1).max(64) }).strict().optional(),
  })
  .strict();

/** Add-on defaults: best-practice starting values per discipline and per system, each with its source. */
export const DESIGN_LIMIT_DEFAULT_POINT = defineExtensionPoint<DesignLimit>({
  id: "kernel.design_limit_default",
  version: 1,
  label: "Design limit defaults",
  idOf: (row) => row.id,
});

/** Problems with design limit rows (pack conformance and library items), in words. */
export function designLimitProblems(rows: readonly DesignLimit[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) out.push(`design limit ${row.id} is listed twice`);
    seen.add(row.id);
    const parsed = designLimitSchema.safeParse(row);
    if (!parsed.success) for (const issue of parsed.error.issues) out.push(`design limit ${row.id}: ${issue.path.join(".") || "row"} ${issue.message}`);
  }
  return out;
}

/** What a value is being checked as. */
export interface DesignLimitSelector {
  readonly quantity: string;
  readonly discipline?: string;
  readonly service?: string;
  readonly system?: string;
  readonly material?: string;
  readonly elementClass?: string;
}

/** The firm's and the project's rows (the host reads library items; tests pass them in). */
export interface DesignLimitSources {
  readonly project?: readonly DesignLimit[];
  readonly firm?: readonly DesignLimit[];
}

export interface ResolvedDesignLimit {
  readonly limit: DesignLimit;
  /** The layer the binding row came from. */
  readonly layer: DesignLimitLayer;
  /** Lower layers that had the same id (what it replaced). */
  readonly replaces: readonly DesignLimitLayer[];
  /** How many `appliesTo` fields it matched on; more is more specific. */
  readonly specificity: number;
}

function matches(limit: DesignLimit, s: DesignLimitSelector): number | null {
  if (limit.quantity !== s.quantity) return null;
  const a = limit.appliesTo;
  let score = 0;
  const one = (wanted: string | undefined, have: string | undefined): boolean => {
    if (wanted === undefined) return true;
    score++;
    return have !== undefined && have === wanted;
  };
  const many = (list: readonly string[] | undefined, have: string | undefined): boolean => {
    if (list === undefined || list.length === 0) return true;
    score++;
    return have !== undefined && list.includes(have);
  };
  if (!one(a.discipline, s.discipline)) return null;
  if (!many(a.services, s.service)) return null;
  if (!many(a.systems, s.system)) return null;
  if (!many(a.materials, s.material)) return null;
  if (!many(a.elementClasses, s.elementClass)) return null;
  return score;
}

/**
 * The limits that bind a value: most specific first (ties keep project,
 * then firm, then add-on order). `stage` absent: stage-bound limits apply
 * too. Add-on defaults are the set in force's.
 */
export function designLimitsFor(selector: DesignLimitSelector, stage: string | undefined, sources: DesignLimitSources = {}): readonly ResolvedDesignLimit[] {
  const layers: ReadonlyArray<readonly [DesignLimitLayer, readonly DesignLimit[]]> = [
    ["project", sources.project ?? []],
    ["firm", sources.firm ?? []],
    ["addon", activePackSet().items(DESIGN_LIMIT_DEFAULT_POINT)],
  ];
  const byId = new Map<string, { limit: DesignLimit; layer: DesignLimitLayer; replaces: DesignLimitLayer[]; order: number }>();
  let order = 0;
  for (const [layer, rows] of layers) {
    for (const limit of rows) {
      const held = byId.get(limit.id);
      if (held) {
        if (held.layer !== layer && !held.replaces.includes(layer)) held.replaces.push(layer);
        continue;
      }
      byId.set(limit.id, { limit, layer, replaces: [], order: order++ });
    }
  }
  const out: (ResolvedDesignLimit & { readonly order: number })[] = [];
  for (const held of byId.values()) {
    if (stage !== undefined && held.limit.stages !== undefined && held.limit.stages.length > 0 && !held.limit.stages.includes(stage)) continue;
    const specificity = matches(held.limit, selector);
    if (specificity === null) continue;
    out.push({ limit: held.limit, layer: held.layer, replaces: held.replaces, specificity, order: held.order });
  }
  out.sort((a, b) => b.specificity - a.specificity || a.order - b.order);
  return out.map(({ order: _order, ...r }) => r);
}

/** Whether a value sits outside a band: "below" the minimum, "above" the maximum, or null inside it. */
export function outsideBand(band: DesignLimitBand, value: number): "below" | "above" | null {
  if (band.min !== undefined && value < band.min) return "below";
  if (band.max !== undefined && value > band.max) return "above";
  return null;
}
