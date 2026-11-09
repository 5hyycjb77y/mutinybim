import { z } from "zod";
import { REGISTRY_ID_MAX_LENGTH, REGISTRY_ID_PATTERN } from "../ids";
import type { SystemKind } from "../parts";
import type { AuthoredRevisions, ElementId, Partition, ValuedCore } from "../types";
import type { PipeDesign } from "./pipe/design";
import type { RunInsulation, RunSizingCriteria } from "./run-insulation";
import type { SystemGraphics } from "./system-graphics";
import type { FlexPath } from "./flex";

/**
 * Connected runs for every discipline: duct, pipe and (structure only, for
 * now) conduit. A run is straight segments joined by fittings. Each end of a
 * segment and each fitting port holds a link to what it meets, and the thing
 * it meets holds the link back (placed parts keep theirs per connector), so
 * every routing edit reads and writes only the elements it touches.
 *
 * Coordinates: plan x/y in millimetres like the rest of the model; z is
 * millimetres above the run's level floor (the same frame as a part's
 * `offsetMm` plus its connector height).
 */

export interface RunPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export const RUN_DOMAINS = ["duct", "pipe", "conduit"] as const;
export type RunDomain = (typeof RUN_DOMAINS)[number];

export const PIPE_MATERIALS = ["copper", "pex", "cpvc", "cast_iron", "pvc", "abs", "steel", "black_steel", "galvanized", "pp_r", "csst", "pe"] as const;
export type PipeMaterial = (typeof PIPE_MATERIALS)[number];

/**
 * The product standard within a material: copper type K / L / M, schedule 40,
 * no-hub or service-weight cast iron, PEX / CPVC by SDR. Absent: the
 * material's usual spec (its default row on `PIPE_PRODUCT_POINT` says which).
 * The names every deployed reader stores; a size may name an add-on product's
 * spec by id once every peer advertises `pipes:open_specs`.
 */
export const PIPE_SPEC_IDS = ["type_k", "type_l", "type_m", "sch40", "dwv_sch40", "no_hub", "service_weight", "sdr9", "sdr11", "sdr7_4", "csst"] as const;
export type PipeSpecId = (typeof PIPE_SPEC_IDS)[number];

export const CONDUIT_TYPES = ["emt", "rmc", "imc", "pvc", "fmc"] as const;
export type ConduitType = (typeof CONDUIT_TYPES)[number];

const mm = z.number().finite().positive().max(10_000);

export const runSizeSchema = z.discriminatedUnion("shape", [
  z.object({ shape: z.literal("rect"), width: mm, height: mm }),
  z.object({ shape: z.literal("round"), diameter: mm }),
  /** Flat oval: width across, height top to bottom (width ≥ height). */
  z.object({ shape: z.literal("oval"), width: mm, height: mm }),
  /** Nominal pipe size in millimetres (1/2" = 12.7), its material, and optionally its spec (type L copper, schedule 40…). */
  z.object({
    shape: z.literal("pipe"),
    nominalMm: mm,
    material: z.enum(PIPE_MATERIALS),
    spec: z.string().max(REGISTRY_ID_MAX_LENGTH).regex(REGISTRY_ID_PATTERN, "a pipe spec id (type_l, testfp.sch10)").optional(),
    /**
     * A pack's pipe material (`civil.rcp`), a row of `PIPE_MATERIAL_POINT`
     * (pipe/materials.ts); `material` is then the row's built-in fallback, which
     * the kernel's own tables and older readers use. Written only to peers
     * advertising `elements:core`.
     */
    materialId: z.string().max(96).regex(/^[a-z][a-z0-9_]*\.[a-z0-9][a-z0-9_.]*$/, "a pack material id (civil.rcp)").optional(),
  }),
  /** Conduit trade size in millimetres (3/4" = 19.05). Structure only: conduit can't be routed yet. */
  z.object({ shape: z.literal("conduit"), tradeSizeMm: mm, conduitType: z.enum(CONDUIT_TYPES) }),
]);
export type RunSize = z.infer<typeof runSizeSchema>;
export type DuctRunSize = Extract<RunSize, { shape: "rect" | "round" | "oval" }>;

/** Which side of a link: a segment's "start" / "end", a fitting port id, or a part connector id. */
export interface PortRef {
  readonly elementId: ElementId;
  readonly port: string;
}

