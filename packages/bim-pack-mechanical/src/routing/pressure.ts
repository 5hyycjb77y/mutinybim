import {
  dot3,
  elbowFrame,
  fittingBody,
  frictionFactor,
  isSource,
  len3,
  loadOf,
  loadPointLoad,
  partLabelOf,
  resolveCoefficient,
  resolveFitting,
  runLabel,
  runNeighbours,
  straightPiece,
  sub3,
  tableSource,
  transitionShape,
  unit3,
  widthAxisFor,
  LINER_ROUGHNESS_MM,
  ductAirway,
  linerSurface,
  type BimElement,
  type CoefficientQuery,
  type CoefficientRole,
  type CoefficientSource,
  type CoefficientValue,
  type DuctInsulation,
  type DuctMaterial,
  type ElementId,
  type MepSystem,
  type ModelState,
  type ResolvedFitting,
  type RunGraphNode,
  type RunSegment,
  type RunSize,
  type SystemDesign,
  type SystemKind,
  type VpReference,
} from "@permitzip/bim-kernel";

/**
 * Static pressure for duct systems (the Mechanical add-on; moved out of the
 * kernel in round 13, contents unchanged). The friction factor is the
 * kernel's shared `frictionFactor`.
 *
 * Straight duct: Darcy–Weisbach, Δp = f (L / Dh) ρV²/2, with the friction
 * factor from Colebrook (iterated) or the Altshul-Tsal approximation, the
 * duct material's absolute roughness, and air density / viscosity at the
 * system's design altitude and temperature (ideal gas, standard atmosphere,
 * Sutherland viscosity). L is the straight piece after fittings take their
 * share. A trunk with taps is split at each tap: every stretch carries what
 * is still downstream of it.
 *
 * Fittings: Δp = C x VP, with C from the coefficient sources (override,
 * tables, licensed, formulas) and VP at the section C is referenced to.
 *
 * Totals: pressure accumulates from the fan (the system's source part)
 * outward along every path; the critical path is the path with the largest
 * total, and the required external static pressure is that total.
 *
 * Incremental: `PressureEngine` keeps one report per system and reuses it
 * while every element in the system is the same object it computed from
 * (commits replace only the elements they touch). An edit re-walks only the
 * edited system; elements outside it are never read.
 */

export const PA_PER_IN_WC = 249.0889;
const M3S_PER_CFM = 0.00047194745;
const FPM_PER_MPS = 196.850394;
const PA_PER_M_TO_IN_PER_100FT = 30.48 / PA_PER_IN_WC;

/** Typical absolute roughness of duct materials, mm (published handbook values; verify for the product used). */
export const DUCT_ROUGHNESS_MM: Readonly<Record<DuctMaterial, number>> = {
  galvanized: 0.09,
  aluminum: 0.05,
  stainless: 0.05,
  pvc_coated: 0.03,
  fiberglass_board: 0.9,
  lined: 4.5,
  flexible: 3.0,
};

/** Inside a liner the air runs over the liner's surface, not the duct material. */
export function airwayRoughnessMm(systemRoughnessMm: number, insulation: DuctInsulation | undefined): number {
  const surface = linerSurface(insulation);
  return surface ? LINER_ROUGHNESS_MM[surface] : systemRoughnessMm;
}

export interface AirProperties {
  readonly altitudeM: number;
  readonly temperatureC: number;
  readonly densityKgM3: number;
  readonly viscosityPaS: number;
}

/** Standard atmosphere pressure at altitude, ideal-gas density, Sutherland viscosity. */
export function airProperties(altitudeM = 0, temperatureC = 20): AirProperties {
  const p = 101_325 * (1 - 2.25577e-5 * altitudeM) ** 5.25588;
  const t = temperatureC + 273.15;
  const densityKgM3 = p / (287.05 * t);
  const viscosityPaS = 1.716e-5 * (t / 273.15) ** 1.5 * ((273.15 + 110.4) / (t + 110.4));
  return { altitudeM, temperatureC, densityKgM3, viscosityPaS };
}

/** Flow area (m²) and hydraulic diameter (m) of a duct size. */
export function ductSection(size: RunSize): { areaM2: number; dhM: number } | null {
  const m = (mm: number) => mm / 1000;
  switch (size.shape) {
    case "rect": {
      const a = m(size.width);
      const b = m(size.height);
      return { areaM2: a * b, dhM: (2 * a * b) / (a + b) };
    }
    case "round": {
      const d = m(size.diameter);
      return { areaM2: (Math.PI * d * d) / 4, dhM: d };
    }
    case "oval": {
      const w = m(Math.max(size.width, size.height));
      const h = m(Math.min(size.width, size.height));
      const area = (Math.PI * h * h) / 4 + h * (w - h);
      const perimeter = Math.PI * h + 2 * (w - h);
      return { areaM2: area, dhM: (4 * area) / perimeter };
    }
    default:
      return null;
  }
}

