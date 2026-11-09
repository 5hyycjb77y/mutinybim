import { isConnectIntoRefusal, physicalConnect, physicalSourcesFor, planConnectInto, type BimElement, type ConnectFace, type ConnectInto, type ConnectIntoPlan, type ConnectIntoSource, type ModelState, type PartConnector, type SourceEndRef, type SourcesForFace } from "@permitzip/bim-kernel";
import { AIR_CONNECT_WORDS as W } from "../ui";

/**
 * Mechanical › Connect › To duct (round 15): join the selected diffusers,
 * grilles and units to the nearest duct of their own system in one action,
 * through the kernel's `connect_into`. The kernel picks the duct, the tap
 * (the system's own fitting preferences), the short rigid piece and the flex
 * into the neck; this file only says which of a part's connectors join a
 * duct. A selection never reads the rest of the model.
 *
 * Round 14 could only join flex to an open round end of the same size within
 * reach, so a diffuser needed a branch drawn to it first. Now the "+" grip on
 * a diffuser uses the same kernel faces, answered here for duct ends only (a
 * pipe or a power connection is another add-on's to answer).
 */

type Elements = Readonly<Record<string, BimElement>>;

const DUCT = "duct";

function connectorsOf(elements: Elements, el: BimElement): readonly PartConnector[] {
  if (el.kind !== "part") return [];
  const type = elements[el.typeId];
  return type?.kind === "part_type" ? type.definition.connectors : [];
}

/**
 * A part's open duct connectors that end a branch: a diffuser's neck, a
 * unit's supply or return. An in-line part (a damper, an in-line fan: two
 * duct connections on one service) is joined by putting it on a duct, not here.
 */
function openDuctPorts(elements: Elements, el: BimElement): string[] {
  if (el.kind !== "part") return [];
  const ducts = connectorsOf(elements, el).filter((c) => c.domain === DUCT);
  return ducts.filter((c) => !el.links?.[c.id] && ducts.filter((o) => o.systemKind === c.systemKind).length === 1).map((c) => c.id);
}

/** Every selected part's open duct connectors, in selection order, each part once. */
export function airConnectSources(elements: Elements, selectedIds: readonly string[]): ConnectIntoSource[] {
  const seen = new Set<string>();
  const out: ConnectIntoSource[] = [];
  for (const id of selectedIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const el = elements[id];
    if (!el) continue;
    for (const port of openDuctPorts(elements, el)) out.push({ elementId: id, port });
  }
  return out;
}

/** Why Connect › To duct is off for this selection, in words; null when it can run. */
export function airConnectBlocked(elements: Elements, selectedIds: readonly string[]): string | null {
  const parts = selectedIds.filter((id) => elements[id]?.kind === "part");
  if (parts.length === 0) return W.selectFirst;
  if (airConnectSources(elements, parts).length > 0) return null;
  const any = parts.some((id) => {
    const el = elements[id];
    return el ? connectorsOf(elements, el).some((c) => c.domain === DUCT) : false;
  });
  return any ? W.allConnected : W.noneHave;
}

/** The request for the selection: into the nearest duct each source's system takes. Null when nothing selected has an open duct connection. */
export function airConnectRequest(elements: Elements, selectedIds: readonly string[], idPrefix: string): ConnectInto | null {
  const from = airConnectSources(elements, selectedIds);
  return from.length > 0 ? { from, into: "nearest", idPrefix } : null;
}

/** One line per source for the preview: what joins where, or why not. */
export interface AirConnectLine {
  readonly key: string;
  readonly elementId: string;
  readonly ok: boolean;
  readonly text: string;
}

const markOf = (elements: Elements, id: string): string => {
  const el = elements[id];
  return el?.kind === "part" && el.mark ? el.mark : id;
};

function portLabel(elements: Elements, source: ConnectIntoSource): string {
  const el = elements[source.elementId];
  const c = el ? connectorsOf(elements, el).find((x) => x.id === source.port) : undefined;
  return `${markOf(elements, source.elementId)} ${(c?.label ?? source.port).toLowerCase()}`;
}

function systemName(elements: Elements, runId: string): string {
  const seg = elements[runId];
  if (seg?.kind !== "run_segment") return runId;
  const system = elements[seg.systemId];
  return system?.kind === "mep_system" ? system.name : runId;
}

const FT = 304.8;

/** The preview of a plan, one line per source, in request order. */
export function airConnectLines(elements: Elements, plan: ConnectIntoPlan): AirConnectLine[] {
  return plan.sources.map((answer, i) => {
    const key = `${answer.source.elementId}:${answer.source.port}:${i}`;
    if (isConnectIntoRefusal(answer)) return { key, elementId: answer.source.elementId, ok: false, text: answer.refused };
    const bits = [answer.fittings.map((f) => f.label).join(", "), answer.flex ? W.flex((Math.round((answer.flex.lengthMm / FT) * 10) / 10).toString()) : ""].filter((b) => b.length > 0);
    return { key, elementId: answer.source.elementId, ok: true, text: `${portLabel(elements, answer.source)} → ${systemName(elements, answer.intoRunId)}${bits.length > 0 ? `: ${bits.join("; ")}` : ""}` };
  });
}

export type AirConnectPreview = { readonly plan: ConnectIntoPlan; readonly lines: readonly AirConnectLine[]; readonly joinable: number } | { readonly refused: string };

/** The preview for the selection, or why there is none. Nothing changes. */
export function previewAirConnect(model: ModelState, selectedIds: readonly string[], idPrefix: string): AirConnectPreview {
  const blocked = airConnectBlocked(model.elements, selectedIds);
  const request = blocked ? null : airConnectRequest(model.elements, selectedIds, idPrefix);
  if (!request) return { refused: blocked ?? W.noneHave };
  const plan = planConnectInto(model, request);
  const lines = airConnectLines(model.elements, plan);
  return { plan, lines, joinable: lines.filter((l) => l.ok).length };
}

// ------------------------------------------------------------------ the "+" grip

/** Whether the grip's end is one of this add-on's duct ends (a part's duct connector, or an open duct end). */
function isDuctEnd(elements: Elements, ref: SourceEndRef): boolean {
  const el = elements[ref.elementId];
  if (!el) return false;
  if (el.kind === "run_segment") return el.domain === DUCT;
  if (el.kind !== "part") return false;
  const connectors = connectorsOf(elements, el);
  if (ref.end !== undefined) return connectors.find((c) => c.id === ref.end)?.domain === DUCT;
  // The kernel serves a part's first open connector a run can take: answer only when that one is a duct.
  const first = connectors.find((c) => (c.domain === DUCT || c.domain === "pipe") && !el.links?.[c.id]);
  return first?.domain === DUCT;
}

/** The "+" grip on a diffuser, grille, unit or open duct end: the nearest ducts of its system (kernel faces), for duct ends only. */
export const mechanicalSourcesFor: SourcesForFace = (model, ref) => (isDuctEnd(model.elements, ref) ? physicalSourcesFor(model, ref) : null);

/** The grip's drop on a duct end: one `connect_into`. */
export const mechanicalConnect: ConnectFace = (model, ref, source, newId) => (isDuctEnd(model.elements, ref) ? physicalConnect(model, ref, source, newId) : null);
