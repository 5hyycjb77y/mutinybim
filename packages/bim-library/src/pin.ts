import { contentHashOf } from "./hash";
import type { LibraryLayer } from "./layering";
import type { LibraryItemSummary, LibraryProblem, StoredLibraryItem } from "./provider";
import { makeItem, type LibraryItem, type LibraryItemType } from "./schema";

/**
 * A model's own copy of a library item it uses (SCHEDULES-PLAN §3a). Prints
 * reproduce, the authority evaluates without any provider, and a firm edit
 * never rewrites an issued sheet: a newer revision is offered, never applied.
 */
export interface LibraryPin {
  readonly id: string;
  readonly type: LibraryItemType;
  readonly revision: number;
  readonly contentHash: string;
  /** Where it was pinned from, e.g. `firm:permitzip`. */
  readonly fromScope: string;
  readonly item: LibraryItem;
}

/** Pins a stored item, refusing one whose content no longer matches its hash. */
export function pinItem(stored: StoredLibraryItem): LibraryPin {
  const item = makeItem(stored.type, stored.body);
  const scope = stored.scope;
  const hash = contentHashOf(item);
  if (item.body.contentHash !== undefined && item.body.contentHash !== hash) {
    throw new Error(`Library item ${item.body.key} (revision ${item.body.revision}) doesn't match its content hash, so it can't be pinned.`);
  }
  return { id: item.body.id, type: item.type, revision: item.body.revision, contentHash: hash, fromScope: scope, item };
}

/** A pin whose stored copy was changed after pinning (or that disagrees with its own header), else null. */
export function checkPin(pin: LibraryPin): LibraryProblem | null {
  const body = pin.item.body;
  if (body.id !== pin.id || body.revision !== pin.revision || pin.item.type !== pin.type) {
    return { itemId: pin.id, itemType: pin.type, message: `The model's copy of ${body.key} disagrees with its pin (it says revision ${body.revision}, the pin ${pin.revision}).` };
  }
  if (contentHashOf(pin.item) !== pin.contentHash) {
    return { itemId: pin.id, itemType: pin.type, message: `The model's copy of ${body.key} was changed after it was pinned. Update it from the library to restore it.` };
  }
  return null;
}

/** The model's pins as the top library layer. */
export function pinsAsLayer(pins: readonly LibraryPin[]): LibraryLayer {
  return { kind: "model", scope: "model", items: pins.map((p) => p.item) };
}

export interface PinUpdate {
  readonly pin: LibraryPin;
  readonly latest: LibraryItemSummary;
}

/** Pins with a newer revision available (different content), for the "newer versions" banner and its review. */
export function pinUpdates(pins: readonly LibraryPin[], available: readonly LibraryItemSummary[]): PinUpdate[] {
  const latestById = new Map<string, LibraryItemSummary>();
  for (const s of available) {
    const prior = latestById.get(s.id);
    if (!prior || s.revision > prior.revision) latestById.set(s.id, s);
  }
  const out: PinUpdate[] = [];
  for (const pin of pins) {
    const latest = latestById.get(pin.id);
    if (latest && latest.revision > pin.revision && latest.contentHash !== pin.contentHash) out.push({ pin, latest });
  }
  return out;
}

/** The pins with the chosen items replaced by their newer stored revisions; every other pin stays as it was. */
export function updatePins(pins: readonly LibraryPin[], newer: readonly StoredLibraryItem[]): LibraryPin[] {
  const byId = new Map(newer.map((s) => [s.body.id, s]));
  return pins.map((pin) => {
    const next = byId.get(pin.id);
    return next && next.body.revision > pin.revision ? pinItem(next) : pin;
  });
}
