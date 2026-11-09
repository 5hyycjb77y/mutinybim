import { z } from "zod";
import type { TrackedReader } from "../model";
import { asElementId, type ElementId } from "../types";
import type { KeynotesTableSpec } from "../annotation/keynotes";
/**
 * Computed tables on a field block (r2-ventilation §4): a field block is one
 * subject's text template and can't repeat a line per space or per fan, so a
 * table names which computed table it is. One discriminated union; each kind's
 * renderer (table-block.ts) returns a `RenderedBlock`, so hashing,
 * freeze-at-issue and "changed since" are unchanged. The block's template is
 * then its caption for the editor. Blocks without `table` render exactly as
 * before (same text, same hash). This file holds the spec only (no renderer
 * imports), so the command schemas stay light.
 */

/** The outdoor-air and pressurization tables' specs: stored on a field block whether or not Mechanical is loaded, so the kernel owns their shape. */
export type AirTableScope = { readonly kind: "model" } | { readonly kind: "level"; readonly levelId: ElementId } | { readonly kind: "zone"; readonly zoneId: ElementId };

export interface VentilationTableSpec {
  readonly kind: "ventilation";
  readonly scope: AirTableScope;
}

export interface PressurizationTableSpec {
  readonly kind: "pressurization";
  readonly scope: AirTableScope;
}

/** The gas schedule's spec: stored on a field block whether or not Plumbing and gas is loaded, so the kernel owns its shape. */
export type GasTableScope = { readonly kind: "model" } | { readonly kind: "level"; readonly levelId: ElementId } | { readonly kind: "zone"; readonly zoneId: ElementId };

export interface GasTableSpec {
  readonly kind: "gas";
  readonly scope: GasTableScope;
}

export type BlockTableSpec = VentilationTableSpec | PressurizationTableSpec | GasTableSpec | KeynotesTableSpec;
export type BlockTableKind = BlockTableSpec["kind"];

/** Gas loads standing on devices have no zone to read, so a gas schedule lists the model or a level. */
export const GAS_TABLE_ZONE_REFUSAL = "A gas schedule lists the whole model or one level. Pick one of those.";

const id = z.string().min(1).max(200);
const scope = z.discriminatedUnion("kind", [z.object({ kind: z.literal("model") }).strict(), z.object({ kind: z.literal("level"), levelId: id }).strict(), z.object({ kind: z.literal("zone"), zoneId: id }).strict()]);

/** A table as commands take it and undo restores it (ids as plain strings). */
const keynoteTable = z
  .object({
    id: z.string().trim().min(1).max(200),
    revision: z.number().int().min(1),
    name: z.string().trim().min(1).max(200),
    keynotes: z.array(z.object({ key: z.string().trim().min(1).max(24), text: z.string().trim().min(1).max(1000), group: z.string().trim().min(1).max(120).optional() }).strict()).max(5000),
  })
  .strict();

const scopedTableKind = z.enum(["ventilation", "pressurization", "gas"]);

/** Every computed table kind a field block may hold. */
export const blockTableKindSchema = z.enum([...scopedTableKind.options, "keynotes"]);

export const blockTableInputSchema = z.union([
  z.object({ kind: scopedTableKind, scope }).strict(),
  /** A sheet's keynote list: the keynotes on its placed views, worded by the keynote table it was given (copied). */
  z.object({ kind: z.literal("keynotes"), sheetId: id, table: keynoteTable }).strict(),
]);
export type BlockTableInput = z.infer<typeof blockTableInputSchema>;


/** The kernel's spec from the command's plain form. */
export function blockTableSpec(input: BlockTableInput): BlockTableSpec {
  if (input.kind === "keynotes") return { kind: "keynotes", sheetId: asElementId(input.sheetId), table: input.table };
  const s = input.scope;
  const typed = s.kind === "model" ? ({ kind: "model" } as const) : s.kind === "level" ? ({ kind: "level", levelId: asElementId(s.levelId) } as const) : ({ kind: "zone", zoneId: asElementId(s.zoneId) } as const);
  switch (input.kind) {
    case "ventilation":
      return { kind: "ventilation", scope: typed };
    case "pressurization":
      return { kind: "pressurization", scope: typed };
    case "gas":
      return { kind: "gas", scope: typed };
  }
}

/** The element a table's scope names, if any (a level or a zone). */
export function blockTableScopeId(table: BlockTableSpec): ElementId | null {
  if (table.kind === "keynotes") return null;
  return table.scope.kind === "level" ? table.scope.levelId : table.scope.kind === "zone" ? table.scope.zoneId : null;
}

/** Why a table can't be placed, in words, or null. */
export function blockTableProblem(reader: Pick<TrackedReader, "find">, table: BlockTableSpec): string | null {
  if (table.kind === "keynotes") {
    const sheet = reader.find(table.sheetId);
    return sheet?.kind === "sheet" && !sheet.deleted ? null : "A keynote list reads the sheet it is placed on. Place it on a sheet.";
  }
  if (table.kind === "gas" && table.scope.kind === "zone") return GAS_TABLE_ZONE_REFUSAL;
  const scopeId = blockTableScopeId(table);
  if (scopeId === null) return null;
  const el = reader.find(scopeId);
  const want = table.scope.kind === "level" ? "level" : "zone";
  if (!el || ("deleted" in el && el.deleted)) return `The ${want} this table lists no longer exists. Pick another, or list the whole model.`;
  if (el.kind !== want) return `${scopeId} is not a ${want}.`;
  return null;
}
