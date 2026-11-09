import { z } from "zod";

/** Fields every library item carries (schema.ts): a stable id, a revision, the content hash. */

export const ITEM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
export const CONTENT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
/** Semver 2.0 without build ranges: `1.3.0`, `2.0.0-beta.1`. */
export const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
/** An SPDX licence expression, as written: `Apache-2.0`, `MIT OR Apache-2.0`, `LicenseRef-acme-parts`. */
export const SPDX_EXPRESSION_PATTERN = /^[A-Za-z0-9.+-]+(?: (?:AND|OR|WITH) [A-Za-z0-9.+-]+)*$/;

export const text = (max: number) => z.string().trim().min(1).max(max);
export const semver = z.string().regex(SEMVER_PATTERN, "a version such as 1.3.0");
export const contentHash = z.string().regex(CONTENT_HASH_PATTERN, "sha256: followed by 64 hex digits");
export const spdxExpression = z.string().max(200).regex(SPDX_EXPRESSION_PATTERN, "an SPDX licence id such as Apache-2.0");
export const isoTime = z.string().max(40).refine((s) => !Number.isNaN(Date.parse(s)), "an ISO 8601 time");

export const itemBase = {
  id: z.string().regex(ITEM_ID_PATTERN, "a stable id: letters, digits, dot, dash, colon or underscore"),
  revision: z.number().int().positive(),
  contentHash: contentHash.optional(),
  deprecated: z.boolean().optional(),
  description: z.string().max(2000).optional(),
};