export interface Flowing {
  readonly velocityMps: number;
  readonly velocityFpm: number;
  readonly vpPa: number;
}

function flowing(cfm: number, size: RunSize, air: AirProperties): Flowing {
  const s = ductSection(size);
  if (!s || s.areaM2 <= 0) return { velocityMps: 0, velocityFpm: 0, vpPa: 0 };
  const v = (cfm * M3S_PER_CFM) / s.areaM2;
  return { velocityMps: v, velocityFpm: v * FPM_PER_MPS, vpPa: (air.densityKgM3 * v * v) / 2 };
}

/** Friction loss per metre of straight duct carrying `cfm` (Pa/m). */
export function frictionRate(cfm: number, size: RunSize, air: AirProperties, roughnessMm: number, method: NonNullable<SystemDesign["frictionMethod"]> = "colebrook"): number {
  const s = ductSection(size);
  if (!s || cfm <= 0) return 0;
  const v = (cfm * M3S_PER_CFM) / s.areaM2;
  const re = (air.densityKgM3 * v * s.dhM) / air.viscosityPaS;
  const f = frictionFactor(re, roughnessMm / 1000 / s.dhM, method);
  return ((f / s.dhM) * air.densityKgM3 * v * v) / 2;
}

// ------------------------------------------------------------------ results

export interface SegmentStretch {
  /** Distance along the segment from its start (mm). */
  readonly fromMm: number;
  readonly toMm: number;
  readonly flowCfm: number;
  readonly lossPa: number;
}

export interface SegmentPressure extends Flowing {
  readonly kind: "segment";
  readonly elementId: ElementId;
  /** At the upstream end. */
  readonly flowCfm: number;
  readonly frictionRatePaPerM: number;
  readonly frictionRateInPer100Ft: number;
  /** Straight duct after the fittings at its ends take their share. */
  readonly straightLengthMm: number;
  readonly lossPa: number;
  readonly stretches: readonly SegmentStretch[];
}

export interface FittingPath extends Flowing {
  readonly role: CoefficientRole;
  readonly flowCfm: number;
  readonly c: number;
  readonly reference: VpReference;
  readonly lossPa: number;
  readonly source: { readonly kind: CoefficientValue["sourceKind"]; readonly id: string; readonly label: string };
  readonly method: string;
  readonly verify: boolean;
}

export interface FittingPressure {
  readonly kind: "fitting";
  readonly elementId: ElementId;
  readonly familyId: string | null;
  readonly familyName: string | null;
  /** True when the fitting has no family of its own and the system's default was used. */
  readonly defaultedFamily: boolean;
  readonly paths: readonly FittingPath[];
  /** Body loss, or the branch loss for a takeoff. */
  readonly lossPa: number;
}

export type ElementPressure = SegmentPressure | FittingPressure;

export interface PathStep {
  readonly elementId: ElementId;
  readonly label: string;
  /** What this element adds along this path (Pa). */
  readonly lossPa: number;
  readonly cumulativePa: number;
}

export interface SystemPressureReport {
  readonly systemId: ElementId;
  readonly systemName: string;
  /** False for systems this engine doesn't calculate (pipe, conduit); `reason` says why. */
  readonly calculable: boolean;
  readonly reason?: string;
  readonly air: AirProperties & { readonly material: DuctMaterial; readonly roughnessMm: number; readonly frictionMethod: NonNullable<SystemDesign["frictionMethod"]> };
  /** The fan (the system's unit), or the run element losses are counted from when no unit is connected. */
  readonly rootId: ElementId | null;
  readonly rootLabel: string;
  readonly hasFan: boolean;
  readonly elements: Readonly<Record<string, ElementPressure>>;
  readonly criticalPath: readonly PathStep[];
  readonly totalPa: number;
  /** External static pressure the fan has to supply for the ductwork (the critical path). */
  readonly requiredEspPa: number;
  readonly requiredEspInWc: number;
  /** Every path end: terminals, caps and open ends, with the loss from the fan to it. */
  readonly ends: ReadonlyArray<{ readonly elementId: ElementId; readonly label: string; readonly pathPa: number }>;
  readonly warnings: readonly string[];
  readonly memberIds: readonly ElementId[];
}

