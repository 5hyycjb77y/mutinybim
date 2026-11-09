import { canonicalJson } from "../canonical";
import type { LoadRecord } from "../requirements/anchor";

/**
 * What undo and conflict checks compare on a load point (`authoredFieldValue`
 * field "load_point"). Its own file so command-core can read it without the
 * commands. A record with none of the lifecycle fields prints exactly as it did
 * before they existed, so old authored values still compare equal.
 */
export function loadPointFingerprint(lp: LoadRecord): string {
  return canonicalJson({
    host: lp.host ?? null,
    connectionType: lp.connectionType,
    values: lp.values,
    mark: lp.mark ?? null,
    attachedPartId: lp.attachedPartId ?? null,
    schematic: lp.schematic ?? false,
    note: lp.note ?? null,
    ...(lp.anchor ? { anchor: lp.anchor } : {}),
    ...(lp.service ? { service: lp.service } : {}),
    ...(lp.basis ? { basis: lp.basis } : {}),
    ...(lp.rates ? { rates: lp.rates } : {}),
    ...(lp.count !== undefined ? { count: lp.count } : {}),
    ...(lp.servedBy ? { servedBy: lp.servedBy } : {}),
    ...(lp.source ? { source: lp.source } : {}),
    ...(lp.future ? { future: true } : {}),
  });
}
