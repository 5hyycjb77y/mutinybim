import type { ViewCategory } from "../documents";
import type { KernelErrorCode } from "../model";
import { defineExtensionPoint } from "../packs/contract";
import { activePackSet } from "../packs/scope";
import type { PackSet } from "../packs/set";
import type { BimElement, ConnectorEnd, ElementId, ModelSettings, Vec2 } from "../types";
import { kindRowFaceProblems, type KindPickShapeFace, type KindPlanGraphicsFace, type KindCreateFace, type KindSolidFace, type KindSymbolFace, type KindTagTextFace } from "./kind-row-faces";

/**
 * Element kinds an add-on owns (contract 1.7.0, `kernel.element_kind` v1).
 *
 * The kernel types the geometry every connected-element tree walks (a
 * segment's ends, a fitting's position, a leaf's mark), but what a kind
 * means to a trade is the add-on's: the values its records keep, the flat
 * fields older records stored them under, the checks its records must pass
 * and what a person calls it. The kernel reads and writes those values by
 * parameter key (`kinds/`), and never names one.
 *
 * Stored values stay readable in both forms (tolerant readers): a record
 * written before this point keeps its flat field; a record an edit upgraded
 * keeps it under `values[key]`. The upgrade runs on edit and only when every
 * peer reads the parameter form (`KINDS_ADDON_OWNED_FEATURE`), so an older
 * peer never receives it.
 */
export interface ElementKindValue {
  /** The parameter key the add-on keeps it under (`<pack>.<name>`). */
  readonly key: string;
  /** The flat field records written before this point store it as. Frozen: old changesets and intents name it. Absent: the value was always a parameter. */
  readonly stored?: string;
  /** Other names a tag or a schedule column calls it by. Read only, never written. */
  readonly aliases?: readonly string[];
  /** What a person calls it ("Rated load"). */
  readonly label: string;
  /** The words after a number of it ("lb"). */
  readonly unit: string;
  /** True: a person sets it (a leaf's design value). False: the tree keeps it (a total). */
  readonly authored: boolean;
  readonly min?: number;
  readonly max?: number;
  /** Whether this record keeps the value (an air leaf does, a water leaf on the same kind doesn't). Absent: every record of the kind. */
  appliesTo?(el: BimElement): boolean;
}

/** One issue a kind's own check raises (validate.ts's `ValidationIssue`). */
export interface ElementKindIssue {
  readonly code: KernelErrorCode;
  readonly message: string;
  readonly elementIds: readonly ElementId[];
}

/**
 * What a kind is (contract 1.8.0): a `physical` part that is drawn and may
 * connect; an `intent` (a site constraint, a program area, a deal
 * assumption: values with no geometry); a `record` (a submittal, an answer,
 * a finding); a `document` (a sheet's content, an issued set). Absent:
 * `physical`, so rows written before 1.8.0 read unchanged. Open: a pack's
 * own nature (`<pack>.<name>`) is kept.
 */
export type KindNature = "physical" | "intent" | "record" | "document" | (string & {});

/** The natures the kernel names. Any other must be namespaced (`<pack>.<name>`). */
export const KNOWN_KIND_NATURES: readonly KindNature[] = ["physical", "intent", "record", "document"];

/** How a stored geometry field is shaped, for readers and conformance. Open: a pack's own form is kept. */
export type KindShapeFieldForm = "point" | "points" | "size" | "number" | "id" | "text" | "flag" | (string & {});

/** One stored field of a kind's geometry (`start`, `position`, `profile`), in the order it is written. */
export interface KindShapeField {
  readonly name: string;
  readonly form: KindShapeFieldForm;
  /** Absent from some records (a field later records added). */
  readonly optional?: boolean;
  /** Contract 1.12.0: a person sets it, so an edit's intent on it is checked and competing writes to it conflict. Absent: derived or not compared. */
  readonly authored?: boolean;
}

/**
 * A kind's stored geometry (`shape` face): the fields its records keep and
 * how to read them. Readers are tolerant (a record that doesn't match is kept
 * as stored); writers are strict (a new or rewritten record of the kind that
 * doesn't match is refused, `kinds/edit-hook.ts`).
 */
export interface ElementKindShapeFace {
  readonly fields: readonly KindShapeField[];
  /** The points that place a record in plan (a segment's two ends, a point kind's one), for `anchorOf` when the row has no `anchor`. */
  points?(el: BimElement): readonly Vec2[];
  /** True when `record` has this kind's stored shape. Absent: every named non-optional field is present. */
  accepts?(record: object): boolean;
}

