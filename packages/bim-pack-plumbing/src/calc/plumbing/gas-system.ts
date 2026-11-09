import { type ModelState, type PipeMaterial } from "@permitzip/bim-kernel";
import { gasConnectionRowsOf, type GasConnectionRow } from "../../routing/pipe/gas-connections";
import { gasNetwork, pressureLabel, IN_WC_PER_PSI, type GasIssueCode, type GasNetwork, type GasZone } from "../../routing/pipe/gas-zones";
import { z } from "zod";
import type { GasMaterial, ProjectCodeAdoption, CalcIssue, CalcStep, CalcValue, Citation, DesignCriteria } from "@permitzip/bim-calc";
import { ifgcCite, isIfgcEdition, type IfgcEdition, PERMITZIP_DESIGN_CRITERIA, defineCalc, round } from "@permitzip/bim-calc";
import { sizeGasCalc } from "./code-calcs";

/**
 * A drawn gas system sized by the fuel gas code, zone by zone: the kernel
 * splits the system at its regulators (the 2 psi zone, each line and
 * appliance regulator's zone) and gives each zone's segment tree; each zone
 * is sized by plumbing.size_gas at its own inlet pressure and allowable drop
 * (IFGC 402.4.3: a hybrid pressure system is sized zone by zone), by the
 * longest length (402.4.1) or branch length (402.4.2) method, from the
 * Table 402.4(n) for that gas, material and pressure, with the 402.4
 * equation beside it.
 *
 * The result is a proposal: the size each drawn pipe needs, against the size
 * drawn, with findings (an undersized pipe, a regulator missing between
 * zones, an appliance the zone can't hold). It never edits the model; the
 * sizing command (set_pipe_sizes, behind the person's approval) does that.
 * It sizes the topology the engineer drew and never proposes another layout.
 */

export type GasFindingCode = GasIssueCode | "undersized_gas_pipe" | "no_size_fits";

export interface GasFinding {
  readonly code: GasFindingCode;
  readonly severity: "error" | "warning" | "info";
  readonly elementId: string | null;
  readonly zoneId: string | null;
  readonly message: string;
}

export interface GasPipeProposal {
  readonly segmentId: string;
  readonly label: string;
  readonly currentIn: number | null;
  readonly proposedIn: number;
  readonly current: string | null;
  readonly proposed: string;
  readonly zoneIds: readonly string[];
  readonly change: "up" | "down" | "same";
}

export interface GasZoneSizing {
  readonly id: string;
  readonly label: string;
  readonly regulatorId: string | null;
  readonly inlet: string;
  readonly allowableDrop: string;
  readonly inletInWc: number;
  readonly allowableDropInWc: number;
  readonly highPressure: boolean;
  readonly longestFt: number;
  readonly totalMbh: number;
  readonly material: GasMaterial | null;
  /** The code table the zone was read from, e.g. "VFGC 2021 Table 402.4(28)"; null when sized by the equation only. */
  readonly table: string | null;
  readonly segments: ReadonlyArray<{ readonly id: string; readonly elementId: string | null; readonly label: string; readonly loadMbh: number; readonly sizingLengthFt: number; readonly size: string | null }>;
}

/** One row of the gas equipment schedule (the issued sheet: ID, qty, input, total, regulator, vent limiter, description). */
export interface GasEquipmentRow {
  readonly mark: string;
  readonly description: string;
  readonly quantity: number;
  readonly inputMbh: number;
  readonly totalMbh: number;
  readonly regulator: string | null;
  readonly vent: string | null;
  readonly zone: string;
  readonly elementIds: readonly string[];
}

/** One gas outlet (appliance or load point) with the basis its feed pipe is sized on, the zone's code table named (the gas connection schedule's rows). */
export interface GasConnectionSizing extends GasConnectionRow {
  /** The code table the outlet's zone was read from, e.g. "VFGC 2021 Table 402.4(28)"; null when sized by the equation only. */
  readonly table: string | null;
  /** "Longest length, 97 ft, VFGC 2021 Table 402.4(28)". */
  readonly basisText: string;
  /** The size the calc needs for the pipe feeding it ("3/4"); null when none was proposed. */
  readonly requiredSize: string | null;
}

