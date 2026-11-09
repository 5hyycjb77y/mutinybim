import { z } from "zod";
import type { QuantityDelta } from "@permitzip/bim-kernel";

/**
 * Quantity delta read (round 8b, lane O), feature `history:quantity_delta`.
 * Built on lane B's history reads: the ids changed between two revisions (or
 * Main and this branch), then those elements and what they name at both
 * ends. Quantities only, never a price. A client asks only when the server
 * advertises the feature; an older server answers with its unknown-message
 * error.
 */
export const QUANTITY_DELTA_FEATURE = "history:quantity_delta";

/** Most changed ids one delta read covers. Past it the answer says so instead of guessing. */
export const QUANTITY_DELTA_MAX_CHANGED = 20000;

const requestId = z.string().min(1).max(100);
const revision = z.number().int().min(0);
const revisionOrHead = z.union([revision, z.literal("head")]);

export const quantityDeltaRequestSchema = z
  .object({
    type: z.literal("quantity_delta"),
    requestId,
    /** A revision of this model, or (on a branch session) Main at a revision. */
    from: z.union([revision, z.object({ model: z.literal("main"), revision: revisionOrHead }).strict()]),
    to: revisionOrHead,
    /** Group by this classification system. */
    system: z.string().min(1).max(100).optional(),
    all: z.boolean().optional(),
  })
  .strict();

export type QuantityDeltaRequest = z.infer<typeof quantityDeltaRequestSchema>;

export function isQuantityDeltaMessageType(type: string): boolean {
  return type === "quantity_delta";
}

export type QuantityDeltaServerMessage =
  | {
      readonly type: "quantity_delta_result";
      readonly requestId: string;
      /** The revisions read (Main's when `fromMain`). */
      readonly fromRevision: number;
      readonly fromMain: boolean;
      readonly toRevision: number;
      readonly changedCount: number;
      readonly deltas: readonly QuantityDelta[];
      /** `sha256:<hex>` of `deltas` (kernel `deltaDigest`). */
      readonly digest: string;
    }
  | { readonly type: "quantity_delta_refused"; readonly requestId: string; readonly reason: string };

export const QUANTITY_DELTA_WORDS = {
  backwards: "Pick an earlier version first, then a later one.",
  tooMany: (n: number) => `${n.toLocaleString("en-US")} elements changed in that range, more than one comparison reads. Pick a shorter range.`,
  notOnBranch: "Comparing with Main works on a branch. Open a branch first.",
  failed: "Couldn't work out the quantity change just now; see the model server's log. Try again.",
} as const;
