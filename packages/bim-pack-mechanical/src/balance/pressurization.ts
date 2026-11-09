import { qty, to, type Quantity } from "@permitzip/bim-units";
import {
  AIR_ZONE_PARAMS,
  EXHAUST_CFM_PARAMS,
  MAKEUP_AIR_CFM_PARAMS,
  MAKEUP_TEMPERING_PARAMS,
  OUTDOOR_AIR_CFM_PARAMS,
  balanceOf,
  elementsOfKind,
  paramValue,
  registeredPressureTargets,
  registeredVentilationReader,
  resolveConnectors,
  spaceLabel,
  spaceOf,
  spacesOfZone,
  spacesOnLevel,
  zonesOfSpace,
  type BalanceContributor,
  type BimElement,
  type ElementId,
  type ParamValue,
  type PartInstance,
  type PartTypeDefinition,
  type PartTypeElement,
  type PressureState,
  type PressureTargetResolution,
  type PressureTargetSource,
  type QuantityBalance,
  type QuantityBalanceTolerance,
  type ResolvedConnector,
  type Space,
  type Zone,
  type ZonePurpose,
} from "@permitzip/bim-kernel";
import { pushTo } from "../collections";
import { makeupAirHeat, type MakeupAirHeat } from "./makeup-air";

/**
 * Building pressurization (ROADMAP M1 on F9's balance): exhaust (exhaust fans,
 * hoods, toilet exhaust) against makeup air (MUA units, outdoor-air fans) and
 * the outdoor air of rooftop units and air handlers, per zone and for the
 * building, with the design target (kitchen negative to dining, building
 * slightly positive). A thin mechanical module on `balanceOf`.
 *
 * What a part contributes is read from its typed values:
 *   exhaust_cfm                        exhaust (out)
 *   makeup_air_cfm                     makeup air (in)
 *   outdoor_cfm / oa_cfm / outdoor_air_cfm
 *     on a unit with a return connector, or one with no ducts drawn yet: outdoor air (in)
 *     on a unit with an outdoor-air intake and no return (an MUA): makeup air (in)
 *     on anything else (a VAV box's zone share): not a building inflow
 *   an exhaust fan (mechanical equipment whose ducts are all exhaust): its airflow (out)
 *
 * Which zone a part belongs to: the zones it serves (a zone's serving unit), else
 * the zones of the space it sits in, else the zone named in `serves_zone` (or
 * `serves`). A roof fan names its zone. Planned parts count; they exist before
 * they are drawn.
 *
 * Reads are indexed: a part is classified once per part and type object
 * (identity caches survive edits to other parts), types that can never move
 * air are skipped with one lookup, and the report is kept per model state.
 */

type Elements = Readonly<Record<string, BimElement>>;

export type AirRole = "exhaust" | "makeup_air" | "outdoor_air";

export const MAKEUP_TEMPERING_STATES = ["untempered", "partial", "tempered"] as const;
export type MakeupTempering = (typeof MAKEUP_TEMPERING_STATES)[number];

/** Zone purposes the pressurization table lists (the same as the ventilation table). */
export const PRESSURIZATION_ZONE_PURPOSES: ReadonlySet<ZonePurpose> = new Set(["ventilation", "thermal"]);

/** Firm default band: a net within 25 cfm counts as neutral. */
export const PRESSURIZATION_DEFAULT_TOLERANCE_CFM = 25;

export const AIR_ROLE_WORDS: Readonly<Record<AirRole, string>> = { exhaust: "Exhaust", makeup_air: "Makeup air", outdoor_air: "Outdoor air" };

export const BUILDING_PRESSURE_TARGET: PressureTargetResolution = {
  target: "positive",
  why: "Buildings are kept slightly positive so unconditioned outdoor air doesn't leak in at doors (firm practice, PermitZIP design criteria).",
};

export interface PressurizationContributor extends BalanceContributor<"flow_air"> {
  readonly partId: ElementId;
  readonly role: AirRole;
  /** Which parameter (or "exhaust fan airflow") the number came from. */
  readonly via: string;
  readonly zoneIds: readonly ElementId[];
  readonly zoneBasis: "serves" | "located" | "named" | null;
  readonly planned: boolean;
}

export interface PressurizationSubtotals {
  readonly exhaust: Quantity<"flow_air">;
  readonly makeupAir: Quantity<"flow_air">;
  readonly outdoorAir: Quantity<"flow_air">;
}