export interface GasSystemSizing {
  readonly systemId: string;
  readonly systemName: string;
  readonly gas: "natural" | "propane";
  readonly method: "longest_length" | "branch_length";
  readonly sizingMode: "check" | "auto";
  readonly totalMbh: number;
  readonly zones: readonly GasZoneSizing[];
  readonly proposals: readonly GasPipeProposal[];
  readonly findings: readonly GasFinding[];
  readonly equipment: readonly GasEquipmentRow[];
  /** Every outlet with its developed length from the source and sizing basis. */
  readonly connections: readonly GasConnectionSizing[];
  readonly regulators: GasNetwork["regulators"];
}

/** The project's fuel gas code from its Code Study rows: whichever discipline it was filed under, by name (Fuel Gas, IFGC, VFGC, NFPA 54), confirmed first. */
export function fuelGasAdoptionFrom(rows: ReadonlyArray<{ readonly code_name: string; readonly edition: string; readonly status: string }>): ProjectCodeAdoption | null {
  const gas = rows.filter((r) => /fuel gas|\bI?FGC\b|\bVFGC\b|NFPA\s*54/i.test(r.code_name) && (r.status === "confirmed" || r.status === "unconfirmed"));
  const best = gas.find((r) => r.status === "confirmed") ?? gas[0];
  return best ? { codeName: best.code_name, edition: best.edition, status: best.status as "confirmed" | "unconfirmed" } : null;
}

/** Which Table 402.4(n) family a kernel pipe material reads. */
export function gasTableMaterial(m: PipeMaterial | null): GasMaterial | null {
  switch (m) {
    case "black_steel":
    case "steel":
    case "galvanized":
      return "sch40";
    case "copper":
      return "copper";
    case "csst":
      return "csst";
    case "pe":
      return "pe_pipe";
    default:
      return null;
  }
}

/** "1-1/4" → 1.25; "3/4" → 0.75; "2" → 2; an equation-only "0.93 in. ID" → null. */
export function inchesOfLabel(label: string | null): number | null {
  if (!label) return null;
  const mixed = /^(\d+)-(\d+)\/(\d+)$/.exec(label);
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  const frac = /^(\d+)\/(\d+)$/.exec(label);
  if (frac) return Number(frac[1]) / Number(frac[2]);
  return /^\d+(\.\d+)?$/.test(label) ? Number(label) : null;
}

export function inchText(v: number | null): string | null {
  if (v === null) return null;
  const whole = Math.floor(v + 1e-9);
  const eighths = Math.round((v - whole) * 8);
  const names: Readonly<Record<number, string>> = { 1: "1/8", 2: "1/4", 3: "3/8", 4: "1/2", 5: "5/8", 6: "3/4", 7: "7/8" };
  if (eighths === 0) return `${whole}`;
  return whole === 0 ? `${names[eighths]}` : `${whole}-${names[eighths]}`;
}

/** A zone's pressure the way the code tables state it: psi at 1 psi and above, else in. w.c. */
function tablePressure(inWc: number): { value: number; unit: "in_wc" | "psi" } {
  return inWc >= IN_WC_PER_PSI - 0.05 ? { value: Math.round((inWc / IN_WC_PER_PSI) * 1000) / 1000, unit: "psi" } : { value: Math.round(inWc * 1000) / 1000, unit: "in_wc" };
}

interface SizeGasDetail {
  readonly table: { readonly tableId: string; readonly code: string; readonly edition: string } | null;
  readonly segments: ReadonlyArray<{ readonly id: string; readonly label: string | null; readonly loadMbh: number; readonly sizingLengthFt: number; readonly size: string | null }>;
}

function isSizeGasDetail(v: unknown): v is SizeGasDetail {
  return typeof v === "object" && v !== null && "segments" in v && Array.isArray((v as { segments: unknown }).segments);
}

/**
 * Size every zone of one gas system. Returns the proposal, or the reason it
 * can't (not a gas system, no pipe yet).
 */
