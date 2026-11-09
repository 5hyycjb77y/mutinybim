import type { PackSet } from "../packs/set";
import { activePackSet } from "../packs/scope";
import type { BimElement } from "../types";
import { stagePlanOf } from "./records";
import { resolveStageSet, stageIn, type LifecycleStageDef, type StageSetView } from "./stages";

type Elements = Readonly<Record<string, BimElement>>;

/** The stage list the model uses and the stage it is in now (the list's first stage when none is recorded). */
export function currentStageOf(elements: Elements, set: PackSet = activePackSet()): { readonly list: StageSetView; readonly stage: LifecycleStageDef | null } {
  const plan = stagePlanOf(elements);
  const list = resolveStageSet(plan?.stageSet ?? null, set);
  const id = plan?.currentStageId;
  const stage = id !== undefined ? (stageIn(list, id) ?? null) : (list.stages[0] ?? null);
  return { list, stage };
}

/** The current stage's id (what a rule's `appliesAt.stages` is checked against); the recorded id even when this release's list lacks it. */
export function currentStageIdOf(elements: Elements, set: PackSet = activePackSet()): string | null {
  const plan = stagePlanOf(elements);
  if (plan?.currentStageId !== undefined) return plan.currentStageId;
  return currentStageOf(elements, set).stage?.id ?? null;
}
