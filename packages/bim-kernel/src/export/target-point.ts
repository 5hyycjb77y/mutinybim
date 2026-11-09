import { payloadDigest } from "../authorship/canonical";
import { defineExtensionPoint } from "../packs/contract";
import { activePackSet, withModelStatePacks } from "../packs/scope";
import type { PackSet } from "../packs/set";
import type { ElementId, ModelState } from "../types";

/**
 * Where a model is written out (contract 1.9.0, `kernel.export_target` v1):
 * IFC for coordination, and through add-ons a point list for building
 * automation, a submittal package, fabrication files. A writer is given the
 * model, a scope and a time stamp it must not read from a clock, and returns
 * bytes that are the same for the same input (deterministic: the artifact
 * row's digest is how a host knows two exports are one). The host stores the
 * bytes and the row; the kernel stores nothing.
 *
 * IFC is the first writer (`@permitzip/bim-ifc` registers it as a built-in
 * row). An add-on registers its own as `<pack>.<name>` with no kernel edit.
 */

export type ExportScope =
  | { readonly kind: "model" }
  | { readonly kind: "level"; readonly levelId: ElementId }
  | { readonly kind: "elements"; readonly ids: readonly ElementId[] };
export type ExportScopeKind = ExportScope["kind"];

export interface ExportTargetInput {
  readonly model: ModelState;
  readonly project: { readonly id: string; readonly name: string; readonly number?: string; readonly description?: string };
  /** ISO 8601. Writers never read a clock. */
  readonly timeStamp: string;
  readonly scope: ExportScope;
  readonly fileName?: string;
  readonly author?: string;
  readonly organization?: string;
}

export interface ExportTargetOutput {
  readonly bytes: Uint8Array;
  readonly fileName: string;
  /** One sentence a person reads ("312 elements on 4 storeys, 3 written as proxies"). */
  readonly summary: string;
  readonly warnings: readonly string[];
  /** What it wrote, counted, for the artifact row. */
  readonly counts?: Readonly<Record<string, number>>;
}

export interface ExportTargetDef<Out extends ExportTargetOutput = ExportTargetOutput> {
  /** Bare for a built-in writer ("ifc"), `<pack>.<name>` for an add-on's. */
  readonly id: string;
  readonly label: string;
  /** File ending with the dot (".ifc"). */
  readonly extension: string;
  readonly mediaType: string;
  /** The scopes it can write; asked for another, `exportTo` refuses in words. */
  readonly scopes: readonly ExportScopeKind[];
  write(input: ExportTargetInput): Out;
}

/** What a host stores beside the bytes: which writer, what was written, from which revision, and the digest. */
export interface ExportArtifactRow {
  readonly target: string;
  readonly targetLabel: string;
  readonly modelId: string;
  readonly revision: number;
  readonly scope: ExportScope;
  readonly fileName: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly digest: string;
  readonly timeStamp: string;
  readonly summary: string;
  readonly warnings: readonly string[];
  readonly counts: Readonly<Record<string, number>>;
}

const builtins: ExportTargetDef[] = [];

/** A writer the core packages ship (IFC), registered by its package when it loads. Same rules as the import formats. */
export function registerBuiltinExportTarget(def: ExportTargetDef): void {
  const had = builtins.find((d) => d.id === def.id);
  if (had === def) return;
  if (had) throw new Error(`Export format "${def.id}" is already registered by another writer`);
  if (def.id.includes(".")) throw new Error(`Export format "${def.id}": a built-in writer's id is bare; an add-on contributes "<pack>.<name>" through EXPORT_TARGET_POINT`);
  builtins.push(def);
}

export const EXPORT_TARGET_POINT = defineExtensionPoint<ExportTargetDef>({
  id: "kernel.export_target",
  version: 1,
  label: "Export formats",
  idOf: (d) => d.id,
  builtins: () => builtins,
});

/** Problems with writer rows, in words (pack conformance). */
export function exportTargetRowProblems(items: readonly ExportTargetDef[]): string[] {
  const out: string[] = [];
  for (const d of items) {
    if (d.label.trim().length === 0) out.push(`export format ${d.id} has no label`);
    if (!/^\.[a-z0-9]{1,12}$/.test(d.extension)) out.push(`export format ${d.id}: "${d.extension}" isn't a lower-case file ending such as .ifc`);
    if (!/^[a-z]+\/[A-Za-z0-9.+-]+$/.test(d.mediaType)) out.push(`export format ${d.id}: "${d.mediaType}" isn't a media type`);
    if (d.scopes.length === 0) out.push(`export format ${d.id} writes no scope`);
    if (typeof d.write !== "function") out.push(`export format ${d.id} needs a write function`);
  }
  return out;
}

export function exportTargets(set: PackSet = activePackSet()): readonly ExportTargetDef[] {
  return set.items(EXPORT_TARGET_POINT);
}

export class ExportTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportTargetError";
  }
}

export interface ExportedArtifact {
  readonly bytes: Uint8Array;
  readonly row: ExportArtifactRow;
}

/** Write `input.model` with the writer `target` names, inside the model's pack set, and describe it as an artifact row. */
export function exportTo(target: string, input: ExportTargetInput): ExportedArtifact {
  return withModelStatePacks(input.model, () => {
    const def = exportTargets().find((d) => d.id === target);
    if (!def) throw new ExportTargetError(`No writer for "${target}" on this model (it writes ${exportTargets().map((d) => d.label).join(", ") || "nothing yet"}). Nothing was written.`);
    if (!def.scopes.includes(input.scope.kind)) throw new ExportTargetError(`${def.label} writes ${def.scopes.join(" or ")}, not one ${input.scope.kind}. Nothing was written.`);
    const out = def.write(input);
    return {
      bytes: out.bytes,
      row: {
        target: def.id,
        targetLabel: def.label,
        modelId: input.model.modelId,
        revision: input.model.revision,
        scope: input.scope,
        fileName: out.fileName,
        mediaType: def.mediaType,
        byteLength: out.bytes.byteLength,
        digest: payloadDigest(out.bytes),
        timeStamp: input.timeStamp,
        summary: out.summary,
        warnings: out.warnings,
        counts: out.counts ?? {},
      },
    };
  });
}

/** Conformance: a writer gives the same bytes twice for one input. The problem in words, or null. */
export function exportTargetDeterminismProblem(target: string, input: ExportTargetInput): string | null {
  const a = exportTo(target, input).row.digest;
  const b = exportTo(target, input).row.digest;
  return a === b ? null : `export format ${target} wrote different bytes for the same model and time stamp (${a} vs ${b})`;
}
