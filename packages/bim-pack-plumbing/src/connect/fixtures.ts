import { isConnectIntoRefusal, physicalConnect, physicalSourcesFor, planConnectInto, type BimElement, type ConnectFace, type ConnectInto, type ConnectIntoPlan, type ConnectIntoSource, type ModelState, type PartConnector, type SourceEndRef, type SourcesForFace, type SystemKind } from "@permitzip/bim-kernel";
import { FIXTURE_CONNECT_WORDS as W } from "../ui";

/**
 * Plumbing › Connect: join the selected fixtures and equipment to the
 * nearest drain, vent, cold or hot water run in one action, through the
 * kernel's `connect_into` (round 15). The kernel picks each run, the
 * takeoff fitting (the system's own fitting preferences: combination wye and
 * 1/8 bend into a level drain, sanitary tee into a stack), the slope and any
 * drop; this file only says which of a fixture's connectors each target
 * means. A selection of fixtures never reads the rest of the model.
 *
 * The "+" grip on a fixture uses the same kernel faces, answered here only
 * for the add-on's own pipe ends (a duct neck or a power connection is
 * another add-on's to answer).
 */

type Elements = Readonly<Record<string, BimElement>>;

export const FIXTURE_CONNECT_TARGETS = ["drain", "vent", "cold_water", "hot_water"] as const;
export type FixtureConnectTarget = (typeof FIXTURE_CONNECT_TARGETS)[number];

/** Which connectors each target joins, by the system kind they carry. */
const TARGET_KINDS: Readonly<Record<FixtureConnectTarget, ReadonlySet<SystemKind>>> = {
  drain: new Set<SystemKind>(["sanitary", "grease_waste", "indirect_waste"]),
  vent: new Set<SystemKind>(["vent"]),
  cold_water: new Set<SystemKind>(["domestic_cold_water"]),
  hot_water: new Set<SystemKind>(["domestic_hot_water"]),
};

const PIPE = "pipe";

function connectorsOf(elements: Elements, el: BimElement): readonly PartConnector[] {
  if (el.kind !== "part") return [];
  const type = elements[el.typeId];
  return type?.kind === "part_type" ? type.definition.connectors : [];
}

/** A fixture's open, end-of-line pipe connectors for a target (an in-line part's in / out is joined by putting it on a pipe, not here). */
function openPorts(elements: Elements, el: BimElement, target: FixtureConnectTarget): string[] {
  if (el.kind !== "part") return [];
  const kinds = TARGET_KINDS[target];
  return connectorsOf(elements, el)
    .filter((c) => c.domain === PIPE && kinds.has(c.systemKind) && c.flowDirection === undefined && !el.links?.[c.id])
    .map((c) => c.id);
}

/** Every selected fixture's open connectors for the target, in selection order, each fixture once. */
export function fixtureConnectSources(elements: Elements, selectedIds: readonly string[], target: FixtureConnectTarget): ConnectIntoSource[] {
  const seen = new Set<string>();
  const out: ConnectIntoSource[] = [];
  for (const id of selectedIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const el = elements[id];
    if (!el) continue;
    for (const port of openPorts(elements, el, target)) out.push({ elementId: id, port });
  }
  return out;
}

/** Why Connect › <target> is off for this selection, in words; null when it can run. */
export function fixtureConnectBlocked(elements: Elements, selectedIds: readonly string[], target: FixtureConnectTarget): string | null {
  const parts = selectedIds.filter((id) => elements[id]?.kind === "part");
  if (parts.length === 0) return W.selectFirst;
  if (fixtureConnectSources(elements, parts, target).length > 0) return null;
  const any = parts.some((id) => {
    const el = elements[id];
    return el ? connectorsOf(elements, el).some((c) => c.domain === PIPE && TARGET_KINDS[target].has(c.systemKind)) : false;
  });
  return any ? W.target[target].allConnected : W.target[target].noneHave;
}

/** The request for the selection: into the nearest run each source's system takes. Null when nothing selected has an open connector for it. */
export function fixtureConnectRequest(elements: Elements, selectedIds: readonly string[], target: FixtureConnectTarget, idPrefix: string): ConnectInto | null {
  const from = fixtureConnectSources(elements, selectedIds, target);
  return from.length > 0 ? { from, into: "nearest", idPrefix } : null;
}

