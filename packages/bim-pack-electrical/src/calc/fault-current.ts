import { paramValue, serviceLinkName, type BimElement, type PartInstance } from "@permitzip/bim-kernel";
import { linkConstruction } from "../catalog/feeder-types";
import { distributionOf } from "../connections/systems";
import { feederOf } from "../connections/panel";
import { z } from "zod";
import { CONDUCTOR_SIZES, parseConductorSize, sizeLabel, type ConductorSize, type CalcIssue, type CalcOutput, type CalcStep, type CalcValue, type Citation, SQRT3, round } from "@permitzip/bim-calc";

/**
 * Available fault current by the point-to-point method (Eaton Bussmann),
 * the same method and C values as the `elec-short-circuit` skill: from the
 * utility's available fault current or a transformer's secondary, through
 * each feeder (f = √3·L·I / (C·n·E) three-phase, 2·L·I / (C·n·E) single-phase;
 * M = 1 / (1 + f)), to every panel, checked against its interrupting rating.
 *
 * Preview: motor contribution and X/R are not modelled; a full short-circuit
 * study governs. Registered only in the preview calc list.
 */

const METHOD: Citation = { source: "method", code: "Eaton Bussmann", edition: null, clause: "Point-to-point method", text: "Eaton Bussmann point-to-point short-circuit method" };
const C_TABLE: Citation = { source: "method", code: "Eaton Bussmann", edition: null, clause: "C values for conductors", text: "Eaton Bussmann C values for conductors (600 V, 60 Hz)" };

type Raceway = "steel" | "nonmagnetic";
type Row = readonly [number, number];
type CTable = Readonly<Partial<Record<ConductorSize, Row>>>;

/** [three-phase C, single-phase C] by size. */
const CU_STEEL: CTable = { "14": [389, 281], "12": [617, 446], "10": [981, 709], "8": [1557, 1128], "6": [2425, 1736], "4": [3806, 2712], "3": [4774, 3421], "2": [5985, 4295], "1": [7493, 5376], "1/0": [9390, 6716], "2/0": [11764, 8430], "3/0": [14777, 10560], "4/0": [18566, 13211], "250": [21389, 15222], "300": [25704, 18226], "350": [29454, 20862], "400": [32938, 23253], "500": [38988, 27452], "600": [44254, 31066], "750": [50699, 35479] };
const CU_NONMAG: CTable = { "14": [389, 281], "12": [617, 446], "10": [981, 709], "8": [1603, 1160], "6": [2525, 1809], "4": [4015, 2877], "3": [5062, 3666], "2": [6417, 4664], "1": [8127, 5909], "1/0": [10322, 7489], "2/0": [13184, 9568], "3/0": [16802, 12233], "4/0": [21468, 15694], "250": [25238, 18394], "300": [30750, 22311], "350": [35669, 25811], "400": [40268, 29016], "500": [48627, 34898], "600": [56042, 40239], "750": [65504, 46897] };
const AL_STEEL: CTable = { "8": [1053, 769], "6": [1631, 1165], "4": [2566, 1822], "3": [3237, 2311], "2": [4066, 2909], "1": [5133, 3677], "1/0": [6437, 4594], "2/0": [8069, 5765], "3/0": [10179, 7286], "4/0": [12886, 9177], "250": [14925, 10682], "300": [17993, 12800], "350": [20692, 14800], "400": [23170, 16510], "500": [27551, 19616], "600": [31299, 22287], "750": [36036, 25750] };
const AL_NONMAG: CTable = { "8": [1084, 792], "6": [1699, 1213], "4": [2712, 1936], "3": [3451, 2493], "2": [4373, 3181], "1": [5596, 4070], "1/0": [7098, 5158], "2/0": [9019, 6587], "3/0": [11526, 8494], "4/0": [14813, 10826], "250": [17660, 12887], "300": [21558, 15741], "350": [25238, 18411], "400": [28560, 20771], "500": [34920, 25196], "600": [40596, 29381], "750": [47565, 34270] };

export function cValue(size: ConductorSize, material: "copper" | "aluminum", raceway: Raceway, phases: 1 | 3): number | null {
  const table = material === "copper" ? (raceway === "steel" ? CU_STEEL : CU_NONMAG) : raceway === "steel" ? AL_STEEL : AL_NONMAG;
  const row = table[size];
  return row ? (phases === 3 ? row[0] : row[1]) : null;
}

