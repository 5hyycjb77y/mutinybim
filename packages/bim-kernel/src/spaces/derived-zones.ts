import { BUILT_IN_CLEARANCE_PURPOSES, CLEARANCE_PURPOSE_POINT, dedicatedZoneTop, type ClearancePurposeDef, type ClearancePurposeId, type PlacedClearance, type ZoneTop } from "../part-model/clearance";
import { defineExtensionPoint } from "../packs/contract";
import type { FirstPartyPackId } from "../packs/first-party/manifests";
import { activePackSet } from "../packs/scope";
import { firstPartyBaseRevision, firstPartyOwnerOf, packSetReadsRecorded, type PackSet } from "../packs/set";
import { partClearances, partFloorMm } from "../spatial";
import { elementsOfKind } from "../store";
import type { BimElement, ElementId, ModelState, PartInstance, Vec2 } from "../types";
import type { Zone } from "./types";
import { zoneBoundsOf } from "./zone-bounds";

/**
 * Derived zones (KERNEL-FOUNDATION §3.4): constraint regions a rule computes
 * from an element, readable by every pack. The NEC 110.26(E) dedicated space
 * above a panel is one; so are a part's service, working-space and
 * combustible clearances. Nothing here is stored: a zone record keeps only
 * `{ kind: "derived", hostId, rule }`, and the geometry is computed on read.
 *
 * Cost: a host's regions are placed once per host revision (the part, its
 * type, its level and the slab it stands on, by identity) and reused until
 * one of them changes. Never a pass over the model per edit; only
 * `derivedZoneCandidates` reads the parts, for the Spaces panel's list.
 */

/** The rule id a dedicated-space zone record stores ("dedicated", since round 5b) and the default rule of a derived zone. Its row is a first-party pack's. */
export const DEDICATED_SPACE_RULE = "dedicated";

/** The rule for one clearance purpose ("clearance:working_space"). */
export function clearanceRule(purpose: ClearancePurposeId): string {
  return `clearance:${purpose}`;
}

/** What a rule's `derive` is told besides the model and its host. */
export interface DerivedZoneContext {
  /** The rule id being resolved (one function may serve several rules). */
  readonly rule: string;
}

export interface DerivedZoneRuleDef {
  readonly id: string;
  /** What the zone is, in words ("Dedicated equipment space"). */
  readonly label: string;
  /** IfcSpatialZone PredefinedType when exported. */
  readonly ifcPredefinedType: "RESERVATION" | "CONSTRUCTION" | "USERDEFINED";
  /** Clearance rules: which of a placed part's clearances the rule takes. */
  readonly takes?: (zone: PlacedClearance) => boolean;
  /**
   * Rules that compute their own regions from any host (sprinkler coverage
   * from a head, detector spacing, a beam's tributary area, a door's swing
   * clearance). Used instead of `takes`; the host may be any element.
   */
  readonly derive?: (model: ModelState, host: BimElement, ctx: DerivedZoneContext) => DerivedZoneRegion[];
  /**
   * The dependency signature of `derive`: the records and values its result
   * depends on besides the host record itself (its type, its level, the
   * room it sits in…). Regions are reused while the host record and every
   * entry are the same (by identity). Absent: `derive` runs on every read.
   */
  readonly dependsOn?: (model: ModelState, host: BimElement) => readonly unknown[];
}

/** The derived-zone rule of one clearance purpose row: built-in rows ship it; an add-on's purpose gets it from its row, so the add-on adds no rule of its own. */
function purposeRule(purpose: ClearancePurposeDef, builtIn: boolean): DerivedZoneRuleDef {
  const id = purpose.id;
  return { id: clearanceRule(id), label: builtIn ? `${id.replace(/_/g, " ")} clearance` : `${purpose.label.toLowerCase()} clearance`, ifcPredefinedType: purpose.ifcPredefinedType ?? "USERDEFINED", takes: (z: PlacedClearance) => z.purpose === id };
}

const CLEARANCE_RULES: readonly DerivedZoneRuleDef[] = BUILT_IN_CLEARANCE_PURPOSES.map((p) => purposeRule(p, true));

/**
 * Derived-zone rules (v1): constraint regions computed from an element on
 * read. Built-in rows are the shared clearance rules; the dedicated
 * equipment space is a first-party pack's row.
 */
export const DERIVED_ZONE_RULE_POINT = defineExtensionPoint<DerivedZoneRuleDef>({
  id: "kernel.derived_zone_rule",
  version: 1,
  label: "Derived-zone rules",
  idOf: (rule) => rule.id,
  builtins: () => CLEARANCE_RULES,
});

/** The first-party pack a rule belongs to, for listing; null for shared clearance rules and another pack's own. */
export function derivedZoneRuleOwner(rule: Pick<DerivedZoneRuleDef, "id">): FirstPartyPackId | null {
  return firstPartyOwnerOf(DERIVED_ZONE_RULE_POINT, rule.id);
}

