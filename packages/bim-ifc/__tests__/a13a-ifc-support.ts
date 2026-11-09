/**
 * Round 13 lane A13a IFC test support: export a model built by commands and
 * read the file back with the package's small STEP reader.
 */
import type { ModelState } from "@permitzip/bim-kernel";
import { exportIfc, readStep, type ReadEntity, type StepFile } from "../src";

export const PROJECT = { id: "0b7f4c52-6a1e-4d2b-9a43-5d2f0c9e7a11", name: "A13a building", number: "13" };

export function exported(model: ModelState): { readonly text: string; readonly file: StepFile } {
  const { text } = exportIfc({ model, project: PROJECT, timeStamp: "2026-11-04T00:00:00" });
  return { text, file: readStep(text) };
}

export function ofType(file: StepFile, type: string): ReadEntity[] {
  return [...file.entities.values()].filter((e) => e.type === type);
}

export function ref(e: ReadEntity, i: number): number {
  const a = e.args[i];
  return a?.kind === "ref" ? a.id : -1;
}

export function refs(e: ReadEntity, i: number): number[] {
  const a = e.args[i];
  return a?.kind === "list" ? a.items.flatMap((t) => (t.kind === "ref" ? [t.id] : [])) : [];
}

export function text(e: ReadEntity | undefined, i: number): string | null {
  const a = e?.args[i];
  return a?.kind === "string" ? a.value : a?.kind === "enum" ? a.value : null;
}

export function num(e: ReadEntity | undefined, i: number): number | null {
  const a = e?.args[i];
  return a?.kind === "number" ? a.value : null;
}
