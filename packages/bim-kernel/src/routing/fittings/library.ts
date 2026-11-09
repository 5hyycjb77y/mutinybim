import type { SystemKind } from "../../parts";
import { packFittingDefault, packFittingFamilies, packFittingFamily, packFittingFamilyRow } from "../../registry/fitting-family-point";
import { activePackSet } from "../../packs/scope";
import { isGravity } from "../pipe/design";
import { pipeDefaultChoice, pipeSlotFor, type PipeFamilyInfo, type PipeSlotContext } from "../pipe/families";
import { PIPE_JOINT_END_TYPE_PARAM } from "../pipe/specs";
import type { FittingChoice, FittingSlot, FittingType, MepSystem, RunDomain, RunFitting, RunSize } from "../types";
import { firstPartyFittingFamilyOwner } from "../../packs/first-party/manifests";
import { packNotLoadedMessage } from "../../packs/set";

/**
 * The fitting library: every fitting family routing can place, as data.
 *
 * Names follow the generic fitting TYPE names of the SMACNA HVAC Duct
 * Construction Standards (radius elbow, mitred elbow with turning vanes,
 * gored elbow, concentric / eccentric transition, ogee offset, 45° entry
 * tap, conical tap, boot tap, lateral…). No figure numbers or coefficient
 * tables are copied from SMACNA or ASHRAE; losses come from the coefficient
 * sources in `coefficients.ts`.
 *
 * Code never branches on a family id. A family says which fitting types and
 * shapes it fits, which parameters it has, how it is built (`geometry`) and
 * which loss correlation applies (`loss`); those three keys are the only
 * places behaviour lives.
 */

export type BodyShape = "rect" | "round" | "oval" | "pipe" | "conduit";

export type FittingGeometryKind =
  | "radius_elbow"
  | "mitred_elbow"
  | "gored_elbow"
  | "transition"
  | "ogee_offset"
  | "collar_tap"
  | "shoe_tap"
  | "conical_tap"
  | "bellmouth_tap"
  | "boot_tap"
  | "lateral_tap"
  | "flat_cap"
  | "pipe_fitting";

export type FittingLossKind =
  | "radius_elbow"
  /** Die-stamped or pleated round elbows (Locklin's data, not the rectangular-bend correlation). */
  | "stamped_elbow"
  | "mitred_elbow"
  | "vaned_elbow"
  | "gored_elbow"
  | "transition"
  | "ogee_offset"
  | "branch_takeoff"
  | "cap"
  /** Pipe: K = (L/D) x the pipe's turbulent friction factor, per path. */
  | "pipe_k"
  | "not_calculated";

export interface NumberParam {
  readonly key: string;
  readonly label: string;
  readonly kind: "number";
  readonly unit: "ratio" | "deg" | "mm" | "count" | "in_wc" | "mbh";
  readonly default: number;
  readonly min: number;
  readonly max: number;
  readonly integer?: boolean;
}

export interface ChoiceParam {
  readonly key: string;
  readonly label: string;
  readonly kind: "choice";
  readonly options: readonly string[];
  readonly default: string;
}

export type FittingParamSpec = NumberParam | ChoiceParam;

export interface FittingFamily {
  readonly id: string;
  readonly name: string;
  /** The generic construction-standard type name it corresponds to. */
  readonly smacnaType: string;
  readonly domain: RunDomain;
  /** Fitting types an instance of this family can be. */
  readonly fittingTypes: readonly FittingType[];
  /** Shapes it is made in (for takeoffs: the branch's shape). */
  readonly shapes: readonly BodyShape[];
  /** Takeoffs: the trunk shapes it can be cut into. */
  readonly mainShapes?: readonly BodyShape[];
  /** Transitions: whether the two ends may change shape (rect to round). */
  readonly shapeChange?: "same" | "different" | "any";
  /** Elbows: turns it is made for; "any" also takes custom angles; a number-named value ("90", "60", "22.5") takes that turn only. Pipe runs turn only at angles some family made for them turns (`pipe/turn-angles.ts`). */
  readonly angles?: "45_90" | "any" | `${number}`;
  readonly params: readonly FittingParamSpec[];
  readonly geometry: FittingGeometryKind;
  readonly loss: FittingLossKind;
  /** Branch takeoffs: angle the branch enters at, and an entry-shape factor on the branch loss. */
  readonly takeoff?: { readonly angleDeg: number; readonly entryFactor: number };
  /** Pipe families: services, materials, joints, form, take-out proportions, loss L/D and drainage direction rules. */
  readonly pipe?: PipeFamilyInfo;
  readonly description: string;
}

/** The kernel makes no fitting family of its own: every family is an add-on's row of `FITTING_FAMILY_POINT`. Kept so readers of the old static list still compile. */
export const FITTING_FAMILIES: readonly FittingFamily[] = [];