export interface PressurizationSet {
  readonly id: string;
  readonly name: string;
  readonly balance: QuantityBalance<"flow_air">;
  /** Null when the balance is incomplete (never a partial total). */
  readonly subtotals: PressurizationSubtotals | null;
  readonly state: PressureState | null;
  readonly target: PressureTargetResolution | null;
  readonly meetsTarget: boolean | null;
  /** "net −220 cfm: negative (target negative, met)" or what is missing. */
  readonly text: string;
}

export interface ZonePressurization extends PressurizationSet {
  readonly zoneId: ElementId;
  readonly purpose: ZonePurpose;
  readonly servedBy: { readonly id: ElementId; readonly mark: string } | null;
  /** Exhaust the ventilation pack requires for the zone's spaces (area exhaust), when it is loaded and says so. */
  readonly requiredExhaust: Quantity<"flow_air"> | null;
  /** True when the exhaust drawn is less than required; null when either is unknown. */
  readonly exhaustShort: boolean | null;
}

export interface MakeupHeatLine {
  readonly partId: ElementId;
  readonly mark: string;
  readonly tempering: MakeupTempering | null;
  /** The units serving the zones this makeup air enters (where its load lands). */
  readonly servingUnits: readonly { readonly id: ElementId; readonly mark: string }[];
  readonly heat: MakeupAirHeat | null;
  /** Why there is no number, or null. */
  readonly missing: string | null;
}

export interface PressurizationReport {
  readonly contributors: readonly PressurizationContributor[];
  readonly zones: readonly ZonePressurization[];
  readonly building: PressurizationSet;
  /** Contributors in no zone: they count for the building only. */
  readonly unassigned: readonly PressurizationContributor[];
  readonly heat: readonly MakeupHeatLine[];
  readonly tolerance: Quantity<"flow_air">;
  /** Set when nothing in the model moves air in or out, in words. */
  readonly empty: string | null;
}

export interface PressurizationOptions {
  readonly tolerance?: QuantityBalanceTolerance<"flow_air">;
  /** Absent: slightly positive. Null: no building target. */
  readonly buildingTarget?: PressureTargetResolution | null;
  /** Absent: the registered source. */
  readonly targets?: PressureTargetSource | null;
}

// ------------------------------------------------------------------ classify parts

interface PartAir {
  readonly role: AirRole;
  readonly cfm: number | null;
  readonly via: string;
  readonly missing: string | null;
  readonly tempering: MakeupTempering | null;
  readonly fromF: number | null;
  readonly toF: number | null;
}

const ALL_AIR_PARAMS: readonly string[] = [...EXHAUST_CFM_PARAMS, ...MAKEUP_AIR_CFM_PARAMS, ...OUTDOOR_AIR_CFM_PARAMS];

function declares(def: PartTypeDefinition, name: string): boolean {
  return def.instanceParams.some((p) => p.name === name) || def.typeParams.some((p) => p.name === name);
}

function connectorsOf(def: PartTypeDefinition, values: Readonly<Record<string, ParamValue>>): readonly ResolvedConnector[] {
  try {
    return resolveConnectors(def, values);
  } catch (err) {
    console.error("[balance/pressurization] connectors could not be resolved; reading the part's values only", err);
    return [];
  }
}

function isExhaustFanType(def: PartTypeDefinition): boolean {
  if (def.category !== "mechanical_equipment") return false;
  const ducts = def.connectors.filter((c) => c.domain === "duct");
  return ducts.length > 0 && ducts.every((c) => c.systemKind === "exhaust_air");
}

const typeMovesAir = new WeakMap<PartTypeElement, boolean>();

function canMoveAir(type: PartTypeElement): boolean {
  const hit = typeMovesAir.get(type);
  if (hit !== undefined) return hit;
  const def = type.definition;
  const v = ALL_AIR_PARAMS.some((n) => declares(def, n)) || isExhaustFanType(def);
  typeMovesAir.set(type, v);
  return v;
}

function markOf(part: PartInstance, def: PartTypeDefinition | null): string {
  if (part.mark && part.mark.trim() !== "") return part.mark;
  return def ? `${def.familyName} (${part.id})` : part.id;
}

function readNumber(def: PartTypeDefinition, values: Readonly<Record<string, ParamValue>>, name: string): number | null {
  try {
    const v = paramValue(def, values, name);
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  } catch (err) {
    console.error(`[balance/pressurization] ${name} could not be read`, err);
    return null;
  }
}

