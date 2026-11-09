import { MAX_EDIT_BATCH_STEPS, elementsOfKind, runLabel, sameSize, sizeLabel, systemKindsWithAdapter, type BimElement, type Command, type ElementId, type MepSystem, type ModelState, type RunSegment, type RunSize } from "@permitzip/bim-kernel";
import { sizingCriteriaFor, suggestDuctSize, type ResolvedSizingCriteria } from "./duct-sizing";
import { ductPerformance } from "./pressure";

/**
 * Mechanical › Analyze › Size ducts (round 15): every duct run of an air
 * system sized from the airflow it carries, by that system's own sizing rule
 * (its friction rate, velocity limit and aspect ratio from Systems, else its
 * kind's typical values; round 12's `sizingCriteriaFor`). A run is what
 * `resize_run` resizes as one: straight pieces of one size joined through
 * elbows, offsets and caps. A rectangular run keeps its depth (the ceiling
 * set it) and widens or narrows; a round run takes the next standard size.
 *
 * The plan changes nothing: it lists each change, each run kept and each run
 * it can't size with the reason, and one `batch_edits` that resizes them all
 * as one undo. It reads the system's own duct pieces from the kind index,
 * never a pass over the model.
 */

type Elements = Readonly<Record<string, BimElement>>;

const DUCT = "duct";
const PASS_THROUGH = new Set(["elbow", "cap", "offset"]);

export interface DuctRunSizeChange {
  readonly runId: ElementId;
  readonly systemId: ElementId;
  readonly label: string;
  readonly from: RunSize;
  readonly to: RunSize;
  readonly cfm: number;
  readonly velocityFpm: number;
  readonly frictionInPer100Ft: number;
  /** What set the size: the friction rate, the velocity limit, or the widest branch it carries (a trunk stays wider than its taps). */
  readonly limitedBy: "friction" | "velocity" | "branches";
}

export interface DuctRunSizeRefusal {
  readonly runId: ElementId;
  readonly systemId: ElementId;
  readonly label: string;
  readonly reason: string;
}

export interface AirSystemSizing {
  readonly systemId: ElementId;
  readonly name: string;
  readonly criteria: ResolvedSizingCriteria;
  /** Criteria that fell back to the kind's typical value (not set on the system). */
  readonly typical: readonly string[];
  readonly runs: number;
}

export interface AirSystemSizePlan {
  readonly systems: readonly AirSystemSizing[];
  readonly changes: readonly DuctRunSizeChange[];
  /** Runs already the size their airflow calls for. */
  readonly kept: number;
  readonly refused: readonly DuctRunSizeRefusal[];
  /** One `batch_edits` resizing every change; empty when nothing changes. */
  readonly commands: readonly Command[];
}

function airSystem(elements: Elements, id: ElementId | string): MepSystem | null {
  const s = elements[id];
  if (s?.kind !== "mep_system") return null;
  return new Set(systemKindsWithAdapter("mechanical")).has(s.systemKind) ? s : null;
}

/** The air systems the selection is on: a duct piece's own system, a part's through the duct its connectors join. */
export function airSystemsOfSelection(elements: Elements, selectedIds: readonly string[]): ElementId[] {
  const out = new Set<ElementId>();
  const add = (systemId: ElementId) => {
    if (airSystem(elements, systemId)) out.add(systemId);
  };
  for (const id of selectedIds) {
    const el = elements[id];
    if (!el) continue;
    if (el.kind === "mep_system") add(el.id);
    else if ((el.kind === "run_segment" || el.kind === "run_fitting") && el.domain === DUCT) add(el.systemId);
    else if (el.kind === "part") {
      for (const link of Object.values(el.links ?? {})) {
        const other = link ? elements[link.elementId] : undefined;
        if ((other?.kind === "run_segment" || other?.kind === "run_fitting") && other.domain === DUCT) add(other.systemId);
      }
    }
  }
  return [...out];
}

