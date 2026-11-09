import { connectionTypeOf, elementsOfKind, inPerFtLabel, isVerticalLeg, mergePipeDesign, minSlopeFor, PIPE_DESIGN_DEFAULTS, serviceOf, slopeInPerFt, specOfSize, type ElementId, type MepSystem, type ModelState, type RunSegment, type SystemKind } from "@permitzip/bim-kernel";
import { sizingInputs } from "../../routing/pipe/plumbing-settings";
import { hazenWilliamsPsiPer100Ft, hunterStyleGpm, pipeLoadWalk, pipeNodeId, type PipeLoadWalk, type PipeWarning } from "../../routing/pipe/hydraulics";
import { projectPlumbingSettings } from "../../routing/pipe/plumbing-catalog";
import { z } from "zod";
import { nominalLabel, methodCite, ipcCite, isIpcEdition, type IpcEdition, defineCalc, round, ipcTables } from "@permitzip/bim-calc";
import { readCurve, type DemandCurve } from "../packs/hunter/curves";
import type { ProjectCodeAdoption, CalcIssue, CalcStep, CalcValue, Citation } from "@permitzip/bim-calc";
import { resolveDemandCurve, resolveSizingMode, type PlumbingSettings, type SizingMode } from "./settings";
import { absZ, changeFindings, labelOf, lengthFt, MM_PER_FT, MM_PER_IN, proposalOf, segOf } from "./sizing-common";
import { sizeStormSystem, sizeVentSystem } from "./vent-storm-sizing";

const { BUILDING_DRAIN_MIN_WITH_WC_IN, findFixtureRow, TABLE_604_3, TABLE_604_5, TABLE_704_1, TABLE_710_1_1, TABLE_710_1_1_SLOPES, TABLE_710_1_2 } = ipcTables;

/**
 * A drawn domestic water or sanitary system sized by the plumbing code, pipe
 * by pipe, on the topology the engineer drew:
 *
 * - Water: each pipe's water supply fixture units (cold or hot, as its
 *   system carries them) become gpm on the system's demand curve (ASHRAE
 *   modified A–D by building type, or the firm's IPC Appendix E import).
 *   The pressure left for friction is the supply pressure less the fixed
 *   losses, the static head to the highest fixture (0.433 psi/ft) and the
 *   pressure the critical fixture needs (Table 604.3); over the longest
 *   developed length plus a fitting allowance, that is the allowable loss
 *   per 100 ft. Each pipe is the smallest size of its own product whose
 *   Hazen–Williams loss stays within it and whose velocity stays within the
 *   limit (8 ft/s cold, 5 ft/s hot unless the system says), and no smaller
 *   than Table 604.5 for the fixture it serves.
 * - Sanitary: each pipe's drainage fixture units, by Table 710.1(1) at its
 *   slope for the building drain (the trunk from the outfall and any
 *   horizontal pipe below a stack), Table 710.1(2) for horizontal branches
 *   and stacks; 3 in. at least where a water closet drains through it; and
 *   never smaller than any pipe draining into it (IPC 704.2).
 *
 * The result is a proposal: what each pipe needs against what is drawn, and
 * findings (undersized, larger than needed, nothing fits, no supply pressure).
 * It never edits the model; `set_pipe_sizes` does, behind the person's
 * approval or the system's auto-sizing. It never proposes another layout.
 */

export type PipeSizingFindingCode =
  | "undersized_pipe"
  | "oversized_pipe"
  | "no_size_fits"
  | "no_demand_curve"
  | "no_supply_pressure"
  | "no_pressure_left"
  | "critical_fixture_pressure_assumed"
  | "level_drain"
  | "system_slope_rule"
  | "beyond_curve"
  | "not_sized_here"
  | "no_rainfall_rate"
  | "no_vent_terminal"
  | "storm_slope"
  | "walk";

export interface PipeSizingFinding {
  readonly code: PipeSizingFindingCode;
  readonly severity: "error" | "warning" | "info";
  readonly elementId: string | null;
  readonly message: string;
}

export type PipeSizingRole = "water" | "building_drain" | "horizontal_branch" | "stack" | "vent_stack" | "branch_vent" | "storm_leader" | "storm_drain";

export interface PipeSizeProposal {
  readonly segmentId: string;
  readonly label: string;
  readonly role: PipeSizingRole;
  readonly currentIn: number | null;
  readonly proposedIn: number;
  readonly current: string | null;
  readonly proposed: string;
  readonly change: "up" | "down" | "same";
  /** What the pipe carries, in words: "43.25 WSFU, 48 gpm" or "88 DFU at 1/8 in/ft". */
  readonly carries: string;
  /** Why this size: friction, velocity, minimum size, table, or "a pipe draining into it". */
  readonly governs: string;
  /** Water: at the proposed size. */
  readonly frictionPsiPer100Ft?: number;
  readonly velocityFps?: number;
}

