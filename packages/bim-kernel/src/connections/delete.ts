import type { TrackedReader } from "../model";
import type { BimElement, ElementId } from "../types";

type Elements = Record<string, BimElement>;

export interface ServiceDeletePlan {
  /** Memberships of deleted parts in links that stay: these are cut (the link survives without them). */
  readonly cuts: ReadonlyArray<{ readonly linkId: ElementId; readonly elementId: ElementId }>;
}

/**
 * Deleting a part takes it off any circuit it is on (a cut, like a run
 * connection); deleting a source needs its links deleted too (they are its
 * dependents, so refuse / disconnect list them and cascade deletes them).
 */
export function planServiceDelete(reader: TrackedReader, removed: ReadonlySet<ElementId>): ServiceDeletePlan {
  const cuts: Array<{ linkId: ElementId; elementId: ElementId }> = [];
  for (const id of removed) {
    const el = reader.model.elements[id];
    if (el?.kind !== "part") continue;
    for (const linkId of new Set(Object.values(el.served ?? {}))) {
      if (removed.has(linkId)) continue;
      reader.get(linkId);
      cuts.push({ linkId, elementId: id });
    }
  }
  return { cuts };
}

/** After `removed` is gone from `working`: drop back-links to deleted links and members of deleted parts. Returns what it changed. */
export function applyServiceDelete(reader: TrackedReader, working: Elements, removed: ReadonlySet<ElementId>, plan: ServiceDeletePlan): ElementId[] {
  const touched = new Set<ElementId>();
  for (const id of removed) {
    const el = reader.model.elements[id];
    if (el?.kind !== "service_link") continue;
    const source = working[el.source.elementId];
    if (source?.kind === "part" && !removed.has(source.id)) {
      reader.get(source.id);
      const feeds = (source.feeds ?? []).filter((x) => x !== id);
      const { feeds: _old, ...rest } = source;
      working[source.id] = feeds.length > 0 ? { ...rest, feeds } : rest;
      touched.add(source.id);
    }
    for (const m of el.members) {
      const part = working[m.elementId];
      if (part?.kind !== "part" || removed.has(part.id)) continue;
      reader.get(part.id);
      const served = Object.fromEntries(Object.entries(part.served ?? {}).filter(([, linkId]) => linkId !== id));
      const { served: _old, ...rest } = part;
      working[part.id] = Object.keys(served).length > 0 ? { ...rest, served } : rest;
      touched.add(part.id);
    }
  }
  for (const cut of plan.cuts) {
    const link = working[cut.linkId];
    if (link?.kind !== "service_link") continue;
    working[cut.linkId] = { ...link, members: link.members.filter((m) => m.elementId !== cut.elementId) };
    touched.add(cut.linkId);
  }
  return [...touched];
}
