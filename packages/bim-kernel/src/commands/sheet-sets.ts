import { z } from "zod";
import type { ExecuteResult } from "../command-core";
import type { ModelState } from "../types";

/**
 * Sheet sets (contract 1.13.0): a named, ordered list of the model's sheets
 * (a permit set, a bid set, one floor's sheets). Print and Issue pick a set;
 * the screen, the agent and scripts build sets with the same three commands.
 * A set only lists sheets; removing one from a set never deletes the sheet.
 * Peers that store sets advertise the feature. Lane D15 builds them.
 */
export const DOCUMENTS_SHEET_SETS_FEATURE = "documents:sheet_sets";

/** Until lane D15 lands, every sheet set command is refused with this. */
export const SHEET_SETS_NOT_BUILT = "Sheet sets aren't built yet";

const id = z.string().min(1).max(200);
const setName = z.string().trim().min(1).max(200);
/** Sheet ids, in the order the set prints them; each at most once. */
const members = z
  .array(id)
  .max(2000)
  .refine((ids) => new Set(ids).size === ids.length, "A sheet is in a set at most once");

export const sheetSetCommandSchemas = [
  z.object({
    type: z.literal("create_sheet_set"),
    setId: id,
    name: setName,
    sheetIds: members,
    /** What the set is for, in words ("Permit set", "Bid set"). */
    purpose: z.string().trim().min(1).max(120).optional(),
  }),
  z.object({
    type: z.literal("update_sheet_set"),
    setId: id,
    name: setName.optional(),
    /** The whole member list, in print order (replaces it). */
    sheetIds: members.optional(),
    /** null clears it. */
    purpose: z.string().trim().min(1).max(120).nullable().optional(),
  }),
  z.object({ type: z.literal("delete_sheet_set"), setId: id }),
] as const;

export type SheetSetCommand = z.infer<(typeof sheetSetCommandSchemas)[number]>;

const TYPES: ReadonlySet<string> = new Set(sheetSetCommandSchemas.map((s) => s.shape.type.value));

export function isSheetSetCommand(command: { readonly type: string }): command is SheetSetCommand {
  return TYPES.has(command.type);
}

/** Run a sheet set command: refused in words until lane D15 lands. */
export function executeSheetSetCommand(_model: ModelState, _command: SheetSetCommand): ExecuteResult {
  return { ok: false, error: { code: "invalid_value", message: SHEET_SETS_NOT_BUILT, elementIds: [] } };
}