export interface PipeSystemSizing {
  readonly systemId: string;
  readonly systemName: string;
  readonly systemKind: SystemKind;
  readonly service: PipeSizingServiceKind;
  readonly sizingMode: SizingMode;
  readonly sizingModeFrom: "system" | "project" | "default";
  readonly curve: { readonly id: string; readonly label: string } | null;
  /** Water: the system's total at its source, the point to mark on the demand curve. */
  readonly designPoint: { readonly wsfu: number; readonly gpm: number } | null;
  readonly availablePsi: number | null;
  readonly allowablePsiPer100Ft: number | null;
  readonly maxVelocityFps: number | null;
  readonly developedLengthFt: number | null;
  /** Water: WSFU at the source. Sanitary and vent: DFU (at the outfall; vented at the open air). Storm: roof area, sq ft. */
  readonly totalLoad: number;
  /** Storm: the design rainfall rate it was sized at, in/h. */
  readonly rainfallInPerHr?: number;
  readonly proposals: readonly PipeSizeProposal[];
  readonly findings: readonly PipeSizingFinding[];
}

const PSI_PER_FT = 0.433;
/** Fittings and valves as a share of the developed length when the friction is allowed for (PermitZIP design default, verify for permit work). */
export const WATER_FITTING_ALLOWANCE_PCT = 30;
/** Table 604.3's least flow pressure for a fixture: used only when the system says nothing, and said so. */
const LEAST_FIXTURE_PSI = Math.min(...TABLE_604_3.map((r) => r.psi));
const WATER_CLOSET = /water\s*closet|toilet|\bw\.?c\.?\b/i;
/** The most water supply fixture units one fixture carries in the code's fixture tables (a public flushometer water closet). */
const SINGLE_FIXTURE_MAX_WSFU = 10;
/** Table 604.5's usual fixture supply minimum, for a fixture the table can't be read for by name. */
const USUAL_FIXTURE_MIN_IN = 0.5;
const SIZED_WATER: ReadonlySet<SystemKind> = new Set(["domestic_cold_water", "domestic_hot_water"]);
const SIZED_DRAIN: ReadonlySet<SystemKind> = new Set(["sanitary"]);

export type PipeSizingServiceKind = "water" | "drainage" | "vent" | "storm";

/** The project's plumbing code from its Code Study rows, by name (Plumbing, IPC, VPC, UPC), confirmed first. */
export function plumbingAdoptionFrom(rows: ReadonlyArray<{ readonly code_name: string; readonly edition: string; readonly status: string }>): ProjectCodeAdoption | null {
  const found = rows.filter((r) => /plumbing|\bI?PC\b|\bVPC\b|\bUPC\b/i.test(r.code_name) && !/fuel gas|mechanical/i.test(r.code_name) && (r.status === "confirmed" || r.status === "unconfirmed"));
  const best = found.find((r) => r.status === "confirmed") ?? found[0];
  return best ? { codeName: best.code_name, edition: best.edition, status: best.status as "confirmed" | "unconfirmed" } : null;
}

/** Which systems this sizes, and why not the others. */
export function pipeSizingService(kind: SystemKind): PipeSizingServiceKind | { readonly reason: string } {
  if (SIZED_WATER.has(kind)) return "water";
  if (SIZED_DRAIN.has(kind)) return "drainage";
  if (kind === "storm") return "storm";
  const s = serviceOf(kind);
  if (s === "vent") return "vent";
  if (s === "gas") return { reason: "Gas systems are sized zone by zone by plumbing.gas_system." };
  return { reason: "Hot water return, hydronic and condensate piping carry gpm, not fixture units; size them from their flow." };
}

function projectSettingsOf(model: ModelState): PlumbingSettings {
  const inputs = sizingInputs(projectPlumbingSettings(model.elements), null);
  return { sizing_mode: inputs.project.sizing_mode, ...(inputs.project.building_type ? { building_type: inputs.project.building_type } : {}), ...(inputs.project.demand_curve ? { demand_curve: inputs.project.demand_curve } : {}) };
}

/** The sizing mode a system resolves to (its own, else the project's, else check). */
export function systemSizingMode(model: ModelState, system: MepSystem): { readonly mode: SizingMode; readonly from: "system" | "project" | "default" } {
  const inputs = sizingInputs(projectPlumbingSettings(model.elements), system.design?.pipe);
  return resolveSizingMode(inputs.project, inputs.system);
}

function segmentsOf(model: ModelState, system: MepSystem): RunSegment[] {
  return elementsOfKind(model.elements, "run_segment")
    .filter((s) => s.systemId === system.id && s.size.shape === "pipe")
    .sort((a, b) => (a.id === system.entryId ? -1 : b.id === system.entryId ? 1 : a.id.localeCompare(b.id)));
}

/** Every connected piece of the system, walked for loads (the same walk as the pipe report). */
function walks(model: ModelState, system: MepSystem, findings: PipeSizingFinding[]): PipeLoadWalk[] {
  const design = mergePipeDesign(undefined, system.design?.pipe);
  const seen = new Set<string>();
  const out: PipeLoadWalk[] = [];
  for (const seg of segmentsOf(model, system)) {
    if (seen.has(seg.id)) continue;
    const warnings: PipeWarning[] = [];
    const lw = pipeLoadWalk(model.elements, system, seg.id as ElementId, design, warnings);
    for (const id of lw.memberIds) seen.add(id);
    for (const w of warnings) findings.push({ code: "walk", severity: "warning", elementId: w.elementId, message: w.message });
    out.push(lw);
  }
  return out;
}

