import { z } from "zod";
import { FITTING_SLOTS, PIPE_MATERIALS, PIPE_SPEC_IDS, SYSTEM_KINDS, defaultPipeSpec, fittingFamily, pipeDefaultChoice, pipeFamilyOf, pipeJointLabel, pipeSpec, pipeSpecLabel, systemKindSchema, type FittingSlot, type PipeServiceOf, type SystemKind } from "@permitzip/bim-kernel";

/**
 * Pipe types (round 12 P12: moved from the kernel byte for byte; the stored
 * `pipe_type` record and its `etype:pipe:` ids are frozen): what a firm calls a pipe it specifies ("DW-PEX", "SAN-PVC",
 * "GAS-SCH40"): the material and product standard, the sizes it comes in, how
 * it is joined, which systems it may carry, and any fitting the engineer
 * picks over the library's choice for that material. The electrical twin is
 * the feeder type (F225); both are records in the project's catalog.
 *
 * Fittings follow the material: with no override, a slot takes the library's
 * first fitting made in the type's material for that service (a cast iron
 * sanitary type gets no-hub drainage fittings, a PEX water type PEX ones).
 */

const PIPE_SERVICES_FOR_SLOTS: Readonly<Record<PipeServiceOf, readonly FittingSlot[]>> = {
  water: ["pipe_elbow_90", "pipe_elbow_45", "pipe_tee", "pipe_reducer", "pipe_cap"],
  gas: ["pipe_elbow_90", "pipe_elbow_45", "pipe_tee", "pipe_reducer", "pipe_cap"],
  drainage: ["drain_turn_hv", "drain_turn_vh", "drain_turn_hh", "drain_turn_45", "drain_branch_hv", "drain_branch_hh", "pipe_reducer", "pipe_cap"],
  vent: ["pipe_elbow_90", "pipe_elbow_45", "pipe_tee", "pipe_reducer", "pipe_cap"],
};

export const PIPE_SLOT_LABEL: Readonly<Partial<Record<FittingSlot, string>>> = {
  pipe_elbow_90: "90° elbows",
  pipe_elbow_45: "45° elbows",
  pipe_tee: "Tees",
  pipe_reducer: "Reducers",
  pipe_cap: "Caps",
  drain_turn_hv: "Turns, level into a stack",
  drain_turn_vh: "Turns, stack to level",
  drain_turn_hh: "Turns, level to level",
  drain_turn_45: "1/8 bends",
  drain_branch_hv: "Branches into a stack",
  drain_branch_hh: "Branches, level",
};

const key = (max: number) => z.string().trim().min(1).max(max);
const inches = z.number().positive().max(48);

export const pipeTypeSchema = z
  .object({
    type: z.literal("pipe_type"),
    /** The name on drawings and in the piping specifications schedule ("DW-PEX"). */
    name: key(40),
    description: z.string().trim().max(160).default(""),
    material: z.enum(PIPE_MATERIALS),
    /** Product standard; absent: the material's usual one. */
    spec: z.enum(PIPE_SPEC_IDS).optional(),
    /** Systems it may carry; empty: any system the material suits. */
    systemKinds: z.array(systemKindSchema).max(SYSTEM_KINDS.length).default([]),
    minIn: inches.optional(),
    maxIn: inches.optional(),
    /** How it is joined, as the spec names it ("press", "no_hub"); absent: the spec's usual joint. */
    joint: key(24).optional(),
    /** Per slot, a fitting the engineer picked over the library's choice for the material. */
    fittings: z.partialRecord(z.enum(FITTING_SLOTS), key(80)).default({}),
    /** Where it may run, as the firm writes it ("above grade, non-plenum"). */
    note: z.string().trim().max(200).default(""),
  })
  .refine((t) => t.minIn === undefined || t.maxIn === undefined || t.minIn <= t.maxIn, { message: "the smallest size is larger than the largest", path: ["minIn"] });

export type PipeTypeEntry = z.infer<typeof pipeTypeSchema>;
export type PipeTypeInput = z.input<typeof pipeTypeSchema>;

function entry(input: Omit<PipeTypeInput, "type">): PipeTypeEntry {
  return pipeTypeSchema.parse({ ...input, type: "pipe_type" });
}

