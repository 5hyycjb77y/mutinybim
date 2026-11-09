import { z } from "zod";
import { catalogEntryOf, catalogRecords, type BimElement, type CatalogEntryTypeRow, type ModelState } from "@permitzip/bim-kernel";

/**
 * Circuit templates, a firm's room convention ("bedroom on circuit 1, living
 * room on 2"), applied to dwelling units the engineer picks (moved from the
 * kernel's catalog in round 12, stored bytes unchanged). Stored type
 * `circuit_template`, ids `etype:template:<NAME>`.
 */

const text = (max: number) => z.string().trim().max(max);
const key = (max: number) => z.string().trim().min(1).max(max);

export const TEMPLATE_DEVICE_FILTERS = ["receptacles", "lighting", "all"] as const;
export type TemplateDeviceFilter = (typeof TEMPLATE_DEVICE_FILTERS)[number];

export const templateRuleSchema = z.object({
  /** Matched against room names, whole words, ignoring case: "bedroom" matches "Bedroom 2" and "Master bedroom". */
  room: key(60),
  devices: z.enum(TEMPLATE_DEVICE_FILTERS),
  /** The circuit number on the unit's panel (its first slot); absent: the next free slot that best balances the phases. */
  circuit: z.number().int().min(1).max(999).optional(),
  /** The circuit's description; absent: "<room name> <receptacles|lighting>". */
  description: text(60).optional(),
  breakerA: z.number().positive().max(10_000).optional(),
});
export type TemplateRule = z.infer<typeof templateRuleSchema>;

export const circuitTemplateSchema = z.object({
  type: z.literal("circuit_template"),
  name: key(80),
  description: text(200),
  /** Top to bottom: the first rule that matches a room wins. */
  rules: z.array(templateRuleSchema).min(1).max(40),
});
export type CircuitTemplateEntry = z.infer<typeof circuitTemplateSchema>;

export function circuitTemplateOf(elements: Readonly<Record<string, BimElement>>, name: string): CircuitTemplateEntry | null {
  return catalogEntryOf(elements, "circuit_template", name);
}

export const circuitTemplates = (model: Pick<ModelState, "elements">) => catalogRecords(model, "circuit_template");

export const CIRCUIT_TEMPLATE_ROW: CatalogEntryTypeRow = {
  type: "circuit_template",
  idPrefix: "template",
  label: "Room template",
  schema: circuitTemplateSchema,
  nameOf: (entry) => {
    const name = (entry as { readonly name?: unknown }).name;
    return typeof name === "string" ? name : "";
  },
  trade: () => "electrical",
};