interface RunElementBase {
  readonly id: ElementId;
  readonly version: number;
  readonly authoredRev: AuthoredRevisions;
  readonly partition?: Partition;
  /** Group and phases (organization/model.ts); absent: General, New construction, not demolished. */
  readonly groupId?: string;
  readonly phaseCreated?: string;
  readonly phaseDemolished?: string;
}

/** A fitting family and the values chosen for its parameters ("Smooth radius elbow", r/W = 1.0). */
export interface FittingChoice {
  readonly family: string;
  readonly params?: Readonly<Record<string, number | string>>;
}

/** Which fitting a system uses by default, per place in a run. */
export const FITTING_SLOTS = [
  "elbow_rect",
  "elbow_round",
  "elbow_oval",
  "transition",
  "transition_shape_change",
  "branch_rect",
  "branch_round",
  "cap",
  "offset",
  // Pipe. Drainage turns and branches are chosen by which way the flow changes direction.
  "pipe_elbow_90",
  "pipe_elbow_45",
  "pipe_tee",
  "pipe_reducer",
  "pipe_cap",
  "drain_turn_hv",
  "drain_turn_vh",
  "drain_turn_hh",
  "drain_turn_45",
  "drain_branch_hv",
  "drain_branch_hh",
] as const;
export type FittingSlot = (typeof FITTING_SLOTS)[number];

export const DUCT_MATERIALS = ["galvanized", "aluminum", "stainless", "pvc_coated", "fiberglass_board", "lined", "flexible"] as const;
export type DuctMaterial = (typeof DUCT_MATERIALS)[number];

/** Design air and duct for a system's pressure calculation. Absent: standard air (sea level, 20 °C), galvanized. */
export interface SystemDesign {
  readonly altitudeM?: number;
  readonly temperatureC?: number;
  readonly material?: DuctMaterial;
  /** Colebrook (default) or the Altshul-Tsal approximation. */
  readonly frictionMethod?: "colebrook" | "altshul_tsal";
  /** Pipe systems: water, drainage and gas design inputs (pipe/design.ts). */
  readonly pipe?: PipeDesign;
  /** Duct and pipe systems: the insulation (pipe: a wrap) new runs get when the route doesn't say (run-insulation.ts). Absent: none. */
  readonly insulation?: RunInsulation;
  /** Duct systems: what a size suggestion from airflow aims for. Absent fields: the system kind's typical values. */
  readonly sizing?: RunSizingCriteria;
}

/** An engineer-entered coefficient: for one family and role, a constant or a curve over one variable. */
export interface CoefficientEntry {
  readonly family: string;
  /** body: elbows, transitions, offsets; branch / main: the two paths through a takeoff. */
  readonly role: "body" | "branch" | "main";
  /** Constant C, or C at points along `variable` (linear between, held at the ends). */
  readonly c?: number;
  readonly variable?: "r_over_w" | "angle_deg" | "area_ratio" | "velocity_ratio" | "aspect_ratio";
  readonly points?: ReadonlyArray<{ readonly x: number; readonly c: number }>;
  /** Restricts the entry to parameter values ("gores" = 5). */
  readonly when?: Readonly<Record<string, number | string>>;
  readonly note?: string;
}

export interface CoefficientTable {
  readonly id: string;
  readonly label: string;
  readonly scope: "firm" | "project";
  readonly entries: readonly CoefficientEntry[];
}

/** A named system (Supply Air 1, Domestic Cold Water…). Runs belong to one; parts join through their connectors. */
export interface MepSystem extends RunElementBase, ValuedCore {
  readonly kind: "mep_system";
  readonly name: string;
  readonly systemKind: SystemKind;
  readonly domain: RunDomain;
  /** Fittings routing places on this system, overriding the library defaults per slot. */
  readonly fittingDefaults?: Partial<Readonly<Record<FittingSlot, FittingChoice>>>;
  readonly design?: SystemDesign;
  /** Coefficients this project's engineer entered for this system; they win over the built-in formulas. */
  readonly coefficientTable?: CoefficientTable;
  /** A run of the system, set when the system is created: where a pressure report starts walking (a scan finds another if it is deleted). */
  readonly entryId?: ElementId;
  /** Colour, line pattern and weight this system overrides; absent: its kind's standard look (system-graphics.ts). */
  readonly graphics?: SystemGraphics;
}

