import { paramValue, resolveConnectors, resolveCoefficient, tableSource, type CoefficientQuery, type CoefficientSource, type CoefficientValue, resolveFitting, type ResolvedFitting, len3, segmentAxis, sub3, isSource, isSourceNode, runNeighbours, type RunGraphNode, endHasLoadPoint, loadPointLoads, loadPointLabel, loadPointQuantities, partConnectionTypeLoad, primaryQuantity, QUANTITIES, frictionFactor, partLabelOf, runLabel, PIPE_DESIGN_DEFAULTS, gasProperties, mergePipeDesign, serviceOf, type PipeDesign, isVerticalLeg, nominalInOf, slopeInPerFt, pipeDims, pipeSizeIssue, specOfSize, accumulateBelow, sumMonoid, typicalEdgeFactor, elementsOfKind, pipeComponent as component, pipeNodeId as idOf, pipePositionOn as positionOn, pipeWalkTree as tree, type PipeWalk as Walk } from "@permitzip/bim-kernel";
import type { BimElement, ElementId, ModelState, PartInstance, MepSystem, RunFitting, RunSegment, RunSize } from "@permitzip/bim-kernel";
import { gasInputOf, gasNetwork, gasSourceNode, regulatorSettings, type GasNetwork } from "./gas-zones";

/**
 * Hydraulics for pipe systems, from published equations. No plumbing or
 * gas code sizing table is bundled; a firm or project enters its own tables
 * (demand, fixture values, drain capacities) and every built-in value is
 * labelled "verify for permit work".
 *
 * - Domestic water: friction by Hazen-Williams (C by material) or
 *   Darcy-Weisbach (Colebrook); fitting losses as K x velocity head or as an
 *   equivalent length; fixture units to demand by the firm's table or a
 *   Hunter-curve-style power fit; static head; pressure at every fixture and
 *   the critical one; velocity limits.
 * - Drainage: fixture units carried by every pipe, design flow, capacity at
 *   its slope by Manning's equation for a circular pipe flowing partly full,
 *   stacks by the Wyly-Eaton annular-flow equation; the firm's DFU capacity
 *   table when it has one.
 * - Fuel gas: pressure drop by the Spitzglass (low pressure) or Mueller
 *   equation with gas specific gravity; demand from appliance input; the
 *   longest run's developed length (fittings by equivalent length).
 */

export const VERIFY = "verify for permit work";
const IN = 25.4;
const MM_PER_FT = 304.8;
const GPM_PER_M3S = 15_850.323;
const PA_PER_PSI = 6894.757;
const G = 9.80665;

type Elements = Readonly<Record<string, BimElement>>;

// ------------------------------------------------------------------ equations (exported for hand checks)

/** Hazen-Williams friction, psi per 100 ft: 4.52 Q^1.852 / (C^1.852 d^4.8704) x 100 (Q gpm, d inside diameter in inches). */
export function hazenWilliamsPsiPer100Ft(gpm: number, c: number, idIn: number): number {
  if (gpm <= 0 || idIn <= 0) return 0;
  return (4.52 * gpm ** 1.852) / (c ** 1.852 * idIn ** 4.8704) * 100;
}

/** Water density, kg/m³ (Thiesen form), at °F. */
export function waterDensity(tempF: number): number {
  const t = ((tempF - 32) * 5) / 9;
  return 1000 * (1 - ((t + 288.9414) / (508_929.2 * (t + 68.12963))) * (t - 3.9863) ** 2);
}

/** Water dynamic viscosity, Pa·s (Vogel form), at °F. */
export function waterViscosity(tempF: number): number {
  const k = ((tempF - 32) * 5) / 9 + 273.15;
  return 2.414e-5 * 10 ** (247.8 / (k - 140));
}

/** Darcy-Weisbach friction for water, psi per 100 ft. */
export function darcyWaterPsiPer100Ft(gpm: number, idMm: number, roughnessMm: number, tempF: number): number {
  if (gpm <= 0 || idMm <= 0) return 0;
  const d = idMm / 1000;
  const v = gpm / GPM_PER_M3S / ((Math.PI * d * d) / 4);
  const rho = waterDensity(tempF);
  const re = (rho * v * d) / waterViscosity(tempF);
  const f = frictionFactor(re, roughnessMm / idMm);
  return ((((f / d) * rho * v * v) / 2) * (30.48 / PA_PER_PSI));
}

/** Fully turbulent Darcy friction factor for a relative roughness: 0.25 / log10(ε / 3.7D)². */
export function turbulentFrictionFactor(roughnessMm: number, idMm: number): number {
  const rel = Math.max(1e-7, roughnessMm / Math.max(1e-6, idMm));
  return 0.25 / Math.log10(rel / 3.7) ** 2;
}

/**
 * Peak demand from fixture units: a Hunter-curve-style power fit,
 * Q = 1.47 FU^0.735 gpm. A general approximation of the probability curve's
 * shape for tank-type fixtures, not a code table: verify for permit work.
 */
export function hunterStyleGpm(fu: number): number {
  return fu <= 0 ? 0 : 1.47 * fu ** 0.735;
}

/** Linear through a table of points, held at the ends. */
export function interpolateTable(points: ReadonlyArray<{ readonly x: number; readonly y: number }>, x: number): number | null {
  if (points.length === 0) return null;
  const s = [...points].sort((a, b) => a.x - b.x);
  const first = s[0];
  const last = s[s.length - 1];
  if (!first || !last) return null;
  if (x <= first.x) return first.y;
  if (x >= last.x) return last.y;
  for (let i = 1; i < s.length; i++) {
    const a = s[i - 1];
    const b = s[i];
    if (a && b && x <= b.x) return b.x === a.x ? b.y : a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x);
  }
  return last.y;
}

/** Flow area and hydraulic radius of a circular pipe of diameter `d` flowing at depth ratio y/D. */
export function partFull(d: number, depthRatio: number): { area: number; hydraulicRadius: number } {
  const y = Math.max(1e-6, Math.min(1, depthRatio));
  if (y >= 1) return { area: (Math.PI * d * d) / 4, hydraulicRadius: d / 4 };
  const theta = 2 * Math.acos(1 - 2 * y);
  const area = ((d * d) / 8) * (theta - Math.sin(theta));
  const wetted = (d * theta) / 2;
  return { area, hydraulicRadius: area / wetted };
}

/** Manning's equation (US units): Q = (1.486 / n) A R^(2/3) S^(1/2), Q gpm for an inside diameter in inches, slope as ft per ft. */
export function manningGpm(idIn: number, slope: number, n: number, depthRatio: number): { gpm: number; velocityFps: number } {
  if (idIn <= 0 || slope <= 0) return { gpm: 0, velocityFps: 0 };
  const { area, hydraulicRadius } = partFull(idIn / 12, depthRatio);
  const v = (1.486 / n) * hydraulicRadius ** (2 / 3) * Math.sqrt(slope);
  return { gpm: v * area * 448.831, velocityFps: v };
}

/** Velocity at a flow, by solving Manning for the depth (bisection on y/D up to full). */
export function manningVelocityAt(gpm: number, idIn: number, slope: number, n: number): { velocityFps: number; depthRatio: number } {
  if (gpm <= 0 || slope <= 0) return { velocityFps: 0, depthRatio: 0 };
  const full = manningGpm(idIn, slope, n, 0.94);
  if (gpm >= full.gpm) return { velocityFps: full.velocityFps, depthRatio: 1 };
  let lo = 1e-4;
  let hi = 0.94;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (manningGpm(idIn, slope, n, mid).gpm < gpm) lo = mid;
    else hi = mid;
  }
  const y = (lo + hi) / 2;
  return { velocityFps: manningGpm(idIn, slope, n, y).velocityFps, depthRatio: y };
}

/** Wyly-Eaton annular-flow stack capacity: Q = 27.8 r^(5/3) D^(8/3) gpm, r the fraction of the bore the water sheet fills (7/24 typical). */
export function stackCapacityGpm(idIn: number, fill = 7 / 24): number {
  return 27.8 * fill ** (5 / 3) * idIn ** (8 / 3);
}