// ------------------------------------------------------------------ engine

type Elements = Readonly<Record<string, BimElement>>;

const TOWARD_FAN: ReadonlySet<SystemKind> = new Set(["return_air", "exhaust_air", "outside_air"]);

function areaOf(size: RunSize): number {
  return ductSection(size)?.areaM2 ?? 0;
}

function num(params: Readonly<Record<string, number | string>>, key: string, fallback: number): number {
  const v = params[key];
  return typeof v === "number" ? v : typeof v === "string" && Number.isFinite(Number(v)) ? Number(v) : fallback;
}

interface Walk {
  readonly nodes: readonly RunGraphNode[];
  readonly root: RunGraphNode;
  readonly parent: ReadonlyMap<RunGraphNode, RunGraphNode | null>;
  readonly children: ReadonlyMap<RunGraphNode, readonly RunGraphNode[]>;
  readonly order: readonly RunGraphNode[];
  readonly load: ReadonlyMap<RunGraphNode, number>;
}

function walkSystem(elements: Elements, start: RunGraphNode): Walk {
  const seen = new Set<RunGraphNode>([start]);
  const stack = [start];
  const nodes: RunGraphNode[] = [];
  while (stack.length > 0) {
    const n = stack.pop();
    if (n === undefined) break;
    nodes.push(n);
    for (const m of runNeighbours(elements, n)) {
      if (seen.has(m) || (!m.includes("#") && !elements[m])) continue;
      seen.add(m);
      stack.push(m);
    }
  }
  nodes.sort();
  const sourceNode = nodes.find((n) => {
    const hash = n.indexOf("#");
    if (hash < 0) return false;
    const part = elements[n.slice(0, hash)];
    return part?.kind === "part" && isSource(elements, part);
  });
  const root = sourceNode ?? nodes.find((n) => !n.includes("#")) ?? start;
  const parent = new Map<RunGraphNode, RunGraphNode | null>([[root, null]]);
  const children = new Map<RunGraphNode, RunGraphNode[]>();
  const order: RunGraphNode[] = [];
  const queue = [root];
  for (let i = 0; i < queue.length; i++) {
    const n = queue[i];
    if (n === undefined) break;
    order.push(n);
    const kids: RunGraphNode[] = [];
    for (const m of runNeighbours(elements, n).sort()) {
      if (parent.has(m) || (!m.includes("#") && !elements[m])) continue;
      parent.set(m, n);
      kids.push(m);
      queue.push(m);
    }
    children.set(n, kids);
  }
  const load = new Map<RunGraphNode, number>();
  for (let i = order.length - 1; i >= 0; i--) {
    const n = order[i];
    if (n === undefined) continue;
    let own = 0;
    const hash = n.indexOf("#");
    if (hash >= 0 && n !== root) {
      const part = elements[n.slice(0, hash)];
      if (part?.kind === "part") own = loadOf(elements, part, n.slice(hash + 1));
    }
    // A tap with a load point and no air device yet: its airflow.
    const point = elements[n];
    if (point?.kind === "load_point") own = loadPointLoad(elements, point);
    let sum = own;
    for (const c of children.get(n) ?? []) sum += load.get(c) ?? 0;
    load.set(n, sum);
  }
  return { nodes, root, parent, children, order, load };
}

const elementOfNode = (elements: Elements, n: RunGraphNode): BimElement | undefined => elements[n.includes("#") ? n.slice(0, n.indexOf("#")) : n];

export interface PressureEngineOptions {
  /** Firm tables and licensed databases, after the system's own project table. */
  readonly sources?: readonly CoefficientSource[];
}

export class PressureEngine {
  private readonly anchors = new Map<string, ElementId>();
  private readonly reports = new Map<string, { readonly system: MepSystem; readonly members: ReadonlyArray<readonly [ElementId, BimElement]>; readonly report: SystemPressureReport }>();
  /** Reports reused from cache vs computed, for tests and perf counters. */
  readonly stats = { computed: 0, reused: 0, scans: 0 };

  constructor(private readonly options: PressureEngineOptions = {}) {}

  /** The pressure report of one system. `hint`: any element of the system, so no scan is needed. */
  report(model: ModelState, systemId: string, hint?: string): SystemPressureReport | null {
    const elements = model.elements;
    const system = elements[systemId];
    if (system?.kind !== "mep_system") return null;
    const cached = this.reports.get(systemId);
    if (cached && cached.system === system && cached.members.every(([id, el]) => elements[id] === el) && this.noNewMembers(elements, cached.members, hint, systemId)) {
      this.stats.reused += 1;
      return cached.report;
    }
    const anchor = this.anchorFor(elements, systemId, hint);
    const report = computeReport(elements, system, anchor, this.options.sources ?? []);
    this.stats.computed += 1;
    this.reports.set(systemId, { system, members: report.memberIds.map((id) => [id, elements[id] as BimElement] as const).filter(([, el]) => el !== undefined), report });
    if (report.memberIds[0]) this.anchors.set(systemId, report.memberIds[0]);
    return report;
  }