export function sizeGasSystem(model: ModelState, systemId: string, ifgc: IfgcEdition, options: { readonly method?: "longest_length" | "branch_length"; readonly elementId?: string; readonly criteria?: DesignCriteria } = {}): { ok: true; sizing: GasSystemSizing; steps: CalcStep[]; issues: CalcIssue[]; cites: Citation[] } | { ok: false; reason: string } {
  const network = gasNetwork(model, systemId, options.elementId ? { anchor: options.elementId } : {});
  if (!network) return { ok: false, reason: `${systemId} isn't a gas pipe system in this model.` };
  if (network.zones.every((z) => z.segments.length === 0)) return { ok: false, reason: `${network.systemName} has no pipe serving a gas appliance yet; route pipe from the source to the appliances first.` };
  const method = options.method ?? network.method;
  const steps: CalcStep[] = [];
  const issues: CalcIssue[] = [];
  const cites: Citation[] = [];
  const findings: GasFinding[] = network.issues.map((i) => ({ ...i }));
  const zones: GasZoneSizing[] = [];
  const need = new Map<string, { inches: number; zoneIds: Set<string>; label: string; current: number | null }>();
  const noFit = new Set<string>();
  for (const zone of network.zones) {
    const sized = sizeZone(zone, network, method, ifgc, options.criteria ?? PERMITZIP_DESIGN_CRITERIA, issues, steps, cites, findings);
    zones.push(sized);
    for (const s of sized.segments) {
      if (!s.elementId) continue;
      const inches = inchesOfLabel(s.size);
      const seg = zone.segments.find((x) => x.id === s.id);
      if (inches === null) {
        noFit.add(s.elementId);
        continue;
      }
      const prev = need.get(s.elementId);
      need.set(s.elementId, { inches: Math.max(prev?.inches ?? 0, inches), zoneIds: new Set([...(prev?.zoneIds ?? []), zone.id]), label: s.label, current: seg?.nominalIn ?? null });
    }
  }
  const proposals: GasPipeProposal[] = [...need.entries()]
    .map(([segmentId, n]): GasPipeProposal => {
      const change = n.current === null ? "up" : n.inches > n.current + 1e-6 ? "up" : n.inches < n.current - 1e-6 ? "down" : "same";
      return { segmentId, label: n.label, currentIn: n.current, proposedIn: n.inches, current: inchText(n.current), proposed: inchText(n.inches) ?? String(n.inches), zoneIds: [...n.zoneIds], change };
    })
    .sort((a, b) => a.segmentId.localeCompare(b.segmentId));
  for (const p of proposals) {
    if (p.change === "up") findings.push({ code: "undersized_gas_pipe", severity: "error", elementId: p.segmentId, zoneId: p.zoneIds[0] ?? null, message: `The ${p.label} is ${p.current ?? "?"}" and needs ${p.proposed}" for the load it carries` });
  }
  for (const id of noFit) if (!need.has(id)) findings.push({ code: "no_size_fits", severity: "error", elementId: id, zoneId: null, message: `No size in the table carries the load on ${id} at its zone's pressure and length; raise the zone's pressure or allowable drop, or split the load` });
  const zoneLabel = new Map(network.zones.map((z) => [z.id, z.label]));
  const regById = new Map(network.regulators.map((g) => [g.elementId, g]));
  const groups = new Map<string, GasEquipmentRow>();
  for (const a of network.appliances) {
    const key = `${a.mark ?? a.elementId}\u0000${a.description}\u0000${a.mbh}`;
    const reg = a.regulatorId ? regById.get(a.regulatorId) : undefined;
    const prev = groups.get(key);
    groups.set(key, {
      mark: a.mark ?? a.elementId,
      description: a.description,
      quantity: (prev?.quantity ?? 0) + 1,
      inputMbh: a.mbh,
      totalMbh: round((prev?.totalMbh ?? 0) + a.mbh, 3),
      regulator: reg ? `${reg.label}, ${pressureLabel(reg.outletInWc)}` : null,
      vent: reg ? reg.vent.replace(/_/g, " ") : null,
      zone: zoneLabel.get(a.zoneId) ?? a.zoneId,
      elementIds: [...(prev?.elementIds ?? []), a.elementId],
    });
  }
  return {
    ok: true,
    sizing: {
      systemId: network.systemId,
      systemName: network.systemName,
      gas: network.gas,
      method,
      sizingMode: network.sizingMode,
      totalMbh: network.totalMbh,
      zones,
      proposals,
      findings,
      equipment: [...groups.values()],
      connections: connectionSizing(network, zones, proposals, method),
      regulators: network.regulators,
    },
    steps,
    issues,
    cites,
  };
}