/** Spitzglass low-pressure equation solved for drop, in. w.c.: h = S L Q² (1 + 3.6/d + 0.03 d) / (3550² d⁵); Q cfh, L ft, d in. */
export function spitzglassDropInWc(cfh: number, lengthFt: number, idIn: number, specificGravity: number): number {
  if (cfh <= 0 || lengthFt <= 0 || idIn <= 0) return 0;
  return (specificGravity * lengthFt * cfh * cfh * (1 + 3.6 / idIn + 0.03 * idIn)) / (3550 ** 2 * idIn ** 5);
}

/** Mueller low-pressure equation solved for drop, in. w.c.: Q = 2971 d^2.725 (h / L)^0.575 / S^0.425. */
export function muellerDropInWc(cfh: number, lengthFt: number, idIn: number, specificGravity: number): number {
  if (cfh <= 0 || lengthFt <= 0 || idIn <= 0) return 0;
  return lengthFt * ((cfh * specificGravity ** 0.425) / (2971 * idIn ** 2.725)) ** (1 / 0.575);
}

// ------------------------------------------------------------------ reports

export interface PipeWarning {
  readonly elementId: ElementId | null;
  readonly message: string;
}

interface ReportBase {
  readonly systemId: ElementId;
  readonly systemName: string;
  readonly rootId: ElementId | null;
  readonly rootLabel: string;
  readonly memberIds: readonly ElementId[];
  readonly warnings: readonly PipeWarning[];
  /** What the numbers rest on, in words, each "verify for permit work" where it is a built-in value. */
  readonly basis: readonly string[];
}

export interface WaterSegmentResult {
  readonly elementId: ElementId;
  readonly label: string;
  readonly fixtureUnits: number;
  readonly gpm: number;
  readonly idIn: number;
  readonly velocityFps: number;
  readonly frictionPsiPer100Ft: number;
  readonly lengthFt: number;
  readonly frictionPsi: number;
  readonly elevationPsi: number;
  readonly overVelocity: boolean;
}

export interface FittingLossResult {
  readonly elementId: ElementId;
  readonly label: string;
  readonly family: string | null;
  readonly paths: ReadonlyArray<{ readonly role: CoefficientQuery["role"]; readonly k: number; readonly equivalentLengthFt: number; readonly loss: number; readonly source: string; readonly verify: boolean }>;
}

export interface FixtureEnd {
  readonly elementId: ElementId;
  readonly label: string;
  readonly isFixture: boolean;
  /** psi for water, in. w.c. for gas (the report's `unit`). */
  readonly pressure: number;
  readonly elevationFt: number;
}

export interface WaterReport extends ReportBase {
  readonly kind: "water";
  readonly unit: "psi";
  readonly method: { readonly friction: "hazen_williams" | "darcy"; readonly fittings: "k" | "equivalent_length"; readonly demand: string; readonly waterTempF: number };
  readonly supplyPsi: number | null;
  readonly segments: readonly WaterSegmentResult[];
  readonly fittings: readonly FittingLossResult[];
  readonly ends: readonly FixtureEnd[];
  readonly critical: FixtureEnd | null;
  readonly minFixturePsi: number | null;
  /** True / false against the required fixture pressure; null when either is unknown. */
  readonly pass: boolean | null;
  readonly totalFixtureUnits: number;
  readonly peakGpm: number;
}

export interface DrainSegmentResult {
  readonly elementId: ElementId;
  readonly label: string;
  readonly role: "horizontal" | "stack";
  readonly fixtureUnits: number;
  readonly designGpm: number;
  readonly nominalIn: number;
  readonly slopeInPerFt: number | null;
  readonly capacityGpm: number;
  readonly utilisation: number;
  readonly velocityFps: number;
  readonly tableMaxDfu: number | null;
  readonly ok: boolean;
}

export interface DrainageReport extends ReportBase {
  readonly kind: "drainage";
  readonly segments: readonly DrainSegmentResult[];
  readonly totalFixtureUnits: number;
  readonly stacks: ReadonlyArray<{ readonly elementId: ElementId; readonly label: string; readonly fixtureUnits: number }>;
  readonly fillRatio: number;
  readonly pass: boolean;
}

export interface GasSegmentResult {
  readonly elementId: ElementId;
  readonly label: string;
  readonly mbh: number;
  readonly cfh: number;
  readonly idIn: number;
  readonly lengthFt: number;
  readonly dropInWc: number;
  /** Drop over the design length (the longest run) at this flow: what the longest-run method sizes on. */
  readonly designDropInWc: number;
  readonly ok: boolean;
}

export interface GasReport extends ReportBase {
  readonly kind: "gas";
  readonly unit: "in_wc";
  readonly equation: "spitzglass" | "mueller";
  readonly specificGravity: number;
  readonly heatingValueBtuPerCf: number;
  readonly inletInWc: number;
  readonly allowableDropInWc: number;
  readonly sizing: "longest_run" | "actual_length" | "branch_length";
  readonly longestRunFt: number;
  readonly segments: readonly GasSegmentResult[];
  readonly fittings: readonly FittingLossResult[];
  readonly ends: readonly FixtureEnd[];
  readonly critical: FixtureEnd | null;
  readonly totalMbh: number;
  readonly pass: boolean;
  /** Present when regulators split the system: each zone is checked from its regulator's outlet against its own allowable drop. */
  readonly zones?: ReadonlyArray<{ readonly id: string; readonly label: string; readonly inletInWc: number; readonly allowableDropInWc: number; readonly longestFt: number; readonly totalMbh: number; readonly pass: boolean }>;
}

export interface NotCalculatedReport extends ReportBase {
  readonly kind: "not_calculated";
  readonly reason: string;
}

export type PipeSystemReport = WaterReport | DrainageReport | GasReport | NotCalculatedReport;

// ------------------------------------------------------------------ loads

type Service = "water" | "drainage" | "gas";

function fixtureLoad(elements: Elements, part: PartInstance, connectorId: string, service: Service, kind: MepSystem["systemKind"], design: PipeDesign): { value: number; found: boolean } {
  if (isSource(elements, part)) return { value: 0, found: true };
  const type = elements[part.typeId];
  if (type?.kind !== "part_type") return { value: 0, found: false };
  const c = resolveConnectors(type.definition, part.values).find((x) => x.id === connectorId);
  if (c?.flow !== undefined) return { value: c.flow, found: true };
  // The connection type the fixture names (P01, K07): one record with its load points.
  const fromType = partConnectionTypeLoad(elements, part, c?.systemKind ?? kind);
  if (fromType !== null) return { value: fromType, found: true };
  const name = type.definition.familyName.trim().toLowerCase();
  const row = design.fixtureTable?.find((r) => r.fixture.trim().toLowerCase() === name);
  const fromRow = service === "water" ? row?.wsfu : service === "drainage" ? row?.dfu : row?.mbh;
  if (fromRow !== undefined) return { value: fromRow, found: true };
  const keys =
    service === "water"
      ? [kind === "domestic_hot_water" ? "wsfu_hot" : "wsfu_cold", "wsfu", "water_fixture_units"]
      : service === "drainage"
        ? [kind === "storm" ? "drain_gpm" : "dfu", "fixture_units"]
        : ["input_mbh", "gas_input_mbh", "mbh"];
  for (const k of keys) {
    const v = paramValue(type.definition, part.values, k);
    if (typeof v === "number") return { value: v, found: true };
  }
  return { value: 0, found: false };
}

// ------------------------------------------------------------------ engine

/** Elements a report read beyond its members (the hot side behind a water heater), so the cache knows to recompute. */
const extraReads = new WeakMap<PipeSystemReport, readonly ElementId[]>();
/** The group records a report's typical factors read (a subset of its extra reads). */
const groupReadsOf = new WeakMap<PipeSystemReport, readonly string[]>();

