import { z } from "zod";

/** Parameter names: lower_snake_case, starting with a letter. */
export const PARAM_NAME = /^[a-z][a-z0-9_]{0,47}$/;

/**
 * A dimension in a part definition: a fixed number, a parameter's value
 * (× scale + add), or a formula over parameters (part-model/formula.ts).
 */
export const dimSchema = z.union([
  z.number().finite(),
  z.object({ param: z.string().regex(PARAM_NAME), scale: z.number().finite().optional(), add: z.number().finite().optional() }),
  z.object({ formula: z.string().trim().min(1).max(400) }),
]);
export type Dim = z.infer<typeof dimSchema>;