const size = z
  .string()
  .trim()
  .min(1)
  .max(20)
  .transform((text, check): ConductorSize => {
    const parsed = parseConductorSize(text);
    if (parsed) return parsed;
    check.addIssue({ code: "custom", message: `"${text}" isn't a conductor size (${CONDUCTOR_SIZES.slice(0, 4).join(", ")}, …, 1/0, 250, 500)` });
    return z.NEVER;
  });

export const faultCurrentInput = z
  .object({
    source: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("utility"), available_a: z.number().positive().max(500_000).describe("The utility's available fault current at the service, A."), voltage_v: z.number().positive().max(1000), phases: z.union([z.literal(1), z.literal(3)]) }).strict(),
      z
        .object({
          kind: z.literal("transformer"),
          kva: z.number().positive().max(10_000),
          voltage_v: z.number().positive().max(1000).describe("Secondary line-to-line voltage."),
          phases: z.union([z.literal(1), z.literal(3)]),
          impedance_pct: z.number().positive().max(20).describe("Nameplate %Z."),
          primary_available_a: z.number().positive().max(500_000).optional().describe("Fault current available at the primary; absent means an infinite bus (conservative)."),
          primary_voltage_v: z.number().positive().max(50_000).optional(),
        })
        .strict(),
    ]),
    nodes: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(60),
            fed_from: z.string().trim().min(1).max(60).describe('The node feeding it, or "source".'),
            size,
            material: z.enum(["copper", "aluminum"]).default("copper"),
            sets: z.number().int().min(1).max(20).default(1).describe("Conductors in parallel per phase."),
            raceway: z.enum(["steel", "nonmagnetic"]).default("steel").describe("Steel (EMT, IMC, RGS) or non-magnetic (PVC, aluminum)."),
            length_ft: z.number().min(0).max(10_000),
            aic_ka: z.number().positive().max(300).optional().describe("Equipment interrupting rating, kA (from the schedule)."),
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict();

export type FaultCurrentInput = z.infer<typeof faultCurrentInput>;

export interface FaultNode {
  readonly name: string;
  readonly fedFrom: string;
  readonly startA: number;
  readonly f: number;
  readonly m: number;
  readonly availableA: number;
  readonly aicKa: number | null;
  readonly passes: boolean | null;
}

export interface FaultCurrentDetail {
  readonly sourceA: number;
  readonly nodes: readonly FaultNode[];
}