/** The firm's starting pipe types, from common MEP piping specifications. A project's own record of the same name wins. */
export const BUILTIN_PIPE_TYPES: readonly PipeTypeEntry[] = [
  entry({ name: "DW-PEX", description: "Domestic water, PEX", material: "pex", systemKinds: ["domestic_cold_water", "domestic_hot_water", "domestic_hot_water_return"], minIn: 0.5, maxIn: 1, joint: "pex_expansion", note: "Non-plenum, 1/2\" to 1\"" }),
  entry({ name: "DW-CPVC", description: "Domestic water, CPVC", material: "cpvc", systemKinds: ["domestic_cold_water", "domestic_hot_water", "domestic_hot_water_return"], minIn: 1.25, maxIn: 4, note: "Non-plenum, 1-1/4\" to 4\"" }),
  entry({ name: "DW-CU-L", description: "Domestic water, copper type L", material: "copper", spec: "type_l", systemKinds: ["domestic_cold_water", "domestic_hot_water", "domestic_hot_water_return"], joint: "press", note: "Plenum and exposed" }),
  entry({ name: "SAN-PVC", description: "Sanitary, waste and vent, PVC DWV", material: "pvc", systemKinds: ["sanitary", "vent", "storm", "condensate"], note: "Non-plenum" }),
  entry({ name: "SAN-CI", description: "Sanitary, waste and vent, hubless cast iron", material: "cast_iron", spec: "no_hub", systemKinds: ["sanitary", "vent", "storm"], joint: "no_hub", note: "Plenum" }),
  entry({ name: "GAS-SCH40", description: "Fuel gas, Schedule 40 black steel, threaded", material: "black_steel", spec: "sch40", systemKinds: ["natural_gas"], joint: "threaded" }),
  entry({ name: "GAS-CSST", description: "Fuel gas, CSST", material: "csst", systemKinds: ["natural_gas"], note: "Bond per the manufacturer" }),
  entry({ name: "GAS-PE", description: "Fuel gas, polyethylene (PE), below grade", material: "pe", spec: "sdr11", systemKinds: ["natural_gas"], joint: "fusion", note: "Below grade only; listed transition fitting where it rises" }),
  entry({ name: "HW-CU-L", description: "Heating water, copper type L", material: "copper", spec: "type_l", systemKinds: ["hydronic_supply", "hydronic_return"] }),
];

/** The stored spec a pipe type means: its own, else its material's default product's (undefined when no add-on here makes the material). */
export function pipeTypeSpec(t: Pick<PipeTypeEntry, "material" | "spec">): string | undefined {
  return t.spec ?? defaultPipeSpec(t.material);
}

/** Why a pipe type can't carry a system of this kind, or null. */
export function pipeTypeMismatch(t: PipeTypeEntry, kind: SystemKind): string | null {
  if (t.systemKinds.length > 0 && !t.systemKinds.includes(kind)) return `${t.name} is for ${t.systemKinds.map((k) => k.replace(/_/g, " ")).join(", ")}`;
  const service = pipeFamilyOf(kind);
  const spec = pipeSpec(t.material, t.spec);
  if (!service) return `${kind.replace(/_/g, " ")} is not piped`;
  const want = service === "vent" ? "drainage" : service;
  if (spec && !spec.services.includes(want)) return `${spec.specLabel} is not made for ${want === "drainage" ? "drainage" : want === "gas" ? "fuel gas" : "water"}`;
  return null;
}

export interface PipeTypeFitting {
  readonly slot: FittingSlot;
  readonly label: string;
  readonly familyId: string;
  readonly familyName: string;
  /** The engineer picked it on the type (otherwise it follows the material). */
  readonly picked: boolean;
}

/**
 * The fitting a pipe type places in each slot on a system of this kind: the
 * type's pick, else the library's first fitting made in its material.
 */
export function pipeTypeFittings(t: PipeTypeEntry, kind: SystemKind): readonly PipeTypeFitting[] {
  const service = pipeFamilyOf(kind);
  if (!service) return [];
  const size = { shape: "pipe" as const, nominalMm: (t.minIn ?? 2) * 25.4, material: t.material, ...(t.spec ? { spec: t.spec } : {}) };
  return PIPE_SERVICES_FOR_SLOTS[service].map((slot) => {
    const picked = t.fittings[slot];
    const familyId = picked ?? pipeDefaultChoice(kind, slot, size).family;
    return { slot, label: PIPE_SLOT_LABEL[slot] ?? slot, familyId, familyName: fittingFamily(familyId)?.name ?? familyId, picked: picked !== undefined };
  });
}

/** One line for pickers and the specifications schedule: "PEX, ASTM F876 SDR 9, expansion, 1/2\"–1\"". */
export function pipeTypeSummary(t: PipeTypeEntry): string {
  const stored = pipeTypeSpec(t);
  const spec = stored !== undefined ? pipeSpecLabel(stored) : undefined;
  const joint = t.joint ? (pipeJointLabel(t.joint) ?? t.joint) : undefined;
  const sizes = t.minIn !== undefined || t.maxIn !== undefined ? `${t.minIn !== undefined ? inchText(t.minIn) : "any"}–${t.maxIn !== undefined ? inchText(t.maxIn) : "any"}` : null;
  return [spec, joint, sizes].filter((s): s is string => Boolean(s)).join(", ");
}

const FRACTIONS: Readonly<Record<string, string>> = { "0.25": "1/4", "0.375": "3/8", "0.5": "1/2", "0.75": "3/4", "1.25": "1-1/4", "1.5": "1-1/2", "2.5": "2-1/2" };

function inchText(v: number): string {
  return `${FRACTIONS[String(v)] ?? String(v)}"`;
}

/** Whether a nominal size (inches) is one this type comes in. */
export function pipeTypeAllowsSize(t: PipeTypeEntry, nominalIn: number): boolean {
  return (t.minIn === undefined || nominalIn >= t.minIn - 1e-6) && (t.maxIn === undefined || nominalIn <= t.maxIn + 1e-6);
}