  /** A hinted element of the system that the cached walk didn't contain means the system grew. */
  private noNewMembers(elements: Elements, members: ReadonlyArray<readonly [ElementId, BimElement]>, hint: string | undefined, systemId: string): boolean {
    if (!hint) return true;
    const el = elements[hint];
    if (!el || (el.kind !== "run_segment" && el.kind !== "run_fitting") || el.systemId !== systemId) return true;
    return members.some(([id]) => id === hint);
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
    // One pass fills every system's anchor (stale ones are dropped first).
    this.stats.scans += 1;
    for (const [sys, id] of this.anchors) {
      const el = elements[id];
      if ((el?.kind !== "run_segment" && el?.kind !== "run_fitting") || el.systemId !== sys) this.anchors.delete(sys);
    }
    for (const id in elements) {
      const el = elements[id];
      if ((el?.kind === "run_segment" || el?.kind === "run_fitting") && !this.anchors.has(el.systemId)) this.anchors.set(el.systemId, el.id);
    }
    const found = this.anchors.get(systemId);
    return found && isMember(found) ? found : null;
  }
}

/** One-off report (no cache). Prefer a long-lived `PressureEngine` where edits repeat. */
export function systemPressure(model: ModelState, systemId: string, options: PressureEngineOptions & { readonly hint?: string } = {}): SystemPressureReport | null {
  return new PressureEngine(options).report(model, systemId, options.hint);
}

function emptyReport(system: MepSystem, air: SystemPressureReport["air"], reason: string, memberIds: readonly ElementId[] = []): SystemPressureReport {
  return {
    systemId: system.id,
    systemName: system.name,
    calculable: false,
    reason,
    air,
    rootId: null,
    rootLabel: "",
    hasFan: false,
    elements: {},
    criticalPath: [],
    totalPa: 0,
    requiredEspPa: 0,
    requiredEspInWc: 0,
    ends: [],
    warnings: [],
    memberIds,
  };
}

function round(v: number, d = 3): number {
  const k = 10 ** d;
  return Math.round(v * k) / k;
}