/** Which way one connector end faces in a tree: toward the source (`upstream`) or away from it (`downstream`). */
export type ConnectorEndRole = "upstream" | "downstream";

/** One named connector end a kind has. */
export interface ConnectorEndDecl {
  readonly end: ConnectorEnd;
  readonly role: ConnectorEndRole;
  /** The end types (`CONNECTOR_END_TYPE_POINT` ids) this end is made with. Absent: not declared. */
  readonly endTypes?: readonly string[];
}

/**
 * Where a hosted record sits along its host (round 11): the stored fields
 * holding its distance along the host from the host's start, which side of
 * the host it leaves from (+1 left of travel, -1 right) and the derived world
 * position. The tree face's rule for the host's kind places it
 * (`TreeTapHost.place`); validation checks its end clearance against the
 * host's span and its spacing from the other placed records on that host.
 * Absent: the kind joins the tree under its host and is never placed.
 */
export interface HostedPlacementFace {
  readonly along: string;
  readonly side: string;
  readonly at: string;
}

/**
 * A kind's connector ends (`connectorEnds` face): what the network index and
 * topology walk. Downstream ends are walked in the order listed. A kind
 * hangs under another without a connection when `hostedBy` names the stored
 * field holding its host's id (it is then listed under the host, after the
 * host's own connections, when an add-on's tree face lets that host kind
 * host it).
 */
export interface ConnectorEndsFace {
  readonly ends: readonly ConnectorEndDecl[];
  /** A tree starts here (a source): every record of the kind is a root. */
  readonly root?: boolean;
  /** The stored field holding the id of the element this one hangs on, and (`placement`) where along it it sits. */
  readonly hostedBy?: { readonly field: string; readonly placement?: HostedPlacementFace };
  /** World position of one of `el`'s ends; null when this end can't be placed (its host is gone). `elements` is the record it sits in. */
  point?(el: BimElement, end: ConnectorEnd, elements: Readonly<Record<string, BimElement>>): Vec2 | null;
}

/**
 * What a writer does for peers that don't know the kind's faces yet
 * (`upgrade` face). Stored records of a kind older peers already keep are
 * never rewritten for a face; a kind no older peer stores is refused in the
 * "older server" words until every peer advertises `feature`.
 */
export interface KindUpgradeFace {
  /** True when no older peer stores records of this kind. */
  readonly newForOlderPeers?: boolean;
  /** The peer feature every peer must advertise first. Absent: `kinds:addon_shapes` when the row has a shape or connector ends, else `kinds:addon_owned`. */
  readonly feature?: string;
}

/** What a kind's `read` face says about one stored record. */
export type KindRecordRead = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface ElementKindItem {
  /** The stored kind (`terminal`, a pack's `vt.car`). Never a kernel kind on `ELEMENT_KIND_POINT`; the kernel's own rows are in `kinds/rows.ts`. */
  readonly kind: string;
  /** What a person calls one ("Air terminal"). */
  readonly label: string;
  /** What it is. Absent: `physical`. A record kind with no shape, no ends and no anchor is a valid row. */
  readonly nature?: KindNature;
  /** Its stored geometry. Absent: none (an intent or a record), or not declared. */
  readonly shape?: ElementKindShapeFace;
  /** Its connector ends. Absent: it joins no tree. Only a `physical` kind has ends. */
  readonly connectorEnds?: ConnectorEndsFace;
  /** Where one sits, for annotations and `anchorOf`; null when it sits nowhere. Absent: the shape's points' midpoint, else nowhere. */
  anchor?(el: BimElement): Vec2 | null;
  /** The values its records keep, in display order; the first is its headline value (schedules, tags, drawings). */
  readonly values?: readonly ElementKindValue[];
  /** What older peers get. */
  readonly upgrade?: KindUpgradeFace;
  /**
   * A tolerant reader for one stored record of the kind: whether it is one,
   * with the reason in words when it isn't (a record kind's body checks).
   * Fields, states and values it doesn't know are kept, never refused.
   * Absent: every record of the kind reads.
   */
  read?(record: object): KindRecordRead;
  /** The kind's own checks on one record (minimum length, routing rules), run by validation for each record of the kind. */
  check?(el: BimElement, settings: ModelSettings, issues: ElementKindIssue[]): void;
  /**
   * True when no older peer stores records of this kind at all, so creating
   * one needs `KINDS_ADDON_OWNED_FEATURE`; a peer without it is refused in
   * the "older server" words. Kinds older peers already store leave it unset.
   * Same as `upgrade.newForOlderPeers` (contract 1.7.0 spelling).
   */
  readonly newForOlderPeers?: boolean;
  /** Contract 1.10.0: the plan symbol one record draws (registry/kind-row-faces.ts). */
  readonly symbol?: KindSymbolFace;
  /** Contract 1.10.0: the text a tag prints for one record by default. */
  readonly tagText?: KindTagTextFace;
  /** Contract 1.10.0: where a click picks one record in plan. */
  readonly pickShape?: KindPickShapeFace;
  /** Contract 1.11.0: plan graphics for one record (registry/kind-row-faces.ts). */
  readonly planGraphics?: KindPlanGraphicsFace;
  /** Contract 1.11.0: its body for sections, 3D views and plan hiding (registry/kind-row-faces.ts). */
  readonly solid?: KindSolidFace;
  /** Contract 1.11.0: how `create_element` draws one record (registry/kind-row-faces.ts). Absent: it isn't drawn by command. */
  readonly create?: KindCreateFace;
  /** Contract 1.11.0: the view category its records draw under (Visibility/Graphics, line looks). Absent: none. */
  readonly viewCategory?: ViewCategory;
  /** Contract 1.11.0: the one-sheet schedule lists its records (mark, type, headline value), in stored order or by mark. Absent: not listed. */
  readonly scheduleListing?: "stored_order" | "by_mark";
  /** Contract 1.12.0: what a schedule's Family column says for its listed records ("Air terminal"). Absent: its `label`. */
  readonly scheduleFamily?: string;
  /** Contract 1.12.0: the element schedule category that lists its records (`scheduleListing` too). Absent: no element schedule category lists them. */
  readonly scheduleCategory?: string;
  /** Contract 1.12.0: the built-in class (`mep.air_terminal`) its records are, joined to that class's recognition. Absent: only classes that name the kind recognise it. */
  readonly classId?: string;
}