// ---------------------------------------------------------------- family reader (P12)
// Every family is a row of `FITTING_FAMILY_POINT`. Read families through
// `fittingFamily` / `fittingFamilies()`.

/** A family by its stored id from the set in force's rows; null when no add-on here makes it. */
export function fittingFamily(id: string): FittingFamily | null {
  return packFittingFamily(id);
}

/** True when an add-on in force makes fittings for `domain` (a bare kernel makes none, so its fittings are kept as stored, unchecked). */
export function domainHasFamilies(domain: RunDomain): boolean {
  return fittingFamilies().some((f) => f.domain === domain);
}

/** "This model uses <add-on>, which isn't loaded here, so <consequence>. Turn on that add-on" when an add-on that's off supplies the family; else null. */
export function missingFittingFamilyOwnerWords(id: string, consequence: string): string | null {
  const owner = firstPartyFittingFamilyOwner(id);
  return owner ? `${packNotLoadedMessage(owner)}, so ${consequence}. Turn on that add-on` : null;
}

/** Why a family id names nothing in the set in force: the add-on it comes from when that add-on is off, else that the library has no such type. */
export function missingFittingFamilyWords(id: string): string {
  return missingFittingFamilyOwnerWords(id, `fitting type ${id} isn't available`) ?? `There is no fitting type ${id} in the library`;
}

/** Every family the set in force can place, each add-on's in row order. */
export function fittingFamilies(): readonly FittingFamily[] {
  return activePackSet().memo("kernel.fitting_family#all", () => packFittingFamilies());
}

/** Which slot a fitting of this type and these sizes fills. Pipe also needs the turn and, for drainage, which way the flow changes direction. */
export function slotFor(type: FittingType, sizes: readonly RunSize[], pipe?: PipeSlotContext): FittingSlot {
  const a = sizes[0];
  if (a?.shape === "pipe") return pipeSlotFor(type, pipe ?? {});
  switch (type) {
    case "elbow":
      return a?.shape === "round" ? "elbow_round" : a?.shape === "oval" ? "elbow_oval" : "elbow_rect";
    case "transition": {
      const b = sizes[1];
      return a && b && a.shape !== b.shape ? "transition_shape_change" : "transition";
    }
    case "tap":
    case "tee":
    case "wye":
      return a?.shape === "round" ? "branch_round" : "branch_rect";
    case "cap":
    case "accessory":
      return "cap";
    case "offset":
      return "offset";
  }
}

/** The fitting a system places in a slot: its own choice, else the library default (for pipe, the first default made in `size`'s material). */
export function systemDefault(system: Pick<MepSystem, "systemKind" | "domain" | "fittingDefaults">, slot: FittingSlot, size?: RunSize): FittingChoice {
  const own = system.fittingDefaults?.[slot];
  if (own) return own;
  // A sized-air domain's slots come from its add-on's rows (its cap when a slot has none); with no add-on for the domain, the generic `<domain>.<slot>` id is kept as stored.
  if (system.domain === "duct") return packFittingDefault(system.domain, slot) ?? packFittingDefault(system.domain, "cap") ?? { family: `${system.domain}.${slot}` };
  return pipeDefaultChoice(system.systemKind as SystemKind, slot, size?.shape === "pipe" ? size : undefined);
}

function shapeWord(s: BodyShape | undefined): string {
  return s === "rect" ? "rectangular" : s === "oval" ? "flat oval" : (s ?? "unknown");
}

export function shapeOf(size: RunSize): BodyShape {
  return size.shape;
}

/** Parameters with every default filled in and every value inside its range. */
export function resolveParams(family: FittingFamily, given: Readonly<Record<string, number | string>> | undefined): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const p of family.params) {
    const v = given?.[p.key];
    if (p.kind === "number") {
      const n = typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : p.default;
      out[p.key] = Math.min(p.max, Math.max(p.min, p.integer ? Math.round(n) : n));
    } else {
      const s = typeof v === "string" ? v : typeof v === "number" ? String(v) : p.default;
      out[p.key] = p.options.includes(s) ? s : p.default;
    }
  }
  // A pipe joint no family option names (an add-on's product) is kept by end type id.
  const endType = given?.[PIPE_JOINT_END_TYPE_PARAM];
  if (family.pipe && typeof endType === "string") out[PIPE_JOINT_END_TYPE_PARAM] = endType;
  return out;
}

