import { drainOutletSides, plumbingSourceRole } from "../connections/plumbing/adapter";
import { drainageParam, drainageParts, isDrainageLoad } from "../drainage/read";
import { connectionTypeOfLoadPoint, paramValue, resolveConnectors, loadAnchorOf, systemKindsServedBy, elementsOfKind } from "@permitzip/bim-kernel";
import type { LoadPointElement, BimElement, ElementId, PartInstance } from "@permitzip/bim-kernel";

type Elements = Readonly<Record<string, BimElement>>;

/**
 * Which fixtures must drain through a grease interceptor, by sewer authority
 * (ROADMAP P5; Plumbing Demo 1, 9:24): in the Hampton Roads Sanitation District
 * every fixture except the restroom fixtures goes to the grease interceptor;
 * Henrico County (its own sewer owner, Henrico County DPU) asks for the
 * three-compartment sink. The project's code study names the sewer owner
 * (code_study_plumbing_locality, HRSD service-area list); a person or the agent
 * types it on the sewer connection, where the building meets that owner's
 * sewer. Nothing here guesses an authority: absent, the checks say "unknown".
 *
 * The same shape serves any other authority: a firm adds a rule to
 * `GREASE_POLICIES`, or a project types `grease_fixtures` on its connection.
 */

/** Instance values on the sewer connection part (drainage role `sewer_connection`). */
export const SEWER_AUTHORITY_PARAMS = {
  /** text: the sewer owner as the code study names it ("HRSD", "Henrico County DPU"). */
  authority: "sewer_authority",
  /** text: overrides the authority's rule: "all except restroom", or a list ("three compartment sink, mop sink, floor sink"). */
  greaseFixtures: "grease_fixtures",
} as const;

export const GREASE_FIXTURE_CLASSES = ["three_compartment_sink", "prep_sink", "mop_sink", "floor_sink", "dishwasher", "hand_sink", "floor_drain", "restroom", "other_drain"] as const;
export type GreaseFixtureClass = (typeof GREASE_FIXTURE_CLASSES)[number];

const CLASS_WORDS: Readonly<Record<GreaseFixtureClass, string>> = {
  three_compartment_sink: "three-compartment sink",
  prep_sink: "prep sink",
  mop_sink: "mop sink",
  floor_sink: "floor sink",
  dishwasher: "dishwasher",
  hand_sink: "hand sink",
  floor_drain: "floor drain",
  restroom: "restroom fixture",
  other_drain: "fixture",
};

export function greaseClassWords(c: GreaseFixtureClass): string {
  return CLASS_WORDS[c];
}

export type GreaseRequirement = "all_but_restroom" | readonly GreaseFixtureClass[];

export interface GreasePolicy {
  readonly id: string;
  /** As findings print it. */
  readonly authority: string;
  readonly matches: RegExp;
  readonly requires: GreaseRequirement;
  /** What the finding cites. */
  readonly cite: string;
}

/** Rules on file. Each cites where it comes from; IPC 1003.3.1 is the code requirement under every one of them. */
export const GREASE_POLICIES: readonly GreasePolicy[] = [
  { id: "hrsd", authority: "HRSD", matches: /\bhrsd\b|hampton roads sanitation/i, requires: "all_but_restroom", cite: "HRSD FOG program; IPC 1003.3.1" },
  { id: "henrico-dpu", authority: "Henrico County DPU", matches: /\bhenrico\b/i, requires: ["three_compartment_sink"], cite: "Henrico County DPU FOG policy; IPC 1003.3.1" },
];

const DESIGNATOR_CLASS: Readonly<Record<string, GreaseFixtureClass>> = {
  SK3: "three_compartment_sink",
  SK1: "prep_sink",
  SK2: "prep_sink",
  MS: "mop_sink",
  FS: "floor_sink",
  DW: "dishwasher",
  HS: "hand_sink",
  FD: "floor_drain",
  TD: "floor_drain",
  "WC-FT": "restroom",
  "WC-FV": "restroom",
  UR: "restroom",
  LAV: "restroom",
};