/** What a fixture node is called: a part's fixture type name, or a load point's connection type ("Water closet"). */
function partNameOf(model: ModelState, n: string): string | null {
  const el = model.elements[n];
  if (el?.kind === "load_point") {
    const attached = el.attachedPartId ? model.elements[el.attachedPartId] : undefined;
    const type = attached?.kind === "part" ? model.elements[attached.typeId] : undefined;
    if (type?.kind === "part_type") return type.definition.familyName;
    return connectionTypeOf(model.elements, el.connectionType)?.description ?? null;
  }
  if (!n.includes("#")) return null;
  const part = model.elements[pipeNodeId(n)];
  if (part?.kind !== "part") return null;
  const type = model.elements[part.typeId];
  return type?.kind === "part_type" ? type.definition.familyName : null;
}

export type SizingOutcome = { ok: true; sizing: PipeSystemSizing; steps: CalcStep[]; cites: Citation[] } | { ok: false; reason: string };

// ------------------------------------------------------------------ water

function sizeWater(model: ModelState, system: MepSystem, ipc: IpcEdition, settings: PlumbingSettings, mode: ReturnType<typeof systemSizingMode>): SizingOutcome {
  const findings: PipeSizingFinding[] = [];
  const steps: CalcStep[] = [];
  const design = mergePipeDesign(undefined, system.design?.pipe);
  const override = system.design?.pipe?.demandCurve ? { demand_curve: system.design.pipe.demandCurve } : null;
  const resolved = resolveDemandCurve(settings, override);
  const curve: DemandCurve | null = "curve" in resolved ? resolved.curve : null;
  const hot = system.systemKind === "domestic_hot_water";
  const vmax = design.maxVelocityFps ?? (hot ? PIPE_DESIGN_DEFAULTS.hotMaxVelocityFps : PIPE_DESIGN_DEFAULTS.maxVelocityFps);
  const velCite = methodCite("Velocity limit", `${vmax} ft/s ${hot ? "hot" : "cold"}`, design.maxVelocityFps ? "the system's" : "PermitZIP design default (verify for permit work)");
  const hazenCite = methodCite("Hazen–Williams", "psi per 100 ft = 4.52 Q^1.852 / (C^1.852 d^4.8704) x 100");
  const cites: Citation[] = [velCite, hazenCite, ipcCite(ipc, "water_sizing")];
  const base = { systemId: system.id, systemName: system.name, systemKind: system.systemKind, service: "water" as const, sizingMode: mode.mode, sizingModeFrom: mode.from, maxVelocityFps: vmax };
  if (!curve) {
    findings.push({ code: "no_demand_curve", severity: "error", elementId: system.id, message: "reason" in resolved ? resolved.reason : "Choose a demand curve." });
    return { ok: true, sizing: { ...base, curve: null, designPoint: null, availablePsi: null, allowablePsiPer100Ft: null, developedLengthFt: null, totalLoad: 0, proposals: [], findings }, steps, cites };
  }
  cites.push(curve.cite);
  steps.push({ label: "Demand curve", detail: `${curve.label}${"from" in resolved ? ` (${resolved.from === "building_type" ? "from the building type" : `the ${resolved.from}'s choice`})` : ""}`, cite: [curve.cite] });
  const proposals: PipeSizeProposal[] = [];
  let developed = 0;
  let rise = 0;
  let total = 0;
  const pieces = walks(model, system, findings);
  // First pass: the longest developed length and the highest fixture over the source, which fix the allowable friction.
  const dist = new Map<string, number>();
  for (const lw of pieces) {
    const rootSeg = lw.walk.order.map((n) => segOf(model, n)).find((s): s is RunSegment => s !== null);
    const rootParent = rootSeg ? lw.walk.parent.get(rootSeg.id) : null;
    const rootZ = rootSeg ? absZ(model, rootSeg, rootSeg.links.end?.elementId === (rootParent ? pipeNodeId(rootParent) : "") ? rootSeg.end.z : rootSeg.start.z) : 0;
    for (const n of lw.walk.order) {
      const p = lw.walk.parent.get(n);
      const seg = segOf(model, n);
      const d = (p ? (dist.get(p) ?? 0) : 0) + (seg ? lengthFt(seg) : 0);
      dist.set(n, d);
      developed = Math.max(developed, d);
      if (seg) rise = Math.max(rise, absZ(model, seg, seg.start.z) - rootZ, absZ(model, seg, seg.end.z) - rootZ);
    }
    total = Math.max(total, lw.load.get(lw.root) ?? 0, ...lw.walk.order.map((n) => lw.load.get(n) ?? 0));
  }
  const supply = design.supplyPressurePsi;
  const staticPsi = round((rise / MM_PER_FT) * PSI_PER_FT, 2);
  let fixturePsi = design.minFixturePressurePsi;
  if (fixturePsi === undefined && supply !== undefined) {
    fixturePsi = LEAST_FIXTURE_PSI;
    findings.push({ code: "critical_fixture_pressure_assumed", severity: "warning", elementId: system.id, message: `${system.name} doesn't say what pressure its critical fixture needs; ${LEAST_FIXTURE_PSI} psi (the least Table 604.3 lists) is used. Flushometer valves need 25–45 psi: set it on the system.` });
  }
  let available: number | null = null;
  let allowable: number | null = null;
  const equivalent = developed * (1 + WATER_FITTING_ALLOWANCE_PCT / 100);
  if (supply === undefined) {
    findings.push({ code: "no_supply_pressure", severity: "warning", elementId: system.id, message: `${system.name} has no supply pressure, so pipes are sized on velocity alone. Set the supply (flow test or design minimum) and fixed losses (meter, backflow preventer) on the system to size by friction.` });
  } else {
    available = round(supply - (design.fixedLossesPsi ?? 0) - staticPsi - (fixturePsi ?? 0), 2);
    const lossCite = [methodCite("Pressure available for friction", "supply − fixed losses − static head (0.433 psi/ft) − critical fixture pressure"), ipcCite(ipc, "fixture_flow_pressure")];
    cites.push(...lossCite);
    steps.push({ label: "Available for friction", detail: `${supply} psi − ${design.fixedLossesPsi ?? 0} fixed − ${staticPsi} static (${round(rise / MM_PER_FT, 1)} ft) − ${fixturePsi} at the critical fixture = ${available} psi`, cite: lossCite });
    if (available <= 0) findings.push({ code: "no_pressure_left", severity: "error", elementId: system.id, message: `Nothing is left for pipe friction on ${system.name} (${available} psi): raise the supply (a booster) or cut a loss. Sized on velocity alone meanwhile.` });
    else if (equivalent > 0) {
      allowable = round((available / equivalent) * 100, 3);
      const allowCite = methodCite("Allowable friction", `available / (developed length + ${WATER_FITTING_ALLOWANCE_PCT}% fittings) x 100`, "fitting allowance: PermitZIP design default (verify for permit work)");
      cites.push(allowCite);
      steps.push({ label: "Allowable friction", detail: `${available} psi over ${round(developed, 1)} ft developed + ${WATER_FITTING_ALLOWANCE_PCT}% fittings (${round(equivalent, 0)} ft): ${allowable} psi per 100 ft`, cite: [allowCite] });
    }
  }
  let beyond = false;
  let capped = false;
  for (const lw of pieces) {
    // The most a pipe can carry is every fixture it serves running at once: each fixture's Table 604.3 flow, or its own units on the Hunter fit.
    const most = new Map<string, number>();
    for (let i = lw.walk.order.length - 1; i >= 0; i--) {
      const n = lw.walk.order[i];
      if (n === undefined) continue;
      const own = lw.own.get(n) ?? 0;
      const name = own > 0 ? partNameOf(model, n) : null;
      const row = name ? findFixtureRow(TABLE_604_3, name) : null;
      // More units than any one fixture has is a lump (a heater's hot side, a whole kitchen on one point): no ceiling below the curve.
      const mine = own > SINGLE_FIXTURE_MAX_WSFU && !row ? Number.POSITIVE_INFINITY : own > 0 ? (row?.gpm ?? hunterStyleGpm(own)) : 0;
      most.set(n, mine + (lw.walk.children.get(n) ?? []).reduce((sum, k) => sum + (most.get(k) ?? 0), 0));
    }
    for (const n of lw.walk.order) {
      const seg = segOf(model, n);
      if (!seg) continue;
      const wsfu = lw.load.get(n) ?? 0;
      if (wsfu <= 0) continue;
      const reading = readCurve(curve, wsfu);
      if (reading.beyondRange) beyond = true;
      const ceiling = most.get(n) ?? Number.POSITIVE_INFINITY;
      const byFixtures = ceiling > 0 && ceiling < reading.gpm;
      if (byFixtures) capped = true;
      const gpm = byFixtures ? ceiling : reading.gpm;
      const spec = seg.size.shape === "pipe" ? specOfSize(seg.size) : null;
      const label = labelOf(model, seg);
      if (!spec) {
        findings.push({ code: "no_size_fits", severity: "warning", elementId: seg.id, message: `The ${label} isn't a listed pipe product, so it isn't sized; give it a material and spec` });
        continue;
      }
      const c = design.hazenC ?? spec.hazenWilliamsC;
      // Table 604.5: the branch to a single fixture is no smaller than the fixture's minimum.
      const childKids = lw.walk.children.get(n) ?? [];
      const fixtureNames = childKids.map((k) => partNameOf(model, k)).filter((x): x is string => x !== null);
      const named = fixtureNames.length === 1 && fixtureNames[0] ? findFixtureRow(TABLE_604_5, fixtureNames[0]) : null;
      // A pipe ending at one fixture or load point is its fixture supply: Table 604.5 by name, else the table's usual 1/2 in.
      const endsAtFixture = childKids.length > 0 && childKids.every((k) => segOf(model, k) === null && (lw.walk.children.get(k) ?? []).length === 0);
      const minRow = named ?? (endsAtFixture ? { fixture: "fixture supply", minIn: USUAL_FIXTURE_MIN_IN } : null);
      const sizes = [...spec.sizes].sort((a, b) => a.nominalIn - b.nominalIn);
      const fits = (s: (typeof sizes)[number]) => {
        const idIn = s.idMm / MM_PER_IN;
        const psi = hazenWilliamsPsiPer100Ft(gpm, c, idIn);
        const fps = gpm / 448.831 / ((Math.PI * (idIn / 12) ** 2) / 4);
        return { psi, fps, ok: (allowable === null || psi <= allowable + 1e-9) && fps <= vmax + 1e-9 };
      };
      const chosen = sizes.find((s) => (!minRow || s.nominalIn >= minRow.minIn - 1e-9) && fits(s).ok);
      const carries = `${round(wsfu, 2)} WSFU, ${round(gpm, 1)} gpm${byFixtures ? " (all its fixtures at once)" : ""}`;
      if (!chosen) {
        findings.push({ code: "no_size_fits", severity: "error", elementId: seg.id, message: `No ${spec.name} size carries ${round(gpm, 1)} gpm on the ${label} within ${allowable === null ? "" : `${allowable} psi/100 ft and `}${vmax} ft/s` });
        continue;
      }
      const at = fits(chosen);
      const smallestOk = sizes.find((s) => fits(s).ok);
      const byFriction = sizes.find((s) => allowable === null || hazenWilliamsPsiPer100Ft(gpm, c, s.idMm / MM_PER_IN) <= allowable + 1e-9);
      const governs =
        minRow && smallestOk && chosen.nominalIn > smallestOk.nominalIn + 1e-9
          ? `Table 604.5 minimum (${minRow.fixture})`
          : allowable === null || (byFriction && byFriction.nominalIn < chosen.nominalIn - 1e-9)
            ? `velocity ${vmax} ft/s`
            : `friction ${allowable} psi/100 ft`;
      proposals.push(proposalOf(seg, label, "water", chosen.nominalIn, carries, governs, { frictionPsiPer100Ft: round(at.psi, 3), velocityFps: round(at.fps, 2) }));
    }
  }
  if (capped) {
    const capCite = methodCite("Fixture flow ceiling", "a pipe never carries more than every fixture it serves running at once: Table 604.3 flow by fixture, else the fixture's own units on the Hunter fit (1.47 FU^0.735, verify for permit work)");
    cites.push(capCite);
    steps.push({ label: "Small branches", detail: `${curve.label} reads a building's demand; on a branch serving a few fixtures that reading is more than those fixtures can draw, so the branch carries their sum instead`, cite: [capCite, curve.cite] });
  }
  if (beyond) findings.push({ code: "beyond_curve", severity: "warning", elementId: system.id, message: `Some pipes carry more fixture units than ${curve.label} reaches; their flow is held at the curve's end. Use a curve that covers the load.` });
  changeFindings(proposals, findings);
  const designPoint = total > 0 ? { wsfu: round(total, 2), gpm: round(readCurve(curve, total).gpm, 1) } : null;
  if (designPoint) steps.push({ label: "Design point", detail: `${designPoint.wsfu} WSFU at the source: ${designPoint.gpm} gpm on ${curve.label}`, cite: [curve.cite] });
  return {
    ok: true,
    sizing: { ...base, curve: { id: curve.id, label: curve.label }, designPoint, availablePsi: available, allowablePsiPer100Ft: allowable, developedLengthFt: developed > 0 ? round(developed, 1) : null, totalLoad: round(total, 2), proposals: proposals.sort((a, b) => a.segmentId.localeCompare(b.segmentId)), findings },
    steps,
    cites,
  };
}