export interface PipeHydraulicsOptions {
  /** The firm's design inputs and tables, under each system's own. */
  readonly firm?: PipeDesign;
  /** Firm coefficient tables and licensed databases, after the system's project table. */
  readonly sources?: readonly CoefficientSource[];
}

export class PipeHydraulicsEngine {
  private readonly cache = new Map<string, { readonly system: MepSystem; readonly members: ReadonlyArray<readonly [ElementId, BimElement | undefined]>; readonly report: PipeSystemReport }>();
  private readonly anchors = new Map<string, ElementId>();
  readonly stats = { computed: 0, reused: 0, scans: 0 };

  constructor(private readonly options: PipeHydraulicsOptions = {}) {}

  report(model: ModelState, systemId: string, hint?: string): PipeSystemReport | null {
    const elements = model.elements;
    const system = elements[systemId];
    if (system?.kind !== "mep_system") return null;
    const cached = this.cache.get(systemId);
    const hinted = hint ? elements[hint] : undefined;
    const grew = hinted && (hinted.kind === "run_segment" || hinted.kind === "run_fitting") && hinted.systemId === systemId && cached && !cached.members.some(([id]) => id === hint);
    if (cached && cached.system === system && !grew && cached.members.every(([id, el]) => elements[id] === el)) {
      this.stats.reused += 1;
      return cached.report;
    }
    const anchor = this.anchorFor(elements, systemId, hint);
    const report = computePipeReport(elements, system, anchor, this.options);
    this.stats.computed += 1;
    // Parts the walk read (fixtures) are members too: a fixture's new load changes the report.
    // So do the load points on the far side of a water heater it read, and the group records a typical's count came from
    // (kept even while a built-in group has no record yet, so making it a typical is seen).
    const memberIds = [...report.memberIds, ...(extraReads.get(report) ?? [])];
    const groupReads = new Set<string>(groupReadsOf.get(report) ?? []);
    this.cache.set(systemId, { system, members: memberIds.map((id) => [id, elements[id]] as const).filter(([id, el]) => el !== undefined || groupReads.has(id)), report });
    if (report.memberIds[0]) this.anchors.set(systemId, report.memberIds[0]);
    return report;
  }

  private anchorFor(elements: Elements, systemId: string, hint?: string): ElementId | null {
    const isMember = (id: string | undefined) => {
      const el = id ? elements[id] : undefined;
      return (el?.kind === "run_segment" || el?.kind === "run_fitting") && el.systemId === systemId;
    };
    if (hint && isMember(hint)) return hint as ElementId;
    const known = this.anchors.get(systemId);
    if (known && isMember(known)) return known;
    const system = elements[systemId];
    const entry = system?.kind === "mep_system" ? system.entryId : undefined;
    if (entry && isMember(entry)) return entry;
    this.stats.scans += 1;
    for (const id in elements) {
      const el = elements[id];
      if ((el?.kind === "run_segment" || el?.kind === "run_fitting") && el.systemId === systemId) return el.id;
    }
    return null;
  }
}

export function pipeSystemReport(model: ModelState, systemId: string, options: PipeHydraulicsOptions & { readonly hint?: string } = {}): PipeSystemReport | null {
  return new PipeHydraulicsEngine(options).report(model, systemId, options.hint);
}

/** The same report from the elements alone (live diagrams read it while drawing a view); `anchor` picks which connected piece of the system. */
export function pipeSystemReportOf(elements: Elements, systemId: string, options: PipeHydraulicsOptions = {}, anchor?: ElementId): PipeSystemReport | null {
  const system = elements[systemId];
  if (system?.kind !== "mep_system") return null;
  const start = anchor ?? (system.entryId && elements[system.entryId] ? system.entryId : (elementsOfKind(elements, "run_segment", "run_fitting").find((el) => el.systemId === systemId)?.id ?? null));
  return computePipeReport(elements, system, start, options);
}

function base(system: MepSystem, rootId: ElementId | null, rootLabel: string, memberIds: readonly ElementId[], warnings: PipeWarning[], basis: string[]): ReportBase {
  return { systemId: system.id, systemName: system.name, rootId, rootLabel, memberIds, warnings, basis };
}

const r = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

function labelOf(elements: Elements, n: RunGraphNode): string {
  const el = elements[idOf(n)];
  if (el?.kind === "part") return partLabelOf(elements, el);
  if (el?.kind === "run_segment" || el?.kind === "run_fitting") return runLabel(elements, el);
  return n;
}

function computePipeReport(elements: Elements, system: MepSystem, anchor: ElementId | null, options: PipeHydraulicsOptions): PipeSystemReport {
  const service = serviceOf(system.systemKind);
  const warnings: PipeWarning[] = [];
  const design = mergePipeDesign(options.firm, system.design?.pipe);
  if (system.domain !== "pipe") return { kind: "not_calculated", reason: `${system.name} is ${system.domain}; this report covers pipe systems`, ...base(system, null, "", [], warnings, []) };
  if (service === null || service === "vent") {
    return { kind: "not_calculated", reason: service === "vent" ? `${system.name} is vent piping; it carries no flow; Pipe sizing below sizes it on the fixture units it vents and its developed length` : `${system.name} isn't a water, drainage or gas system`, ...base(system, null, "", [], warnings, []) };
  }
  if (!anchor) return { kind: "not_calculated", reason: `${system.name} has no pipe routed yet`, ...base(system, null, "", [], warnings, []) };
  const lw = pipeLoadWalk(elements, system, anchor, design, warnings);
  const { memberIds, root, walk, load, points } = lw;
  const rootEl = elements[idOf(root)];
  const rootId = (rootEl?.id ?? null) as ElementId | null;
  const rootLabel = labelOf(elements, root);
  for (const id of memberIds) {
    const el = elements[id];
    if (el?.kind === "run_segment" && el.size.shape === "pipe") {
      const issue = pipeSizeIssue(el.size);
      if (issue) warnings.push({ elementId: el.id, message: `${issue}; nominal size used for its bore` });
    }
  }
  const b = (basis: string[]) => base(system, rootId, rootLabel, memberIds, warnings, basis);
  const report = service === "drainage" ? drainage(elements, system, walk, load, design, b) : pressureWalk(elements, system, walk, load, design, service, options, warnings, b);
  if (points.alsoRead.length > 0) extraReads.set(report, points.alsoRead as ElementId[]);
  if (lw.groupIds.length > 0) groupReadsOf.set(report, lw.groupIds);
  return report;
}

/** One pipe system walked for loads: its tree from the source (else the outfall or entry), and what every node carries. */
export interface PipeLoadWalk {
  readonly nodes: readonly RunGraphNode[];
  readonly memberIds: readonly ElementId[];
  readonly root: RunGraphNode;
  readonly walk: Walk;
  /** Each node's own load (load points, fixtures, heater inlets). */
  readonly own: ReadonlyMap<RunGraphNode, number>;
  /** What each node carries: its own plus everything below it. */
  readonly load: ReadonlyMap<RunGraphNode, number>;
  readonly points: ReturnType<typeof loadPointLoads>;
  /** The groups the walk's elements are in: a typical's count (its group record) changes the totals. Also in `points.alsoRead`. */
  readonly groupIds: readonly string[];
}

/**
 * The walk the pipe report, the "Carries…" line and the network engine
 * (load-points/engine.ts) all share, so they never disagree.
 */