function computeReport(elements: Elements, system: MepSystem, anchor: ElementId | null, hostSources: readonly CoefficientSource[]): SystemPressureReport {
  const design = system.design ?? {};
  const material = design.material ?? "galvanized";
  const frictionMethod = design.frictionMethod ?? "colebrook";
  const air = { ...airProperties(design.altitudeM ?? 0, design.temperatureC ?? 20), material, roughnessMm: DUCT_ROUGHNESS_MM[material], frictionMethod };
  if (system.domain !== "duct") return emptyReport(system, air, `Pressure drop is calculated for duct systems; ${system.name} is ${system.domain}`);
  if (!anchor) return emptyReport(system, air, `${system.name} has no duct routed yet`);
  const sources = [...(system.coefficientTable ? [tableSource(system.coefficientTable)] : []), ...hostSources];
  const walk = walkSystem(elements, anchor);
  const memberIds = walk.nodes.filter((n) => !n.includes("#")).map((n) => n as ElementId);
  const towardFan = TOWARD_FAN.has(system.systemKind);
  const warnings: string[] = [];
  const rootEl = elementOfNode(elements, walk.root);
  const hasFan = walk.root.includes("#");
  const rootLabel = rootEl?.kind === "part" ? partLabelOf(elements, rootEl) : rootEl?.kind === "run_segment" || rootEl?.kind === "run_fitting" ? runLabel(elements, rootEl) : walk.root;
  if (!hasFan) warnings.push(`No unit is connected to ${system.name}; losses are counted from ${rootLabel}, so the total isn't a fan pressure yet`);

  const out: Record<string, ElementPressure> = {};
  /** Pressure at the outlet of each node, i.e. what each child starts from. */
  const pressureAt = new Map<RunGraphNode, number>();
  /** Pressure a particular child starts from when a node feeds children at different pressures (a trunk feeding taps). */
  const childStart = new Map<RunGraphNode, number>();
  /** What a node adds on the path to a particular child. */
  const addsToward = new Map<string, number>();
  const ends: Array<{ node: RunGraphNode; pathPa: number }> = [];
  const mainPaths = new Map<ElementId, FittingPath>();

  const label = (n: RunGraphNode) => {
    const el = elementOfNode(elements, n);
    if (el?.kind === "part") return partLabelOf(elements, el);
    if (el?.kind === "run_segment" || el?.kind === "run_fitting") return runLabel(elements, el);
    return n;
  };

  const query = (rf: ResolvedFitting, role: CoefficientRole, extra: Partial<CoefficientQuery>): CoefficientQuery => ({
    family: rf.family,
    params: rf.params,
    role,
    angleDeg: 90,
    rOverW: num(rf.params, "r_over_w", 1),
    aspectRatio: 1,
    areaRatio: 1,
    expanding: false,
    includedAngleDeg: 60,
    velocityRatio: 1,
    diverging: !towardFan,
    ...extra,
  });

  const path = (role: CoefficientRole, v: CoefficientValue, cfm: number, at: Flowing, vpPa: number): FittingPath => ({
    role,
    flowCfm: round(cfm),
    ...at,
    c: v.c,
    reference: v.reference,
    lossPa: round(v.c * vpPa, 4),
    source: { kind: v.sourceKind, id: v.sourceId, label: v.sourceLabel },
    method: v.method,
    verify: v.verify,
  });

  for (const n of walk.order) {
    const start = n === walk.root ? 0 : (childStart.get(n) ?? pressureAt.get(walk.parent.get(n) ?? "") ?? 0);
    const kids = walk.children.get(n) ?? [];
    const el = elementOfNode(elements, n);
    const flowHere = walk.load.get(n) ?? 0;
    if (!el) continue;
    if (el.kind === "part") {
      pressureAt.set(n, start);
      if (n !== walk.root) ends.push({ node: n, pathPa: start });
      continue;
    }
    if (el.kind === "run_segment") {
      const seg = el;
      const total = len3(sub3(seg.end, seg.start));
      const piece = straightPiece(elements, seg);
      if (piece.lengthMm < -0.5) warnings.push(`The fittings at the ends of ${runLabel(elements, seg)} overlap by ${Math.round(-piece.lengthMm)} mm; it is too short for them`);
      const parent = walk.parent.get(n) ?? null;
      const positionOf = (other: RunGraphNode | null): number => {
        if (other === null) return 0;
        const id = other.includes("#") ? other.slice(0, other.indexOf("#")) : other;
        if (seg.links.start?.elementId === id) return 0;
        if (seg.links.end?.elementId === id) return total;
        const hosted = elements[id];
        if (hosted?.kind === "run_fitting" && hosted.host?.segmentId === seg.id) return hosted.host.s;
        return 0;
      };
      const entry = positionOf(parent);
      const airway = ductAirway(seg.size, seg.insulation);
      // Flex is its own material, whatever the system's sheet metal is.
      const roughness = airwayRoughnessMm(seg.flex ? DUCT_ROUGHNESS_MM.flexible : air.roughnessMm, seg.insulation);
      const rate = (cfm: number) => frictionRate(cfm, airway, air, roughness, frictionMethod);
      const stretches: SegmentStretch[] = [];
      let friction = 0;
      const lo = piece.cutStart;
      const hi = total - piece.cutEnd;
      const clampLen = (a: number, b: number) => Math.max(0, Math.min(Math.max(a, b), hi) - Math.max(Math.min(a, b), lo));
      // From the entry towards each end: exits in order, each stretch carrying what is still beyond it.
      const exits = kids.map((k) => ({ k, s: positionOf(k), q: walk.load.get(k) ?? 0 }));
      const forwardOf = (s: number) => entry < total && s >= entry;
      for (const forward of [true, false]) {
        const side = exits.filter((e) => forwardOf(e.s) === forward).sort((a, b) => (forward ? a.s - b.s : b.s - a.s));
        let remaining = side.reduce((sum, e) => sum + e.q, 0);
        let at = entry;
        let p = start;
        for (const e of side) {
          const len = clampLen(at, e.s) / 1000;
          const loss = rate(remaining) * len;
          stretches.push({ fromMm: round(Math.min(at, e.s), 1), toMm: round(Math.max(at, e.s), 1), flowCfm: round(remaining), lossPa: round(loss, 4) });
          p += loss;
          friction += loss;
          at = e.s;
          // The child leaves the trunk here, at this pressure.
          childStart.set(e.k, p);
          addsToward.set(`${n}>${e.k}`, p - start);
          const upstream = remaining;
          remaining -= e.q;
          // Air carrying on past a takeoff pays its straight-through loss.
          const hosted = elements[e.k];
          if (remaining <= 0 || hosted?.kind !== "run_fitting" || hosted.host?.segmentId !== seg.id) continue;
          const rf = resolveFitting(system, hosted);
          if (!rf || rf.family.loss !== "branch_takeoff") continue;
          const up = flowing(upstream, airway, air);
          const down = flowing(remaining, airway, air);
          const v = resolveCoefficient(query(rf, "main", { velocityRatio: up.velocityMps > 0 ? down.velocityMps / up.velocityMps : 1 }), sources, hosted.coefficientOverride);
          if (!v) continue;
          const mp = path("main", v, upstream, up, up.vpPa);
          mainPaths.set(hosted.id, mp);
          p += mp.lossPa;
        }
      }
      const upstreamFlow = stretches[0]?.flowCfm ?? flowHere;
      const f0 = flowing(upstreamFlow, airway, air);
      const r0 = rate(upstreamFlow);
      out[seg.id] = {
        kind: "segment",
        elementId: seg.id,
        flowCfm: round(upstreamFlow),
        ...roundFlowing(f0),
        frictionRatePaPerM: round(r0, 4),
        frictionRateInPer100Ft: round(r0 * PA_PER_M_TO_IN_PER_100FT, 4),
        straightLengthMm: round(Math.max(0, piece.lengthMm), 1),
        lossPa: round(friction, 4),
        stretches,
      };
      pressureAt.set(n, start + friction);
      if (kids.length === 0) ends.push({ node: n, pathPa: start + friction });
      continue;
    }
    if (el.kind !== "run_fitting") continue;
    const f = el;
    const rf = resolveFitting(system, f);
    if (!rf) {
      warnings.push(`${runLabel(elements, f)} has no fitting type this engine knows; its loss is left out`);
      pressureAt.set(n, start);
      continue;
    }
    const paths: FittingPath[] = [];
    let loss = 0;
    const flowThrough = flowHere;
    if (f.host) {
      const host = elements[f.host.segmentId];
      const branch = f.ports[0];
      if (host?.kind === "run_segment" && branch) {
        // Fed from its trunk, the takeoff's own load is the branch; fed from the branch, it passes the trunk's load.
        const branchFlow = walk.parent.get(n) === host.id ? flowThrough : (walk.load.get(host.id) ?? flowThrough);
        const main = mainPaths.get(f.id);
        const up = flowing(Math.max(main?.flowCfm ?? branchFlow, branchFlow), ductAirway(host.size, host.insulation), air);
        const b = flowing(branchFlow, ductAirway(branch.size, f.insulation), air);
        const v = resolveCoefficient(query(rf, "branch", { velocityRatio: up.velocityMps > 0 ? b.velocityMps / up.velocityMps : 1 }), sources, f.coefficientOverride);
        if (v) {
          const bp = path("branch", v, branchFlow, b, v.reference === "upstream" ? up.vpPa : b.vpPa);
          paths.push(bp);
          loss = bp.lossPa;
        }
        if (main) paths.push(main);
      }
    } else {
      const [pa, pb] = f.ports;
      const v = (() => {
        if (!pa) return null;
        switch (f.fittingType) {
          case "elbow": {
            const frame = elbowFrame(f, elements);
            if (!frame) return null;
            return { q: query(rf, "body", { angleDeg: frame.turnDeg, aspectRatio: frame.depthDim / frame.planeDim }), size: pa.size };
          }
          case "offset": {
            if (!pb) return null;
            const t = unit3(pb.direction);
            const d = sub3(pb.position, pa.position);
            const across = sub3(d, { x: t.x * dot3(d, t), y: t.y * dot3(d, t), z: t.z * dot3(d, t) });
            const w = widthAxisFor(t, { x: 0, y: 1, z: 0 });
            const dimsWidth = pa.size.shape === "round" ? pa.size.diameter : pa.size.shape === "rect" || pa.size.shape === "oval" ? pa.size.width : 0;
            const dimsHeight = pa.size.shape === "round" ? pa.size.diameter : pa.size.shape === "rect" || pa.size.shape === "oval" ? pa.size.height : 0;
            const sideways = len3(across) > 0 && Math.abs(dot3(unit3(across), w)) > 0.5;
            const plane = sideways ? dimsWidth : dimsHeight;
            const radius = fittingBody(elements, f).radiusMm ?? plane;
            return { q: query(rf, "body", { angleDeg: num(rf.params, "bend_angle_deg", 45), rOverW: plane > 0 ? radius / plane : 1, aspectRatio: plane > 0 ? (sideways ? dimsHeight : dimsWidth) / plane : 1 }), size: pa.size };
          }
          case "transition": {
            if (!pb) return null;
            // Air enters on the side towards the fan for supply, away from it for return.
            const parent = walk.parent.get(n) ?? "";
            const parentId = parent.includes("#") ? parent.slice(0, parent.indexOf("#")) : parent;
            const aIsParentSide = pa.link?.elementId === parentId;
            const [inlet, outlet] = towardFan !== aIsParentSide ? [pa, pb] : [pb, pa];
            const ai = areaOf(ductAirway(inlet.size, f.insulation));
            const ao = areaOf(ductAirway(outlet.size, f.insulation));
            const shape = transitionShape(pa.size, pb.size, rf);
            const small = ai <= ao ? inlet.size : outlet.size;
            return { q: query(rf, "body", { areaRatio: Math.min(ai, ao) / Math.max(ai, ao, 1e-12), expanding: ao > ai, includedAngleDeg: 2 * shape.wallAngleDeg }), size: small };
          }
          case "cap":
            return { q: query(rf, "body", {}), size: pa.size };
          default:
            return null;
        }
      })();
      if (v) {
        const value = resolveCoefficient(v.q, sources, f.coefficientOverride);
        if (value) {
          const at = flowing(flowThrough, ductAirway(v.size, f.insulation), air);
          const bp = path("body", value, flowThrough, at, at.vpPa);
          paths.push(bp);
          loss = bp.lossPa;
        } else if (rf.family.loss === "not_calculated") {
          warnings.push(`${runLabel(elements, f)}: ${rf.family.description}`);
        }
      }
    }
    out[f.id] = { kind: "fitting", elementId: f.id, familyId: rf.family.id, familyName: rf.family.name, defaultedFamily: rf.defaulted, paths, lossPa: round(loss, 4) };
    pressureAt.set(n, start + loss);
    for (const k of kids) addsToward.set(`${n}>${k}`, loss);
    if (kids.length === 0) ends.push({ node: n, pathPa: start + loss });
  }

  // Critical path: the end with the largest loss, walked back to the fan.
  ends.sort((a, b) => b.pathPa - a.pathPa || (a.node < b.node ? -1 : 1));
  const worst = ends[0];
  const steps: PathStep[] = [];
  if (worst) {
    const chain: RunGraphNode[] = [];
    for (let c: RunGraphNode | null = worst.node; c !== null; c = walk.parent.get(c) ?? null) chain.unshift(c);
    let cum = 0;
    for (let i = 0; i < chain.length; i++) {
      const c = chain[i];
      if (c === undefined) continue;
      const next = chain[i + 1];
      const el = elementOfNode(elements, c);
      if (!el || el.kind === "part") continue;
      const add = next !== undefined ? (addsToward.get(`${c}>${next}`) ?? 0) : out[el.id]?.lossPa ?? 0;
      cum += add;
      steps.push({ elementId: el.id, label: label(c), lossPa: round(add, 4), cumulativePa: round(cum, 4) });
    }
  }
  const totalPa = round(worst?.pathPa ?? 0, 3);
  // With nothing drawing air, every loss is zero: a 0 in. w.c. answer would read as "no static needed".
  const noFlow = (walk.load.get(walk.root) ?? 0) <= 0;
  return {
    systemId: system.id,
    systemName: system.name,
    calculable: !noFlow,
    ...(noFlow ? { reason: `No terminals with airflow on ${system.name}, so its pressure isn't meaningful. Connect air terminals (diffusers, grilles) with CFM and read it again.` } : {}),
    air,
    rootId: (rootEl?.id ?? null) as ElementId | null,
    rootLabel,
    hasFan,
    elements: out,
    criticalPath: steps,
    totalPa,
    requiredEspPa: totalPa,
    requiredEspInWc: round(totalPa / PA_PER_IN_WC, 4),
    ends: ends.map((e) => ({ elementId: (elementOfNode(elements, e.node)?.id ?? e.node) as ElementId, label: label(e.node), pathPa: round(e.pathPa, 3) })),
    warnings,
    memberIds,
  };
}

