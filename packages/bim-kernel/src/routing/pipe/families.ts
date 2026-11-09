import type { SystemKind } from "../../parts";
import { packFittingDefault, packFittingFamily, packFittingFamilyRow } from "../../registry/fitting-family-point";
import type { FittingFamily } from "../fittings/library";
import type { FittingChoice, FittingSlot, FittingType, PipeMaterial, RunSize } from "../types";
import { serviceOf, type DirectionRule, type PipeServiceOf } from "./design";
import { PIPE_JOINT_END_TYPE_PARAM, endTypeOfStoredJoint, pipeJointEndType, pipeJointLabel, pipeProductTable, specOfSize, storedJointName } from "./specs";

/**
 * Pipe fitting families as the kernel reads them. Which families exist,
 * what they are made of and which one fills each slot are rows of
 * `FITTING_FAMILY_POINT` (round 12: a first-party add-on ships the built-in
 * catalogue). The kernel keeps the shape of a pipe family, the slot
 * a fitting fills, and the generic product and joint checks.
 */

export type PipeForm = "bend" | "tee" | "reducer" | "cap" | "inline" | "trap" | "drip_leg";

export type AccessoryKind = "valve" | "union" | "coupling" | "cleanout" | "test_tee" | "trap" | "drip_leg" | "gas_cock" | "prv" | "regulator";

export interface PipeFamilyInfo {
  /** What it carries, by a service row's pipe family. */
  readonly services: readonly PipeServiceOf[];
  readonly materials: readonly PipeMaterial[];
  /** The joints it is made with, by the stored name a fitting keeps (`params.joint`; an end type's `stored` name). Frozen once stored. */
  readonly joints: readonly string[];
  readonly form: PipeForm;
  /** Bends: centreline radius over the pipe's outside diameter. */
  readonly rOverD?: number;
  /** Branches: the angle the branch meets the run at, and whether it sweeps into it. */
  readonly branch?: { readonly angleDeg: number; readonly sweep: boolean };
  /** Inline items: laying length over the outside diameter. */
  readonly layingOverOd?: number;
  /** Typical equivalent length in diameters, per path. */
  readonly lOverD?: { readonly body?: number; readonly branch?: number; readonly main?: number };
  /** Gravity systems: where it may change the flow's direction. Absent: anywhere. */
  readonly direction?: DirectionRule;
  /** No sweep, so it can't take gravity flow (the add-on's fit rule reads it). */
  readonly ventOnly?: boolean;
  /** Made in these nominal sizes only (inches). */
  readonly sizesIn?: { readonly min?: number; readonly max?: number };
  readonly accessory?: AccessoryKind;
  /** Inline accessories: only on level pipe, or only on vertical pipe. */
  readonly placement?: "horizontal" | "vertical";
}

// ------------------------------------------------------------------ slots and defaults

export type FlowTurn = "hv" | "vh" | "hh";

export interface PipeSlotContext {
  readonly angleDeg?: number;
  readonly gravity?: boolean;
  /** Gravity flow: which way it changes direction here. */
  readonly orientation?: FlowTurn;
}

export function pipeSlotFor(type: FittingType, ctx: PipeSlotContext): FittingSlot {
  const forty5 = ctx.angleDeg !== undefined && Math.abs(ctx.angleDeg - 45) < 1;
  switch (type) {
    case "elbow":
    case "offset":
      if (ctx.gravity) return forty5 ? "drain_turn_45" : ctx.orientation === "hv" ? "drain_turn_hv" : ctx.orientation === "vh" ? "drain_turn_vh" : "drain_turn_hh";
      return forty5 ? "pipe_elbow_45" : "pipe_elbow_90";
    case "transition":
      return "pipe_reducer";
    case "tap":
    case "tee":
    case "wye":
      if (ctx.gravity) return ctx.orientation === "hv" ? "drain_branch_hv" : "drain_branch_hh";
      return "pipe_tee";
    case "cap":
    case "accessory":
      return "pipe_cap";
  }
}

/** The generic id a pipe slot falls back to when no add-on here fills it (kept as stored; unresolved in a bare kernel). */
const UNFILLED_PIPE_FAMILY = "pipe.elbow";

type PipeSize = Extract<RunSize, { shape: "pipe" }>;

