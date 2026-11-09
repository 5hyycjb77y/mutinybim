import { z } from "zod";
import type { BimElement, Connection, ModelSettings, ModelState, PartTypeDefinition, Revision } from "@permitzip/bim-kernel";
import { installedFirstPartyPacks, modelPackSet, modelStatePackSet } from "@permitzip/bim-kernel/packs";
import { scriptReadsSchema, type ScriptReads } from "@permitzip/bim-library";

/**
 * The slice of a model a script reads (SCRIPTING-PROPOSAL §5.1): only what
 * its `reads` names, so a host serialises little and a script can't wander.
 * Reading beyond it is a plain error naming what to add.
 */

export const SLICE_FORMAT = "mutinybim-slice";

export interface ModelSlice {
  readonly format: typeof SLICE_FORMAT;
  readonly version: 1;
  readonly modelId: string;
  readonly revision: number;
  readonly reads: ScriptReads;
  /** The person's selection when the run started (`reads.ids: "selection"`). */
  readonly selection: readonly string[];
  readonly elements: Readonly<Record<string, BimElement>>;
  /** Connections with both ends in the slice. */
  readonly connections: readonly Connection[];
  readonly settings: ModelSettings;
  /**
   * Features the model server holding this model advertises: edits the
   * script makes are decided under them, as the server will decide them, so
   * a newer shape the server can't store is refused in the run, not at apply.
   */
  readonly features: readonly string[];
  /**
   * The add-ons the model uses, as the host resolved them: the first-party
   * trades it installed and the model's own (its pins and add-on switches).
   * A sealed runner starts with none and installs exactly these, so the
   * kernel decides the script's edits as the model server will. Absent: the
   * run uses whatever the running process installed (a laptop, a test).
   */
  readonly addOns?: readonly ScriptAddOn[];
  /**
   * Part types the host's library offers this run, by the type id a placement
   * uses (a firm's parts): only ids the script's `reads.partTypes` name and
   * the model doesn't have yet. `equipment.place` sends one's definition, as
   * it does a built-in's. The open kit ships none; a host fills it from its
   * own library. Absent: built-in and model part types only.
   */
  readonly partLibrary?: Readonly<Record<string, PartTypeDefinition>>;
}

/** At most this many library part types ride in one slice. */
export const MAX_SLICE_LIBRARY_PARTS = 500;

/** One add-on a slice names: its id and the version the model uses. */
export interface ScriptAddOn {
  readonly id: string;
  readonly version: string;
}

/**
 * The add-ons `model` uses in this process: the installed first-party packs,
 * then the model's own set (resolved from its state, else what the host bound
 * to its id), each once, in that order.
 */
export function modelAddOns(model: ModelState): ScriptAddOn[] {
  const own = (modelStatePackSet(model) ?? modelPackSet(model.modelId))?.packs ?? [];
  const base = installedFirstPartyPacks().filter((p) => !own.some((o) => o.manifest.id === p.manifest.id));
  return [...base, ...own].map((p) => ({ id: p.manifest.id, version: p.manifest.version }));
}

const scriptAddOnSchema = z.object({ id: z.string().min(1).max(200), version: z.string().min(1).max(64) });

/** For reading a slice a host sent (the runner's input). Elements and settings stay the kernel's to check when commands run. */
export const modelSliceSchema = z.object({
  format: z.literal(SLICE_FORMAT),
  version: z.literal(1),
  modelId: z.string().min(1).max(200),
  revision: z.number().int().min(0),
  reads: scriptReadsSchema,
  selection: z.array(z.string().max(200)).max(5000),
  elements: z.record(z.string(), z.custom<BimElement>((v) => typeof v === "object" && v !== null && typeof (v as { kind?: unknown }).kind === "string")),
  connections: z.array(z.custom<Connection>((v) => typeof v === "object" && v !== null)),
  settings: z.custom<ModelSettings>((v) => typeof v === "object" && v !== null),
  features: z.array(z.string().max(120)).max(500),
  addOns: z.array(scriptAddOnSchema).max(100).optional(),
  partLibrary: z
    .record(z.string().min(1).max(200), z.custom<PartTypeDefinition>((v) => typeof v === "object" && v !== null && typeof (v as { typeName?: unknown }).typeName === "string"))
    .refine((r) => Object.keys(r).length <= MAX_SLICE_LIBRARY_PARTS, `A slice carries at most ${MAX_SLICE_LIBRARY_PARTS} library part types`)
    .optional(),
});

export class ScriptReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptReadError";
  }
}

/** `*` matches any run of characters; everything else literally. */
export function globMatch(pattern: string, text: string): boolean {
  const re = new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
  return re.test(text);
}