export function faultCurrent(input: FaultCurrentInput): CalcOutput<FaultCurrentDetail> {
  const steps: CalcStep[] = [];
  const issues: CalcIssue[] = [];
  const values: CalcValue[] = [];
  const src = input.source;
  const e = src.voltage_v;
  const phases = src.phases;
  let sourceA: number;
  if (src.kind === "utility") {
    sourceA = src.available_a;
    steps.push({ label: "Source", detail: `Utility available fault current ${Math.round(sourceA).toLocaleString("en-US")} A at ${e} V`, cite: [METHOD] });
  } else {
    const fla = (src.kva * 1000) / (phases === 3 ? SQRT3 * e : e);
    const z = src.impedance_pct / 100;
    sourceA = src.primary_available_a ? fla / Math.sqrt(z * z + (fla / src.primary_available_a) ** 2) : fla / z;
    steps.push({ label: "Transformer secondary", detail: `${src.kva} kVA at ${e} V: ${round(fla, 0)} A full load ÷ ${src.impedance_pct}% Z${src.primary_available_a ? `, with ${Math.round(src.primary_available_a).toLocaleString("en-US")} A at the primary` : " (infinite bus)"} = ${Math.round(sourceA).toLocaleString("en-US")} A`, cite: [METHOD] });
    if (!src.primary_available_a) issues.push({ severity: "info", message: "Infinite primary assumed: the secondary fault current is the most it can be.", cite: [METHOD] });
  }
  values.push({ key: "source_a", label: "Available fault current at the source", value: Math.round(sourceA), unit: "A", cite: [METHOD] });

  const byName = new Map<string, FaultNode>();
  const pending = [...input.nodes];
  const out: FaultNode[] = [];
  for (let guard = 0; pending.length > 0 && guard < input.nodes.length + 1; guard++) {
    for (let i = 0; i < pending.length; ) {
      const n = pending[i];
      if (!n) break;
      const startA = n.fed_from.toLowerCase() === "source" ? sourceA : byName.get(n.fed_from)?.availableA;
      if (startA === undefined) {
        i++;
        continue;
      }
      pending.splice(i, 1);
      const c = cValue(n.size, n.material, n.raceway, phases);
      if (c === null) {
        issues.push({ severity: "error", message: `${n.name}: no C value for ${sizeLabel(n.size)} ${n.material} in ${n.raceway} raceway`, cite: [C_TABLE] });
        continue;
      }
      const f = ((phases === 3 ? SQRT3 : 2) * n.length_ft * startA) / (c * n.sets * e);
      const m = 1 / (1 + f);
      const availableA = startA * m;
      const passes = n.aic_ka === undefined ? null : n.aic_ka * 1000 >= availableA;
      const node: FaultNode = { name: n.name, fedFrom: n.fed_from, startA, f, m, availableA, aicKa: n.aic_ka ?? null, passes };
      byName.set(n.name, node);
      out.push(node);
      steps.push({ label: n.name, detail: `${n.sets > 1 ? `${n.sets} sets of ` : ""}${sizeLabel(n.size)} ${n.material === "copper" ? "Cu" : "Al"}, ${n.length_ft} ft, C = ${c.toLocaleString("en-US")}: f = ${round(f, 4)}, M = ${round(m, 4)} → ${Math.round(availableA).toLocaleString("en-US")} A${passes === null ? "" : passes ? `, within ${n.aic_ka} kA` : `, over its ${n.aic_ka} kA rating`}`, cite: [METHOD, C_TABLE] });
      values.push({ key: `afc_${n.name}`, label: `Available fault current at ${n.name}`, value: Math.round(availableA), unit: "A", cite: [METHOD] });
      if (passes === false) issues.push({ severity: "error", message: `${n.name}: ${Math.round(availableA).toLocaleString("en-US")} A available is more than its ${n.aic_ka} kA interrupting rating.`, cite: [METHOD] });
    }
  }
  for (const n of pending) issues.push({ severity: "error", message: `${n.name} is fed from "${n.fed_from}", which isn't "source" or another node`, cite: [] });
  issues.push({ severity: "info", message: "Preview: motor contribution and X/R are not included; a full short-circuit study governs.", cite: [METHOD] });
  return { values, steps, issues, detail: { sourceA, nodes: out } };
}

/**
 * Available fault current through the model's own distribution, for the
 * panel view, the one-line and the coordination lint: from the value entered
 * on a source (the utility's letter, a study) down each feeder (its length and
 * conductors, or its feeder type's) and through each transformer (kVA, %Z),
 * point to point, to every panel, compared with its interrupting rating.
 *
 * Nothing is guessed. A feeder with no length or conductors is taken as 0 ft
 * (the panel sees all the current upstream, the most it could), and the trail
 * says so; a transformer with no %Z, or a source with no value entered, stops
 * the calculation below it with the reason.
 */

/** Instance values a source or transformer carries for this (CONNECTION_TYPE_PARAM-style: any distribution equipment may hold them). */
export const AVAILABLE_FAULT_PARAM = "available_fault_current";
export const IMPEDANCE_PARAM = "impedance_pct";

export interface ModelFaultNode {
  readonly elementId: string;
  readonly name: string;
  /** Amps available at its line terminals; null when it can't be calculated (see `reason`). */
  readonly availableA: number | null;
  /** Interrupting or short-circuit rating, amps; null when the equipment states none. */
  readonly ratingA: number | null;
  /** Rating at least the available fault current; null when either is unknown. */
  readonly passes: boolean | null;
  /** The value was entered here (a utility letter or a study), not calculated. */
  readonly entered: boolean;
  /** Source to here, one line per step, with the numbers. */
  readonly trail: readonly string[];
  /** The same steps in a few words each, for a one-line finding: "22,000 A at MDP", "100 ft 3/0 Cu". */
  readonly chain: readonly string[];
  /** Why there is no number, in plain words. */
  readonly reason: string | null;
}

type ModelElements = Readonly<Record<string, BimElement>>;

function partNumber(elements: ModelElements, part: PartInstance, ...names: string[]): number | null {
  const type = elements[part.typeId];
  if (type?.kind !== "part_type") return null;
  for (const n of names) {
    const v = paramValue(type.definition, part.values, n);
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) && Number(v) > 0) return Number(v);
  }
  return null;
}

const amps = (a: number) => `${Math.round(a).toLocaleString("en-US")} A`;