const TABLE_KEY = "kernel.derived_zone_rule#table";

/** The rules of the set in force, by id, built once per set. A pack row never replaces a built-in one (`PackSet.items` refuses it). */
let last: { readonly set: PackSet; readonly base: number; readonly table: ReadonlyMap<string, DerivedZoneRuleDef> } | null = null;

function ruleTable(): ReadonlyMap<string, DerivedZoneRuleDef> {
  const set = activePackSet();
  const base = firstPartyBaseRevision();
  if (last !== null && last.set === set && last.base === base && !packSetReadsRecorded()) return last.table;
  const table = set.memo(TABLE_KEY, () => {
    const rules = new Map(set.items(DERIVED_ZONE_RULE_POINT).map((r) => [r.id, r]));
    for (const p of set.items(CLEARANCE_PURPOSE_POINT)) if (!rules.has(clearanceRule(p.id))) rules.set(clearanceRule(p.id), purposeRule(p, false));
    return rules;
  });
  last = { set, base, table };
  return table;
}

export function derivedZoneRule(id: string): DerivedZoneRuleDef | null {
  return ruleTable().get(id) ?? null;
}

/** One region a rule derives from its host, in the model's frame. */
export interface DerivedZoneRegion {
  readonly hostId: ElementId;
  readonly rule: string;
  /** The region's key within its host, stable across edits (a clearance rule: the clearance id). */
  readonly clearanceId: string;
  readonly name: string;
  /** The clause it comes from ("NEC 2023 110.26(E)(1)(a)"), when the zone says. */
  readonly cite: string | null;
  readonly levelId: ElementId;
  /** Plan corners, counter-clockwise, mm. */
  readonly outline: readonly Vec2[];
  readonly centre: Vec2;
  /** Model elevations, mm. `topMm` is the zone's own depth, before the structure or a ceiling cuts it (`derivedZoneTop`). */
  readonly bottomMm: number;
  readonly topMm: number;
  /** The floor or roof the host stands on, mm. */
  readonly floorMm: number;
  /** Clearance rules: the placed clearance it is (lint builds its solid from this). Absent for regions a `derive` rule computed. */
  readonly clearance?: PlacedClearance;
}

/** What is over a region, found by the caller from what it indexes (the lint's surfaces, linked ceilings). */
export interface BuildingAbove {
  readonly structureMm: number | null;
  readonly suspendedCeilingMm: number | null;
}

interface HostEntry {
  readonly type: BimElement | undefined;
  readonly level: BimElement | undefined;
  readonly placed: readonly PlacedClearance[];
  /** The floor or roof it stands on (a slab host's floor follows its level by name, so it is compared, not its record). */
  readonly floorMm: number;
}

const byHost = new WeakMap<PartInstance, HostEntry>();
let placements = 0;

/** How many hosts were placed since the last reset (tests: proves the cache holds). */
export function derivedZonePlacements(): number {
  return placements;
}

function hostEntry(model: ModelState, part: PartInstance): HostEntry {
  const type = model.elements[part.typeId];
  const level = model.elements[part.levelId];
  const floorMm = partFloorMm(model, part);
  const hit = byHost.get(part);
  if (hit && hit.type === type && hit.level === level && hit.floorMm === floorMm) return hit;
  placements += 1;
  const entry: HostEntry = { type, level, placed: partClearances(model, part), floorMm };
  byHost.set(part, entry);
  return entry;
}

function regionOf(part: PartInstance, rule: string, floorMm: number, z: PlacedClearance): DerivedZoneRegion {
  const [c0, , c2] = z.corners;
  return {
    hostId: part.id,
    rule,
    clearanceId: z.id,
    name: z.name,
    cite: z.cite ?? null,
    levelId: part.levelId,
    outline: z.corners,
    centre: { x: (c0.x + c2.x) / 2, y: (c0.y + c2.y) / 2 },
    bottomMm: z.bottomMm,
    topMm: z.topMm,
    floorMm,
    clearance: z,
  };
}

interface DerivedEntry {
  readonly deps: readonly unknown[] | null;
  readonly regions: readonly DerivedZoneRegion[];
}

const byDerivedHost = new WeakMap<BimElement, Map<string, DerivedEntry>>();