/** The system's duct pieces grouped into runs the way `resize_run` walks them. */
function runsOf(elements: Elements, segments: readonly RunSegment[]): RunSegment[][] {
  const seen = new Set<ElementId>();
  const runs: RunSegment[][] = [];
  for (const start of segments) {
    if (seen.has(start.id) || start.flex) continue;
    const run: RunSegment[] = [];
    const stack: ElementId[] = [start.id];
    const fittings = new Set<ElementId>();
    while (stack.length > 0) {
      const id = stack.pop();
      if (id === undefined) continue;
      const el = elements[id];
      if (el?.kind === "run_segment") {
        if (seen.has(el.id) || el.flex || !sameSize(el.size, start.size)) continue;
        seen.add(el.id);
        run.push(el);
        for (const link of [el.links.start, el.links.end]) if (link) stack.push(link.elementId);
      } else if (el?.kind === "run_fitting" && PASS_THROUGH.has(el.fittingType) && !fittings.has(el.id)) {
        fittings.add(el.id);
        for (const p of el.ports) if (p.link) stack.push(p.link.elementId);
      }
    }
    if (run.length > 0) runs.push(run);
  }
  return runs;
}

const r = (v: number, k = 1000) => Math.round(v * k) / k;
const IN = 25.4;
/** A trunk stays at least this much wider than the widest branch it carries, for the takeoff's collar. */
const BRANCH_MARGIN_MM = 2 * IN;

const planWidth = (size: RunSize): number => (size.shape === "round" ? size.diameter : size.shape === "rect" || size.shape === "oval" ? size.width : 0);

/** The widest branch tapped into each duct piece, by the piece it is hosted on. */
function widestBranches(elements: Elements, wanted: ReadonlySet<ElementId>): Map<ElementId, number> {
  const out = new Map<ElementId, number>();
  for (const f of elementsOfKind(elements, "run_fitting")) {
    if (f.domain !== DUCT || !wanted.has(f.systemId) || !f.host) continue;
    const branch = f.ports[0]?.size;
    if (!branch) continue;
    const w = planWidth(branch);
    if (w > (out.get(f.host.segmentId) ?? 0)) out.set(f.host.segmentId, w);
  }
  return out;
}

/** The size at least `minWidthMm` wide: the same depth for rectangular (next even inch), the next standard diameter for round. */
function atLeastWide(size: RunSize, minWidthMm: number): RunSize | null {
  const inches = minWidthMm / IN;
  if (size.shape === "rect") return { shape: "rect", width: Math.round(Math.ceil(inches / 2) * 2 * IN * 1000) / 1000, height: size.height };
  if (size.shape === "round") {
    const d = inches <= 20 ? Math.ceil(inches) : Math.ceil(inches / 2) * 2;
    return { shape: "round", diameter: Math.round(d * IN * 1000) / 1000 };
  }
  return null;
}