/** The rating a panel prints (`aic`, amps; a value under 1,000 is read as kA, as schedules write "22"). */
export function interruptingRatingA(elements: ModelElements, part: PartInstance): number | null {
  const v = partNumber(elements, part, "aic", "sccr", "kaic", "aic_rating");
  return v === null ? null : v < 1000 ? v * 1000 : v;
}

/** One feeder by the point-to-point method: f = √3·L·I / (C·n·E) three-phase, 2·L·I / (C·n·E) single-phase; M = 1 / (1 + f). */
export function conductorFaultStep(startA: number, run: { readonly lengthFt: number; readonly size: ConductorSize; readonly material: "copper" | "aluminum"; readonly raceway: Raceway; readonly sets: number; readonly voltageV: number; readonly phases: 1 | 3 }): { readonly c: number; readonly f: number; readonly m: number; readonly availableA: number } | null {
  const c = cValue(run.size, run.material, run.raceway, run.phases);
  if (c === null) return null;
  const f = ((run.phases === 3 ? SQRT3 : 2) * run.lengthFt * startA) / (c * run.sets * run.voltageV);
  const m = 1 / (1 + f);
  return { c, f, m, availableA: startA * m };
}

/** A transformer by the point-to-point method: f = I·Vp·√3·%Z / (100,000·kVA) three-phase, I·Vp·%Z / (100,000·kVA) single-phase; M = 1 / (1 + f); I secondary = Vp / Vs · M · I primary. */
export function transformerFaultStep(primaryA: number, t: { readonly kva: number; readonly primaryV: number; readonly secondaryV: number; readonly impedancePct: number; readonly phases: 1 | 3 }): { readonly f: number; readonly m: number; readonly availableA: number } {
  const f = (primaryA * t.primaryV * (t.phases === 3 ? SQRT3 : 1) * t.impedancePct) / (100_000 * t.kva);
  const m = 1 / (1 + f);
  return { f, m, availableA: (t.primaryV / t.secondaryV) * m * primaryA };
}

function racewayOf(type: string | undefined): { readonly raceway: Raceway; readonly assumed: boolean } {
  if (!type) return { raceway: "nonmagnetic", assumed: true };
  return /pvc|hdpe|fiber|alum|nonmet/i.test(type) ? { raceway: "nonmagnetic", assumed: false } : /emt|imc|rmc|rgs|steel|gal/i.test(type) ? { raceway: "steel", assumed: false } : { raceway: "nonmagnetic", assumed: true };
}

const faultCache = new WeakMap<ModelElements, Map<string, ModelFaultNode>>();

/** Available fault current at a piece of distribution equipment (cached per model revision); null when it isn't distribution equipment. */
export function faultCurrentAt(elements: ModelElements, partId: string): ModelFaultNode | null {
  let memo = faultCache.get(elements);
  if (!memo) {
    memo = new Map();
    faultCache.set(elements, memo);
  }
  return nodeAt(elements, partId, memo, new Set());
}

