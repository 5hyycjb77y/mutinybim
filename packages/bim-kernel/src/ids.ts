/**
 * One id grammar for every registry row a record stores: services, classes,
 * categories, zone purposes, derived-zone rules, facets, connector domains.
 *
 * Readers accept any id of this shape, known or not, keep it byte for byte
 * and show its raw words, so a newer peer's row survives a rolling deploy
 * (MIGRATION-PLAN §1.3). Writers still check their own registry at command
 * time; this grammar never loosens a writer.
 *
 * Writer grammar:
 * - built-in rows are bare (`grease_waste`, `thermal`) and reserved;
 * - firm rows are `firm:<slug>`;
 * - pack rows are `<namespace>.<name>`, the namespace being the pack's
 *   registered prefix (`fp`, `struct`, `fa`, `civil`, `gc`; classes already
 *   use `arch.`, `mep.`, `struct.`, `fp.`).
 *
 * This module imports nothing, so any layer may read it.
 */

export const REGISTRY_ID_PATTERN = /^[a-z][a-z0-9_]*(?:[.:][a-z0-9][a-z0-9_]*)*$/;

export const REGISTRY_ID_MAX_LENGTH = 96;

/** A stored registry id this release's readers accept, whether or not this release knows the row. */
export function isRegistryIdShape(id: unknown): id is string {
  return typeof id === "string" && id.length <= REGISTRY_ID_MAX_LENGTH && REGISTRY_ID_PATTERN.test(id);
}

/** A row id's raw words for display when this release doesn't know the row (`fp.sprinkler_wet` → "Sprinkler wet"). */
export function rawRegistryWords(id: string): string {
  const last = id.split(/[.:]/).pop() ?? id;
  const words = last.replace(/_/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : id;
}