function roundFlowing(f: Flowing): Flowing {
  return { velocityMps: round(f.velocityMps, 4), velocityFpm: round(f.velocityFpm, 1), vpPa: round(f.vpPa, 4) };
}

/** A fitting's or segment's numbers, with its system's summary: what a properties panel shows. */
export function elementPressure(engine: PressureEngine, model: ModelState, elementId: string): { element: ElementPressure | null; system: SystemPressureReport } | null {
  const el = model.elements[elementId];
  if (el?.kind !== "run_segment" && el?.kind !== "run_fitting") return null;
  const report = engine.report(model, el.systemId, el.id);
  if (!report) return null;
  return { element: report.elements[el.id] ?? null, system: report };
}
// ------------------------------------------------------------------ live readout while routing

export interface RunReadout {
  /** False for pipe (no pressure engine yet); `reason` says so. */
  readonly calculable: boolean;
  readonly reason?: string;
  /** Largest flow the pieces carry (0 until the run reaches an air device). */
  readonly flowCfm: number;
  readonly velocityFpm: number;
  readonly frictionInPer100Ft: number;
  /** Straight-duct friction over the pieces' straight lengths, inches of water. */
  readonly straightLossInWc: number;
  readonly lengthMm: number;
}

/**
 * Velocity, friction rate and straight-duct loss for a handful of segments
 * (the ones a route preview just drew), with their system's design air. Cheap
 * enough to run per pointer move: it reads only those segments. Fitting
 * losses and the fan's static pressure come from the full report after saving.
 */