function inReads(el: BimElement, reads: ScriptReads, ids: ReadonlySet<string>): boolean {
  if (ids.has(el.id)) return true;
  if (reads.levels && el.kind === "level") return true;
  if (reads.kinds?.includes(el.kind)) return true;
  if (el.kind === "part_type" && reads.partTypes?.some((p) => globMatch(p, el.id))) return true;
  return false;
}

/** The slice of `model` that `reads` names (one pass over the elements). */
export function sliceModel(model: ModelState, reads: ScriptReads, selection: readonly string[] = [], features: readonly string[] = [], library: Readonly<Record<string, PartTypeDefinition>> = {}): ModelSlice {
  const ids = new Set<string>(reads.ids === "selection" ? selection : (reads.ids ?? []));
  const elements: Record<string, BimElement> = {};
  for (const id in model.elements) {
    const el = model.elements[id];
    if (el && inReads(el, reads, ids)) elements[id] = el;
  }
  const connections = model.connections.filter((c) => elements[c.a.elementId] !== undefined && elements[c.b.elementId] !== undefined);
  const partLibrary: Record<string, PartTypeDefinition> = {};
  for (const [typeId, definition] of Object.entries(library)) {
    if (model.elements[typeId] || !reads.partTypes?.some((p) => globMatch(p, typeId))) continue;
    if (Object.keys(partLibrary).length >= MAX_SLICE_LIBRARY_PARTS) break;
    partLibrary[typeId] = definition;
  }
  return { format: SLICE_FORMAT, version: 1, modelId: model.modelId, revision: Number(model.revision), reads, selection: [...selection], elements, connections, settings: model.settings, features: [...features], addOns: modelAddOns(model), ...(Object.keys(partLibrary).length > 0 ? { partLibrary } : {}) };
}

/** The slice as a model the kernel's commands run on. */
export function sliceAsModel(slice: ModelSlice): ModelState {
  return { modelId: slice.modelId, revision: slice.revision as Revision, elements: slice.elements, connections: slice.connections, settings: slice.settings };
}

/** What a script reads the model through. Beyond its reads: `ScriptReadError`. Elements its own edits made are always readable. */
export interface SliceReader {
  /** The element, or a plain error when it isn't in what the script reads. */
  get(id: string): BimElement;
  /** The element when present in the slice, else undefined (no error: for "is it there yet?"). */
  find(id: string): BimElement | undefined;
  /** Every element of a kind the reads name. */
  ofKind(kind: string): BimElement[];
  levels(): BimElement[];
  /** The selection's elements (`reads.ids: "selection"`). */
  selection(): BimElement[];
  partTypes(pattern?: string): BimElement[];
  /** A part type the host's library supplied for this run (`ModelSlice.partLibrary`), by type id; undefined when it supplied none. */
  libraryPart(typeId: string): PartTypeDefinition | undefined;
  readonly revision: number;
}

/**
 * A reader over the working copy, which holds only the slice plus what the
 * script's own edits made: an id that isn't there was never sent, so the
 * error names what to add to `reads`.
 */
export function sliceReader(slice: ModelSlice, current: () => ModelState): SliceReader {
  const reads = slice.reads;
  const all = () => Object.values(current().elements);
  return {
    revision: slice.revision,
    get(id) {
      const el = current().elements[id];
      if (el) return el;
      throw new ScriptReadError(`This script read ${id}, which isn't in what it reads. Add "${id}" to reads.ids, or its kind to reads.kinds.`);
    },
    find(id) {
      return current().elements[id];
    },
    ofKind(kind) {
      if (!reads.kinds?.includes(kind) && !(kind === "level" && reads.levels)) throw new ScriptReadError(`This script lists every ${kind}, which its reads don't name. Add "${kind}" to reads.kinds.`);
      return all().filter((e) => e.kind === kind);
    },
    levels() {
      if (!reads.levels) throw new ScriptReadError("This script reads the levels, which its reads don't name. Set reads.levels to true.");
      return all().filter((e) => e.kind === "level");
    },
    selection() {
      if (reads.ids !== "selection") throw new ScriptReadError(`This script reads the selection, which its reads don't name. Set reads.ids to "selection".`);
      const els = current().elements;
      return slice.selection.flatMap((id) => {
        const el = els[id];
        return el ? [el] : [];
      });
    },
    libraryPart(typeId) {
      return slice.partLibrary?.[typeId];
    },
    partTypes(pattern = "*") {
      if (!reads.partTypes?.length) throw new ScriptReadError(`This script reads part types, which its reads don't name. Add a pattern such as "${pattern}" to reads.partTypes.`);
      return all().filter((e) => e.kind === "part_type" && globMatch(pattern, e.id) && (reads.partTypes ?? []).some((p) => globMatch(p, e.id)));
    },
  };
}
