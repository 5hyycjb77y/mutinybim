import { paramValue, type BimElement, type ElementId, linkServing, serviceLinkName, type ServiceLink } from "@permitzip/bim-kernel";
import { distributionOf, electricalConnectorIds } from "./systems";

/**
 * A panel's typed "Fed from" text against the feeder that actually serves it.
 * Once a feeder link exists the link is the truth (schedules and the one-line
 * read it); the typed text is left over from before, and when it names other
 * equipment it is a mismatch to flag, not a value to print.
 */

type Elements = Readonly<Record<string, BimElement>>;

const norm = (s: string) => s.toUpperCase().replace(/[\s_]+/g, "");

export interface FedFromMismatch {
  readonly elementId: ElementId;
  /** What the typed parameter says. */
  readonly typed: string;
  /** The equipment the feeder link says serves it. */
  readonly linkedSourceId: ElementId;
  readonly linkedSourceName: string;
}

/** The typed fed-from text when it exists. */
export function typedFedFrom(elements: Elements, partId: string): string | null {
  const part = elements[partId];
  if (part?.kind !== "part") return null;
  const type = elements[part.typeId];
  if (type?.kind !== "part_type") return null;
  const v = paramValue(type.definition, part.values, "fed_from");
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/** Whether the panel is fed by a feeder link (then its typed fed-from text is no longer the source of truth). */
export function fedByLink(elements: Elements, partId: string): boolean {
  const part = elements[partId];
  if (part?.kind !== "part") return false;
  const info = distributionOf(elements, part);
  return Boolean(info?.input && linkServing(elements, part.id, info.input));
}

/** The typed fed-from text of a panel that takes a feeder but has no feeder link: the text says it is fed while nothing feeds it. */
export function fedFromTextUnlinked(elements: Elements, partId: string): { readonly elementId: ElementId; readonly typed: string } | null {
  const typed = typedFedFrom(elements, partId);
  if (!typed) return null;
  const part = elements[partId];
  if (part?.kind !== "part") return null;
  const info = distributionOf(elements, part);
  if (!info?.input || linkServing(elements, part.id, info.input)) return null;
  return { elementId: part.id, typed };
}

/** Null when there is no typed text, no feeder link, or the text names the linked source ("MDP", "MDP via 225A", "MDP-1"). */
export function fedFromTextMismatch(elements: Elements, partId: string): FedFromMismatch | null {
  const typed = typedFedFrom(elements, partId);
  if (!typed) return null;
  const part = elements[partId];
  if (part?.kind !== "part") return null;
  const info = distributionOf(elements, part);
  if (!info?.input) return null;
  const link = linkServing(elements, part.id, info.input);
  if (!link) return null;
  const source = elements[link.source.elementId];
  const sourceInfo = source?.kind === "part" ? distributionOf(elements, source) : null;
  const sourceName = sourceInfo?.name ?? (source?.kind === "part" ? source.mark : "");
  const key = norm(sourceName);
  const t = norm(typed);
  if (key && (t === key || t.startsWith(`${key}VIA`) || t.startsWith(`${key}-`))) return null;
  return { elementId: part.id, typed, linkedSourceId: link.source.elementId, linkedSourceName: sourceName };
}

/** The branch circuit that serves a powered part (a receptacle, a light, a unit), else null. */
export function circuitServing(elements: Elements, partId: string): ServiceLink | null {
  const part = elements[partId];
  if (part?.kind !== "part" || distributionOf(elements, part)) return null;
  for (const connector of electricalConnectorIds(elements, part)) {
    const link = linkServing(elements, part.id, connector);
    if (link && link.role === "branch") return link;
  }
  return null;
}

/**
 * A device's typed "Circuit" text against the circuit that serves it, the same
 * rule as Fed from: once on a circuit the link is the truth. Null when there is
 * no circuit, no typed text, or the text names the circuit ("P1-1", "p1 1").
 */
export function circuitTextMismatch(elements: Elements, partId: string): { readonly elementId: ElementId; readonly typed: string; readonly linkedName: string } | null {
  const link = circuitServing(elements, partId);
  const part = elements[partId];
  if (!link || part?.kind !== "part") return null;
  const type = elements[part.typeId];
  if (type?.kind !== "part_type") return null;
  const v = paramValue(type.definition, part.values, "circuit");
  const typed = typeof v === "string" ? v.trim() : "";
  if (typed === "") return null;
  const linkedName = serviceLinkName(elements, link);
  return norm(typed).replace(/-/g, "") === norm(linkedName).replace(/-/g, "") ? null : { elementId: part.id, typed, linkedName };
}