/**
 * The pipe fitting for a slot on a system of this kind, in `size`'s material
 * when given. Rows of `FITTING_FAMILY_POINT` name the defaults by scope: the
 * system's pipe service in that material (`<service>/<material>`), else the
 * service, else the run domain (`pipe`, the generic fittings). A service
 * default not made in the size's material falls to the generic one.
 */
export function pipeDefaultChoice(kind: SystemKind, slot: FittingSlot, size: PipeSize | undefined): FittingChoice {
  const service = serviceOf(kind);
  if (service) {
    const own = (size ? packFittingDefault(`${service}/${size.material}`, slot) : null) ?? packFittingDefault(service, slot);
    if (own) {
      const f = packFittingFamily(own.family);
      if (f?.pipe && (!size || f.pipe.materials.includes(size.material))) return own;
    }
  }
  return packFittingDefault("pipe", slot) ?? { family: UNFILLED_PIPE_FAMILY };
}

// ------------------------------------------------------------------ fit checks

/** Why a pipe family can't be this fitting (its add-on's fit rules: material, size, service, branch angle), or null. */
export function pipeFamilyMismatch(
  family: FittingFamily,
  f: { readonly fittingType: FittingType; readonly sizes: readonly RunSize[]; readonly systemKind?: SystemKind; readonly main?: RunSize },
): string | null {
  if (!family.pipe) return null;
  return packFittingFamilyRow(family.id)?.mismatch?.(family, { ...f, domain: "pipe" }) ?? null;
}

/** Why a joint can't be used on this pipe, or null: the pipe's product row says which end types it is made with. */
export function jointIssue(family: FittingFamily, params: Readonly<Record<string, number | string>>, size: RunSize | undefined): string | null {
  if (!family.pipe || size?.shape !== "pipe") return null;
  const stored = params.joint;
  const table = pipeProductTable();
  const endType = pipeJointEndType(params);
  if (endType === undefined && typeof stored !== "string") return null;
  const byId = params[PIPE_JOINT_END_TYPE_PARAM];
  if (typeof byId === "string" && pipeJointLabel(byId) === undefined) {
    const dot = byId.indexOf(".");
    return `This fitting's joint (${byId}) comes from ${dot > 0 ? `the ${byId.slice(0, dot)} add-on` : "an add-on"}, which isn't on for this model. It is kept as stored, but nothing checks it until that add-on is turned on`;
  }
  const product = table.ofSize(size);
  if (!product || (endType !== undefined && table.makes(product, endType))) return null;
  const said = endType ?? String(stored);
  return `${pipeJointLabel(said) ?? (typeof stored === "string" ? stored : said)} joints aren't made for ${product.name}; use ${product.endTypes.map((j) => (pipeJointLabel(j) ?? j).toLowerCase()).join(" or ")}`;
}

/**
 * Parameters for a pipe fitting: the given values, with the joint defaulted
 * to the pipe product's usual one when the family offers it, else the first
 * joint the family offers that the product is made with. When a family made
 * in the pipe's material offers none of the product's joints by stored name
 * (an add-on's product), the fitting keeps the product's usual joint by end
 * type.
 */
export function pipeParams(family: FittingFamily, size: RunSize | undefined, given: Readonly<Record<string, number | string>> | undefined): Record<string, number | string> {
  const out: Record<string, number | string> = { ...(given ?? {}) };
  if (!family.pipe || size?.shape !== "pipe" || out.joint !== undefined || out[PIPE_JOINT_END_TYPE_PARAM] !== undefined) return out;
  const product = specOfSize(size);
  if (!product) return out;
  const offered = family.pipe.joints;
  const usual = storedJointName(product.defaultEndType);
  const pick =
    usual !== undefined && offered.includes(usual)
      ? usual
      : offered.find((j) => {
          const e = endTypeOfStoredJoint(j);
          return e !== undefined && product.endTypes.includes(e);
        });
  if (pick !== undefined) out.joint = pick;
  else if (family.pipe.materials.includes(size.material)) out[PIPE_JOINT_END_TYPE_PARAM] = product.defaultEndType;
  return out;
}

/** What a placed pipe fitting is called: its row's label for these sizes ("Reducing tee"), else the family name. */
export function pipeFittingLabel(family: FittingFamily, sizes: readonly RunSize[], main: RunSize | undefined): string {
  return packFittingFamilyRow(family.id)?.label?.(family, sizes, main) ?? family.name;
}