export interface RunSegment extends RunElementBase, ValuedCore {
  readonly kind: "run_segment";
  readonly domain: RunDomain;
  readonly systemId: ElementId;
  readonly levelId: ElementId;
  /** Authored (moved by routing edits). */
  readonly start: RunPoint;
  readonly end: RunPoint;
  /** Authored. */
  readonly size: RunSize;
  readonly links: { readonly start?: PortRef; readonly end?: PortRef };
  /** Branch fittings (taps, tees, wyes) hosted on this segment, in the order they were added. */
  readonly branches: readonly ElementId[];
  /** Derived: what the segment carries (CFM for air, fixture units or GPM for water, as the system's loads give it). */
  readonly flow: number;
  /** Authored: duct takes an external wrap or internal liner (`size` is the sheet-metal size either way); pipe takes a wrap. Absent: bare. */
  readonly insulation?: RunInsulation;
  /** Flexible duct: the curve between `start` and `end` (flex.ts). Absent: straight sheet metal. */
  readonly flex?: FlexPath;
}

/** `accessory`: an inline pipe item hosted on a segment (valve, union, cleanout, trap, drip leg); the pipe stays one piece through it. */
export const FITTING_TYPES = ["elbow", "transition", "tap", "tee", "wye", "cap", "offset", "accessory"] as const;
export type FittingType = (typeof FITTING_TYPES)[number];

export interface RunPort {
  readonly id: string;
  readonly position: RunPoint;
  /** Unit vector pointing out of the fitting through this port. */
  readonly direction: RunPoint;
  readonly size: RunSize;
  readonly link?: PortRef;
}

export interface HostedOn {
  readonly segmentId: ElementId;
  /** Authored: distance along the host from its start. */
  readonly s: number;
  /** Which side of the host the branch leaves from (+1 left of travel, -1 right). */
  readonly side: 1 | -1;
  /** Vertical hosts (a stack or riser): the level direction the branch leaves in, since left and right mean nothing there. */
  readonly dir?: { readonly x: number; readonly y: number };
  /** Level hosts: the face the branch leaves through when it isn't a side (`top`, `bottom`; feature `routing:tap_faces`). Absent: the side `side` names. */
  readonly face?: string;
  /** Level hosts: across the face from its centre line, mm (feature `routing:tap_offset`). Absent: on the centre line, as every tap before it. */
  readonly t?: number;
}

/**
 * A fitting where runs meet. Elbows, transitions and caps sit between
 * segments at a point. Taps, tees and wyes are hosted on a continuous trunk
 * (`host`) and have one port, the branch; the trunk stays one piece.
 */
export interface RunFitting extends RunElementBase {
  readonly kind: "run_fitting";
  readonly fittingType: FittingType;
  /** What the system's rules call it ("Conical tap", "Combination wye", "Reducer"). */
  readonly label: string;
  readonly domain: RunDomain;
  readonly systemId: ElementId;
  readonly levelId: ElementId;
  readonly position: RunPoint;
  /** Elbows: the turn in degrees (any angle for duct, 45 or 90 for pipe; route-angles.ts). */
  readonly angleDeg?: number;
  readonly ports: readonly RunPort[];
  readonly host?: HostedOn;
  /** Authored: the library family (`FITTING_FAMILIES`) and its parameters. Absent on runs routed before families: the system's default applies. */
  readonly family?: string;
  readonly params?: Readonly<Record<string, number | string>>;
  /** Authored: an engineer's own loss coefficient, which wins over every source. */
  readonly coefficientOverride?: CoefficientOverride;
  /** Authored, duct and pipe: set with the segments it joins (routing and insulation edits write both). */
  readonly insulation?: RunInsulation;
}

export interface CoefficientOverride {
  readonly c: number;
  /** Which path through the fitting it replaces (a takeoff has a branch and a main path). */
  readonly role: "body" | "branch" | "main";
  readonly by: string;
  /** ISO time it was set. */
  readonly at: string;
  readonly note?: string;
}

export type RunElement = MepSystem | RunSegment | RunFitting;
export type RunElementKind = RunElement["kind"];
