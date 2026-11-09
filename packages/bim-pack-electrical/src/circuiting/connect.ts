import { linksFedFrom, type ConnectPlan, type ModelState, type SourceCandidate, type SourceEndRef } from "@permitzip/bim-kernel";
import { distributionEquipment } from "../connections/panel";
import { planCircuitDrop } from "./drop";

/**
 * Electrical's `connect` face (round 12): a "+" grip drop on a panel is Add
 * to circuit with the panel and its first free spaces already chosen, the
 * same plan the drag-to-panel and the dialog use (one edit, one undo step),
 * named from the room ("RECEPT OFFICE 104"). Positions that a circuit on the
 * panel already holds name that circuit: the device joins it (Continue
 * circuit, round 15). A source that isn't a panel is another network's, so
 * it answers null.
 */
export function electricalConnect(model: ModelState, end: SourceEndRef, source: SourceCandidate, newId: string): ConnectPlan | null {
  if (!distributionEquipment(model.elements).some((p) => p.id === source.sourceId)) return null;
  const slot = source.positions?.[0];
  const held = slot === undefined ? undefined : linksFedFrom(model.elements, source.sourceId).find((l) => l.role === "branch" && l.source.positions.includes(slot));
  const plan = planCircuitDrop(model, [end.elementId], { panelId: source.sourceId, ...(held ? { linkId: held.id } : slot !== undefined ? { slot } : {}) }, newId);
  if (!plan.ok) return plan;
  const last = plan.commands.length - 1;
  return { ok: true, commands: plan.commands, labels: plan.commands.map((_, i) => (i === last ? plan.label : "take devices off their old circuit")) };
}
