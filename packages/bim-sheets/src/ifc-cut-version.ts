/**
 * Version of what `cutIfcPlan` / `cutIfcSection` produce for the same IFC
 * and the same request. Shared caches of linked-model cuts are keyed by it
 * (with the IFC's content hash and the request), so bumping it is how a
 * change to the cut reaches every cached drawing background.
 *
 * Bump it whenever the cut's output changes. `ifc-cut-version.test.ts` hashes
 * the cut of a fixed model and fails until this number and its golden hash
 * move together. Kept apart from ./ifc-plan so a cache can read it without
 * loading web-ifc.
 */
export const IFC_CUT_VERSION = 2;

/** The IFC reader the cut runs on; part of the cache key too. Checked against the installed package by the same test. */
export const IFC_READER = "web-ifc@0.0.78";
