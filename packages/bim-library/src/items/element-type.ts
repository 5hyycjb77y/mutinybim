import { z } from "zod";
import { ITEM_ID_PATTERN, itemBase, text } from "../item-base";

/**
 * The `element_type` library item (round 13 wave 0): a firm's or project's
 * element type for any kind an add-on lets a person draw (a wall type with
 * its layers, thickness, fire rating and room bounding; a door or window
 * type with its size and operation). The kind and parameter keys are the
 * add-on's; the library only stores them. Offered in the type picker when
 * drawing.
 */
const paramValue = z.union([z.number(), z.string().max(400), z.boolean(), z.null()]);

export const elementTypeItemSchema = z
  .object({
    ...itemBase,
    key: z.string().regex(ITEM_ID_PATTERN, "a type id such as firm:gyp_1hr"),
    name: text(200),
    /** The element kind it is a type for (`wall`, `opening`, `zz.partition`). */
    kind: text(80),
    /** The class it classifies new elements as, when the add-on names one. */
    classId: text(120).optional(),
    /** Type parameter values by key (`thickness_mm`, `fire_rating`, `room_bounding`). */
    values: z.record(z.string().max(120), paramValue),
  })
  .strict();

export type ElementTypeItem = z.infer<typeof elementTypeItemSchema>;
