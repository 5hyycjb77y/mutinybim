import { canonicalJson } from "../canonical";
import type { AuthoredValue } from "../command-core";
import type { BimElement } from "../types";
import { DEFAULT_GROUP_ID, DEFAULT_PHASE_ID, isOrganized } from "./model";

/** Field names for the competing-edit check. */
export const ORG_FIELDS = {
  groupId: "org.groupId",
  phaseCreated: "org.phaseCreated",
  phaseDemolished: "org.phaseDemolished",
  entry: "org.entry",
} as const;

/** An element's organization field value, as `authoredFieldValue` reads it. */
export function organizationFieldValue(el: BimElement, field: string): AuthoredValue | undefined {
  if (!field.startsWith("org.")) return undefined;
  if (field === ORG_FIELDS.entry) return el.kind === "organization" ? canonicalJson({ entry: el.entry, deleted: el.deleted === true }) : undefined;
  if (!isOrganized(el)) return undefined;
  if (field === ORG_FIELDS.groupId) return el.groupId ?? DEFAULT_GROUP_ID;
  if (field === ORG_FIELDS.phaseCreated) return el.phaseCreated ?? DEFAULT_PHASE_ID;
  if (field === ORG_FIELDS.phaseDemolished) return el.phaseDemolished ?? "none";
  return undefined;
}