// ------------------------------------------------------------------ sanitary

const minSlope = (nominalIn: number) => TABLE_704_1.find((b) => nominalIn <= b.maxNominalIn + 1e-9)?.inPerFt ?? 0.0625;

/**
 * The smallest drain for its fixture units at the slope it is drawn at
 * (null slope: level, so each size at its Table 704.1 minimum). A size whose
 * minimum slope is steeper than the drawn fall doesn't qualify.
 */
function drainSize(role: PipeSizingRole, dfu: number, slope: number | null, closet: boolean, systemMinSlope: (nominalIn: number) => number = () => 0): number | null {
  const required = (nominalIn: number) => Math.max(minSlope(nominalIn), systemMinSlope(nominalIn));
  if (role === "building_drain") {
    for (const row of TABLE_710_1_1) {
      if (closet && row.nominalIn < BUILDING_DRAIN_MIN_WITH_WC_IN) continue;
      const need = required(row.nominalIn);
      if (slope !== null && slope < need - 1e-9) continue;
      const at = slope ?? need;
      const idx = TABLE_710_1_1_SLOPES.map((v, i) => [v, i] as const).filter(([v]) => v <= at + 1e-9).pop()?.[1];
      const max = idx === undefined ? null : row.maxDfu[idx];
      if (max !== null && max !== undefined && max >= dfu) return row.nominalIn;
    }
    return null;
  }
  if (role === "stack") return TABLE_710_1_2.find((r) => r.stackUpTo3 !== null && r.stackUpTo3 >= dfu)?.nominalIn ?? null;
  return TABLE_710_1_2.find((r) => r.branch >= dfu && (slope === null || slope >= required(r.nominalIn) - 1e-9))?.nominalIn ?? null;
}

