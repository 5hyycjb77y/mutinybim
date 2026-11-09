import { lineageRole } from "../lineages/roles";
import type { LineageRoleId } from "../lineages/types";
import { defineExtensionPoint } from "../packs/contract";
import { activePackSet, withModelStatePacks } from "../packs/scope";
import type { PackSet } from "../packs/set";
import type { ModelState } from "../types";
import { planIfcImport, type PlanImportOptions } from "./plan";
import type { IfcImportPlan, ImportSource } from "./types";

/**
 * Where an outside model's file is read (contract 1.9.0,
 * `kernel.import_source` v1). A reader turns a file into the importer's
 * neutral products (`ImportSource`); what each product becomes is still the
 * class registry's and the import rules' (`IFC_IMPORT_RULE_POINT`), so a
 * reader decides nothing about the model. What it reads lands in a copy, never
 * on the copy it was read against: a `proposal` (today's branch) or an
 * `external_author` copy, or another role the reader names.
 *
 * IFC is the first reader (`@permitzip/bim-ifc` registers it as a built-in
 * row). An add-on registers its own as `<pack>.<name>` with no kernel edit.
 */

export interface ImportSourceReadOptions {
  /** The linked model version the products come from (`provenance.source`). */
  readonly sourceId: string;
  readonly label: string;
  readonly disciplines: readonly string[];
  /** How the file sits in the host (its placement and adjustment), mm and degrees. */
  readonly placement?: { readonly dx: number; readonly dy: number; readonly dz: number; readonly rotationDeg: number };
  /** Checked between products; true stops the read (the reader throws its own "stopped" error). */
  readonly isCancelled?: () => boolean;
}

export interface ImportSourceDef {
  /** The format id stored with what was read: bare for a built-in reader ("ifc"), `<pack>.<name>` for an add-on's. */
  readonly id: string;
  readonly label: string;
  /** File name endings it reads, lower case with the dot (".ifc"). */
  readonly extensions: readonly string[];
  /** The copy purposes what it reads may land in; the first is the default. */
  readonly landsIn: readonly LineageRoleId[];
  /** True when the start of a file (its first few kilobytes) is this format. */
  detect(head: string): boolean;
  read(text: string, opts: ImportSourceReadOptions): ImportSource;
}

const builtins: ImportSourceDef[] = [];

/**
 * A reader the core packages ship (IFC), registered by the package that
 * implements it when it loads. Idempotent for the same row; a different row
 * for an id already registered is refused loudly.
 */
export function registerBuiltinImportSource(def: ImportSourceDef): void {
  const had = builtins.find((d) => d.id === def.id);
  if (had === def) return;
  if (had) throw new Error(`Import format "${def.id}" is already registered by another reader`);
  if (def.id.includes(".")) throw new Error(`Import format "${def.id}": a built-in reader's id is bare; an add-on contributes "<pack>.<name>" through IMPORT_SOURCE_POINT`);
  builtins.push(def);
}

export const IMPORT_SOURCE_POINT = defineExtensionPoint<ImportSourceDef>({
  id: "kernel.import_source",
  version: 1,
  label: "Import formats",
  idOf: (d) => d.id,
  builtins: () => builtins,
});

/** Problems with reader rows, in words (pack conformance). */
export function importSourceRowProblems(items: readonly ImportSourceDef[]): string[] {
  const out: string[] = [];
  for (const d of items) {
    if (d.label.trim().length === 0) out.push(`import format ${d.id} has no label`);
    if (d.landsIn.length === 0) out.push(`import format ${d.id} names no copy purpose to land in`);
    for (const e of d.extensions) if (!/^\.[a-z0-9]{1,12}$/.test(e)) out.push(`import format ${d.id}: "${e}" isn't a lower-case file ending such as .ifc`);
    if (typeof d.detect !== "function" || typeof d.read !== "function") out.push(`import format ${d.id} needs detect and read functions`);
  }
  return out;
}

export function importSources(set: PackSet = activePackSet()): readonly ImportSourceDef[] {
  return set.items(IMPORT_SOURCE_POINT);
}

/** How much of a file `detect` sees. */
export const IMPORT_DETECT_HEAD = 4096;

/** The reader for a file: by its ending first, then by its content. Null when none reads it. */
export function detectImportSource(text: string, fileName?: string, set?: PackSet): ImportSourceDef | null {
  const rows = importSources(set);
  const head = text.slice(0, IMPORT_DETECT_HEAD);
  const ending = fileName ? (/\.[A-Za-z0-9]{1,12}$/.exec(fileName)?.[0] ?? "").toLowerCase() : "";
  if (ending) {
    const byEnding = rows.filter((d) => d.extensions.includes(ending));
    const hit = byEnding.find((d) => d.detect(head)) ?? (byEnding.length === 1 ? byEnding[0] : undefined);
    if (hit) return hit;
  }
  return rows.find((d) => d.detect(head)) ?? null;
}

export class ImportSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportSourceError";
  }
}

export interface ImportFromInput extends Omit<PlanImportOptions, "model"> {
  /** The copy it is read against (its levels, its ids). */
  readonly model: ModelState;
  readonly read: ImportSourceReadOptions;
  /** A format id; absent: detected from `fileName` and the file's start. */
  readonly format?: string;
  readonly fileName?: string;
  /** The copy purpose to land in; absent: the reader's first. */
  readonly landIn?: LineageRoleId;
}

export interface ImportFromResult extends IfcImportPlan {
  /** The reader that read it. */
  readonly format: string;
  /** The copy purpose the records land in (a new copy whose parent is `model`'s). */
  readonly landsIn: LineageRoleId;
  readonly readMs: number;
  readonly planMs: number;
}

/**
 * Read a file with the reader its format names and plan what converts, for a
 * new copy. Pure: writes nothing. Refuses, in words, a file no reader knows
 * and a copy purpose the reader doesn't land in or this model doesn't have.
 */
export function planImportFrom(text: string, input: ImportFromInput): ImportFromResult {
  return withModelStatePacks(input.model, () => {
    const set = activePackSet();
    const def = input.format !== undefined ? (importSources(set).find((d) => d.id === input.format) ?? null) : detectImportSource(text, input.fileName, set);
    if (!def) {
      const known = importSources(set).map((d) => d.label);
      throw new ImportSourceError(input.format !== undefined ? `No reader for "${input.format}" on this model (it reads ${known.join(", ") || "nothing yet"}). Nothing was read.` : `This file isn't a format this model reads (${known.join(", ") || "none yet"}). Nothing was read.`);
    }
    const landsIn = input.landIn ?? def.landsIn[0];
    if (landsIn === undefined || !def.landsIn.includes(landsIn)) throw new ImportSourceError(`${def.label} files land in ${def.landsIn.join(" or ")} copies, not "${String(input.landIn)}". Nothing was read.`);
    if (!lineageRole(landsIn, set)) throw new ImportSourceError(`This model has no "${landsIn}" copies (the add-on that defines them isn't installed). Nothing was read.`);
    const t0 = performance.now();
    const source = def.read(text, input.read);
    const t1 = performance.now();
    const plan = planIfcImport(source, { model: input.model, referenceId: input.referenceId, sourceKey: input.sourceKey, ...(input.registry ? { registry: input.registry } : {}), ...(input.rules ? { rules: input.rules } : {}) });
    return { ...plan, format: def.id, landsIn, readMs: t1 - t0, planMs: performance.now() - t1 };
  });
}
