import { z } from "zod";
import type { Aabb, Convex, P3 } from "./geometry/convex";

export type Severity = "error" | "warning" | "info";

/** The rule packs this release ships. A pack's rules name their own (`zz`, the pack's namespace): an open string. */
export const KNOWN_RULE_PACKS = ["coordination", "placement", "clearance", "systems", "documents", "electrical", "process"] as const;
export type KnownRulePack = (typeof KNOWN_RULE_PACKS)[number];
/** @deprecated Read `KNOWN_RULE_PACKS`; a rule's `pack` is open. */
export const RULE_PACKS = KNOWN_RULE_PACKS;
export type RulePack = KnownRulePack | (string & {});

export function isKnownRulePack(pack: string): pack is KnownRulePack {
  return (KNOWN_RULE_PACKS as readonly string[]).includes(pack);
}

export const RULESETS = ["default", "coordination", "documents", "issue"] as const;
export type Ruleset = (typeof RULESETS)[number];

export const SNAPSHOT_MODES = ["off", "on_request", "after_edit", "auto_if_vision"] as const;
export type SnapshotMode = (typeof SNAPSHOT_MODES)[number];

/** A linked model element the finding involves (read-only). */
export interface LinkedRef {
  readonly modelId: string;
  readonly globalId: string;
  readonly name: string;
  readonly ifcClass: string;
}

export interface Finding {
  /** Stable: the rule plus the sorted element ids and linked GlobalIds. Acceptances suppress by it. */
  readonly id: string;
  readonly rule: string;
  readonly severity: Severity;
  /** Ours, sorted. */
  readonly elementIds: readonly string[];
  readonly linked?: readonly LinkedRef[];
  readonly at: { readonly level: string; readonly x_ft: number; readonly y_ft: number; readonly z_ft: number };
  /** Plain words, at most 160 characters. */
  readonly message: string;
  readonly fix?: { readonly tool: string; readonly hint: string };
  /** The rule's version, so a finding is a ledger `FindingRef` (round 11 F11): a decision against another version re-opens. Absent: "1". */
  readonly ruleVersion?: string;
}

/**
 * The session's lint settings, set once (bim_lint_configure or the
 * Coordination panel), never per call. Snake case: this is what the agent
 * and the settings table see.
 */
export const lintConfigSchema = z
  .object({
    ruleset: z.enum(RULESETS).default("default"),
    tolerance_in: z.number().min(0).max(12).default(0.5),
    soft_clearance_in: z.number().min(0).max(24).default(1),
    structure_clearance_in: z.number().min(0).max(24).default(2),
    scope_radius_ft: z.number().min(1).max(200).default(10),
    include_linked: z.boolean().default(true),
    max_findings: z.number().int().min(1).max(8).default(8),
    snapshot: z.enum(SNAPSHOT_MODES).default("off"),
    disabled_rules: z.array(z.string().min(1).max(60)).max(40).default([]),
  })
  .strict();
export type LintConfig = z.infer<typeof lintConfigSchema>;

export const DEFAULT_LINT_CONFIG: LintConfig = lintConfigSchema.parse({});

export function readLintConfig(raw: unknown): LintConfig {
  const parsed = lintConfigSchema.safeParse(raw ?? {});
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  throw new Error(`Lint settings aren't readable (${issue ? `${issue.path.join(".") || "settings"}: ${issue.message}` : "invalid"})`);
}

// ---------------------------------------------------------------------------
// Linked models (read-only)

export const LINKED_KINDS = ["slab", "roof", "wall", "column", "beam", "space", "opening", "covering", "stair", "door", "window", "furniture", "mep", "other"] as const;
export type LinkedKind = (typeof LINKED_KINDS)[number];

/** One linked element as the index holds it: box, plan hull, what it is and where. */
export interface LinkedElement {
  readonly globalId: string;
  readonly name: string;
  readonly ifcClass: string;
  readonly kind: LinkedKind;
  /** Storey name it is contained in, or null. */
  readonly storey: string | null;
  /** World mm (host frame): [minX, minY, minZ, maxX, maxY, maxZ]. */
  readonly box: readonly [number, number, number, number, number, number];
  /** Plan convex hull, world mm, flat [x0, y0, x1, y1, …], at most 12 points. Absent: the box's footprint. */
  readonly hull?: readonly number[];
}

export interface LinkedStorey {
  readonly name: string;
  readonly elevationMm: number;
}

/** A linked model version's index: built once per version and placement, cached by content. */
export interface LinkedModelIndex {
  /** Same id the 3D view uses for the linked model. */
  readonly modelId: string;
  /** The link itself, stable across its versions (references to its elements are kept by this). Absent from indexes cached before it was sent. */
  readonly linkId?: string;
  readonly label: string;
  readonly discipline: "architecture" | "structure" | "mep" | "other";
  readonly storeys: readonly LinkedStorey[];
  readonly elements: readonly LinkedElement[];
}

// ---------------------------------------------------------------------------
// Shapes the engine holds per element

/** Ours or linked, as the broad phase and rules see it. */
export interface Body {
  readonly key: string;
  /** Our element id, or null for a linked element. */
  readonly elementId: string | null;
  readonly linked: LinkedRef | null;
  readonly linkedKind: LinkedKind | null;
  readonly box: Aabb;
  /** Built on demand for the narrow phase. */
  pieces(): readonly Convex[];
}

export interface NearItem {
  readonly name: string;
  readonly distanceFt: number;
  readonly direction: string;
}

export interface NearContext {
  readonly level: string | null;
  readonly room: string | null;
  readonly host: string | null;
  readonly within: readonly NearItem[];
}

export type Vec3 = P3;
