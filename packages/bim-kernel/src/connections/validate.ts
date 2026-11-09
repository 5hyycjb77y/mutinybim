import type { ValidationIssue } from "../validate";
import type { BimElement, ElementId } from "../types";
import { linksFedFrom, serviceLinkName, tradeAdapter } from "./model";
import { SERVICE_ROLES, linkAdapterId } from "./types";

type Elements = Readonly<Record<string, BimElement>>;

/**
 * Structural checks only: both ends of every link agree, members exist once,
 * positions are not shared. Whether a source can still serve a member (a
 * panel's voltage changed after circuiting) is a design finding the reports
 * show, not a model error: link commands refuse it when it is made, and a
 * later type edit can't be checked incrementally, so it must never block
 * unrelated commands.
 */
export function serviceIssues(elements: Elements, el: BimElement, issues: ValidationIssue[]): void {
  if (el.kind === "service_link") {
    linkIssues(elements, el, issues);
    return;
  }
  if (el.kind !== "part") return;
  for (const [connector, linkId] of Object.entries(el.served ?? {})) {
    const link = elements[linkId];
    if (link?.kind !== "service_link" || !link.members.some((m) => m.elementId === el.id && m.connector === connector)) {
      issues.push({ code: "disconnected", message: `${el.mark || el.id} says it is served by ${linkId} on ${connector}, but that circuit doesn't list it`, elementIds: [el.id] });
    }
  }
  for (const linkId of el.feeds ?? []) {
    const link = elements[linkId];
    if (link?.kind !== "service_link" || link.source.elementId !== el.id) {
      issues.push({ code: "disconnected", message: `${el.mark || el.id} says it feeds ${linkId}, but that circuit is fed from elsewhere`, elementIds: [el.id] });
    }
  }
}

function linkIssues(elements: Elements, link: Extract<BimElement, { kind: "service_link" }>, issues: ValidationIssue[]): void {
  const name = serviceLinkName(elements, link);
  // A pack's link (adapter "fa", role "slc_loop") is kept as stored; only a registered adapter judges its roles.
  const adapter = tradeAdapter(linkAdapterId(link));
  const roles: readonly string[] = adapter?.roles ?? SERVICE_ROLES;
  if (adapter && !roles.includes(link.role)) {
    issues.push({ code: "invalid_value", message: `${name} has a role (${link.role.replace(/_/g, " ")}) its ${linkAdapterId(link)} network doesn't use`, elementIds: [link.id] });
  }
  const source = elements[link.source.elementId];
  if (source?.kind !== "part") {
    issues.push({ code: "element_not_found", message: `${name} is fed from ${link.source.elementId}, which is not a placed part`, elementIds: [link.id] });
  } else if (!(source.feeds ?? []).includes(link.id)) {
    issues.push({ code: "disconnected", message: `${name} is fed from ${source.mark || source.id}, which doesn't list it`, elementIds: [link.id, source.id] });
  }
  const positions = link.source.positions;
  if (positions.some((p) => !Number.isInteger(p) || p < 1) || new Set(positions).size !== positions.length) {
    issues.push({ code: "invalid_value", message: `${name} has invalid positions ${positions.join(",")}`, elementIds: [link.id] });
  }
  if (source?.kind === "part" && positions.length > 0) {
    // Report a shared position once: on the later of the two links in the source's order.
    const mine = new Set(positions);
    for (const other of linksFedFrom(elements, source.id)) {
      if (other.id === link.id) break;
      const shared = other.source.positions.find((p) => mine.has(p));
      if (shared !== undefined) issues.push({ code: "in_use", message: `${name} and ${serviceLinkName(elements, other)} both use circuit ${shared}`, elementIds: [link.id, other.id] });
    }
  }
  if (link.role === "feeder" && link.members.length > 1) {
    issues.push({ code: "invalid_value", message: `${name} is a feeder with ${link.members.length} members; a feeder feeds one piece of equipment`, elementIds: [link.id] });
  }
  const seen = new Set<string>();
  for (const m of link.members) {
    const key = `${m.elementId}#${m.connector}`;
    if (seen.has(key)) issues.push({ code: "invalid_value", message: `${name} lists ${m.elementId} twice`, elementIds: [link.id] });
    seen.add(key);
    const part = elements[m.elementId];
    if (part?.kind !== "part") {
      issues.push({ code: "element_not_found", message: `${name} serves ${m.elementId}, which is not a placed part`, elementIds: [link.id] });
    } else if (part.served?.[m.connector] !== link.id) {
      issues.push({ code: "disconnected", message: `${name} serves ${part.mark || part.id}, which doesn't name it`, elementIds: [link.id, part.id] });
    }
  }
}

/** Ids whose links point at an element being deleted, for delete planning. */
export function serviceDependents(el: BimElement | undefined): ElementId[] {
  return el?.kind === "part" ? [...(el.feeds ?? [])] : [];
}
