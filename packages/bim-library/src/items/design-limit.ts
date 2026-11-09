import { z } from "zod";
import { designLimitSchema, type DesignLimit } from "@permitzip/bim-kernel/policy";
import { ITEM_ID_PATTERN, itemBase } from "../item-base";

/**
 * The `design_limit` library item (round 12 S12): one firm or project design
 * limit ("domestic cold water velocity at most 8 ft/s", "25 % spare capacity
 * on panels"), with its source and who set it. The body is the kernel's
 * strict writer shape (`designLimitSchema`) plus the item fields; the item's
 * `key` is the limit's id, so a firm item keyed `plumbing.cold_water_velocity`
 * replaces the add-on default with that id, and a project item with the same
 * key replaces the firm's (`designLimitsFor`).
 */

export const designLimitItemSchema = designLimitSchema
  .omit({ id: true })
  .extend({
    ...itemBase,
    /** The limit's id: an add-on default's id to replace it, or the firm's own (`firm:<name>`). */
    key: z.string().regex(ITEM_ID_PATTERN, "a limit id such as plumbing.cold_water_velocity or firm:duct_velocity"),
  })
  .strict();

export type DesignLimitItem = z.infer<typeof designLimitItemSchema>;

/** The limit a stored item holds, as `designLimitsFor` reads it. */
export function designLimitFromItem(item: DesignLimitItem): DesignLimit {
  return {
    id: item.key,
    label: item.label,
    quantity: item.quantity,
    unit: item.unit,
    appliesTo: item.appliesTo,
    band: item.band,
    severity: item.severity,
    citation: item.citation,
    ...(item.stages ? { stages: item.stages } : {}),
    ...(item.setBy ? { setBy: item.setBy } : {}),
  };
}

const copy = (list: readonly string[] | undefined) => (list ? [...list] : undefined);

/** A limit as an item body (the editor's save). The item id is stable per limit id, so a re-save is a new revision of the same item. */
export function designLimitItemBody(limit: DesignLimit, revision: number): DesignLimitItem {
  const a = limit.appliesTo;
  const appliesTo: DesignLimitItem["appliesTo"] = {
    ...(a.discipline !== undefined ? { discipline: a.discipline } : {}),
    ...(a.services ? { services: copy(a.services) } : {}),
    ...(a.systems ? { systems: copy(a.systems) } : {}),
    ...(a.materials ? { materials: copy(a.materials) } : {}),
    ...(a.elementClasses ? { elementClasses: copy(a.elementClasses) } : {}),
  };
  return {
    id: `design_limit:${limit.id}`.slice(0, 200),
    key: limit.id,
    revision,
    label: limit.label,
    quantity: limit.quantity,
    unit: limit.unit,
    appliesTo,
    band: { ...limit.band },
    severity: limit.severity,
    citation: { ...limit.citation },
    ...(limit.stages ? { stages: [...limit.stages] } : {}),
    ...(limit.setBy ? { setBy: { ...limit.setBy } } : {}),
  };
}
