import { dependsOn, why, type DependsOnAnswer, type ModelState, type NodeRef, type RankedAnswer } from "@permitzip/bim-kernel";

/**
 * The requirements graph as an agent reads it: "why is this here?" and "what
 * re-opens if these go?", in plain words with citations. A host binds its
 * own requirements (a code study) around these with `RequirementsBinding`.
 */

/** One answer as the agent reads it: sentences and citations, nothing else. */
export interface AgentAnswer {
  readonly items: readonly { readonly what: string; readonly because: string }[];
  readonly more: number;
  readonly empty?: string;
}

function answerOut(a: RankedAnswer): AgentAnswer {
  return { items: a.items.map((i) => ({ what: i.label, because: i.cause })), more: a.more, ...(a.items.length === 0 && a.empty ? { empty: a.empty } : {}) };
}

function nodeOf(model: ModelState, id: string): NodeRef {
  const kind = model.elements[id]?.kind;
  return { kind: kind === "space" || kind === "zone" ? kind : "element", id };
}

/** Why each element is here (five each, then "and N more"). */
export function agentWhy(model: ModelState, ids: readonly string[]): Record<string, AgentAnswer> {
  const out: Record<string, AgentAnswer> = {};
  for (const id of ids) out[id] = answerOut(why(model, nodeOf(model, id)));
  return out;
}

/** What re-opens if these elements are taken out, before anyone does it, with the quantity changes ("−42 ft of 1-hour wall"). */
export function agentImpactOfRemoving(model: ModelState, ids: readonly string[], label: string): AgentAnswer & { readonly quantity_changes: readonly string[] } {
  const answer: DependsOnAnswer = dependsOn(model, { removedIds: ids, label });
  return { ...answerOut(answer), quantity_changes: answer.quantityDeltas.map((q) => q.label) };
}