function readText(def: PartTypeDefinition, values: Readonly<Record<string, ParamValue>>, name: string): string | null {
  try {
    const v = paramValue(def, values, name);
    return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
  } catch (err) {
    console.error(`[balance/pressurization] ${name} could not be read`, err);
    return null;
  }
}

function firstStated(def: PartTypeDefinition, part: PartInstance, names: readonly string[]): { readonly name: string; readonly value: number | null } | null {
  let declared: string | null = null;
  for (const n of names) {
    if (!declares(def, n) && part.values[n] === undefined) continue;
    declared ??= n;
    const v = readNumber(def, part.values, n);
    if (v !== null) return { name: n, value: v };
  }
  return declared === null ? null : { name: declared, value: null };
}

function tempering(def: PartTypeDefinition, part: PartInstance): Pick<PartAir, "tempering" | "fromF" | "toF"> {
  const s = readText(def, part.values, MAKEUP_TEMPERING_PARAMS.state);
  const state = (MAKEUP_TEMPERING_STATES as readonly string[]).includes(s ?? "") ? (s as MakeupTempering) : null;
  return { tempering: state, fromF: readNumber(def, part.values, MAKEUP_TEMPERING_PARAMS.from), toF: readNumber(def, part.values, MAKEUP_TEMPERING_PARAMS.to) };
}

function classify(part: PartInstance, def: PartTypeDefinition): PartAir | null {
  const mark = markOf(part, def);
  const noValue = (what: string, param: string) => `${mark} has no ${what} (${param}). Type it in Properties.`;
  const makeup = firstStated(def, part, MAKEUP_AIR_CFM_PARAMS);
  if (makeup) return { role: "makeup_air", cfm: makeup.value, via: makeup.name, missing: makeup.value === null ? noValue("makeup airflow", makeup.name) : null, ...tempering(def, part) };
  const exhaust = firstStated(def, part, EXHAUST_CFM_PARAMS);
  if (exhaust) return { role: "exhaust", cfm: exhaust.value, via: exhaust.name, missing: exhaust.value === null ? noValue("exhaust airflow", exhaust.name) : null, tempering: null, fromF: null, toF: null };
  const outdoor = firstStated(def, part, OUTDOOR_AIR_CFM_PARAMS);
  if (outdoor) {
    const connectors = connectorsOf(def, part.values);
    const ducts = connectors.filter((c) => c.domain === "duct");
    const hasReturn = connectors.some((c) => c.systemKind === "return_air");
    const intake = connectors.some((c) => c.systemKind === "outside_air" && c.intake !== undefined);
    const role: AirRole | null = hasReturn || ducts.length === 0 ? "outdoor_air" : intake ? "makeup_air" : null;
    if (role === null) return null;
    return { role, cfm: outdoor.value, via: outdoor.name, missing: outdoor.value === null ? noValue("outdoor airflow", outdoor.name) : null, ...(role === "makeup_air" ? tempering(def, part) : { tempering: null, fromF: null, toF: null }) };
  }
  if (isExhaustFanType(def)) {
    const duct = connectorsOf(def, part.values).find((c) => c.domain === "duct" && c.flow !== undefined && Number.isFinite(c.flow));
    const cfm = duct?.flow ?? readNumber(def, part.values, "airflow");
    return { role: "exhaust", cfm, via: "exhaust fan airflow", missing: cfm === null ? noValue("airflow", "airflow") : null, tempering: null, fromF: null, toF: null };
  }
  return null;
}

const classified = new WeakMap<PartInstance, { readonly type: BimElement | undefined; readonly air: PartAir | null }>();
let classifyCount = 0;

/** How many parts have been classified (tests and the perf case prove an edit re-reads one part). */
export function pressurizationClassifyCount(): number {
  return classifyCount;
}

/** What a part moves, or null when it doesn't move air into or out of the building. */
export function partAirOf(elements: Elements, part: PartInstance): PartAir | null {
  const type = elements[part.typeId];
  const hit = classified.get(part);
  if (hit && hit.type === type) return hit.air;
  let air: PartAir | null = null;
  if (type?.kind === "part_type" && (canMoveAir(type) || ALL_AIR_PARAMS.some((n) => part.values[n] !== undefined))) {
    classifyCount += 1;
    air = classify(part, type.definition);
  }
  classified.set(part, { type, air });
  return air;
}

// ------------------------------------------------------------------ zones

interface ZoneMaps {
  readonly zones: readonly Zone[];
  readonly byServer: ReadonlyMap<string, readonly Zone[]>;
  readonly byName: ReadonlyMap<string, readonly Zone[]>;
}

