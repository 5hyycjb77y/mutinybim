import { refuse } from "../command-core";
import { familyMismatch, fittingFamily, missingFittingFamilyOwnerWords, resolveParams, slotFor, systemDefault } from "./fittings/library";
import { isGravity } from "./pipe/design";
import { pipeFittingLabel, pipeParams, type FlowTurn } from "./pipe/families";
import { familyMakesTurn, pipeElbowForTurn } from "./pipe/turn-angles";
import type { FittingChoice, MepSystem, RunFitting, RunSegment, RunSize } from "./types";

/**
 * Fitting choice shared by the routing commands and the follow-up refits
 * (`fitting-follow.ts`), which the routing commands run: a leaf of both.
 */

/**
 * A pipe elbow at a turn the slot's family isn't made for (a 22½° or 60°
 * turn, whose slots are the 45° / 90° ones): the first family in force made
 * for that turn on this pipe, else the slot's choice (whose mismatch says why).
 */
function pipeTurnChoice(system: MepSystem, type: RunFitting["fittingType"], domain: RunSegment["domain"], sizes: readonly RunSize[], angleDeg: number | undefined, slotChoice: FittingChoice): FittingChoice {
  if (domain !== "pipe" || angleDeg === undefined) return slotChoice;
  // Only turning fittings say what they turn (`angles`); a tee or reducer keeps its slot's choice.
  const slotFamily = fittingFamily(slotChoice.family);
  if (!slotFamily || slotFamily.angles === undefined || !slotFamily.fittingTypes.includes(type) || familyMakesTurn(slotFamily, angleDeg)) return slotChoice;
  const size = sizes[0];
  const other = pipeElbowForTurn(system.systemKind, size?.shape === "pipe" ? size : undefined, angleDeg);
  return other ? { family: other.id } : slotChoice;
}

/** The system's fitting for this place, checked against the fitting it has to be. */
export function chooseFitting(
  system: MepSystem,
  type: RunFitting["fittingType"],
  domain: RunSegment["domain"],
  sizes: readonly RunSize[],
  angleDeg: number | undefined,
  main: RunSize | undefined,
  /** Drainage: which way the flow changes direction here (horizontal to vertical, …). */
  orientation?: FlowTurn,
): { fields: Pick<RunFitting, "family" | "params">; branchLabel: string | null } {
  const slotChoice = systemDefault(system, slotFor(type, sizes, { ...(angleDeg !== undefined ? { angleDeg } : {}), gravity: isGravity(system.systemKind), ...(orientation ? { orientation } : {}) }), sizes[0]);
  const choice = pipeTurnChoice(system, type, domain, sizes, angleDeg, slotChoice);
  const family = fittingFamily(choice.family);
  if (!family) {
    // A first-party add-on that is off supplies it: say so (round 12). No add-on known to make it: keep the choice as stored, unchecked, for its add-on to read.
    const owner = missingFittingFamilyOwnerWords(choice.family, `${system.name} can't place its ${choice.family} fittings`);
    if (owner) refuse("invalid_value", owner);
  }
  if (!family) return { fields: { family: choice.family, ...(choice.params && Object.keys(choice.params).length > 0 ? { params: { ...choice.params } } : {}) }, branchLabel: null };
  const why = familyMismatch(family, { fittingType: type, domain, sizes, systemKind: system.systemKind, ...(angleDeg !== undefined ? { angleDeg } : {}), ...(main ? { main } : {}) });
  if (why) refuse("profile_incompatible", `${system.name} places ${family.name} here, but ${why.charAt(0).toLowerCase()}${why.slice(1)}; change the system's fitting choice`);
  const params = resolveParams(family, domain === "pipe" ? pipeParams(family, sizes[0], choice.params) : choice.params);
  const isBranch = type === "tap" || type === "tee" || type === "wye";
  const label = domain === "pipe" ? pipeFittingLabel(family, sizes, main) : isBranch ? family.name : null;
  return { fields: { family: family.id, ...(Object.keys(params).length > 0 ? { params } : {}) }, branchLabel: label };
}