function nodeAt(elements: ModelElements, partId: string, memo: Map<string, ModelFaultNode>, visiting: Set<string>): ModelFaultNode | null {
  const cached = memo.get(partId);
  if (cached) return cached;
  const part = elements[partId];
  if (part?.kind !== "part") return null;
  const info = distributionOf(elements, part);
  if (!info) return null;
  const ratingA = interruptingRatingA(elements, part);
  const done = (availableA: number | null, trail: readonly string[], reason: string | null, chain: readonly string[] = [], entered = false): ModelFaultNode => {
    const node: ModelFaultNode = { elementId: partId, name: info.name, availableA, ratingA, passes: availableA === null || ratingA === null ? null : ratingA >= availableA - 0.5, entered, trail, chain, reason };
    memo.set(partId, node);
    return node;
  };
  const entered = partNumber(elements, part, AVAILABLE_FAULT_PARAM);
  if (entered !== null) return done(entered, [`${info.name}: ${amps(entered)} available, as entered (from the utility or a study)`], null, [`${amps(entered)} at ${info.name}`], true);
  const feeder = feederOf(elements, part);
  if (!feeder) return done(null, [], `Nothing feeds ${info.name} and no available fault current is entered on it (the utility's figure goes on the service equipment)`);
  if (visiting.has(partId)) return done(null, [], `${info.name} is fed in a loop`);
  visiting.add(partId);
  const parentPart = elements[feeder.source.elementId];
  const parent = nodeAt(elements, feeder.source.elementId, memo, visiting);
  visiting.delete(partId);
  if (!parent || parentPart?.kind !== "part") return done(null, [], `${info.name}'s feeder comes from something that isn't distribution equipment`);
  if (parent.availableA === null) return done(null, parent.trail, `Not known at ${parent.name}, which feeds it: ${parent.reason ?? "no value"}`);
  const parentInfo = distributionOf(elements, parentPart);
  const trail = [...parent.trail];
  const chain = [...parent.chain];
  let startA = parent.availableA;
  let system = parentInfo?.system ?? info.supply;
  if (parentInfo?.kind === "transformer") {
    const z = partNumber(elements, parentPart, IMPEDANCE_PARAM, "z_pct", "impedance");
    const kva = parentInfo.kva;
    if (z === null || kva === null) return done(null, trail, `${parentInfo.name}'s ${z === null ? "impedance (%Z, from its nameplate)" : "kVA"} isn't entered, so the fault current on its secondary can't be calculated`);
    const phases: 1 | 3 = parentInfo.system.phases === 3 ? 3 : 1;
    const t = transformerFaultStep(startA, { kva, primaryV: parentInfo.supply.lineToLine, secondaryV: parentInfo.system.lineToLine, impedancePct: z, phases });
    trail.push(`${parentInfo.name} secondary: ${kva} kVA, ${z}% Z, ${parentInfo.supply.lineToLine}/${parentInfo.system.lineToLine} V: f = ${round(t.f, 4)}, M = ${round(t.m, 4)} → ${amps(t.availableA)}`);
    chain.push(`${parentInfo.name} ${kva} kVA ${z}%Z`);
    startA = t.availableA;
    system = parentInfo.system;
  }
  const phases: 1 | 3 = system.phases === 3 ? 3 : 1;
  const voltageV = system.lineToLine;
  const feederName = serviceLinkName(elements, feeder);
  const construction = linkConstruction(elements, feeder);
  const lengthFt = feeder.electrical?.lengthFt;
  const conductors = construction.conductors;
  const size = conductors ? parseConductorSize(conductors.phaseSize) : null;
  if (lengthFt === undefined || !conductors || !size) {
    const missing = lengthFt === undefined ? "no length" : "no conductor size";
    trail.push(`Feeder ${feederName}: ${missing}, taken as 0 ft, so ${info.name} sees all ${amps(startA)} (the most it could)`);
    chain.push(`${missing} (0 ft)`);
    return done(startA, trail, null, chain);
  }
  const material = conductors.material === "al" ? "aluminum" : "copper";
  const rw = racewayOf(construction.feederType?.conduit?.type);
  const step = conductorFaultStep(startA, { lengthFt, size, material, raceway: rw.raceway, sets: conductors.sets, voltageV, phases });
  if (!step) return done(null, trail, `There is no C value for ${sizeLabel(size)} ${material} in ${rw.raceway} raceway, so ${feederName} can't be calculated`);
  trail.push(
    `Feeder ${feederName}: ${conductors.sets > 1 ? `${conductors.sets} sets of ` : ""}${sizeLabel(size)} ${material === "copper" ? "Cu" : "Al"} in ${rw.raceway === "steel" ? "steel" : "non-magnetic"} raceway${rw.assumed ? " (raceway not stated: non-magnetic, the higher fault current)" : ""}, ${lengthFt} ft, C = ${step.c.toLocaleString("en-US")}, ${voltageV} V ${phases}-phase: f = ${round(step.f, 4)}, M = ${round(step.m, 4)} → ${amps(step.availableA)}`,
  );
  chain.push(`${lengthFt} ft ${conductors.sets > 1 ? `${conductors.sets}×` : ""}${sizeLabel(size)} ${material === "copper" ? "Cu" : "Al"}`);
  return done(step.availableA, trail, null, chain);
}

/** One line for a panel header: "14,312 A available, 65 kAIC: OK" / "… over its 10 kAIC rating" / why it's unknown. */
export function faultCurrentSummary(node: ModelFaultNode): string {
  if (node.availableA === null) return node.reason ?? "Available fault current not known";
  const rating = node.ratingA === null ? "no interrupting rating stated" : `${round(node.ratingA / 1000, 1)} kAIC`;
  const verdict = node.passes === null ? "" : node.passes ? ": OK" : ": rating below the available fault current";
  return `${amps(node.availableA)} available${node.entered ? " (entered)" : ""}, ${rating}${verdict}`;
}