function sizeDrainage(model: ModelState, system: MepSystem, ipc: IpcEdition, mode: ReturnType<typeof systemSizingMode>): SizingOutcome {
  const findings: PipeSizingFinding[] = [];
  const steps: CalcStep[] = [];
  const cites: Citation[] = [ipcCite(ipc, "building_drain"), ipcCite(ipc, "branch_stack"), ipcCite(ipc, "drain_slope")];
  const proposals: PipeSizeProposal[] = [];
  let total = 0;
  let intervalsNoted = false;
  let stricterNoted = false;
  const design = mergePipeDesign(undefined, system.design?.pipe);
  for (const lw of walks(model, system, findings)) {
    const order = lw.walk.order;
    const kids = (n: string) => lw.walk.children.get(n) ?? [];
    // Upstream is down the tree: the outfall is the root, fixtures are leaves.
    const stackBelow = new Map<string, boolean>();
    const closetBelow = new Map<string, boolean>();
    for (let i = order.length - 1; i >= 0; i--) {
      const n = order[i];
      if (n === undefined) continue;
      const seg = segOf(model, n);
      const name = partNameOf(model, n);
      stackBelow.set(n, (seg !== null && isVerticalLeg({ x: seg.end.x - seg.start.x, y: seg.end.y - seg.start.y, z: seg.end.z - seg.start.z })) || kids(n).some((k) => stackBelow.get(k) === true));
      closetBelow.set(n, (name !== null && WATER_CLOSET.test(name)) || kids(n).some((k) => closetBelow.get(k) === true));
    }
    // The trunk: from the outfall, always into the branch carrying the most.
    const trunk = new Set<string>();
    for (let n: string | undefined = lw.root; n !== undefined; ) {
      trunk.add(n);
      const next: string | undefined = [...kids(n)].sort((a, b) => (lw.load.get(b) ?? 0) - (lw.load.get(a) ?? 0) || a.localeCompare(b))[0];
      n = next;
    }
    total = Math.max(total, ...order.map((n) => lw.load.get(n) ?? 0));
    const required = new Map<string, { inches: number; role: PipeSizingRole; carries: string; governs: string }>();
    for (const n of order) {
      const seg = segOf(model, n);
      if (!seg) continue;
      const dfu = lw.load.get(n) ?? 0;
      const vertical = isVerticalLeg({ x: seg.end.x - seg.start.x, y: seg.end.y - seg.start.y, z: seg.end.z - seg.start.z });
      const below = kids(n).some((k) => stackBelow.get(k) === true);
      const role: PipeSizingRole = vertical ? "stack" : trunk.has(n) || below ? "building_drain" : "horizontal_branch";
      const slope = vertical ? null : slopeInPerFt(seg);
      const label = labelOf(model, seg);
      if (!vertical && (slope ?? 0) <= 0) findings.push({ code: "level_drain", severity: "error", elementId: seg.id, message: `The ${label} is level; a drain needs fall (Table 704.1). Sized at the minimum slope for now.` });
      if (role === "stack" && !intervalsNoted) {
        intervalsNoted = true;
        findings.push({ code: "walk", severity: "info", elementId: seg.id, message: "Stacks are sized as three branch intervals or fewer (Table 710.1(2))." });
      }
      const closet = closetBelow.get(n) === true;
      const drawnSlope = slope !== null && slope > 0 ? slope : null;
      const sizeIn = drainSize(role, dfu, drawnSlope, closet, (nominalIn) => minSlopeFor(nominalIn, design));
      const byCodeAlone = drainSize(role, dfu, drawnSlope, closet);
      if (sizeIn !== null && byCodeAlone !== null && sizeIn > byCodeAlone + 1e-9 && !stricterNoted) {
        stricterNoted = true;
        findings.push({ code: "system_slope_rule", severity: "warning", elementId: system.id, message: `${system.name}'s minimum slopes are steeper than Table 704.1 (the model's built-in ${inPerFtLabel(minSlopeFor(byCodeAlone, design))} for ${nominalLabel(byCodeAlone)}" against the code's ${inPerFtLabel(minSlope(byCodeAlone))}), so some drains are sized a size up to keep their drawn fall. Set the system's slopes from Table 704.1 to size them at the code's minimum.` });
      }
      const carries = `${round(dfu, 2)} DFU${slope !== null ? ` at ${round(slope, 3)} in/ft` : ""}`;
      if (sizeIn === null) {
        findings.push({ code: "no_size_fits", severity: "error", elementId: seg.id, message: `${carries} on the ${label} is beyond Table ${role === "building_drain" ? "710.1(1)" : "710.1(2)"}${role === "building_drain" ? " at that slope" : ""}` });
        continue;
      }
      // A water closet's horizontal branch is at least 3 in. as well.
      const inches = closet && role === "horizontal_branch" ? Math.max(sizeIn, 3) : sizeIn;
      const governs = role === "building_drain" ? `Table 710.1(1)${closet ? ", 3 in. with a water closet" : ""}` : role === "stack" ? "Table 710.1(2), stack" : `Table 710.1(2), horizontal branch${closet && inches > sizeIn ? ", 3 in. with a water closet" : ""}`;
      required.set(n, { inches, role, carries, governs });
    }
    // IPC 704.2: never smaller than any pipe draining into it.
    const finalIn = new Map<string, number>();
    const maxBelow = new Map<string, number>();
    for (let i = order.length - 1; i >= 0; i--) {
      const n = order[i];
      if (n === undefined) continue;
      const fromKids = Math.max(0, ...kids(n).map((k) => finalIn.get(k) ?? maxBelow.get(k) ?? 0));
      maxBelow.set(n, fromKids);
      const own = required.get(n);
      if (own) finalIn.set(n, Math.max(own.inches, fromKids));
    }
    for (const [n, own] of required) {
      const seg = segOf(model, n);
      if (!seg) continue;
      let inches = finalIn.get(n) ?? own.inches;
      const spec = seg.size.shape === "pipe" ? specOfSize(seg.size) : null;
      const listed = spec ? [...spec.sizes].map((s) => s.nominalIn).sort((a, b) => a - b).find((s) => s >= inches - 1e-9) : inches;
      if (listed === undefined) {
        findings.push({ code: "no_size_fits", severity: "error", elementId: seg.id, message: `${spec?.name ?? "This pipe"} doesn't come as large as ${nominalLabel(inches)}" (the ${labelOf(model, seg)})` });
        continue;
      }
      const raised = inches > own.inches + 1e-9;
      inches = listed;
      proposals.push(proposalOf(seg, labelOf(model, seg), own.role, inches, own.carries, raised ? "a larger pipe drains into it (704.2)" : own.governs));
    }
  }
  cites.push(methodCite("Direction of flow", "a drain is never reduced in size in the direction of flow", "IPC 704.2"));
  steps.push({ label: "Drainage fixture units", detail: `${round(total, 2)} DFU at the outfall`, cite: [ipcCite(ipc, "dfu_fixtures")] });
  changeFindings(proposals, findings);
  return {
    ok: true,
    sizing: { systemId: system.id, systemName: system.name, systemKind: system.systemKind, service: "drainage", sizingMode: mode.mode, sizingModeFrom: mode.from, curve: null, designPoint: null, availablePsi: null, allowablePsiPer100Ft: null, maxVelocityFps: null, developedLengthFt: null, totalLoad: round(total, 2), proposals: proposals.sort((a, b) => a.segmentId.localeCompare(b.segmentId)), findings },
    steps,
    cites,
  };
}

