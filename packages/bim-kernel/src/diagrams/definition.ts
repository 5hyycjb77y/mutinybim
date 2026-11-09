import { z } from "zod";
import { ONE_LINE_ORIENTATIONS } from "../layout/one-line";

/**
 * A live diagram: a drafting view whose drawing is derived, at every
 * evaluation, from the building model's connection graph by one adapter (the
 * electrical one-line, the electrical riser, the plumbing riser). The view
 * stores only this definition: which adapter, and the engineer's layout
 * hints. Never line work: the lines, symbols and text are drawn fresh from
 * the model each time, so a changed bus rating, feeder or enclosure shows
 * the moment it is saved (DIAGRAMS.md).
 */

/**
 * The four stored kinds every peer since round 5 reads. Any other kind is an
 * add-on's row on `DIAGRAM_LAYOUT_POINT` (a first-party add-on's bare id, any
 * other add-on's `<pack>.<name>`) and is written only to peers that advertise
 * `DIAGRAM_OPEN_KINDS_FEATURE`: an older peer's view schema lists these four.
 */
export const DIAGRAM_KINDS = ["one_line", "electrical_riser", "plumbing_riser", "plumbing_isometric"] as const;
export type DiagramKind = (typeof DIAGRAM_KINDS)[number];

/** A stored diagram kind: one of `DIAGRAM_KINDS`, or the kind of an add-on's diagram layout row. Readers keep a kind they can't draw. */
export type StoredDiagramKind = string;

export const DIAGRAM_KIND_LABELS: Readonly<Record<DiagramKind, string>> & Readonly<Partial<Record<StoredDiagramKind, string>>> = {
  one_line: "One-line diagram",
  electrical_riser: "Electrical riser diagram",
  plumbing_riser: "Plumbing riser diagram",
  plumbing_isometric: "Plumbing isometric",
};

/** One of the four kinds every peer reads. */
export function isRound5DiagramKind(kind: StoredDiagramKind): kind is DiagramKind {
  return (DIAGRAM_KINDS as readonly string[]).includes(kind);
}

/** The diagrams drawn from routed piping (plumbing-graph.ts) rather than from feeders. */
export const PIPING_DIAGRAM_KINDS: ReadonlySet<StoredDiagramKind> = new Set(["plumbing_riser", "plumbing_isometric"]);

/** Same shape as a diagram layout row's kind: lower case words with underscores, `<pack>.<name>` for a pack's own. */
export const DIAGRAM_KIND_ID = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)?$/;

/** Peers that store a diagram kind other than `DIAGRAM_KINDS` (an add-on's row). An older peer's strict view schema refuses one. */
export const DIAGRAM_OPEN_KINDS_FEATURE = "diagrams:open_kinds";

/** What each piece of pipe prints on a piping diagram; absent: by system (drains size, DFU, slope; gas size, MBH, length; water size, WFU). */
export const PIPE_LABELS = ["size", "load", "slope", "invert", "length"] as const;
export type PipeLabel = (typeof PIPE_LABELS)[number];

/** flat: text beside each symbol. box3d: each piece of equipment's text in a box drawn with depth (the "3D box" look). */
export const DIAGRAM_STYLES = ["flat", "box3d"] as const;
export type DiagramStyle = (typeof DIAGRAM_STYLES)[number];

/** full: every rating and conductor. schematic: names, buses and systems only (early design, before schedules exist). */
export const DIAGRAM_DETAILS = ["full", "schematic"] as const;
export type DiagramDetail = (typeof DIAGRAM_DETAILS)[number];

/** Which text block a template list is for. */
export const DIAGRAM_LABEL_KINDS = ["bus", "transformer", "equipment"] as const;
export type DiagramLabelKind = (typeof DIAGRAM_LABEL_KINDS)[number];


const idSchema = z.string().trim().min(1).max(80);
const text = z.string().trim().min(1).max(120);

export const diagramHintsSchema = z
  .object({
    orientation: z.enum(ONE_LINE_ORIENTATIONS),
    style: z.enum(DIAGRAM_STYLES),
    detail: z.enum(DIAGRAM_DETAILS),
    order: z.record(idSchema, z.array(idSchema).max(60)),
    pins: z.record(idSchema, z.object({ dx: z.number().finite().min(-5000).max(5000), dy: z.number().finite().min(-5000).max(5000) }).strict()),
    sections: z.array(z.object({ id: idSchema, label: text, elementIds: z.array(idSchema).min(1).max(200) }).strict()).max(20),
    futureSpaces: z.record(idSchema, z.number().int().min(0).max(12)),
    hidden: z.array(idSchema).max(400),
    roots: z.array(idSchema).max(20),
    utility: z.boolean(),
    showWarnings: z.boolean(),
    showLoads: z.boolean(),
    labels: z.partialRecord(z.enum(DIAGRAM_LABEL_KINDS), z.array(z.string().max(160)).max(8)),
    title: text,
    notes: z.array(z.string().trim().min(1).max(200)).max(12),
    systemKinds: z.array(z.string().trim().min(1).max(40)).max(12),
    pipeLabels: z.array(z.enum(PIPE_LABELS)).max(PIPE_LABELS.length),
    /** Text moved by hand, keyed by `diagramTextKey` (drawing mm). The text keeps reading the model; only where it sits changes. leader: draw one back (absent: when moved well away). */
    textOffsets: z.record(z.string().trim().min(1).max(200), z.object({ dx: z.number().finite().min(-5000).max(5000), dy: z.number().finite().min(-5000).max(5000), leader: z.boolean().optional() }).strict()),
    /** Round 12: print the available fault current at each bus. Absent: off. Written only when every peer advertises `DIAGRAM_FAULT_CURRENT_FEATURE`. */
    faultCurrent: z.boolean(),
  })
  .partial()
  .strict();

/** Peers that store and draw a one-line's "Show fault current" (an older peer's strict hints schema refuses the field). */
export const DIAGRAM_FAULT_CURRENT_FEATURE = "diagrams:fault_current";

export const diagramDefinitionSchema = z
  .object({ kind: z.string().max(80).regex(DIAGRAM_KIND_ID, "A diagram kind is lower case words with underscores (an add-on's own: <pack>.<name>)."), hints: diagramHintsSchema.optional() })
  .strict();

/** The default text block of each kind of equipment, as field templates. */
export const DEFAULT_DIAGRAM_LABELS: Readonly<Record<DiagramDetail, Readonly<Record<DiagramLabelKind, readonly string[]>>>> = {
  full: {
    bus: ["{name}", "{bus_rating}A BUS {mains_text}", "{voltage_system} {phases_wires}", "{enclosure} {kaic}"],
    transformer: ["{name}", "{kva} KVA", "{primary_system} - {secondary_system}", "{enclosure}"],
    equipment: ["{name}", "{voltage_system} {phases_wires}", "{enclosure}"],
  },
  schematic: {
    bus: ["{name}", "{bus_rating}A BUS", "{voltage_system}"],
    transformer: ["{name}", "{kva} KVA"],
    equipment: ["{name}"],
  },
};

/** Engineer's layout choices. Every field is optional; absent: the default. None of it is drawing geometry. */
export type DiagramHints = z.infer<typeof diagramHintsSchema>;
export type DiagramDefinition = z.infer<typeof diagramDefinitionSchema>;
export type DiagramSection = NonNullable<DiagramHints["sections"]>[number];