function sameDeps(a: readonly unknown[] | null, b: readonly unknown[] | null): boolean {
  if (a === null || b === null || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function derivedRegions(model: ModelState, host: BimElement, def: DerivedZoneRuleDef, derive: NonNullable<DerivedZoneRuleDef["derive"]>): DerivedZoneRegion[] {
  const deps = def.dependsOn ? def.dependsOn(model, host) : null;
  let perRule = byDerivedHost.get(host);
  const hit = perRule?.get(def.id);
  if (hit && sameDeps(hit.deps, deps)) return [...hit.regions];
  placements += 1;
  const regions = derive(model, host, { rule: def.id });
  if (deps !== null) {
    if (!perRule) {
      perRule = new Map();
      byDerivedHost.set(host, perRule);
    }
    perRule.set(def.id, { deps, regions });
  }
  return [...regions];
}

/** A host's regions under one rule, from the per-host cache. Unknown rule, or a clearance rule on a host that isn't a part: none. */
export function derivedZonesOfHost(model: ModelState, host: BimElement, rule: string): DerivedZoneRegion[] {
  const def = ruleTable().get(rule);
  if (!def) return [];
  if (def.derive) return derivedRegions(model, host, def, def.derive);
  const takes = def.takes;
  if (!takes || host.kind !== "part") return [];
  const entry = hostEntry(model, host);
  const out: DerivedZoneRegion[] = [];
  for (const z of entry.placed) if (takes(z)) out.push(regionOf(host, rule, entry.floorMm, z));
  return out;
}

export type DerivedZoneResolution = { readonly ok: true; readonly regions: readonly DerivedZoneRegion[] } | { readonly ok: false; readonly reason: string };

/** Resolve a derived zone's geometry now, or say plainly why it has none. */
export function resolveDerivedZone(model: ModelState, hostId: ElementId, rule: string): DerivedZoneResolution {
  const def = ruleTable().get(rule);
  if (!def) return { ok: false, reason: `Listed, not computed: it comes from a rule ("${rule}") this version doesn't know, so it is kept as it is` };
  const host = model.elements[hostId];
  if (!host) return { ok: false, reason: `The ${def.derive ? "element" : "equipment"} this zone comes from (${hostId}) was deleted` };
  if (def.derive) {
    const regions = derivedZonesOfHost(model, host, rule);
    return regions.length > 0 ? { ok: true, regions } : { ok: false, reason: `${hostId} has no ${def.label.toLowerCase()} now` };
  }
  if (host.kind !== "part") return { ok: false, reason: `${hostId} is a ${host.kind.replace(/_/g, " ")}; code zones come from placed equipment` };
  if (host.planned !== undefined) return { ok: false, reason: `${host.mark || host.id} isn't placed yet, so its zone has no place in the model` };
  const regions = derivedZonesOfHost(model, host, rule);
  if (regions.length === 0) return { ok: false, reason: `${host.mark || host.id} has no ${ruleTable().get(rule)?.label.toLowerCase() ?? "zone"} now (its clearances changed or were switched off)` };
  return { ok: true, regions };
}

/** Where an upward zone ends: its depth, the structure above or a suspended ceiling inside it (NEC 110.26(E), the looser reading by default). */
export function derivedZoneTop(region: DerivedZoneRegion, found: BuildingAbove): ZoneTop {
  if (!region.clearance) return { topMm: region.topMm, endsAt: "depth", structureAssumed: false };
  return dedicatedZoneTop(region.clearance, region.floorMm, found);
}

/** A derived zone record's regions, or why it has none; null for a zone that isn't derived. */
export function derivedRegionsOfZone(model: ModelState, zone: Zone): DerivedZoneResolution | null {
  const b = zoneBoundsOf(zone);
  return b.kind === "derived" ? resolveDerivedZone(model, b.hostId, b.rule) : null;
}

export interface DerivedZoneCandidate {
  readonly hostId: ElementId;
  readonly rule: string;
  readonly hostLabel: string;
  readonly label: string;
  readonly regions: readonly DerivedZoneRegion[];
  /** A zone record already made from it (accepted), if any. */
  readonly zoneId: ElementId | null;
}

/**
 * Code zones the placed equipment derives under `rule` (default: the
 * dedicated space above electrical equipment), optionally on one level, with
 * the zone already accepted from each. Reads the parts once; for the Spaces
 * panel's list, never per edit.
 */
export function derivedZoneCandidates(model: ModelState, opts: { readonly rule?: string; readonly levelId?: ElementId | null } = {}): DerivedZoneCandidate[] {
  const rule = opts.rule ?? DEDICATED_SPACE_RULE;
  const def = ruleTable().get(rule);
  if (!def) return [];
  const accepted = new Map<string, ElementId>();
  for (const z of elementsOfKind(model.elements, "zone")) {
    const b = zoneBoundsOf(z);
    if (b.kind === "derived" && b.rule === rule) accepted.set(b.hostId, z.id);
  }
  const out: DerivedZoneCandidate[] = [];
  for (const part of elementsOfKind(model.elements, "part")) {
    if (opts.levelId && part.levelId !== opts.levelId) continue;
    const type = model.elements[part.typeId];
    if (type?.kind !== "part_type" || (!type.definition.clearances?.length && !part.clearances && !type.definition.positions?.length)) continue;
    const regions = derivedZonesOfHost(model, part, rule);
    if (regions.length === 0) continue;
    out.push({ hostId: part.id, rule, hostLabel: part.mark.trim() || part.id, label: def.label, regions, zoneId: accepted.get(part.id) ?? null });
  }
  return out.sort((a, b) => a.hostLabel.localeCompare(b.hostLabel, "en", { numeric: true }));
}