/** Plain reason a parameter value is out of range, or null. */
export function paramIssue(family: FittingFamily, params: Readonly<Record<string, number | string>> | undefined): string | null {
  for (const [key, v] of Object.entries(params ?? {})) {
    // A pipe joint kept by end type id; `jointIssue` judges it against the pipe's product.
    if (family.pipe && key === PIPE_JOINT_END_TYPE_PARAM && typeof v === "string") continue;
    const p = family.params.find((q) => q.key === key);
    if (!p) return `${family.name} has no parameter ${key}`;
    if (p.kind === "number") {
      if (typeof v !== "number" || !Number.isFinite(v)) return `${p.label} has to be a number`;
      if (v < p.min || v > p.max) return `${p.label} has to be between ${p.min} and ${p.max}`;
    } else if (typeof v !== "string" || !p.options.includes(v)) {
      return `${p.label} is one of ${p.options.join(", ")}`;
    }
  }
  return null;
}

/** What a fitting instance is made of, for geometry and loss: its family (authored or the system's default) and resolved parameters. */
export interface ResolvedFitting {
  readonly family: FittingFamily;
  readonly params: Readonly<Record<string, number | string>>;
  /** True when the instance has no authored family (routed before families) and shows its system's default. */
  readonly defaulted: boolean;
}

export function resolveFitting(system: Pick<MepSystem, "systemKind" | "domain" | "fittingDefaults"> | null, f: Pick<RunFitting, "fittingType" | "family" | "params" | "ports" | "domain" | "angleDeg">): ResolvedFitting | null {
  const authored = f.family ? fittingFamily(f.family) : null;
  if (authored) return { family: authored, params: resolveParams(authored, f.params), defaulted: false };
  if (!system) return null;
  const sizes = f.ports.map((p) => p.size);
  const choice = systemDefault(system, slotFor(f.fittingType, sizes, { angleDeg: f.angleDeg ?? 90, gravity: isGravity(system.systemKind), orientation: "hh" }), sizes[0]);
  const family = fittingFamily(choice.family);
  return family ? { family, params: resolveParams(family, choice.params), defaulted: true } : null;
}

/**
 * Why `family` can't be this fitting, or null when it can. `branchOf` / `mainOf`:
 * for takeoffs, the branch and trunk sizes; `angleDeg`: for elbows, the turn.
 */
export function familyMismatch(
  family: FittingFamily,
  f: { readonly fittingType: FittingType; readonly domain: RunDomain; readonly sizes: readonly RunSize[]; readonly angleDeg?: number; readonly main?: RunSize; readonly systemKind?: SystemKind },
): string | null {
  const isBranch = f.fittingType === "tap" || f.fittingType === "tee" || f.fittingType === "wye";
  const what = isBranch ? "a branch takeoff" : f.fittingType === "elbow" || f.fittingType === "offset" || f.fittingType === "accessory" ? `an ${f.fittingType}` : `a ${f.fittingType === "cap" ? "cap" : "transition"}`;
  if (family.domain !== f.domain) return `${family.name} is a ${family.domain} fitting; this is ${f.domain}`;
  if (!family.fittingTypes.includes(f.fittingType)) return `${family.name} isn't ${what}; pick ${what} type`;
  const addOnWhy = packFittingFamilyRow(family.id)?.mismatch?.(family, f) ?? null;
  if (addOnWhy) return addOnWhy;
  const shapes = f.sizes.map(shapeOf);
  for (const s of isBranch ? shapes.slice(0, 1) : shapes) {
    if (!family.shapes.includes(s)) return `${family.name} isn't made in ${shapeWord(s)} duct`;
  }
  if (isBranch && f.main && family.mainShapes && !family.mainShapes.includes(shapeOf(f.main))) {
    return `${family.name} can't be cut into a ${shapeWord(shapeOf(f.main))} trunk`;
  }
  if (f.fittingType === "transition" && shapes.length === 2) {
    const changes = shapes[0] !== shapes[1];
    if (family.shapeChange === "same" && changes) return `${family.name} keeps one shape; these ends are ${shapeWord(shapes[0])} and ${shapeWord(shapes[1])}, so use a rectangular-to-round transition`;
    if (family.shapeChange === "different" && !changes) return `${family.name} changes shape; both ends here are ${shapeWord(shapes[0])}`;
  }
  if (f.fittingType === "elbow" && family.angles === "45_90" && f.angleDeg !== undefined && Math.abs(f.angleDeg - 45) > 0.5 && Math.abs(f.angleDeg - 90) > 0.5) {
    return `${family.name} is made for 45° and 90° turns; this one turns ${f.angleDeg.toFixed(0)}°`;
  }
  if (f.fittingType === "elbow" && f.angleDeg !== undefined && family.angles !== undefined && family.angles !== "any" && family.angles !== "45_90") {
    const made = Number(family.angles);
    if (Number.isFinite(made) && Math.abs(f.angleDeg - made) > 0.5) return `${family.name} turns ${family.angles}°; this turn is ${f.angleDeg.toFixed(0)}°`;
  }
  return null;
}