function connectionSizing(network: GasNetwork, zones: readonly GasZoneSizing[], proposals: readonly GasPipeProposal[], method: "longest_length" | "branch_length"): GasConnectionSizing[] {
  const tableOf = new Map(zones.map((z) => [z.id, z.table]));
  const need = new Map(proposals.map((p) => [p.segmentId, p.proposed]));
  return gasConnectionRowsOf({ ...network, method }).map((row) => {
    const table = tableOf.get(row.zoneId) ?? null;
    const words = row.basis.method === "branch_length" ? "Branch length" : "Longest length";
    return { ...row, table, basisText: `${words}, ${Math.ceil(row.basis.lengthFt - 1e-9)} ft, ${table ?? "402.4 sizing equation"}`, requiredSize: row.feedElementId ? (need.get(row.feedElementId) ?? null) : null };
  });
}

function sizeZone(zone: GasZone, network: GasNetwork, method: "longest_length" | "branch_length", ifgc: IfgcEdition, criteria: DesignCriteria, issues: CalcIssue[], steps: CalcStep[], cites: Citation[], findings: GasFinding[]): GasZoneSizing {
  const material = gasTableMaterial(zone.material);
  const base = {
    id: zone.id,
    label: zone.label,
    regulatorId: zone.regulatorId,
    inlet: pressureLabel(zone.inletInWc),
    allowableDrop: pressureLabel(zone.allowableDropInWc),
    inletInWc: zone.inletInWc,
    allowableDropInWc: zone.allowableDropInWc,
    highPressure: zone.highPressure,
    longestFt: zone.longestFt,
    totalMbh: zone.totalMbh,
    material,
  };
  if (zone.segments.length === 0) return { ...base, table: null, segments: [] };
  if (!material) {
    findings.push({ code: "mixed_material", severity: "warning", elementId: zone.regulatorId, zoneId: zone.id, message: `${zone.label} is ${zone.material ?? "unknown"} pipe, which has no Table 402.4(n) here; size it from the manufacturer's or the code's table for that material` });
    return { ...base, table: null, segments: zone.segments.map((s) => ({ id: s.id, elementId: s.elementId, label: s.label, loadMbh: s.loadMbh, sizingLengthFt: 0, size: null })) };
  }
  const raw = {
    gas: network.gas,
    material,
    inlet: tablePressure(zone.inletInWc),
    drop: tablePressure(zone.allowableDropInWc),
    method,
    basis: "both",
    ...(network.heatingValueBtuPerCf !== (network.gas === "propane" ? 2516 : 1000) ? { heating_value_btu_per_cf: network.heatingValueBtuPerCf } : {}),
    segments: zone.segments.map((s) => ({ id: s.id, parent: s.parent, length_ft: Math.max(s.lengthFt, 0.01), load_mbh: s.loadMbh, label: s.label })),
  };
  const r = sizeGasCalc.execute(raw, { code: ifgc, criteria, model: null });
  if (!r.ok) {
    issues.push({ severity: "error", message: `${zone.label}: ${r.reason}`, cite: [] });
    return { ...base, table: null, segments: [] };
  }
  for (const i of r.output.issues) issues.push({ ...i, message: `${zone.label}: ${i.message}` });
  for (const v of r.output.values) for (const c of v.cite) cites.push(c);
  steps.push({ label: zone.label, detail: `${pressureLabel(zone.inletInWc)}, ${pressureLabel(zone.allowableDropInWc)} drop, ${round(zone.totalMbh, 3)} MBH, longest ${round(zone.longestFt, 1)} ft`, cite: [ifgcCite(ifgc, zone.regulatorId ? "hybrid_pressure" : method)] });
  for (const s of r.output.steps.slice(1)) steps.push({ ...s, label: `${zone.label} · ${s.label}` });
  const detail = isSizeGasDetail(r.output.detail) ? r.output.detail : null;
  const byId = new Map((detail?.segments ?? []).map((s) => [s.id, s]));
  return {
    ...base,
    table: detail?.table ? `${detail.table.code} ${detail.table.edition} ${detail.table.tableId}` : null,
    segments: zone.segments.map((s) => {
      const d = byId.get(s.id);
      return { id: s.id, elementId: s.elementId, label: s.label, loadMbh: d?.loadMbh ?? s.loadMbh, sizingLengthFt: d?.sizingLengthFt ?? 0, size: d?.size ?? null };
    }),
  };
}