export function pipeLoadWalk(elements: Elements, system: MepSystem, anchor: ElementId, design: PipeDesign, warnings: PipeWarning[]): PipeLoadWalk {
  const service = serviceOf(system.systemKind);
  if (service === null || service === "vent") throw new Error(`${system.name} carries no load to walk (${system.systemKind})`);
  const nodes = component(elements, anchor);
  const memberIds = [...new Set(nodes.map(idOf))].filter((id) => elements[id] !== undefined) as ElementId[];
  // Root: the source (meter, heater) for water and gas; the lowest open end or outfall for drainage.
  const sourceNode = service === "gas" ? gasSourceNode(elements, nodes, design) : nodes.find((n) => isSourceNode(elements, n));
  let root: RunGraphNode | undefined = sourceNode;
  if (!root && service === "drainage") root = outfallOf(elements, nodes);
  if (!root) {
    root = system.entryId && nodes.includes(system.entryId) ? system.entryId : nodes.find((n) => !n.includes("#")) ?? anchor;
    warnings.push({ elementId: null, message: service === "drainage" ? `No outfall found; flows are counted towards ${labelOf(elements, root)}` : `No ${service === "gas" ? "meter" : "water source"} is connected to ${system.name}; pressures are counted from ${labelOf(elements, root)}` });
  }
  const walk = tree(elements, nodes, root);
  // Loads below every node: load points first (their attached fixtures don't count twice), then fixtures.
  const points = loadPointLoads(elements, walk, system.systemKind, (n) => runNeighbours(elements, n));
  const own = new Map<RunGraphNode, number>(points.own);
  const quantity = primaryQuantity(system.systemKind);
  for (const id of points.loadPointIds) {
    const lp = elements[id];
    // Warn only when nothing says the value: a connection type that sets 0 means "none here".
    if (lp?.kind === "load_point" && quantity && loadPointQuantities(elements, lp)[quantity] === undefined) warnings.push({ elementId: lp.id, message: `${loadPointLabel(elements, lp)} has no ${quantity ? QUANTITIES[quantity].label.toLowerCase() : "load"}; set it on the point or its connection type` });
  }
  for (const n of walk.order) {
    if (!n.includes("#") || n === root) continue;
    const p = elements[idOf(n)];
    // Attached to a load point (the point counts), or a water heater's inlet (it carries its hot side).
    if (p?.kind !== "part" || points.attachedParts.has(p.id) || points.own.has(n)) continue;
    // A regulator passes gas through; only appliances downstream of it carry load.
    if (service === "gas" && (walk.children.get(n) ?? []).some((k) => k.includes("#") && idOf(k) === p.id)) continue;
    const gasIn = service === "gas" ? gasInputOf(elements, p, n.slice(n.indexOf("#") + 1), design) : null;
    const l = gasIn ? { value: gasIn.mbh, found: gasIn.found } : fixtureLoad(elements, p, n.slice(n.indexOf("#") + 1), service, system.systemKind, design);
    if (!l.found) warnings.push({ elementId: p.id, message: `${partLabelOf(elements, p)} has no ${service === "water" ? "water supply fixture units" : service === "drainage" ? "drainage fixture units" : "gas input"}; add it to the fixture table or the part type` });
    own.set(n, (own.get(n) ?? 0) + l.value);
  }
  // Fixture units are additive; demand (gpm, cfh) is taken from each node's total, never by adding the children's demands.
  // A typical unit's branch counts once per instance where it joins pipe outside the unit (F6).
  const load = accumulateBelow(walk.order, (n) => walk.children.get(n) ?? [], (n) => own.get(n), sumMonoid, (c, p, t) => {
    const k = typicalEdgeFactor(elements, c, p);
    return k === 1 ? t : t * k;
  });
  // The group records the walk's factors read: a typical's copies changing changes every total.
  const groups = new Set<string>();
  for (const n of nodes) {
    const g = elements[idOf(n)]?.groupId;
    if (g) groups.add(g);
  }
  const groupIds = [...groups].sort();
  const withGroups = groups.size === 0 ? points : { ...points, alsoRead: [...points.alsoRead, ...groupIds.filter((g) => !points.alsoRead.includes(g))] };
  return { nodes, memberIds, root, walk, own, load, points: withGroups, groupIds };
}

/** The drainage root: an open end lowest in the building, else the lowest segment end. */
function outfallOf(elements: Elements, nodes: readonly RunGraphNode[]): RunGraphNode | undefined {
  let best: { n: RunGraphNode; z: number; open: boolean } | undefined;
  for (const n of nodes) {
    const el = elements[n];
    if (el?.kind !== "run_segment") continue;
    for (const end of ["start", "end"] as const) {
      // An end with a load point is a fixture, not where the drain leaves.
      const open = !el.links[end] && !endHasLoadPoint(elements, el.id, end);
      const z = el[end].z;
      if (!best || (open && !best.open) || (open === best.open && z < best.z - 0.5)) best = { n, z, open };
    }
  }
  return best?.n;
}

// ------------------------------------------------------------------ drainage

function drainage(elements: Elements, system: MepSystem, walk: Walk, load: ReadonlyMap<RunGraphNode, number>, design: PipeDesign, b: (basis: string[]) => ReportBase): DrainageReport {
  const fill = design.fillRatio ?? PIPE_DESIGN_DEFAULTS.fillRatio;
  const storm = system.systemKind === "storm";
  const flowTable = design.drainFlowTable?.map((p) => ({ x: p.dfu, y: p.gpm })) ?? [];
  const toGpm = (dfu: number) => (storm ? dfu : (flowTable.length > 0 ? interpolateTable(flowTable, dfu) : null) ?? hunterStyleGpm(dfu));
  const basis = [
    storm ? "Storm loads are read as gpm from each drain" : flowTable.length > 0 ? "Design flow from the firm/project DFU-to-gpm table" : `Design flow from drainage fixture units by a Hunter-curve-style fit (Q = 1.47 DFU^0.735 gpm), ${VERIFY}`,
    `Horizontal capacity by Manning's equation, circular pipe flowing ${Math.round(fill * 100)}% full at its slope; n by material, ${VERIFY}`,
    `Stack capacity by the Wyly-Eaton annular-flow equation at 7/24 fill, ${VERIFY}`,
    design.capacityTable && design.capacityTable.length > 0 ? "DFU limits from the firm/project capacity table" : "No DFU capacity table entered: compare fixture units with the adopted code's tables",
  ];
  const segments: DrainSegmentResult[] = [];
  const stacks: Array<{ elementId: ElementId; label: string; fixtureUnits: number }> = [];
  let total = 0;
  for (const n of walk.order) {
    const el = elements[n];
    if (el?.kind !== "run_segment" || el.size.shape !== "pipe") continue;
    const dfu = load.get(n) ?? 0;
    total = Math.max(total, dfu);
    const spec = specOfSize(el.size);
    const idIn = pipeDims(el.size).idMm / IN;
    const nMan = design.manningN ?? spec?.manningN ?? 0.012;
    const vertical = isVerticalLeg(sub3(el.end, el.start));
    const q = toGpm(dfu);
    const nominal = nominalInOf(el.size);
    const label = runLabel(elements, el);
    let capacity = 0;
    let velocity = 0;
    let slope: number | null = null;
    if (vertical) {
      capacity = stackCapacityGpm(idIn);
      stacks.push({ elementId: el.id, label, fixtureUnits: dfu });
    } else {
      slope = slopeInPerFt(el);
      const s = slope / 12;
      capacity = manningGpm(idIn, s, nMan, fill).gpm;
      velocity = manningVelocityAt(q, idIn, s, nMan).velocityFps;
    }
    const table = design.capacityTable ?? [];
    const rows = table.filter((t) => Math.abs(t.nominalIn - nominal) < 1e-3 && (vertical ? t.inPerFt === undefined : t.inPerFt !== undefined && slope !== null && t.inPerFt <= slope + 1e-6));
    const tableMax = rows.length > 0 ? Math.max(...rows.map((t) => t.maxDfu)) : null;
    const utilisation = capacity > 0 ? q / capacity : q > 0 ? Number.POSITIVE_INFINITY : 0;
    const ok = (capacity > 0 || q === 0) && utilisation <= 1 + 1e-9 && (tableMax === null || dfu <= tableMax);
    segments.push({ elementId: el.id, label, role: vertical ? "stack" : "horizontal", fixtureUnits: r(dfu, 2), designGpm: r(q, 2), nominalIn: nominal, slopeInPerFt: slope === null ? null : r(slope, 4), capacityGpm: r(capacity, 2), utilisation: r(utilisation, 3), velocityFps: r(velocity, 2), tableMaxDfu: tableMax, ok });
  }
  const report = b(basis);
  const warnings = report.warnings as PipeWarning[];
  for (const s of segments) {
    if (!s.ok) {
      warnings.push({
        elementId: s.elementId,
        message:
          s.tableMaxDfu !== null && s.fixtureUnits > s.tableMaxDfu
            ? `The ${s.label} carries ${s.fixtureUnits} DFU; the capacity table allows ${s.tableMaxDfu} at this size and slope`
            : s.role === "horizontal" && (s.slopeInPerFt ?? 0) <= 0
              ? `The ${s.label} is level, so it has no gravity capacity`
              : `The ${s.label} needs ${s.designGpm} gpm and carries ${s.capacityGpm} gpm ${s.role === "stack" ? "as a stack" : `at ${Math.round(100 * (design.fillRatio ?? PIPE_DESIGN_DEFAULTS.fillRatio))}% full`}; go up a size${s.role === "horizontal" ? " or steepen it" : ""}`,
      });
    } else if (s.role === "horizontal" && s.designGpm > 0 && s.velocityFps < 2) {
      warnings.push({ elementId: s.elementId, message: `The ${s.label} runs ${s.velocityFps} ft/s at its design flow, under the 2 ft/s usually wanted to scour solids (${VERIFY})` });
    }
  }
  return { kind: "drainage", ...report, segments, totalFixtureUnits: r(total, 2), stacks, fillRatio: fill, pass: segments.every((s) => s.ok) };
}

