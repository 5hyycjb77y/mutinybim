import type { BimElement, ElementId, PartInstance } from "../types";
import type { ServiceLink } from "./types";

/**
 * Service links as stored on parts: which links a source feeds and which
 * link serves a connector. A leaf: the trade adapters read these, and the
 * adapter table in `model.ts` imports the adapters.
 */

type Elements = Readonly<Record<string, BimElement>>;

export function partOf(elements: Elements, id: string): PartInstance | null {
  const el = elements[id];
  return el?.kind === "part" ? el : null;
}

/** Links this element is the source of, in the order they were made. */
export function linksFedFrom(elements: Elements, sourceId: string): ServiceLink[] {
  const part = partOf(elements, sourceId);
  const out: ServiceLink[] = [];
  for (const id of part?.feeds ?? []) {
    const link = elements[id];
    if (link?.kind === "service_link") out.push(link);
  }
  return out;
}

/** The link serving one connector of a part, if any. */
export function linkServing(elements: Elements, partId: string, connector: string): ServiceLink | null {
  const id = partOf(elements, partId)?.served?.[connector];
  const link = id ? elements[id] : undefined;
  return link?.kind === "service_link" ? link : null;
}

/** Positions already taken at a source, by link, optionally leaving one link out. */
export function occupiedPositions(elements: Elements, sourceId: string, except?: string): Map<number, ServiceLink> {
  const taken = new Map<number, ServiceLink>();
  for (const link of linksFedFrom(elements, sourceId)) {
    if (link.id === except) continue;
    for (const p of link.source.positions) taken.set(p, link);
  }
  return taken;
}

/** Elements on the other end of a link or of a part's links: what a change to it can invalidate. */
export function serviceNeighbours(el: BimElement | undefined): ElementId[] {
  if (!el) return [];
  if (el.kind === "service_link") return [el.source.elementId, ...el.members.map((m) => m.elementId)];
  if (el.kind === "part") return [...Object.values(el.served ?? {}), ...(el.feeds ?? [])];
  return [];
}

/** What a link authored: source, positions and members, as one comparable value (intents and conflict checks). */
export function serviceFingerprint(link: ServiceLink): string {
  return `${link.source.elementId}:${link.source.positions.join(",")}|${link.members.map((m) => `${m.elementId}#${m.connector}`).join(",")}`;
}
