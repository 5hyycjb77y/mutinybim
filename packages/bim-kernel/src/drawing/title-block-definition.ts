import { z } from "zod";
import type { Vec2 } from "../types";

/**
 * A title block as a library row (`title_block`, round 15): the paper, the
 * border with its binding margin, a vertical strip on the right edge and the
 * slots stacked in it, top to bottom. Any firm's title block is one of these
 * rows; the kernel draws every row with the same code (`title-block.ts`) and
 * ships no firm's content. Colours are ink only: the strip must read in full
 * when plotted in pure black, so no slot carries information in colour.
 *
 * Readers are tolerant (unknown keys inside a slot are kept, an unknown slot
 * kind draws nothing); writers are strict (`titleBlockDefinitionSchema`).
 */

const HEX = /^#[0-9a-fA-F]{6}$/;
const hex = z.string().regex(HEX, "a colour such as #161E2C");
const mm = (max: number) => z.number().finite().min(0).max(max);
const unit = z.number().finite().min(0).max(1);
const label = z.string().trim().min(1).max(120);

export const titleBlockFontSchema = z
  .object({
    family: z.string().trim().min(1).max(60),
    weight: z.number().int().min(100).max(900),
    /** The file the writers load, as the firm library names it (a served path, a library file id). */
    file: z.string().trim().min(1).max(300),
    /** Cap height as a fraction of the em; sizes text by its cap height. */
    capHeight: z.number().finite().min(0.4).max(0.95),
  })
  .strict();

/** A logo drawn as vector: filled shapes and words in a box, coordinates 0–1 of the box (y down). */
export const titleBlockLogoSchema = z
  .object({
    widthMm: mm(300),
    heightMm: mm(200),
    shapes: z.array(z.object({ points: z.array(z.object({ x: unit, y: unit }).strict()).min(3).max(400), color: hex }).strict()).max(40),
    words: z
      .array(
        z
          .object({
            text: z.string().min(1).max(40),
            /** Baseline point, 0–1 of the box. */
            x: unit,
            y: unit,
            /** Cap height as a fraction of the box height. */
            cap: unit,
            anchor: z.enum(["start", "middle", "end"]),
            font: z.enum(["display", "displayBold", "body"]),
            color: hex,
          })
          .strict(),
      )
      .max(10),
  })
  .strict();

const slotBase = { heightMm: mm(800) };

export const titleBlockSlotSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("firm"),
      ...slotBase,
      logo: titleBlockLogoSchema.optional(),
      /** Name (when there is no logo), discipline line, address, phone, web: one printed line each. */
      lines: z.array(z.string().trim().min(1).max(120)).max(8),
      /** Registration / certificate-of-authorization number by project state (two-letter code): printed when the project's state has one. */
      registrations: z.record(z.string().regex(/^[A-Z]{2}$/), z.string().trim().min(1).max(80)).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("consultants"),
      ...slotBase,
      /** The roles listed, as sheet fields name them (`owner` → the sheet's `owner` field, else the project's). */
      roles: z.array(z.object({ key: z.string().regex(/^[a-z][a-z0-9_]*$/), label }).strict()).min(1).max(8),
    })
    .strict(),
  z.object({ kind: z.literal("project"), ...slotBase }).strict(),
  z
    .object({
      kind: z.literal("key_plan"),
      ...slotBase,
      boxMm: z.object({ x: mm(300), y: mm(300) }).strict(),
      /** Print the key plan's north beside it. */
      northArrow: z.boolean().optional(),
    })
    .strict(),
  z.object({ kind: z.literal("seal"), ...slotBase, squareMm: mm(200) }).strict(),
  /** The issue / revision table and issue purpose. Takes whatever height the other slots leave. */
  z.object({ kind: z.literal("revisions"), heightMm: mm(800).optional() }).strict(),
  z.object({ kind: z.literal("sheet_data"), ...slotBase }).strict(),
  z.object({ kind: z.literal("qr"), ...slotBase }).strict(),
  z.object({ kind: z.literal("sheet_id"), ...slotBase, titleCapMm: mm(20), numberCapMm: mm(40) }).strict(),
  z.object({ kind: z.literal("footer"), ...slotBase, text: z.string().trim().min(1).max(300) }).strict(),
]);

export const titleBlockDefinitionSchema = z
  .object({
    schema: z.literal(1),
    /** As sheets name it (`ARCH E1`, `ARCH D`). */
    paperName: z.string().trim().min(1).max(40),
    /** Landscape paper size, mm. */
    paperMm: z.object({ x: mm(3000), y: mm(3000) }).strict(),
    /** Border from the paper edge, mm; the left one is the binding margin. */
    marginsMm: z.object({ top: mm(100), right: mm(100), bottom: mm(100), left: mm(100) }).strict(),
    /** The vertical strip on the right edge, inside the border. */
    stripWidthMm: mm(400),
    colors: z.object({ ink: hex, label: hex, accent: hex, tint: hex.optional() }).strict(),
    fonts: z.object({ display: titleBlockFontSchema, displayBold: titleBlockFontSchema, body: titleBlockFontSchema }).strict(),
    lines: z.object({ borderMm: mm(3), dividerMm: mm(2), ruleMm: mm(1), accentRuleMm: mm(2).optional() }).strict(),
    slots: z
      .array(titleBlockSlotSchema)
      .min(1)
      .max(20)
      .refine((slots) => slots.filter((s) => s.kind === "revisions").length <= 1, "A title block has at most one revision table"),
  })
  .strict();

export type TitleBlockFont = z.infer<typeof titleBlockFontSchema>;
export type TitleBlockLogo = z.infer<typeof titleBlockLogoSchema>;
export type TitleBlockSlot = z.infer<typeof titleBlockSlotSchema>;
export type TitleBlockDefinition = z.infer<typeof titleBlockDefinitionSchema>;

/** A library title block as a sheet keeps it: the row's id and revision, and the definition copied when it was chosen. */
export interface TitleBlockRow {
  readonly id: string;
  readonly revision: number;
  readonly name: string;
  readonly definition: TitleBlockDefinition;
}

export const titleBlockRowSchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    revision: z.number().int().min(1),
    name: z.string().trim().min(1).max(200),
    definition: titleBlockDefinitionSchema,
  })
  .strict();

/** The strip's frame on paper, mm (y down). */
export function titleBlockStripFrame(def: TitleBlockDefinition): { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number } {
  const right = def.paperMm.x - def.marginsMm.right;
  return { left: right - def.stripWidthMm, right, top: def.marginsMm.top, bottom: def.paperMm.y - def.marginsMm.bottom };
}

/** The drawing area left of the strip, inside the border (mm). */
export function titleBlockDrawingArea(def: TitleBlockDefinition): { readonly min: Vec2; readonly max: Vec2 } {
  const strip = titleBlockStripFrame(def);
  return { min: { x: def.marginsMm.left, y: def.marginsMm.top }, max: { x: strip.left, y: strip.bottom } };
}