/**
 * Each domestic water system's design point on its demand curve: the
 * fixture units at its source and the gpm the curve reads there. Needs no
 * code edition (the curve is the project's choice), so the chart draws
 * before the plumbing code is known.
 */
export function waterDesignPoints(model: ModelState): ReadonlyArray<{ readonly systemId: string; readonly systemName: string; readonly systemKind: SystemKind; readonly curve: DemandCurve | null; readonly curveNote: string | null; readonly wsfu: number; readonly gpm: number | null }> {
  const settings = projectSettingsOf(model);
  const out: Array<{ systemId: string; systemName: string; systemKind: SystemKind; curve: DemandCurve | null; curveNote: string | null; wsfu: number; gpm: number | null }> = [];
  for (const system of elementsOfKind(model.elements, "mep_system")) {
    if (system.domain !== "pipe" || pipeSizingService(system.systemKind) !== "water" || segmentsOf(model, system).length === 0) continue;
    const resolved = resolveDemandCurve(settings, system.design?.pipe?.demandCurve ? { demand_curve: system.design.pipe.demandCurve } : null);
    const curve = "curve" in resolved ? resolved.curve : null;
    let wsfu = 0;
    for (const lw of walks(model, system, [])) wsfu = Math.max(wsfu, ...lw.walk.order.map((n) => lw.load.get(n) ?? 0));
    out.push({ systemId: system.id, systemName: system.name, systemKind: system.systemKind, curve, curveNote: "reason" in resolved ? resolved.reason : null, wsfu: round(wsfu, 2), gpm: curve ? round(readCurve(curve, wsfu).gpm, 1) : null });
  }
  return out;
}