export function runReadout(model: Pick<ModelState, "elements">, segmentIds: readonly string[]): RunReadout | null {
  const segs: RunSegment[] = [];
  for (const id of segmentIds) {
    const el = model.elements[id];
    if (el?.kind === "run_segment") segs.push(el);
  }
  const first = segs[0];
  if (!first) return null;
  const system = model.elements[first.systemId];
  const design = system?.kind === "mep_system" ? (system.design ?? {}) : {};
  if (first.domain !== "duct") return { calculable: false, reason: "Pressure is calculated for duct; pipe sizing readouts aren't available yet", flowCfm: 0, velocityFpm: 0, frictionInPer100Ft: 0, straightLossInWc: 0, lengthMm: 0 };
  const material = design.material ?? "galvanized";
  const air = airProperties(design.altitudeM ?? 0, design.temperatureC ?? 20);
  let flow = 0;
  let velocity = 0;
  let rate = 0;
  let loss = 0;
  let length = 0;
  for (const s of segs) {
    const piece = straightPiece(model.elements, s);
    const l = Math.max(0, piece.lengthMm);
    length += len3(sub3(s.end, s.start));
    const airway = ductAirway(s.size, s.insulation);
    const r = frictionRate(s.flow, airway, air, airwayRoughnessMm(DUCT_ROUGHNESS_MM[s.flex ? "flexible" : material], s.insulation), design.frictionMethod ?? "colebrook");
    loss += (r * l) / 1000;
    if (s.flow >= flow) {
      flow = s.flow;
      velocity = flowing(s.flow, airway, air).velocityFpm;
      rate = r;
    }
  }
  const r4 = (v: number) => Math.round(v * 10_000) / 10_000;
  return {
    calculable: true,
    flowCfm: Math.round(flow),
    velocityFpm: Math.round(velocity),
    frictionInPer100Ft: r4((rate * 30.48) / PA_PER_IN_WC),
    straightLossInWc: r4(loss / PA_PER_IN_WC),
    lengthMm: Math.round(length),
  };
}

