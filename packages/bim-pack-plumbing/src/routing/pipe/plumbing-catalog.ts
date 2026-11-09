import { catalogElementId, catalogKey, catalogRecords } from "@permitzip/bim-kernel";
import { BUILTIN_PIPE_TYPES, type PipeTypeEntry } from "./pipe-types";
import { DEFAULT_PLUMBING_SETTINGS_ENTRY, PLUMBING_SETTINGS_NAME, type PlumbingSettingsEntry } from "./plumbing-settings";
import type { BimElement, ModelState } from "@permitzip/bim-kernel";

/** Reading the plumbing records in the project's catalog. */

export interface PipeTypeRecord {
  readonly entry: PipeTypeEntry;
  /** Saved in this project (otherwise one of the firm's built-in types). */
  readonly saved: boolean;
  /** A saved record that replaces a built-in type of the same name. */
  readonly overridesBuiltin: boolean;
}

/** Every pipe type the project can use: its own records, then the built-in types it hasn't replaced, by name. */
export function projectPipeTypes(model: Pick<ModelState, "elements">): readonly PipeTypeRecord[] {
  const saved = catalogRecords(model, "pipe_type").map((r) => r.entry);
  const savedKeys = new Set(saved.map((e) => catalogKey(e.name)));
  const builtinKeys = new Set(BUILTIN_PIPE_TYPES.map((e) => catalogKey(e.name)));
  const out: PipeTypeRecord[] = [
    ...saved.map((entry) => ({ entry, saved: true, overridesBuiltin: builtinKeys.has(catalogKey(entry.name)) })),
    ...BUILTIN_PIPE_TYPES.filter((e) => !savedKeys.has(catalogKey(e.name))).map((entry) => ({ entry, saved: false, overridesBuiltin: false })),
  ];
  return out.sort((a, b) => a.entry.name.localeCompare(b.entry.name));
}

export function pipeTypeOf(model: Pick<ModelState, "elements">, name: string): PipeTypeEntry | null {
  const key = catalogKey(name);
  return projectPipeTypes(model).find((r) => catalogKey(r.entry.name) === key)?.entry ?? null;
}

/** The project's plumbing settings record, or the defaults (auto-sizing off) when none is saved. */
export function projectPlumbingSettings(elements: Readonly<Record<string, BimElement>>): PlumbingSettingsEntry {
  const el = elements[catalogElementId("plumbing_settings", PLUMBING_SETTINGS_NAME)];
  return el?.kind === "service_catalog" && el.entry.type === "plumbing_settings" ? el.entry : DEFAULT_PLUMBING_SETTINGS_ENTRY;
}