/** Peers that read and write add-on-owned kinds in their parameter form. A writer upgrades a record to it only when the peers advertise it. */
export const KINDS_ADDON_OWNED_FEATURE = "kinds:addon_owned";

/** Peers that read kinds whose shape and connector ends an add-on declares (contract 1.8.0). A record of a new such kind is written only when every peer advertises it. */
export const KINDS_ADDON_SHAPES_FEATURE = "kinds:addon_shapes";

/** A row's nature, `physical` when absent. */
export function kindNatureOf(item: Pick<ElementKindItem, "nature">): KindNature {
  return item.nature ?? "physical";
}

/** True when no older peer stores records of the row's kind (either spelling). */
export function isNewForOlderPeers(item: ElementKindItem): boolean {
  return item.newForOlderPeers === true || item.upgrade?.newForOlderPeers === true;
}

/** The peer feature a record of a new kind waits for. */
export function upgradeFeatureOf(item: ElementKindItem): string {
  if (item.upgrade?.feature !== undefined) return item.upgrade.feature;
  return item.shape !== undefined || item.connectorEnds !== undefined ? KINDS_ADDON_SHAPES_FEATURE : KINDS_ADDON_OWNED_FEATURE;
}

/** True when `record` has the stored shape the row declares (no shape declared: true). */
export function kindShapeAccepts(item: ElementKindItem, record: object): boolean {
  const shape = item.shape;
  if (shape === undefined) return true;
  if (shape.accepts !== undefined) return shape.accepts(record);
  for (const field of shape.fields) {
    if (field.optional) continue;
    if (!(field.name in record)) return false;
  }
  return true;
}

export const ELEMENT_KIND_POINT = defineExtensionPoint<ElementKindItem>({
  id: "kernel.element_kind",
  version: 1,
  label: "Element kinds",
  idOf: (item) => item.kind,
});

/** The set in force's element kinds, by stored kind. */
export interface ElementKindTable {
  row(kind: string): ElementKindItem | undefined;
  /** The value `field` names on `kind`: its parameter key or the flat field older records stored it as. */
  valueOf(kind: string, field: string): ElementKindValue | undefined;
  /** Every registered kind, in row order. */
  readonly kinds: readonly string[];
}

const TABLE_KEY = "kernel.element_kind#table";