export interface DuctPerformance {
  readonly velocityFpm: number;
  readonly frictionInPer100Ft: number;
  /** What the air passes through: the size less any liner. */
  readonly airway: RunSize;
  readonly areaFt2: number;
}

/** Velocity and friction rate for `cfm` through this duct, with the system's design air and material. Null for a size that isn't duct. */
export function ductPerformance(cfm: number, size: RunSize, insulation: DuctInsulation | undefined, design: SystemDesign | undefined): DuctPerformance | null {
  if (size.shape !== "rect" && size.shape !== "round" && size.shape !== "oval") return null;
  const airway = ductAirway(size, insulation);
  const section = ductSection(airway);
  if (!section || section.areaM2 <= 0) return null;
  const air = airProperties(design?.altitudeM ?? 0, design?.temperatureC ?? 20);
  const roughness = airwayRoughnessMm(DUCT_ROUGHNESS_MM[design?.material ?? "galvanized"], insulation);
  const q = Math.max(0, cfm);
  const velocityFpm = ((q * M3S_PER_CFM) / section.areaM2) * FPM_PER_MPS;
  const friction = frictionRate(q, airway, air, roughness, design?.frictionMethod ?? "colebrook") * PA_PER_M_TO_IN_PER_100FT;
  return { velocityFpm, frictionInPer100Ft: friction, airway, areaFt2: section.areaM2 / (0.3048 * 0.3048) };
}