/** Size one domestic water or sanitary system. Returns the proposal, or why it can't. */
export function sizePipeSystem(model: ModelState, systemId: string, ipc: IpcEdition): SizingOutcome {
  const system = model.elements[systemId];
  if (system?.kind !== "mep_system" || system.domain !== "pipe") return { ok: false, reason: `${systemId} isn't a pipe system in this model.` };
  const service = pipeSizingService(system.systemKind);
  if (typeof service !== "string") return { ok: false, reason: `${system.name}: ${service.reason}` };
  if (segmentsOf(model, system).length === 0) return { ok: false, reason: `${system.name} has no pipe yet; route it first.` };
  const mode = systemSizingMode(model, system);
  if (service === "water") return sizeWater(model, system, ipc, projectSettingsOf(model), mode);
  if (service === "storm") return sizeStormSystem(model, system, ipc, mode);
  if (service === "vent") {
    const sanitary = new Map<string, PipeSystemSizing | null>();
    return sizeVentSystem(model, system, ipc, mode, (id) => {
      if (!sanitary.has(id)) {
        const s = model.elements[id];
        const r = s?.kind === "mep_system" && s.systemKind === "sanitary" ? sizeDrainage(model, s, ipc, systemSizingMode(model, s)) : null;
        sanitary.set(id, r?.ok ? r.sizing : null);
      }
      return sanitary.get(id) ?? null;
    });
  }
  return sizeDrainage(model, system, ipc, mode);
}