const zoneMapsCache = new WeakMap<Elements, ZoneMaps>();

function zoneMaps(elements: Elements): ZoneMaps {
  const hit = zoneMapsCache.get(elements);
  if (hit) return hit;
  const zones = elementsOfKind(elements, "zone").filter((z) => PRESSURIZATION_ZONE_PURPOSES.has(z.purpose));
  const byServer = new Map<string, Zone[]>();
  const byName = new Map<string, Zone[]>();
  for (const z of zones) {
    if (z.servedBy) pushTo(byServer, z.servedBy, z);
    const key = z.name.trim().toLowerCase();
    pushTo(byName, key, z);
    byName.set(z.id.toLowerCase(), [z]);
  }
  const maps = { zones, byServer, byName };
  zoneMapsCache.set(elements, maps);
  return maps;
}

function zonesOfPart(elements: Elements, part: PartInstance, def: PartTypeDefinition | null, maps: ZoneMaps): { readonly zones: readonly Zone[]; readonly basis: PressurizationContributor["zoneBasis"] } {
  const served = maps.byServer.get(part.id);
  if (served && served.length > 0) return { zones: served, basis: "serves" };
  const space = spaceOf(elements, part.id);
  if (space) {
    const zones = zonesOfSpace(elements, space.id).filter((z) => PRESSURIZATION_ZONE_PURPOSES.has(z.purpose));
    if (zones.length > 0) return { zones, basis: "located" };
  }
  if (def) {
    for (const n of AIR_ZONE_PARAMS) {
      const named = readText(def, part.values, n);
      const zones = named ? maps.byName.get(named.toLowerCase()) : undefined;
      if (zones && zones.length > 0) return { zones, basis: "named" };
    }
  }
  return { zones: [], basis: null };
}

// ------------------------------------------------------------------ report

const WHOLE = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
/** "+2,400" / "−3,000" / "0": a signed cfm as the pressurization table prints it. */
export function signedCfm(cfm: number): string {
  const r = Math.round(cfm);
  return r > 0 ? `+${WHOLE.format(r)}` : r < 0 ? `−${WHOLE.format(-r)}` : "0";
}
const cfmOf = (q: Quantity<"flow_air">): number => to(q, "cfm");

/** A contributor's signed cfm (+ in, − out), or null when it has no value. */
export function signedContributorCfm(c: Pick<PressurizationContributor, "side" | "value">): number | null {
  return c.value === null ? null : c.side === "out" ? -cfmOf(c.value) : cfmOf(c.value);
}

/** A zone's or the building's net cfm (in − out), or null when incomplete. */
export function netCfm(s: Pick<PressurizationSet, "balance">): number | null {
  return s.balance.status === "complete" ? cfmOf(s.balance.net) : null;
}
const collator = new Intl.Collator("en-US", { numeric: true, sensitivity: "base" });

function stateOf(b: QuantityBalance<"flow_air">): PressureState | null {
  if (b.status !== "complete") return null;
  return b.verdict === "more_in" ? "positive" : b.verdict === "more_out" ? "negative" : "neutral";
}

function subtotalsOf(b: QuantityBalance<"flow_air">): PressurizationSubtotals | null {
  if (b.status !== "complete") return null;
  let exhaust = 0;
  let makeupAir = 0;
  let outdoorAir = 0;
  for (const c of b.contributors) {
    const v = c.value ?? 0;
    if (c.role === "exhaust") exhaust += v;
    else if (c.role === "makeup_air") makeupAir += v;
    else outdoorAir += v;
  }
  return { exhaust: exhaust as Quantity<"flow_air">, makeupAir: makeupAir as Quantity<"flow_air">, outdoorAir: outdoorAir as Quantity<"flow_air"> };
}

function setText(b: QuantityBalance<"flow_air">, state: PressureState | null, target: PressureTargetResolution | null, meets: boolean | null): string {
  if (b.status !== "complete") return `No net yet: ${b.missing.map((m) => m.reason).join(" ")}`;
  if (b.contributors.length === 0) return "Nothing moves air in or out here yet.";
  const t = target ? ` (target ${target.target}, ${meets ? "met" : "NOT met"})` : "";
  return `net ${signedCfm(cfmOf(b.net))} cfm: ${state}${t}`;
}

