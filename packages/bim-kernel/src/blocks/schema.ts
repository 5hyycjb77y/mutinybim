import { z } from "zod";
import { asElementId } from "../types";
import { blockTableInputSchema, blockTableSpec } from "./table-spec";

/** A calculation block as stored and sent (`CalcBlockSpec`): a template id and its options. */
export const calcBlockInputSchema = z
  .object({
    template: z.string().min(1).max(200),
    options: z.record(z.string().min(1).max(80), z.union([z.string().max(400), z.number().finite(), z.boolean()])).optional(),
  })
  .strict();

/** A field block as commands take it and undo restores it (`blocks/types.ts` FieldBlockSpec). */
export const fieldBlockSpecSchema = z
  .object({
    template: z.string().min(1).max(8000),
    subjectId: z.string().min(1).max(200).transform(asElementId).optional(),
    title: z.string().trim().min(1).max(120).optional(),
    table: blockTableInputSchema.transform(blockTableSpec).optional(),
    calc: calcBlockInputSchema.optional(),
  })
  .strict();