const sizeSystemInput = z.object({ system_id: z.string().min(1).max(200).describe("A domestic cold or hot water, sanitary, vent or storm pipe system (mep_system) id.") }).strict();

const TOTAL_LABEL: Readonly<Record<PipeSizingServiceKind, string>> = { water: "Fixture units at the source", drainage: "Drainage fixture units at the outfall", vent: "Drainage fixture units vented", storm: "Roof area drained, sq ft" };

export const sizeSystemCalc = defineCalc({
  id: "plumbing.size_system",
  version: "1.0.0",
  domain: "plumbing",
  title: "Water, sanitary, vent and storm system sizing (plumbing code)",
  summary:
    "Sizes a drawn domestic water system (fixture units to gpm on its demand curve; friction within the pressure left after static head and the critical fixture over the developed length; velocity limit; Table 604.5 minimums) or sanitary system (DFU by Table 710.1(1) at slope for the building drain, 710.1(2) for branches and stacks, never smaller downstream), vent system (stack vents and vent stacks by Table 906.1 on DFU vented and developed length; branch vents half the drain they vent, 1-1/4 in. least, a size up over 40 ft, 906.2) or storm system (roof area at the system's design rainfall rate: leaders by Table 1106.2(1), horizontal drains by Table 1106.3 at slope). Returns each pipe's needed size against the drawn size and findings. Proposes only; bim_size_pipes applies it, or auto-sizing when the system is set to auto.",
  codeFamily: "ipc",
  needsModel: true,
  input: sizeSystemInput,
  example: { system_id: "sys-cw" },
  run: (input, ctx) => {
    if (!isIpcEdition(ctx.code)) throw new Error("This calc needs the plumbing code pack.");
    if (!ctx.model) return { values: [], steps: [], issues: [{ severity: "error", message: "Give the model to size.", cite: [] }], detail: null };
    const r = sizePipeSystem(ctx.model, input.system_id, ctx.code);
    if (!r.ok) return { values: [], steps: [], issues: [{ severity: "error", message: r.reason, cite: [] }], detail: null };
    const s = r.sizing;
    const issues: CalcIssue[] = s.findings.filter((f) => f.code !== "oversized_pipe").map((f) => ({ severity: f.severity, message: f.message, cite: r.cites.slice(0, 2) }));
    const values: CalcValue[] = [
      { key: "sizing_mode", label: "Auto-sizing", value: s.sizingMode === "auto" ? "on" : "off (check only)", unit: null, cite: [] },
      { key: "total", label: TOTAL_LABEL[s.service], value: s.totalLoad, unit: s.service === "water" ? "wsfu" : s.service === "storm" ? null : "dfu", cite: r.cites.slice(0, 1) },
      ...(s.designPoint ? [{ key: "design_gpm", label: "Design flow", value: s.designPoint.gpm, unit: "gpm" as const, cite: r.cites }] : []),
      ...(s.allowablePsiPer100Ft !== null ? [{ key: "allowable_psi_per_100ft", label: "Allowable friction", value: s.allowablePsiPer100Ft, unit: "psi_per_100ft" as const, cite: r.cites }] : []),
      { key: "pipes_to_resize", label: "Pipes that need another size", value: s.proposals.filter((p) => p.change !== "same").length, unit: null, cite: [] },
      ...s.proposals.filter((p) => p.change !== "same").map((p): CalcValue => ({ key: `size:${p.segmentId}`, label: `${p.label} (drawn ${p.current}")`, value: p.proposed, unit: "in", cite: r.cites })),
      ...s.proposals.filter((p) => p.change !== "same").map((p): CalcValue => ({ key: `size_nominal_in:${p.segmentId}`, label: `${p.label}, nominal inches`, value: p.proposedIn, unit: "in", cite: r.cites })),
    ];
    return { values, steps: r.steps, issues, detail: s };
  },
});