const gasSystemInput = z
  .object({
    system_id: z.string().min(1).max(200).describe("The gas system (mep_system) id."),
    element_id: z.string().min(1).max(200).optional().describe("Any pipe in it (picks the connected piece)."),
    method: z.enum(["longest_length", "branch_length"]).optional().describe("402.4.1 or 402.4.2; default the system's."),
  })
  .strict();

export const gasSystemCalc = defineCalc({
  id: "plumbing.gas_system",
  version: "1.0.0",
  domain: "plumbing",
  title: "Gas system sizing by pressure zone (IFGC 402.4)",
  summary: "Sizes a drawn gas system zone by zone (each regulator starts a zone at its outlet pressure and allowable drop) from the Table 402.4(n) for the gas, material and pressure, by longest or branch length. Returns each pipe's needed size against the drawn size, findings (undersized pipe, regulator missing between zones, appliance below its minimum inlet), the gas equipment schedule, each outlet's developed length and sizing basis, and total input. Proposes only; bim_size_pipes applies it.",
  codeFamily: "ifgc",
  needsModel: true,
  input: gasSystemInput,
  example: { system_id: "sys-gas" },
  run: (input, ctx) => {
    if (!isIfgcEdition(ctx.code)) throw new Error("This calc needs the fuel gas code pack.");
    if (!ctx.model) return { values: [], steps: [], issues: [{ severity: "error", message: "Give the model to size.", cite: [] }], detail: null };
    const r = sizeGasSystem(ctx.model, input.system_id, ctx.code, { criteria: ctx.criteria, ...(input.method ? { method: input.method } : {}), ...(input.element_id ? { elementId: input.element_id } : {}) });
    if (!r.ok) return { values: [], steps: [], issues: [{ severity: "error", message: r.reason, cite: [] }], detail: null };
    const s = r.sizing;
    const cite = [ifgcCite(ctx.code, "hybrid_pressure"), ifgcCite(ctx.code, s.method)];
    const findingIssues: CalcIssue[] = s.findings.map((f) => ({ severity: f.severity, message: f.message, cite }));
    const values: CalcValue[] = [
      { key: "total_mbh", label: "Connected gas input", value: s.totalMbh, unit: "mbh", cite: [] },
      { key: "zones", label: "Pressure zones", value: s.zones.length, unit: null, cite },
      { key: "pipes_to_resize", label: "Pipes that need another size", value: s.proposals.filter((p) => p.change !== "same").length, unit: null, cite },
      ...s.zones.map((z): CalcValue => ({ key: `zone:${z.id}`, label: z.label, value: `${z.inlet}, ${z.allowableDrop} drop, ${z.totalMbh} MBH over ${z.longestFt} ft${z.table ? `, ${z.table}` : ", equation"}`, unit: null, cite })),
      ...s.proposals.map((p): CalcValue => ({ key: `size:${p.segmentId}`, label: `${p.label} (drawn ${p.current ?? "?"}")`, value: p.proposed, unit: "in", cite })),
      ...s.proposals.map((p): CalcValue => ({ key: `size_nominal_in:${p.segmentId}`, label: `${p.label}, nominal inches`, value: p.proposedIn, unit: "in", cite })),
    ];
    return { values, steps: r.steps, issues: [...findingIssues, ...r.issues], detail: s };
  },
});