/** One line per source for the preview: what joins where, or why not. */
export interface FixtureConnectLine {
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

function runText(elements: Elements, runId: string): string {
  const seg = elements[runId];
  if (seg?.kind !== "run_segment") return runId;
  const system = elements[seg.systemId];
  return system?.kind === "mep_system" ? system.name : runId;
}

/** Per-ft slope as a fraction of an inch ("1/4\" per ft"). */
function slopeText(ratio: number): string {
  const inPerFt = ratio * 12;
  const eighths = Math.round(inPerFt * 8);
  if (eighths <= 0) return "";
  const whole = Math.floor(eighths / 8);
  const rest = eighths % 8;
  const g = rest === 0 ? 1 : rest % 4 === 0 ? 4 : rest % 2 === 0 ? 2 : 1;
  const frac = rest === 0 ? "" : `${rest / g}/${8 / g}`;
  return `${whole > 0 ? `${whole}${frac ? `-${frac}` : ""}` : frac}" per ft`;
}

/** The preview of a plan, one line per source, in request order. */
export function fixtureConnectLines(elements: Elements, plan: ConnectIntoPlan): FixtureConnectLine[] {
  return plan.sources.map((answer, i) => {
    const key = `${answer.source.elementId}:${answer.source.port}:${i}`;
    if (isConnectIntoRefusal(answer)) return { key, elementId: answer.source.elementId, ok: false, text: answer.refused };
    const bits = [answer.fittings.map((f) => f.label).join(", "), answer.slope ? slopeText(answer.slope.ratio) : "", answer.flex ? W.flex : ""].filter((b) => b.length > 0);
    return { key, elementId: answer.source.elementId, ok: true, text: `${portLabel(elements, answer.source)} → ${runText(elements, answer.intoRunId)}${bits.length > 0 ? `: ${bits.join("; ")}` : ""}` };
  });
}

/** The preview for the selection, or why there is none. Nothing changes. */
export function previewFixtureConnect(model: ModelState, selectedIds: readonly string[], target: FixtureConnectTarget, idPrefix: string): { readonly plan: ConnectIntoPlan; readonly lines: readonly FixtureConnectLine[]; readonly joinable: number } | { readonly refused: string } {
  const blocked = fixtureConnectBlocked(model.elements, selectedIds, target);
  const request = blocked ? null : fixtureConnectRequest(model.elements, selectedIds, target, idPrefix);
  if (!request) return { refused: blocked ?? W.target[target].noneHave };
  const plan = planConnectInto(model, request);
  const lines = fixtureConnectLines(model.elements, plan);
  return { plan, lines, joinable: lines.filter((l) => l.ok).length };
}

// ------------------------------------------------------------------ the "+" grip

/** Whether the grip's end is one of this add-on's pipe ends (a fixture's pipe connector, or an open pipe end). */
function isPlumbingEnd(elements: Elements, ref: SourceEndRef): boolean {
  const el = elements[ref.elementId];
  if (!el) return false;
  if (el.kind === "run_segment") return el.domain === PIPE;
  if (el.kind !== "part") return false;
  const connectors = connectorsOf(elements, el);
  if (ref.end !== undefined) return connectors.find((c) => c.id === ref.end)?.domain === PIPE;
  // The kernel serves a part's first open connector a run can take: answer only when that one is a pipe.
  const first = connectors.find((c) => (c.domain === PIPE || c.domain === "duct") && !el.links?.[c.id]);
  return first?.domain === PIPE;
}

/** The order a fixture's open ends are offered when the grip names none: drain first, then vent, then water, then the rest. */
const GRIP_ORDER: readonly FixtureConnectTarget[] = ["drain", "vent", "cold_water", "hot_water"];
const gripRank = (kind: SystemKind): number => {
  const i = GRIP_ORDER.findIndex((t) => TARGET_KINDS[t].has(kind));
  return i < 0 ? GRIP_ORDER.length : i;
};

/** A fixture's open pipe ends, drain first: the ends the grip can serve when the hover names none. */
function gripEnds(elements: Elements, ref: SourceEndRef): SourceEndRef[] {
  const el = elements[ref.elementId];
  if (ref.end !== undefined || el?.kind !== "part") return [ref];
  return connectorsOf(elements, el)
    .filter((c) => c.domain === PIPE && c.flowDirection === undefined && !el.links?.[c.id])
    .sort((a, b) => gripRank(a.systemKind) - gripRank(b.systemKind))
    .map((c) => ({ elementId: ref.elementId, end: c.id }));
}

/**
 * The "+" grip on a fixture or an open pipe end: the nearest runs of its
 * system (kernel faces), for plumbing ends only. Hovering a fixture names no
 * end, so the first of its open ends (drain first) with a run in reach is
 * offered: a closet with a drain 3 ft away and no cold water main yet offers
 * the drain, not an empty cold water list.
 */
export const plumbingSourcesFor: SourcesForFace = (model, ref) => {
  if (!isPlumbingEnd(model.elements, ref)) return null;
  let empty: ReturnType<SourcesForFace> = null;
  for (const end of gripEnds(model.elements, ref)) {
    const answer = physicalSourcesFor(model, end);
    if (answer && answer.candidates.length > 0) return answer;
    empty ??= answer;
  }
  return empty;
};

/** The grip's drop on a plumbing end: one `connect_into` from the end whose system the dropped-on run carries. */
export const plumbingConnect: ConnectFace = (model, ref, source, newId) => {
  if (!isPlumbingEnd(model.elements, ref)) return null;
  const ends = gripEnds(model.elements, ref);
  const end = ends.find((e) => physicalSourcesFor(model, e)?.candidates.some((c) => c.sourceId === source.sourceId)) ?? ends[0] ?? ref;
  return physicalConnect(model, end, source, newId);
};