// ------------------------------------------------------------------ water and gas (a pressure walk from the source)

interface Context {
  readonly design: PipeDesign;
  readonly service: "water" | "gas";
  readonly sources: readonly CoefficientSource[];
  readonly hot: boolean;
  readonly tempF: number;
  readonly rho: number;
  readonly friction: "hazen_williams" | "darcy";
  readonly fittings: "k" | "equivalent_length";
  readonly toFlow: (load: number) => number;
  readonly gasS: number;
  readonly gasHv: number;
  readonly gasEq: "spitzglass" | "mueller";
}

function boreOf(size: RunSize): { idMm: number; roughnessMm: number; c: number } {
  if (size.shape !== "pipe") return { idMm: 0, roughnessMm: 0.05, c: 130 };
  const spec = specOfSize(size);
  return { idMm: pipeDims(size).idMm, roughnessMm: spec?.roughnessMm ?? 0.05, c: spec?.hazenWilliamsC ?? 130 };
}

/** Loss along a length of pipe at a flow: psi (water) or in. w.c. (gas). */
function pipeLoss(ctx: Context, size: RunSize, flow: number, lengthFt: number): { loss: number; ratePer100: number; velocityFps: number } {
  const bore = boreOf(size);
  const idIn = bore.idMm / IN;
  const area = (Math.PI * (bore.idMm / 1000) ** 2) / 4;
  if (ctx.service === "gas") {
    const drop = ctx.gasEq === "mueller" ? muellerDropInWc(flow, Math.max(lengthFt, 0), idIn, ctx.gasS) : spitzglassDropInWc(flow, Math.max(lengthFt, 0), idIn, ctx.gasS);
    const per100 = ctx.gasEq === "mueller" ? muellerDropInWc(flow, 100, idIn, ctx.gasS) : spitzglassDropInWc(flow, 100, idIn, ctx.gasS);
    const v = area > 0 ? (flow * 0.0283168) / 3600 / area / 0.3048 : 0;
    return { loss: drop, ratePer100: per100, velocityFps: v };
  }
  const rate = ctx.friction === "darcy" ? darcyWaterPsiPer100Ft(flow, bore.idMm, bore.roughnessMm, ctx.tempF) : hazenWilliamsPsiPer100Ft(flow, ctx.design.hazenC ?? bore.c, idIn);
  const v = area > 0 ? flow / GPM_PER_M3S / area / 0.3048 : 0;
  return { loss: (rate * lengthFt) / 100, ratePer100: rate, velocityFps: v };
}

/** K x velocity head (water, psi) or the K's equivalent length at the pipe's rate (gas, in. w.c.; water with the equivalent-length method). */
function fittingLoss(ctx: Context, k: number, size: RunSize, flow: number): { loss: number; equivalentLengthFt: number } {
  const bore = boreOf(size);
  const fT = turbulentFrictionFactor(bore.roughnessMm, bore.idMm);
  const leFt = fT > 0 ? ((k / fT) * bore.idMm) / MM_PER_FT : 0;
  if (ctx.service === "gas" || ctx.fittings === "equivalent_length") return { loss: pipeLoss(ctx, size, flow, leFt).loss, equivalentLengthFt: leFt };
  const area = (Math.PI * (bore.idMm / 1000) ** 2) / 4;
  const v = area > 0 ? flow / GPM_PER_M3S / area : 0;
  return { loss: (k * ctx.rho * v * v) / 2 / PA_PER_PSI, equivalentLengthFt: leFt };
}

function coefficient(ctx: Context, system: MepSystem, rf: ResolvedFitting, f: RunFitting, role: CoefficientQuery["role"], size: RunSize, areaRatio = 1, expanding = false): CoefficientValue | null {
  const bore = boreOf(size);
  const q: CoefficientQuery = {
    family: rf.family,
    params: rf.params,
    role,
    angleDeg: f.angleDeg ?? 90,
    rOverW: 1,
    aspectRatio: 1,
    areaRatio,
    expanding,
    includedAngleDeg: 30,
    velocityRatio: 1,
    diverging: true,
    turbulentFrictionFactor: turbulentFrictionFactor(bore.roughnessMm, bore.idMm),
  };
  const sources = [...(system.coefficientTable ? [tableSource(system.coefficientTable)] : []), ...ctx.sources];
  return resolveCoefficient(q, sources, f.coefficientOverride);
}