function makeSet(id: string, name: string, contributors: readonly BalanceContributor<"flow_air">[], tolerance: QuantityBalanceTolerance<"flow_air">, target: PressureTargetResolution | null): PressurizationSet {
  const balance = balanceOf("flow_air", contributors, tolerance);
  const state = stateOf(balance);
  const meetsTarget = state === null || target === null || balance.contributors.length === 0 ? null : state === target.target;
  return { id, name, balance, subtotals: subtotalsOf(balance), state, target, meetsTarget, text: setText(balance, state, target, meetsTarget) };
}

function zoneTarget(elements: Elements, zone: Zone, source: PressureTargetSource | null): PressureTargetResolution | null {
  if (!source) return null;
  const found: Array<{ readonly space: Space; readonly r: PressureTargetResolution }> = [];
  for (const s of spacesOfZone(elements, zone.id)) {
    const r = source(s);
    if (r) found.push({ space: s, r });
  }
  for (const want of ["negative", "positive", "neutral"] as const) {
    const hit = found.find((f) => f.r.target === want);
    if (hit) return { target: want, why: `${spaceLabel(hit.space)}: ${hit.r.why}` };
  }
  return null;
}

function requiredExhaustOf(elements: Elements, zoneId: ElementId): Quantity<"flow_air"> | null {
  const reader = registeredVentilationReader();
  const z = reader?.zone(elements, zoneId);
  return z ? z.standards[z.governing.standard].exhaust : null;
}

function unitMark(elements: Elements, id: ElementId): string {
  const el = elements[id];
  return el && "mark" in el && typeof el.mark === "string" && el.mark.trim() !== "" ? el.mark : id;
}

const reportCache = new WeakMap<Elements, { readonly targets: PressureTargetSource | null; readonly report: PressurizationReport }>();

/** The whole building's pressurization, kept per model state for the default options. */
export function pressurizationOf(elements: Elements, opts: PressurizationOptions = {}): PressurizationReport {
  const defaults = opts.tolerance === undefined && opts.buildingTarget === undefined && opts.targets === undefined;
  const targets = opts.targets === undefined ? registeredPressureTargets() : opts.targets;
  if (defaults) {
    const hit = reportCache.get(elements);
    if (hit && hit.targets === targets) return hit.report;
  }
  const report = computeReport(elements, opts, targets);
  if (defaults) reportCache.set(elements, { targets, report });
  return report;
}

