import { rawRegistryWords } from "../../ids";
import { defineExtensionPoint } from "../../packs/contract";
import { activePackSet } from "../../packs/scope";
import { PIPE_MATERIALS, type PipeMaterial, type RunSize } from "../types";

/**
 * Pipe materials beyond the kernel's twelve (FOUNDATION-COVERAGE §2.5: a storm
 * pack's reinforced concrete). A pack contributes a row with its own id and
 * the built-in material the kernel's tables treat it as (`fallback`: sizes,
 * specs, fittings, hydraulics and every older reader). A pipe size then
 * stores both: `material` is the fallback and `materialId` the pack row, so a
 * peer without the pack still reads a pipe, and the pack's own calcs (a
 * Manning n) read the row.
 */
export interface PipeMaterialRow {
  /** `<pack>.<name>`; built-in rows are the bare `PIPE_MATERIALS`. */
  readonly id: string;
  readonly label: string;
  /** What the kernel's own tables use for it. */
  readonly fallback: PipeMaterial;
  readonly description?: string;
}

export const PIPE_MATERIAL_POINT = defineExtensionPoint<PipeMaterialRow>({
  id: "kernel.pipe_material",
  version: 1,
  label: "Pipe materials",
  idOf: (row) => row.id,
  builtins: () => PIPE_MATERIALS.map((m) => ({ id: m, label: rawRegistryWords(m), fallback: m })),
});

/** The row of the pack set in force with this id, or null. */
export function pipeMaterialRow(id: string): PipeMaterialRow | null {
  const set = activePackSet();
  const rows = set.memo("kernel.pipe_material.rows", () => new Map(set.items(PIPE_MATERIAL_POINT).map((r) => [r.id, r])));
  return rows.get(id) ?? null;
}

/** A pipe size's material as readers take it: the pack row's id and label when the size names one (kept even when this host lacks the pack), else the built-in material. */
export function pipeMaterialOf(size: Extract<RunSize, { shape: "pipe" }>): { readonly id: string; readonly label: string; readonly fallback: PipeMaterial; readonly known: boolean } {
  const id = size.materialId ?? size.material;
  const row = pipeMaterialRow(id);
  return { id, label: row?.label ?? rawRegistryWords(id), fallback: size.material, known: row !== null };
}
