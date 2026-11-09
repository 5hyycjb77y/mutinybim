import { z } from "zod";
import { ITEM_ID_PATTERN, itemBase, text } from "../item-base";

/**
 * Sheet library items (round 15 wave 0; lane SH15 fills their content):
 *
 * - `title_block`: a firm's title block for the paper sizes it fits. Its
 *   layout (frames, fields, logo and seal slots, revision table) is the sheet
 *   engine's to read and check; the library only stores it.
 * - `keynote_table`: a firm's keynotes, each a short key and the words it
 *   stands for, grouped as the firm groups them.
 *
 * Firm content (a firm's logo, fonts and title block) lives in the host's
 * library, never in the open-source packages.
 */
export const titleBlockItemSchema = z
  .object({
    ...itemBase,
    key: z.string().regex(ITEM_ID_PATTERN, "a title block id such as firm:standard"),
    name: text(200),
    /** Paper sizes it is drawn for, as sheets name them (`ARCH E1`, `ARCH D`). */
    paperSizes: z.array(text(40)).min(1).max(20),
    /** The layout, as the sheet engine writes it. */
    definition: z.record(z.string(), z.unknown()),
  })
  .strict();
export type TitleBlockItem = z.infer<typeof titleBlockItemSchema>;

export const keynoteSchema = z
  .object({
    /** What the drawing shows in the keynote's tag (`1`, `M-3`, `09 21 16.A1`). */
    key: text(24),
    text: text(1000),
    /** The heading it is listed under; absent: no heading. */
    group: text(120).optional(),
  })
  .strict();

export const keynoteTableItemSchema = z
  .object({
    ...itemBase,
    key: z.string().regex(ITEM_ID_PATTERN, "a keynote table id such as firm:general"),
    name: text(200),
    keynotes: z
      .array(keynoteSchema)
      .max(5000)
      .refine((rows) => new Set(rows.map((r) => r.key)).size === rows.length, "Each keynote key is listed once"),
  })
  .strict();
export type KeynoteTableItem = z.infer<typeof keynoteTableItemSchema>;