function buildTable(items: readonly ElementKindItem[]): ElementKindTable {
  const rows = new Map<string, ElementKindItem>();
  const byField = new Map<string, ElementKindValue>();
  for (const item of items) {
    if (rows.has(item.kind)) {
      const message = `[bim-kernel/element-kinds] two add-ons register the element kind "${item.kind}"`;
      console.error(message);
      throw new Error(message);
    }
    rows.set(item.kind, item);
    for (const v of item.values ?? []) {
      byField.set(`${item.kind}\u0000${v.key}`, v);
      if (v.stored !== undefined) byField.set(`${item.kind}\u0000${v.stored}`, v);
      for (const alias of v.aliases ?? []) if (!byField.has(`${item.kind}\u0000${alias}`)) byField.set(`${item.kind}\u0000${alias}`, v);
    }
  }
  return {
    row: (kind) => rows.get(kind),
    valueOf: (kind, field) => byField.get(`${kind}\u0000${field}`),
    kinds: [...rows.keys()],
  };
}

/**
 * The kernel's own rows (round 11): the kernel kinds (`kinds/rows.ts`) and
 * the record kinds it keeps (`kinds/records/`), one per kind. Never
 * contributed to `ELEMENT_KIND_POINT`, so the point's table lists add-on
 * kinds only.
 *
 * Each row belongs to the module that declares it (`source`). A host may
 * evaluate a declaring module again while this registry survives (a dev
 * server's hot reload, a second bundle of the same package in one process),
 * so the same source registering again replaces its own rows. Only a second
 * source claiming a kind is a conflict.
 */
const kernelRows = new Map<string, ElementKindItem>();
const kernelRowSources = new Map<string, string>();
const kernelSourceKinds = new Map<string, ReadonlySet<string>>();

/** Register `source`'s kernel rows. The same source again replaces its rows; another source's row for a kind is refused loudly, and nothing is registered. */
export function registerKernelKindRows(source: string, rows: readonly ElementKindItem[]): void {
  const kinds = new Set<string>();
  for (const r of rows) {
    const owner = kernelRowSources.get(r.kind);
    const problem = kinds.has(r.kind)
      ? `"${source}" lists the kind "${r.kind}" twice`
      : owner !== undefined && owner !== source
        ? `the kernel already keeps a row for the kind "${r.kind}" (from "${owner}", not "${source}")`
        : undefined;
    if (problem !== undefined) {
      const message = `[bim-kernel/element-kinds] ${problem}`;
      console.error(message);
      throw new Error(message);
    }
    kinds.add(r.kind);
  }
  for (const kind of kernelSourceKinds.get(source) ?? []) {
    if (kinds.has(kind)) continue;
    kernelRows.delete(kind);
    kernelRowSources.delete(kind);
  }
  for (const r of rows) {
    kernelRows.set(r.kind, r);
    kernelRowSources.set(r.kind, source);
  }
  kernelSourceKinds.set(source, kinds);
}

/** The kernel's own row for `kind` (a kernel kind, or a record kind the kernel keeps), or undefined. */
export function kernelKindRow(kind: string): ElementKindItem | undefined {
  return kernelRows.get(kind);
}

/** Every kind the kernel keeps a row for, in registration order. */
export function kernelKindRowKinds(): readonly string[] {
  return [...kernelRows.keys()];
}

const tableOf = (set: PackSet): ElementKindTable => buildTable(set.items(ELEMENT_KIND_POINT));

/** The element kinds of `set` (the set in force by default), resolved once per set. Two add-ons registering one kind are refused loudly. */
export function elementKindTable(set: PackSet = activePackSet()): ElementKindTable {
  return set.memo(TABLE_KEY, tableOf);
}

const NAMESPACED = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*$/;