/** The plan for sizing every duct run of these air systems. Nothing is changed. */
export function planSizeAirSystems(model: ModelState, systemIds: readonly string[]): AirSystemSizePlan {
  const elements = model.elements;
  const systems = systemIds.map((id) => airSystem(elements, id)).filter((s): s is MepSystem => s !== null);
  const wanted = new Set(systems.map((s) => s.id));
  const bySystem = new Map<ElementId, RunSegment[]>();
  for (const seg of elementsOfKind(elements, "run_segment")) {
    if (seg.domain !== DUCT || !wanted.has(seg.systemId)) continue;
    const list = bySystem.get(seg.systemId);
    if (list) list.push(seg);
    else bySystem.set(seg.systemId, [seg]);
  }
  const branches = widestBranches(elements, wanted);
  const sized: AirSystemSizing[] = [];
  const changes: DuctRunSizeChange[] = [];
  const refused: DuctRunSizeRefusal[] = [];
  let kept = 0;
  for (const system of systems) {
    const { typical, ...criteria } = sizingCriteriaFor(system.systemKind, system.design);
    const runs = runsOf(elements, bySystem.get(system.id) ?? []);
    sized.push({ systemId: system.id, name: system.name, criteria, typical, runs: runs.length });
    for (const run of runs) {
      const first = run[0];
      if (!first) continue;
      const label = runLabel(elements, first);
      const cfm = Math.max(...run.map((s) => s.flow));
      const shape = first.size.shape === "round" ? "round" : first.size.shape === "rect" ? "rect" : null;
      const no = (reason: string) => refused.push({ runId: first.id, systemId: system.id, label, reason });
      if (!shape) {
        no(`${label} isn't round or rectangular, so it isn't sized here; size it in its Properties`);
        continue;
      }
      if (!(cfm > 0)) {
        no(`${label} carries no airflow yet: connect the diffusers it serves, or give them their CFM`);
        continue;
      }
      const s = suggestDuctSize({ cfm, shape, criteria, ...(first.insulation ? { insulation: first.insulation } : {}), ...(system.design ? { design: system.design } : {}), ...(first.size.shape === "rect" ? { holdHeightMm: first.size.height } : {}) });
      if (!s.ok) {
        no(`${label}: ${s.reason}`);
        continue;
      }
      let pick: { readonly size: RunSize; readonly velocityFpm: number; readonly frictionInPer100Ft: number; readonly limitedBy: DuctRunSizeChange["limitedBy"] } = s.atHeight ?? s.best;
      const widest = Math.max(0, ...run.map((seg) => branches.get(seg.id) ?? 0));
      const minWidth = widest > 0 ? widest + BRANCH_MARGIN_MM : 0;
      if (planWidth(pick.size) < minWidth) {
        const wider = atLeastWide(pick.size, minWidth);
        const perf = wider ? ductPerformance(cfm, wider, first.insulation, system.design) : null;
        if (!wider || !perf) {
          no(`${label}: no size carries its airflow and stays wider than its ${Math.round(widest / IN)}" branches`);
          continue;
        }
        pick = { size: wider, velocityFpm: perf.velocityFpm, frictionInPer100Ft: perf.frictionInPer100Ft, limitedBy: "branches" };
      }
      if (sameSize(pick.size, first.size)) {
        kept += 1;
        continue;
      }
      if (changes.length >= MAX_EDIT_BATCH_STEPS) {
        no(`${label}: more than ${MAX_EDIT_BATCH_STEPS} runs change at once; press Size ducts again for the rest`);
        continue;
      }
      changes.push({ runId: first.id, systemId: system.id, label, from: first.size, to: pick.size, cfm: r(cfm, 1), velocityFpm: r(pick.velocityFpm, 1), frictionInPer100Ft: r(pick.frictionInPer100Ft), limitedBy: pick.limitedBy });
    }
  }
  const commands: Command[] = changes.length === 0 ? [] : [{ type: "batch_edits", label: `Size ducts: ${systems.map((s) => s.name).join(", ")}`, commands: changes.map((c) => ({ type: "resize_run" as const, segmentId: c.runId, profile: c.to })) }];
  return { systems: sized, changes, kept, refused, commands };
}

/** One line of the Size ducts preview: a change, or a run it can't size and why. */
export interface SizeDuctsLine {
  readonly key: string;
  readonly elementId: ElementId;
  readonly ok: boolean;
  readonly text: string;
}

const fmt = (n: number, digits = 0) => n.toLocaleString("en-US", { maximumFractionDigits: digits });

/** The preview of a plan: each system's rule, then one line per change, then one per run it can't size. */
export function sizeDuctsLines(plan: AirSystemSizePlan): { readonly rules: readonly string[]; readonly lines: readonly SizeDuctsLine[] } {
  const rules = plan.systems.map((s) => `${s.name}: ${s.criteria.frictionInPer100Ft}" per 100 ft, ${fmt(s.criteria.maxVelocityFpm)} fpm${s.typical.length > 0 ? " (typical values for its kind; the system sets none of its own)" : ""}; ${s.runs} ${s.runs === 1 ? "run" : "runs"}`);
  const lines: SizeDuctsLine[] = [
    ...plan.changes.map((c) => ({ key: `c:${c.runId}`, elementId: c.runId, ok: true, text: `${c.label}: ${sizeLabel(c.from)} → ${sizeLabel(c.to)} (${fmt(c.cfm)} CFM, ${fmt(c.velocityFpm)} fpm, ${fmt(c.frictionInPer100Ft, 3)}" per 100 ft${c.limitedBy === "branches" ? "; kept wider than its taps" : ""})` })),
    ...plan.refused.map((r) => ({ key: `r:${r.runId}`, elementId: r.runId, ok: false, text: r.reason })),
  ];
  return { rules, lines };
}