const WORD_CLASS: ReadonlyArray<readonly [GreaseFixtureClass, RegExp]> = [
  ["three_compartment_sink", /\b(three|3)[- ]?(compartment|comp\.?)\b/i],
  ["mop_sink", /\b(mop|service|janitor'?s?) (sink|basin|receptor)\b/i],
  ["floor_sink", /\bfloor sinks?\b/i],
  ["dishwasher", /\bdish ?wash\w*/i],
  ["hand_sink", /\bhand ?(sink|wash)\w*/i],
  ["restroom", /\b(water closet|toilet|urinal|lavator\w*|wc)\b/i],
  ["floor_drain", /\b(floor|trench|hub) drains?\b/i],
  ["prep_sink", /\b(prep|one|two|1|2)[- ]?(compartment )?sinks?\b|\b(bar|dump|veg\w*|pot) sinks?\b/i],
];

function classFromWords(text: string): GreaseFixtureClass | null {
  for (const [c, re] of WORD_CLASS) if (re.test(text)) return c;
  return null;
}

function partWords(elements: Elements, part: PartInstance | undefined): string {
  if (!part) return "";
  const type = elements[part.typeId];
  if (type?.kind !== "part_type") return part.mark;
  const d = paramValue(type.definition, part.values, "description");
  return [type.definition.familyName, typeof d === "string" ? d : "", part.mark].join(" ");
}

/** What kind of drain a load is, for grease routing: from its connection type, then the words on it and on its fixture. Null: it adds no drainage. */
export function greaseFixtureClassOf(elements: Elements, lp: LoadPointElement): GreaseFixtureClass | null {
  if (!isDrainageLoad(elements, lp)) return null;
  const designator = lp.connectionType.trim().toUpperCase();
  const byDesignator = DESIGNATOR_CLASS[designator];
  if (byDesignator) return byDesignator;
  const ct = connectionTypeOfLoadPoint(elements, lp);
  const anchor = loadAnchorOf(lp);
  const partId = lp.attachedPartId ?? (anchor.kind === "part" ? anchor.partId : undefined);
  const part = partId ? elements[partId] : undefined;
  const words = [ct?.description ?? "", lp.note ?? "", lp.mark ?? "", partWords(elements, part?.kind === "part" ? part : undefined)].join(" ");
  return classFromWords(words) ?? "other_drain";
}

/** Grease-laden on its face: grease waste by service, or a three-compartment sink. The fixtures an unknown authority can't be silent about. */
export function isGreaseFixtureOnItsFace(elements: Elements, lp: LoadPointElement): boolean {
  return lp.service === "grease_waste" || greaseFixtureClassOf(elements, lp) === "three_compartment_sink";
}

export function requirementRequires(req: GreaseRequirement, c: GreaseFixtureClass): boolean {
  return req === "all_but_restroom" ? c !== "restroom" : req.includes(c);
}

/** "all except restroom" or "three compartment sink, mop sink" as a requirement; null when it names nothing known. */
export function parseGreaseFixtures(text: string): GreaseRequirement | null {
  const t = text.trim();
  if (t === "") return null;
  if (/\ball\b/i.test(t) && /\b(restroom|bathroom|toilet room)s?\b/i.test(t)) return "all_but_restroom";
  const classes = new Set<GreaseFixtureClass>();
  for (const item of t.split(/[,;/]|\band\b/i)) {
    const c = classFromWords(item);
    if (c) classes.add(c);
  }
  return classes.size > 0 ? [...classes] : null;
}

export type SewerAuthorityRead =
  /** A rule applies: an authority on file, or a typed `grease_fixtures`. */
  | { readonly kind: "known"; readonly connectionId: ElementId; readonly authority: string; readonly requires: GreaseRequirement; readonly cite: string }
  /** The authority is typed but no rule is on file for it, and the project typed none. */
  | { readonly kind: "no_rule"; readonly connectionId: ElementId; readonly authority: string }
  | { readonly kind: "unknown"; readonly reason: "no_connection" | "not_typed" | "disagree"; readonly connectionId: ElementId | null };

const authorityCache = new WeakMap<object, SewerAuthorityRead>();

const textParam = (elements: Elements, part: PartInstance, name: string): string => {
  const v = drainageParam(elements, part, name);
  return typeof v === "string" ? v.trim() : "";
};

/** The sewer authority, from the sewer connection(s), once per model state. Two connections naming different owners is "unknown" (it says so). */
export function sewerAuthorityOf(elements: Elements): SewerAuthorityRead {
  const hit = authorityCache.get(elements);
  if (hit) return hit;
  const result = readAuthority(elements);
  authorityCache.set(elements, result);
  return result;
}

function readAuthority(elements: Elements): SewerAuthorityRead {
  const ids = drainageParts(elements).sewerConnections;
  if (ids.length === 0) return { kind: "unknown", reason: "no_connection", connectionId: null };
  const typed: Array<{ id: ElementId; authority: string; override: string }> = [];
  for (const id of ids) {
    const part = elements[id];
    if (part?.kind !== "part") continue;
    const authority = textParam(elements, part, SEWER_AUTHORITY_PARAMS.authority);
    const override = textParam(elements, part, SEWER_AUTHORITY_PARAMS.greaseFixtures);
    if (authority || override) typed.push({ id: part.id, authority, override });
  }
  const first = typed[0];
  if (!first) return { kind: "unknown", reason: "not_typed", connectionId: ids[0] ?? null };
  if (typed.some((t) => t.authority.toLowerCase() !== first.authority.toLowerCase())) return { kind: "unknown", reason: "disagree", connectionId: first.id };
  const override = first.override ? parseGreaseFixtures(first.override) : null;
  if (override) return { kind: "known", connectionId: first.id, authority: first.authority || "the project", requires: override, cite: `${first.authority ? `${first.authority}, as set on the project` : "Project setting"}; IPC 1003.3.1` };
  const policy = GREASE_POLICIES.find((p) => p.matches.test(first.authority));
  if (policy) return { kind: "known", connectionId: first.id, authority: policy.authority, requires: policy.requires, cite: policy.cite };
  return { kind: "no_rule", connectionId: first.id, authority: first.authority };
}

export type GreaseRoute =
  | { readonly kind: "through_interceptor"; readonly interceptorId: ElementId; readonly how: "drawn" | "named" }
  | { readonly kind: "bypasses"; readonly toId: ElementId | null; readonly how: "drawn" | "named"; readonly belowInterceptor: ElementId | null }
  | { readonly kind: "not_routed" };

/** The pipe a load drains from: its run end, or its fixture's sanitary or grease waste connection when that is piped. */
function drainStartOf(elements: Elements, lp: LoadPointElement): ElementId | null {
  const a = loadAnchorOf(lp);
  if (a.kind === "run_end") return elements[a.hostId] ? a.hostId : null;
  const partId = lp.attachedPartId ?? (a.kind === "part" ? a.partId : undefined);
  const part = partId ? elements[partId] : undefined;
  if (part?.kind !== "part") return null;
  const type = elements[part.typeId];
  if (type?.kind !== "part_type") return null;
  const drains = systemKindsServedBy("grease_interceptor");
  for (const c of resolveConnectors(type.definition, part.values)) {
    if (!drains.includes(c.systemKind)) continue;
    const link = part.links?.[c.id];
    if (link && elements[link.elementId]) return link.elementId;
  }
  return null;
}

const first = (s: ReadonlySet<ElementId>): ElementId | null => [...s].sort()[0] ?? null;

/** Where a drainage load goes relative to a grease interceptor: the drawn pipe when it reaches anything, else the source it names. */
export function greaseRouteOf(elements: Elements, lp: LoadPointElement): GreaseRoute {
  const start = drainStartOf(elements, lp);
  if (start) {
    const s = drainOutletSides(elements, start);
    const gi = first(s.interceptorInlets);
    if (gi) return { kind: "through_interceptor", interceptorId: gi, how: "drawn" };
    if (s.interceptorOutlets.size > 0 || s.sewer.size > 0) return { kind: "bypasses", toId: first(s.sewer), how: "drawn", belowInterceptor: first(s.interceptorOutlets) };
  }
  const named = lp.servedBy ? elements[lp.servedBy] : undefined;
  const role = named?.kind === "part" ? plumbingSourceRole(elements, named) : null;
  if (named && role === "grease_interceptor") return { kind: "through_interceptor", interceptorId: named.id, how: "named" };
  if (named && (role === "sewer_connection" || role === "sewage_pump" || role === "backwater_valve")) return { kind: "bypasses", toId: named.id, how: "named", belowInterceptor: null };
  return { kind: "not_routed" };
}

const interceptorLoadsCache = new WeakMap<object, Map<ElementId, readonly LoadPointElement[]>>();

/**
 * The loads that drain through a grease interceptor, for its sizing sheet:
 * every load whose drawn drain reaches the interceptor's inlet, and every load
 * that names it as source with nothing drawn yet (`greaseRouteOf`). A load
 * named to the interceptor but piped past it is not counted: the sheet sizes
 * what actually drains through the unit, and the lint says the rest bypasses.
 * Sorted by id; walked once per model state.
 */
export function greaseInterceptorLoads(elements: Elements, interceptorId: ElementId): readonly LoadPointElement[] {
  let byGi = interceptorLoadsCache.get(elements);
  if (!byGi) interceptorLoadsCache.set(elements, (byGi = new Map()));
  const known = byGi.get(interceptorId);
  if (known) return known;
  const out: LoadPointElement[] = [];
  for (const lp of elementsOfKind(elements, "load_point")) {
    const route = greaseRouteOf(elements, lp);
    if (route.kind === "through_interceptor" && route.interceptorId === interceptorId) out.push(lp);
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  byGi.set(interceptorId, out);
  return out;
}