function pressureWalk(
  elements: Elements,
  system: MepSystem,
  walk: Walk,
  load: ReadonlyMap<RunGraphNode, number>,
  design: PipeDesign,
  service: "water" | "gas",
  options: PipeHydraulicsOptions,
  warnings: PipeWarning[],
  b: (basis: string[]) => ReportBase,
): WaterReport | GasReport {
  const hot = system.systemKind === "domestic_hot_water" || system.systemKind === "domestic_hot_water_return";
  const tempF = design.waterTempF ?? (hot ? PIPE_DESIGN_DEFAULTS.hotWaterTempF : PIPE_DESIGN_DEFAULTS.waterTempF);
  const gpmLoads = design.demandMethod === "flow_is_gpm" || system.systemKind === "domestic_hot_water_return" || system.systemKind === "hydronic_supply" || system.systemKind === "hydronic_return";
  const table = design.demandTable?.map((p) => ({ x: p.fu, y: p.gpm })) ?? [];
  const demandMethod = gpmLoads ? "flow_is_gpm" : design.demandMethod ?? PIPE_DESIGN_DEFAULTS.demandMethod;
  if (demandMethod === "table" && table.length === 0) warnings.push({ elementId: null, message: `${system.name} is set to use the demand table, but it is empty; the Hunter-curve-style fit is used instead (${VERIFY})` });
  const gasProps = gasProperties(design);
  const gasHv = gasProps.heatingValueBtuPerCf;
  const ctx: Context = {
    design,
    service,
    sources: options.sources ?? [],
    hot,
    tempF,
    rho: waterDensity(tempF),
    friction: design.frictionMethod ?? PIPE_DESIGN_DEFAULTS.frictionMethod,
    fittings: design.fittingMethod ?? PIPE_DESIGN_DEFAULTS.fittingMethod,
    toFlow: (l: number) => (service === "gas" ? (l * 1000) / gasHv : demandMethod === "flow_is_gpm" ? l : demandMethod === "table" && table.length > 0 ? (interpolateTable(table, l) ?? 0) : hunterStyleGpm(l)),
    gasS: gasProps.specificGravity,
    gasHv,
    gasEq: design.gasEquation ?? PIPE_DESIGN_DEFAULTS.gasEquation,
  };
  // Pressure (psi for water, in. w.c. for gas) at the outlet of each node; where a hosted child starts.
  const at = new Map<RunGraphNode, number>();
  const childStart = new Map<RunGraphNode, number>();
  const lengthTo = new Map<RunGraphNode, number>();
  const childLength = new Map<RunGraphNode, number>();
  const zAt = new Map<RunGraphNode, number>();
  const childZ = new Map<RunGraphNode, number>();
  const segs: WaterSegmentResult[] = [];
  const gasSegs: Array<Omit<GasSegmentResult, "designDropInWc" | "ok">> = [];
  const fits: FittingLossResult[] = [];
  const ends: FixtureEnd[] = [];
  const mainPaths = new Map<ElementId, { k: number; loss: number; le: number; source: string; verify: boolean }>();
  const supply = service === "gas" ? (design.inletPressureInWc ?? PIPE_DESIGN_DEFAULTS.inletPressureInWc) : design.supplyPressurePsi !== undefined ? design.supplyPressurePsi - (design.fixedLossesPsi ?? 0) : 0;
  // Static head per mm of rise: psi for water; gas is too light to count at these heights.
  const headPerMm = service === "gas" ? 0 : (ctx.rho * G) / 1000 / PA_PER_PSI;
  const rootZ = (() => {
    const el = elements[idOf(walk.root)];
    if (el?.kind === "run_segment") return el.start.z;
    if (el?.kind === "run_fitting") return el.position.z;
    const first = walk.children.get(walk.root)?.[0];
    const seg = first ? elements[first] : undefined;
    if (seg?.kind === "run_segment") {
      const link = idOf(walk.root);
      return seg.links.start?.elementId === link ? seg.start.z : seg.end.z;
    }
    return 0;
  })();

  for (const n of walk.order) {
    const parentNode = walk.parent.get(n) ?? null;
    const start = n === walk.root ? supply : (childStart.get(n) ?? at.get(parentNode ?? "") ?? supply);
    const len0 = n === walk.root ? 0 : (childLength.get(n) ?? lengthTo.get(parentNode ?? "") ?? 0);
    const z0 = n === walk.root ? rootZ : (childZ.get(n) ?? zAt.get(parentNode ?? "") ?? rootZ);
    const el = elements[idOf(n)];
    const kids = walk.children.get(n) ?? [];
    if (!el) continue;
    if (el.kind === "part") {
      const reg = service === "gas" && kids.some((k) => k.includes("#") && idOf(k) === el.id) ? regulatorSettings(elements, el) : null;
      if (reg) {
        at.set(n, Math.min(start, reg.outletInWc));
        lengthTo.set(n, len0);
        zAt.set(n, z0);
        continue;
      }
      at.set(n, start);
      lengthTo.set(n, len0);
      zAt.set(n, z0);
      if (n !== walk.root) ends.push({ elementId: el.id, label: partLabelOf(elements, el), isFixture: true, pressure: start, elevationFt: z0 / MM_PER_FT });
      continue;
    }
    if (el.kind === "run_segment") {
      const seg = el;
      const total = len3(sub3(seg.end, seg.start));
      const axis = segmentAxis(seg);
      const entry = positionOn(elements, seg, parentNode, total);
      const exits = kids.map((k) => ({ k, s: positionOn(elements, seg, k, total), q: load.get(k) ?? 0 }));
      let friction = 0;
      let firstFlow = 0;
      let firstRate = 0;
      let firstV = 0;
      let elevation = 0;
      for (const forward of [true, false]) {
        const side = exits.filter((e) => (entry < total && e.s >= entry) === forward).sort((a, c) => (forward ? a.s - c.s : c.s - a.s));
        let remaining = side.reduce((sum, e) => sum + e.q, 0);
        let pos = entry;
        let p = start;
        let len = len0;
        let z = z0;
        for (const e of side) {
          const lenMm = Math.abs(e.s - pos);
          const flow = ctx.toFlow(remaining);
          const run = pipeLoss(ctx, seg.size, flow, lenMm / MM_PER_FT);
          const dz = (e.s - pos) * axis.z;
          if (firstFlow === 0 && flow > 0) {
            firstFlow = flow;
            firstRate = run.ratePer100;
            firstV = run.velocityFps;
          }
          p -= run.loss + dz * headPerMm;
          friction += run.loss;
          elevation += dz * headPerMm;
          len += lenMm / MM_PER_FT;
          z += dz;
          pos = e.s;
          childStart.set(e.k, p);
          childLength.set(e.k, len);
          childZ.set(e.k, z);
          const hosted = elements[idOf(e.k)];
          if (hosted?.kind !== "run_fitting" || hosted.host?.segmentId !== seg.id) {
            remaining -= e.q;
            continue;
          }
          const rf = resolveFitting(system, hosted);
          if (!rf) {
            remaining -= e.q;
            continue;
          }
          if (hosted.fittingType === "accessory") {
            const reg = service === "gas" ? regulatorSettings(elements, hosted) : null;
            if (reg) {
              // A regulator holds its outlet setting downstream (it cannot raise a pressure that has already fallen below it).
              p = Math.min(p, reg.outletInWc);
              childStart.set(e.k, p);
              remaining -= e.q;
              continue;
            }
            // Inline: everything still beyond pays its loss.
            const v = coefficient(ctx, system, rf, hosted, "body", seg.size);
            if (v) {
              const fl = fittingLoss(ctx, v.c, seg.size, ctx.toFlow(remaining));
              p -= fl.loss;
              len += fl.equivalentLengthFt;
              fits.push({ elementId: hosted.id, label: runLabel(elements, hosted), family: rf.family.name, paths: [{ role: "body", k: r(v.c, 4), equivalentLengthFt: r(fl.equivalentLengthFt, 2), loss: r(fl.loss, 5), source: v.sourceLabel, verify: v.verify }] });
            }
            remaining -= e.q;
            continue;
          }
          const beyond = remaining - e.q;
          remaining = beyond;
          if (beyond <= 0) continue;
          const v = coefficient(ctx, system, rf, hosted, "main", seg.size);
          if (!v) continue;
          const fl = fittingLoss(ctx, v.c, seg.size, ctx.toFlow(beyond));
          mainPaths.set(hosted.id, { k: v.c, loss: fl.loss, le: fl.equivalentLengthFt, source: v.sourceLabel, verify: v.verify });
          p -= fl.loss;
          len += fl.equivalentLengthFt;
        }
      }
      const lengthFt = total / MM_PER_FT;
      const label = runLabel(elements, seg);
      const idIn = boreOf(seg.size).idMm / IN;
      if (service === "gas") {
        gasSegs.push({ elementId: seg.id, label, mbh: r(load.get(n) ?? 0, 2), cfh: r(firstFlow || ctx.toFlow(load.get(n) ?? 0), 2), idIn: r(idIn, 4), lengthFt: r(lengthFt, 2), dropInWc: r(friction, 5) });
      } else {
        const maxV = design.maxVelocityFps ?? (hot ? PIPE_DESIGN_DEFAULTS.hotMaxVelocityFps : PIPE_DESIGN_DEFAULTS.maxVelocityFps);
        const flow = firstFlow || ctx.toFlow(load.get(n) ?? 0);
        const run = pipeLoss(ctx, seg.size, flow, 1);
        const v = firstV || run.velocityFps;
        segs.push({
          elementId: seg.id,
          label,
          fixtureUnits: r(load.get(n) ?? 0, 2),
          gpm: r(flow, 3),
          idIn: r(idIn, 4),
          velocityFps: r(v, 3),
          frictionPsiPer100Ft: r(firstRate || run.ratePer100, 4),
          lengthFt: r(lengthFt, 2),
          frictionPsi: r(friction, 4),
          elevationPsi: r(elevation, 4),
          overVelocity: v > maxV + 1e-9,
        });
        if (v > maxV + 1e-9) warnings.push({ elementId: seg.id, message: `The ${label} runs ${r(v, 2)} ft/s, over the ${maxV} ft/s limit${design.maxVelocityFps === undefined ? ` (typical, ${VERIFY})` : ""}; go up a size` });
      }
      const far = exits.find((e) => e.s === (entry === 0 ? total : 0));
      at.set(n, far ? (childStart.get(far.k) ?? start - friction) : start - friction - elevation);
      lengthTo.set(n, far ? (childLength.get(far.k) ?? len0 + lengthFt) : len0 + lengthFt);
      zAt.set(n, z0 + (entry === 0 ? total : -total) * axis.z);
      if (kids.length === 0) ends.push({ elementId: seg.id, label: `open end of ${label}`, isFixture: false, pressure: at.get(n) ?? start, elevationFt: (zAt.get(n) ?? z0) / MM_PER_FT });
      continue;
    }
    if (el.kind !== "run_fitting") continue;
    const f = el;
    const rf = resolveFitting(system, f);
    let p = start;
    let len = len0;
    if (rf && f.fittingType !== "accessory") {
      const flow = ctx.toFlow(load.get(n) ?? 0);
      const paths: Array<FittingLossResult["paths"][number]> = [];
      if (f.host) {
        const port = f.ports[0];
        const v = port ? coefficient(ctx, system, rf, f, "branch", port.size) : null;
        if (v && port) {
          const fl = fittingLoss(ctx, v.c, port.size, flow);
          paths.push({ role: "branch", k: r(v.c, 4), equivalentLengthFt: r(fl.equivalentLengthFt, 2), loss: r(fl.loss, 5), source: v.sourceLabel, verify: v.verify });
          p -= fl.loss;
          len += fl.equivalentLengthFt;
        }
        const main = mainPaths.get(f.id);
        if (main) paths.push({ role: "main", k: r(main.k, 4), equivalentLengthFt: r(main.le, 2), loss: r(main.loss, 5), source: main.source, verify: main.verify });
      } else {
        const [pa, pb] = f.ports;
        const small = pa && pb && pb.size.shape === "pipe" && pa.size.shape === "pipe" ? (pa.size.nominalMm <= pb.size.nominalMm ? pa.size : pb.size) : pa?.size;
        const large = pa && pb && pb.size.shape === "pipe" && pa.size.shape === "pipe" ? (pa.size.nominalMm <= pb.size.nominalMm ? pb.size : pa.size) : pa?.size;
        if (small && large) {
          const ai = (boreOf(small).idMm / Math.max(1e-6, boreOf(large).idMm)) ** 2;
          const parentId = parentNode ? idOf(parentNode) : "";
          const inlet = pa?.link?.elementId === parentId ? pa : pb;
          const expanding = inlet ? inlet.size === small : false;
          const v = coefficient(ctx, system, rf, f, "body", small, ai, expanding);
          if (v) {
            const fl = fittingLoss(ctx, v.c, small, flow);
            paths.push({ role: "body", k: r(v.c, 4), equivalentLengthFt: r(fl.equivalentLengthFt, 2), loss: r(fl.loss, 5), source: v.sourceLabel, verify: v.verify });
            p -= fl.loss;
            len += fl.equivalentLengthFt;
          }
        }
      }
      fits.push({ elementId: f.id, label: runLabel(elements, f), family: rf.family.name, paths });
    }
    at.set(n, p);
    lengthTo.set(n, len);
    zAt.set(n, z0);
    if (kids.length === 0 && f.fittingType !== "accessory" && f.fittingType !== "cap") ends.push({ elementId: f.id, label: `open end at ${runLabel(elements, f)}`, isFixture: false, pressure: p, elevationFt: z0 / MM_PER_FT });
  }
  const fixtures = ends.filter((e) => e.isFixture);
  const pool = fixtures.length > 0 ? fixtures : ends;
  const critical = [...pool].sort((a, c) => a.pressure - c.pressure)[0] ?? null;
  const rounded = (e: FixtureEnd): FixtureEnd => ({ ...e, pressure: r(e.pressure, 5), elevationFt: r(e.elevationFt, 2) });
  if (service === "gas") {
    const longest = Math.max(0, ...[...lengthTo.entries()].filter(([k]) => (walk.children.get(k) ?? []).length === 0).map(([, v]) => v));
    const sizing = design.gasSizing ?? PIPE_DESIGN_DEFAULTS.gasSizing;
    const allowable = design.allowableDropInWc ?? PIPE_DESIGN_DEFAULTS.allowableDropInWc;
    const inlet = design.inletPressureInWc ?? PIPE_DESIGN_DEFAULTS.inletPressureInWc;
    const network = gasNetwork({ elements }, system.id, { firm: design, ...(gasSegs[0] ? { anchor: gasSegs[0].elementId } : {}) });
    if (network && network.zones.length > 1) return zonedGasReport(elements, network, gasSegs, fits, ends.map(rounded), ctx, design, b, warnings, load.get(walk.root) ?? 0);
    const segments: GasSegmentResult[] = gasSegs.map((s) => {
      const el = elements[s.elementId];
      const size = el?.kind === "run_segment" ? el.size : null;
      const designDrop = size ? pipeLoss(ctx, size, s.cfh, sizing === "longest_run" ? longest : s.lengthFt).loss : 0;
      return { ...s, designDropInWc: r(designDrop, 5), ok: designDrop <= allowable + 1e-9 };
    });
    const worst = critical ? inlet - critical.pressure : 0;
    for (const s of segments) if (!s.ok) warnings.push({ elementId: s.elementId, message: `The ${s.label} carries ${s.cfh} cfh; over the ${r(longest, 1)} ft longest run it would drop ${r(s.designDropInWc, 3)} in. w.c., more than the ${allowable} in. allowed; go up a size` });
    if (worst > allowable + 1e-9 && critical) warnings.push({ elementId: critical.elementId, message: `${critical.label} sees ${r(worst, 3)} in. w.c. of drop from the meter, more than the ${allowable} in. allowed` });
    const totalMbh = load.get(walk.root) ?? 0;
    const basis = [
      `${ctx.gasEq === "mueller" ? "Mueller" : "Spitzglass low-pressure"} equation, gas specific gravity ${ctx.gasS}, ${gasHv} Btu/cf, ${VERIFY}`,
      `Fittings by equivalent length (typical L/D), ${VERIFY}`,
      sizing === "longest_run" ? `Each pipe checked at its own flow over the longest run's developed length (${r(longest, 1)} ft)` : "Each pipe checked over its own path length",
      ...(segments.some((s) => elements[s.elementId]?.kind === "run_segment" && (elements[s.elementId] as RunSegment).size.shape === "pipe" && ((elements[s.elementId] as RunSegment).size as { material: string }).material === "csst")
        ? ["CSST bores are placeholders: use the manufacturer's capacity tables for CSST"]
        : []),
    ];
    return {
      kind: "gas",
      unit: "in_wc",
      ...b(basis),
      equation: ctx.gasEq,
      specificGravity: ctx.gasS,
      heatingValueBtuPerCf: gasHv,
      inletInWc: inlet,
      allowableDropInWc: allowable,
      sizing,
      longestRunFt: r(longest, 2),
      segments,
      fittings: fits,
      ends: ends.map(rounded),
      critical: critical ? rounded(critical) : null,
      totalMbh: r(totalMbh, 2),
      pass: segments.every((s) => s.ok) && worst <= allowable + 1e-9,
    };
  }
  const minPsi = design.minFixturePressurePsi ?? null;
  const supplyKnown = design.supplyPressurePsi !== undefined;
  if (!supplyKnown) warnings.push({ elementId: null, message: `${system.name} has no supply pressure set, so fixture pressures are losses below 0 psi at the source; set the supply pressure to get pressures` });
  if (minPsi === null) warnings.push({ elementId: null, message: "Set the pressure the critical fixture needs to get a pass or fail" });
  const peak = ctx.toFlow(load.get(walk.root) ?? 0);
  const basis = [
    ctx.friction === "darcy" ? `Darcy-Weisbach friction (Colebrook), water at ${tempF} °F, roughness by material, ${VERIFY}` : `Hazen-Williams friction, C by material${design.hazenC ? ` (system C ${design.hazenC})` : ""}, ${VERIFY}`,
    ctx.fittings === "k" ? `Fittings as K x velocity head, K = typical L/D x turbulent friction factor, ${VERIFY}` : `Fittings as equivalent lengths (typical L/D), ${VERIFY}`,
    demandMethod === "flow_is_gpm" ? "Loads read as gpm" : demandMethod === "table" && table.length > 0 ? "Demand from the firm/project fixture-unit table" : `Demand from fixture units by a Hunter-curve-style fit (Q = 1.47 FU^0.735 gpm), ${VERIFY}`,
    "Static head from each fixture's height above the source",
  ];
  return {
    kind: "water",
    unit: "psi",
    ...b(basis),
    method: { friction: ctx.friction, fittings: ctx.fittings, demand: demandMethod, waterTempF: tempF },
    supplyPsi: supplyKnown ? (design.supplyPressurePsi ?? null) : null,
    segments: segs,
    fittings: fits,
    ends: ends.map(rounded),
    critical: critical ? rounded(critical) : null,
    minFixturePsi: minPsi,
    pass: minPsi === null || !supplyKnown || !critical ? null : critical.pressure >= minPsi - 1e-9,
    totalFixtureUnits: r(load.get(walk.root) ?? 0, 2),
    peakGpm: r(peak, 3),
  };
}