function computeReport(elements: Elements, opts: PressurizationOptions, targets: PressureTargetSource | null): PressurizationReport {
  const tolerance: QuantityBalanceTolerance<"flow_air"> = opts.tolerance ?? { absolute: qty("flow_air", PRESSURIZATION_DEFAULT_TOLERANCE_CFM, "cfm") };
  const maps = zoneMaps(elements);
  const contributors: PressurizationContributor[] = [];
  const temperingByPart = new Map<ElementId, PartAir>();
  for (const part of elementsOfKind(elements, "part")) {
    const air = partAirOf(elements, part);
    if (!air) continue;
    const type = elements[part.typeId];
    const def = type?.kind === "part_type" ? type.definition : null;
    const { zones, basis } = zonesOfPart(elements, part, def, maps);
    const mark = markOf(part, def);
    contributors.push({
      id: part.id,
      partId: part.id,
      label: mark,
      side: air.role === "exhaust" ? "out" : "in",
      role: air.role,
      via: air.via,
      value: air.cfm === null ? null : qty("flow_air", air.cfm, "cfm"),
      ...(air.missing ? { missing: air.missing } : {}),
      zoneIds: zones.map((z) => z.id),
      zoneBasis: basis,
      planned: part.planned !== undefined,
    });
    if (air.role === "makeup_air") temperingByPart.set(part.id, air);
  }
  contributors.sort((a, b) => collator.compare(a.label, b.label) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const byZone = new Map<ElementId, BalanceContributor<"flow_air">[]>();
  for (const c of contributors) {
    for (const zid of c.zoneIds) {
      const split = c.zoneBasis === "serves" && c.zoneIds.length > 1;
      const entry: BalanceContributor<"flow_air"> = split
        ? { id: c.id, label: c.label, side: c.side, role: c.role, value: null, missing: `${c.label} serves ${c.zoneIds.length} zones (${c.zoneIds.map((id) => maps.zones.find((z) => z.id === id)?.name ?? id).join(", ")}); its ${AIR_ROLE_WORDS[c.role as AirRole].toLowerCase()} isn't split between zones yet.` }
        : c;
      pushTo(byZone, zid, entry);
    }
  }

  const zones: ZonePressurization[] = [...maps.zones]
    .sort((a, b) => collator.compare(a.name, b.name) || (a.id < b.id ? -1 : 1))
    .map((z) => {
      const set = makeSet(z.id, z.name, byZone.get(z.id) ?? [], tolerance, zoneTarget(elements, z, targets));
      const requiredExhaust = requiredExhaustOf(elements, z.id);
      const exhaustShort = requiredExhaust === null || set.subtotals === null ? null : cfmOf(set.subtotals.exhaust) + 0.5 < cfmOf(requiredExhaust);
      return { ...set, zoneId: z.id, purpose: z.purpose, servedBy: z.servedBy ? { id: z.servedBy, mark: unitMark(elements, z.servedBy) } : null, requiredExhaust, exhaustShort };
    });

  const buildingTarget = opts.buildingTarget === undefined ? BUILDING_PRESSURE_TARGET : opts.buildingTarget;
  const building = makeSet("building", "Building", contributors, tolerance, buildingTarget);

  const heat: MakeupHeatLine[] = [];
  for (const c of contributors) {
    const air = temperingByPart.get(c.partId);
    if (!air) continue;
    const servingUnits = [...new Map(c.zoneIds.flatMap((zid) => maps.zones.filter((z) => z.id === zid && z.servedBy).map((z) => [z.servedBy as ElementId, { id: z.servedBy as ElementId, mark: unitMark(elements, z.servedBy as ElementId) }] as const))).values()];
    if (air.tempering === "tempered") continue;
    let missing: string | null = null;
    let h: MakeupAirHeat | null = null;
    if (air.tempering === null) missing = `Say whether ${c.label}'s air is tempered (${MAKEUP_TEMPERING_PARAMS.state}: untempered, partial or tempered); untempered makeup air adds load to the unit serving the space.`;
    else if (air.cfm === null) missing = air.missing;
    else if (air.fromF === null || air.toF === null) missing = `${c.label} is ${air.tempering === "partial" ? "partially tempered" : "untempered"}: give the temperature its air arrives at (${MAKEUP_TEMPERING_PARAMS.from}) and the temperature it must be brought to (${MAKEUP_TEMPERING_PARAMS.to}), in °F.`;
    else h = makeupAirHeat({ airflow: qty("flow_air", air.cfm, "cfm"), from: qty("temperature", air.fromF, "degF"), to: qty("temperature", air.toF, "degF") });
    heat.push({ partId: c.partId, mark: c.label, tempering: air.tempering, servingUnits, heat: h, missing });
  }

  return {
    contributors,
    zones,
    building,
    unassigned: contributors.filter((c) => c.zoneIds.length === 0),
    heat,
    tolerance: (tolerance.absolute ?? qty("flow_air", 0, "cfm")) as Quantity<"flow_air">,
    empty: contributors.length > 0 ? null : "Nothing in the model moves air in or out yet. Give exhaust fans an exhaust airflow, makeup air units a makeup airflow and rooftop units an outdoor airflow.",
  };
}

/** Makeup-air load a unit must carry: the heat lines whose makeup air enters zones only it serves. */
export function makeupLoadOnUnit(report: PressurizationReport, unitId: ElementId): { readonly load: Quantity<"thermal_power">; readonly lines: readonly MakeupHeatLine[] } | null {
  const lines = report.heat.filter((l) => l.heat !== null && l.servingUnits.length === 1 && l.servingUnits[0]?.id === unitId);
  if (lines.length === 0) return null;
  return { load: lines.reduce((t, l) => t + (l.heat?.load ?? 0), 0) as Quantity<"thermal_power">, lines };
}

export type PressurizationScope = { readonly kind: "model" } | { readonly kind: "level"; readonly levelId: ElementId } | { readonly kind: "zone"; readonly zoneId: ElementId };

/** The zones a scope shows, and whether the building line belongs (model scope only). */
export function pressurizationScopeZones(elements: Elements, report: PressurizationReport, scope: PressurizationScope): { readonly zones: readonly ZonePressurization[]; readonly showBuilding: boolean } {
  if (scope.kind === "model") return { zones: report.zones, showBuilding: true };
  if (scope.kind === "zone") return { zones: report.zones.filter((z) => z.zoneId === scope.zoneId), showBuilding: false };
  const ids = new Set<ElementId>();
  for (const s of spacesOnLevel(elements, scope.levelId)) for (const z of zonesOfSpace(elements, s.id)) ids.add(z.id);
  return { zones: report.zones.filter((z) => ids.has(z.zoneId)), showBuilding: false };
}
