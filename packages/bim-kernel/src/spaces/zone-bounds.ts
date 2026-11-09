import { isRegistryIdShape, rawRegistryWords } from "../ids";
import { registerSchemaStep, schemaSteps, stepAllowed } from "../schema-version/registry";
import type { BimElement, ElementId } from "../types";
import type { Zone, ZoneBounds } from "./types";

/**
 * Zone bounds, expand then contract (MIGRATION-PLAN §3 and §6 "Spatial").
 *
 * - Readers (this release, every peer): a zone without `bounds` reads as a
 *   spaces zone; `outline` and `derived` read as themselves; a kind this
 *   version doesn't know reads as `unknown` and is never rewritten, so a newer
 *   peer's zone round-trips byte for byte.
 * - Writers: an outlined or derived zone is written only when every peer
 *   advertises `schema:zone@2` (the step below is gated on it). Until then the
 *   commands refuse in plain words. A v1 zone a command touches is upgraded
 *   quietly in the same batch (bounds added beside `spaceIds`), so undo puts
 *   the stored record back.
 * - Contract (a later release): drop the `spaceIds` mirror once no v1 reader
 *   is deployed.
 */

export const ZONE_BOUNDS_FEATURE = "schema:zone@2";
export const ZONE_BOUNDS_STEP = "zone_bounds";

function isZone(record: BimElement): record is Zone {
  return record.kind === "zone";
}

registerSchemaStep({
  kind: "zone",
  from: 1,
  to: 2,
  name: ZONE_BOUNDS_STEP,
  feature: ZONE_BOUNDS_FEATURE,
  detect: (record) => isZone(record) && record.bounds === undefined,
  upgrade: (record) => (isZone(record) && record.bounds === undefined ? { ...record, bounds: { kind: "spaces", spaceIds: [...record.spaceIds] } } : record),
});

/** A stored bounds kind this version doesn't read (written by a newer peer). */
export interface UnknownZoneBounds {
  readonly kind: "unknown";
  readonly storedKind: string;
}

export type ReadZoneBounds = ZoneBounds | UnknownZoneBounds;

const KNOWN: ReadonlySet<string> = new Set(["spaces", "outline", "derived"]);

/**
 * The zone's bounds as this version reads them (v1 zones are spaces zones).
 * A derived zone's rule may be any registry-shaped id (`clearance:working_space`,
 * a pack's `struct.tributary_area`): it reads as derived even when this version
 * doesn't know the rule, and resolving it says "listed, not computed". A rule
 * that isn't an id at all reads as an unknown kind, kept as stored.
 */
export function zoneBoundsOf(zone: Zone): ReadZoneBounds {
  const b = zone.bounds;
  if (b === undefined) return { kind: "spaces", spaceIds: zone.spaceIds };
  const kind: unknown = Reflect.get(b, "kind");
  if (kind === "derived" && (!isRegistryIdShape(Reflect.get(b, "rule")) || typeof Reflect.get(b, "hostId") !== "string")) return { kind: "unknown", storedKind: "derived" };
  if (typeof kind === "string" && KNOWN.has(kind)) return b;
  return { kind: "unknown", storedKind: typeof kind === "string" ? kind : "?" };
}

/** Zone purposes this version's commands write (a writer list: readers accept any registry-shaped purpose). */
export const KNOWN_ZONE_PURPOSES = ["thermal", "ventilation", "electrical_load_region", "fire_area", "smoke", "lighting_control", "sprinkler_hazard", "structural_load_area", "drainage_catchment", "code_clearance"] as const;

const KNOWN_PURPOSE_SET: ReadonlySet<string> = new Set(KNOWN_ZONE_PURPOSES);

/** True when this version knows the purpose (a built-in or a `firm:` purpose). Others are kept and shown in their raw words. */
export function isKnownZonePurpose(purpose: string): boolean {
  return KNOWN_PURPOSE_SET.has(purpose) || /^firm:[a-z0-9_]{1,40}$/.test(purpose);
}

/** A zone purpose in words: built-ins with underscores as spaces, `firm:` and pack purposes in their raw words (`struct.tributary` → "Tributary"). */
export function zonePurposeWords(purpose: string): string {
  return KNOWN_PURPOSE_SET.has(purpose) ? purpose.replace(/_/g, " ") : isRegistryIdShape(purpose) ? rawRegistryWords(purpose) : purpose;
}

/** The zone's member spaces: its spaces, or none for an outlined, derived or unknown zone. */
export function zoneSpaceIds(zone: Zone): readonly ElementId[] {
  const b = zoneBoundsOf(zone);
  return b.kind === "spaces" ? b.spaceIds : [];
}

/** True when the zone is made of spaces (the only zones spaces can be added to or taken out of). */
export function isSpacesZone(zone: Zone): boolean {
  return zoneBoundsOf(zone).kind === "spaces";
}

/** The zone with new member spaces, keeping `bounds` and the v1 `spaceIds` mirror equal. */
export function withZoneSpaceIds(zone: Zone, spaceIds: readonly ElementId[]): Zone {
  const ids = [...spaceIds];
  return zone.bounds === undefined ? { ...zone, spaceIds: ids } : { ...zone, spaceIds: ids, bounds: { kind: "spaces", spaceIds: ids } };
}

/**
 * Whether outlined and derived zones may be written now: the host's upgrade
 * policy says every peer reads `zone@2` (the model server: every connected
 * page; a page: the server). False with no policy and during undo.
 */
export function zoneBoundsWritable(): boolean {
  const step = schemaSteps("zone").find((s) => s.name === ZONE_BOUNDS_STEP);
  return step !== undefined && stepAllowed(step);
}

/** The plain refusal when a peer can't read outlined or derived zones yet. */
export const ZONE_BOUNDS_NOT_YET =
  "Someone working on this model is on an older version that can't read outlined or code zones yet, so this wasn't saved. Ask them to reload the page, then try again";