/** Problems with one row's faces (contract 1.8.0), in words. `endTypes`: the end-type ids registered in the set (absent: not checked). */
function faceProblems(item: ElementKindItem, endTypes: ReadonlySet<string> | undefined): string[] {
  const out: string[] = [];
  const nature = kindNatureOf(item);
  if (!KNOWN_KIND_NATURES.includes(nature) && !NAMESPACED.test(nature)) out.push(`element kind ${item.kind}: nature "${nature}" must be physical, intent, record, document or "<pack>.<name>"`);
  const shape = item.shape;
  if (shape !== undefined) {
    const names = new Set<string>();
    for (const field of shape.fields) {
      if (field.name.trim().length === 0) out.push(`element kind ${item.kind}: a shape field has no name`);
      if (names.has(field.name)) out.push(`element kind ${item.kind}: shape field ${field.name} is listed twice`);
      names.add(field.name);
    }
    if (shape.points !== undefined && typeof shape.points !== "function") out.push(`element kind ${item.kind}: shape points must be a function`);
    if (shape.accepts !== undefined && typeof shape.accepts !== "function") out.push(`element kind ${item.kind}: shape accepts must be a function`);
  }
  const ends = item.connectorEnds;
  if (ends !== undefined) {
    if (nature !== "physical") out.push(`element kind ${item.kind} is ${/^[aeiou]/.test(nature) ? "an" : "a"} ${nature} kind; only a physical kind has connector ends`);
    const seen = new Set<string>();
    let upstream = 0;
    for (const decl of ends.ends) {
      if (decl.end.trim().length === 0) out.push(`element kind ${item.kind}: a connector end has no name`);
      if (seen.has(decl.end)) out.push(`element kind ${item.kind}: connector end ${decl.end} is listed twice`);
      seen.add(decl.end);
      if (decl.role !== "upstream" && decl.role !== "downstream") out.push(`element kind ${item.kind}: connector end ${decl.end} must face upstream or downstream`);
      if (decl.role === "upstream") upstream += 1;
      for (const id of decl.endTypes ?? []) {
        if (endTypes !== undefined && !endTypes.has(id)) out.push(`element kind ${item.kind}: connector end ${decl.end} names the end type ${id}, which no add-on in the set registers`);
      }
    }
    if (upstream > 1) out.push(`element kind ${item.kind} has ${upstream} upstream ends; a kind has at most one`);
    if (ends.root === true && upstream > 0) out.push(`element kind ${item.kind} starts a tree, so it has no upstream end`);
    if (ends.hostedBy !== undefined && ends.hostedBy.field.trim().length === 0) out.push(`element kind ${item.kind}: hostedBy names no field`);
    const placement = ends.hostedBy?.placement;
    if (placement !== undefined) {
      const fields = [placement.along, placement.side, placement.at];
      if (fields.some((f) => f.trim().length === 0)) out.push(`element kind ${item.kind}: hostedBy placement names an empty field`);
      if (new Set([...fields, ends.hostedBy?.field ?? ""]).size !== 4) out.push(`element kind ${item.kind}: hostedBy placement's fields (along, side, at) and its host field must all differ`);
    }
    if (ends.point !== undefined && typeof ends.point !== "function") out.push(`element kind ${item.kind}: connector end point must be a function`);
  }
  if (item.anchor !== undefined && typeof item.anchor !== "function") out.push(`element kind ${item.kind}: anchor must be a function`);
  if (item.read !== undefined && typeof item.read !== "function") out.push(`element kind ${item.kind}: read must be a function`);
  if (item.upgrade?.feature !== undefined && item.upgrade.feature.trim().length === 0) out.push(`element kind ${item.kind}: upgrade names an empty feature`);
  if (item.scheduleFamily !== undefined && item.scheduleFamily.trim().length === 0) out.push(`element kind ${item.kind}: scheduleFamily is empty`);
  if (item.classId !== undefined && item.classId.trim().length === 0) out.push(`element kind ${item.kind}: classId is empty`);
  if (item.scheduleCategory !== undefined && item.scheduleListing === undefined) out.push(`element kind ${item.kind}: scheduleCategory needs scheduleListing (a schedule lists only records its row lists)`);
  return out;
}

/**
 * Problems with element-kind rows, in words (pack conformance): a row may not
 * take a kernel kind, its value keys are namespaced, and its faces are well
 * formed (only a physical kind has connector ends; an end names end types
 * the set registers, when `endTypes` is given). A shape-less record kind
 * with no ends and no anchor is a valid row.
 */
export function elementKindRowProblems(items: readonly ElementKindItem[], kernelKinds: ReadonlySet<string>, endTypes?: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const item of items) {
    out.push(...faceProblems(item, endTypes));
    if (kernelKinds.has(item.kind) || kernelRows.has(item.kind)) out.push(`element kind ${item.kind} is one of the kernel's own kinds; an add-on registers a kind of its own`);
    if (item.label.trim().length === 0) out.push(`element kind ${item.kind} has no label`);
    const keys = new Set<string>();
    for (const v of item.values ?? []) {
      if (!NAMESPACED.test(v.key)) out.push(`element kind ${item.kind}: value key "${v.key}" must be "<pack>.<name>"`);
      if (keys.has(v.key)) out.push(`element kind ${item.kind} lists the value ${v.key} twice`);
      keys.add(v.key);
      if (v.min !== undefined && v.max !== undefined && v.min > v.max) out.push(`element kind ${item.kind}: ${v.key} has min above max`);
    }
    if (item.check !== undefined && typeof item.check !== "function") out.push(`element kind ${item.kind}: check must be a function`);
    out.push(...kindRowFaceProblems(item.kind, item));
  }
  return out;
}
