import { canonicalJson } from "../canonical";
import type { DrawingUnderlay, Space, SpaceSeparator, Zone } from "./types";

/**
 * What undo and conflict checks compare on a space, zone or underlay
 * (`authoredFieldValue` field "spatial_design"): everything a person set,
 * without the bookkeeping. Its own file so command-core can read it without
 * the commands.
 */
export const SPATIAL_DESIGN_FIELD = "spatial_design";

export function spatialDesignFingerprint(el: Space | Zone | DrawingUnderlay | SpaceSeparator): string {
  const { id: _id, version: _version, authoredRev: _rev, ...rest } = el;
  return canonicalJson(rest);
}