/**
 * A gas system with regulators: each pipe is checked at its own flow over its
 * zone's longest length against its zone's allowable drop, and each appliance
 * against the drop from its own zone's start (the 402.4.3 hybrid pressure
 * approach, with the equation; the code tables size it in plumbing.gas_system).
 */
function zonedGasReport(
  elements: Elements,
  network: GasNetwork,
  gasSegs: ReadonlyArray<Omit<GasSegmentResult, "designDropInWc" | "ok">>,
  fits: readonly FittingLossResult[],
  ends: readonly FixtureEnd[],
  ctx: Context,
  design: PipeDesign,
  b: (basis: string[]) => ReportBase,
  warnings: PipeWarning[],
  totalMbh: number,
): GasReport {
  const zoneById = new Map(network.zones.map((z) => [z.id, z]));
  const inZones = new Map<string, string[]>();
  for (const z of network.zones) for (const s of z.segments) if (s.elementId) inZones.set(s.elementId, [...new Set([...(inZones.get(s.elementId) ?? []), z.id])]);
  const zoneFail = new Set<string>();
  const segments: GasSegmentResult[] = gasSegs.map((s) => {
    const el = elements[s.elementId];
    const size = el?.kind === "run_segment" ? el.size : null;
    const zs = (inZones.get(s.elementId) ?? []).map((id) => zoneById.get(id)).filter((z): z is NonNullable<typeof z> => z !== undefined);
    if (!size || zs.length === 0) return { ...s, designDropInWc: 0, ok: true };
    const strict = [...zs].sort((a, c) => a.allowableDropInWc - c.allowableDropInWc)[0] ?? zs[0];
    if (!strict) return { ...s, designDropInWc: 0, ok: true };
    const length = network.method === "longest_length" ? strict.longestFt : s.lengthFt;
    const drop = pipeLoss(ctx, size, s.cfh, length).loss;
    const ok = drop <= strict.allowableDropInWc + 1e-9;
    if (!ok) {
      zoneFail.add(strict.id);
      warnings.push({ elementId: s.elementId, message: `The ${s.label} carries ${s.cfh} cfh; over ${strict.label}'s ${r(strict.longestFt, 1)} ft longest run it would drop ${r(drop, 3)} in. w.c., more than the ${strict.allowableDropInWc} in. allowed there; go up a size` });
    }
    return { ...s, designDropInWc: r(drop, 5), ok };
  });
  for (const a of network.appliances) {
    const z = zoneById.get(a.zoneId);
    const end = ends.find((e) => e.elementId === a.elementId);
    if (!z || !end) continue;
    const drop = z.inletInWc - end.pressure;
    if (drop > z.allowableDropInWc + 1e-9) {
      zoneFail.add(z.id);
      warnings.push({ elementId: a.elementId, message: `${a.label} sees ${r(drop, 3)} in. w.c. of drop from the start of ${z.label}, more than the ${z.allowableDropInWc} in. allowed` });
    }
  }
  for (const issue of network.issues) if (issue.severity === "error") warnings.push({ elementId: issue.elementId, message: issue.message });
  const high = network.zones.filter((z) => z.highPressure);
  const basis = [
    `${ctx.gasEq === "mueller" ? "Mueller" : "Spitzglass low-pressure"} equation, gas specific gravity ${ctx.gasS}, ${ctx.gasHv} Btu/cf, ${VERIFY}`,
    `${network.zones.length} pressure zones split by regulators: each pipe is checked over its zone's longest pipe length (from the regulator) against that zone's allowable drop, each appliance from its zone's start`,
    ...(high.length > 0 ? [`${high.map((z) => z.label).join(", ")} ${high.length === 1 ? "is" : "are"} at 1-1/2 psi or more, where the fuel gas code's high-pressure equation applies; size ${high.length === 1 ? "it" : "them"} with the gas sizing calc (plumbing.gas_system)`] : []),
  ];
  const source = zoneById.get("zone-source");
  const critical = [...ends.filter((e) => e.isFixture)].sort((a, c) => a.pressure - c.pressure)[0] ?? null;
  return {
    kind: "gas",
    unit: "in_wc",
    ...b(basis),
    equation: ctx.gasEq,
    specificGravity: ctx.gasS,
    heatingValueBtuPerCf: ctx.gasHv,
    inletInWc: source?.inletInWc ?? design.inletPressureInWc ?? PIPE_DESIGN_DEFAULTS.inletPressureInWc,
    allowableDropInWc: source?.allowableDropInWc ?? design.allowableDropInWc ?? PIPE_DESIGN_DEFAULTS.allowableDropInWc,
    sizing: design.gasSizing ?? PIPE_DESIGN_DEFAULTS.gasSizing,
    longestRunFt: source?.longestFt ?? 0,
    segments,
    fittings: fits,
    ends,
    critical,
    totalMbh: r(totalMbh, 2),
    pass: zoneFail.size === 0 && !network.issues.some((i) => i.severity === "error"),
    zones: network.zones.map((z) => ({ id: z.id, label: z.label, inletInWc: z.inletInWc, allowableDropInWc: z.allowableDropInWc, longestFt: z.longestFt, totalMbh: z.totalMbh, pass: !zoneFail.has(z.id) })),
  };
}

/** The pipe walk helpers, for the gas zones (same tree as the reports). */
export { component as pipeComponent, tree as pipeWalkTree, idOf as pipeNodeId, positionOn as pipePositionOn };
export type { Walk as PipeWalk };

/** One element's numbers with its system's report: what a properties panel shows. */
export function elementHydraulics(engine: PipeHydraulicsEngine, model: ModelState, elementId: string): { report: PipeSystemReport; segment: WaterSegmentResult | DrainSegmentResult | GasSegmentResult | null; fitting: FittingLossResult | null } | null {
  const el = model.elements[elementId];
  if ((el?.kind !== "run_segment" && el?.kind !== "run_fitting") || el.domain !== "pipe") return null;
  const report = engine.report(model, el.systemId, el.id);
  if (!report) return null;
  if (report.kind === "not_calculated") return { report, segment: null, fitting: null };
  const segment = (report.segments as ReadonlyArray<WaterSegmentResult | DrainSegmentResult | GasSegmentResult>).find((s) => s.elementId === el.id) ?? null;
  const fitting = report.kind === "drainage" ? null : (report.fittings.find((f) => f.elementId === el.id) ?? null);
  return { report, segment, fitting };
}

