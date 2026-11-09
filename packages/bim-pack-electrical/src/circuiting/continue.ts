import { elementValues, linkServing, linksFedFrom, serviceLinkName, type Command, type ElementId, type ModelState, type ServiceLink } from "@permitzip/bim-kernel";
import { distributionEquipment, isCircuitableLoad } from "../connections/panel";
import { electricalConnectorIds } from "../connections/systems";
import { electricalConnect } from "./connect";

/**
 * Continue circuit (round 15, E2): keep adding devices to one circuit while
 * placing them. Each device placed while it is on joins the chosen circuit
 * through Electrical's connect face (the same plan the "+" grip and Add to
 * circuit use: one edit, one undo step per device). The first device of a
 * new circuit starts it on the panel's best-balanced free spaces; every one
 * after joins that circuit.
 */

export interface ContinueCircuitTarget {
  readonly panelId: string;
  /** The circuit devices join; null: the next device starts a new one with `newLinkId`. */
  readonly linkId: string | null;
  readonly newLinkId: string;
}

/** The edit for one device, and the circuit it ends up on; or why it can't, in words. */
export type ContinueCircuitPlan =
  | { readonly ok: true; readonly commands: readonly Command[]; readonly label: string; readonly linkId: string }
  | { readonly ok: false; readonly reason: string };

/** A circuit on a panel, as the picker lists it ("L1-3 RECEPT OFFICE 104", 4 on it). */
export interface ContinueCircuitChoice {
  readonly linkId: string;
  readonly label: string;
  readonly members: number;
}

/** The branch circuits on a panel, in the panel's order. */
export function panelCircuits(model: Pick<ModelState, "elements">, panelId: string): ContinueCircuitChoice[] {
  return linksFedFrom(model.elements, panelId)
    .filter((l) => l.role === "branch")
    .sort((a, b) => (a.source.positions[0] ?? 0) - (b.source.positions[0] ?? 0))
    .map((l) => ({ linkId: l.id, label: [serviceLinkName(model.elements, l), l.description].filter((s) => s.trim().length > 0).join(" "), members: l.members.length }));
}

/** The panels Continue circuit can put devices on (panelboards and switchboards with spaces), named. */
export function continuePanels(model: Pick<ModelState, "elements">): { readonly panelId: string; readonly name: string }[] {
  return distributionEquipment(model.elements).map((p) => ({ panelId: p.id, name: p.name }));
}

/** Devices that could go on a circuit and aren't on one yet, not among `known`: what was just placed. */
export function newUncircuitedDevices(model: Pick<ModelState, "elements">, known: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const el of elementValues(model.elements)) {
    if (el.kind !== "part" || known.has(el.id) || !isCircuitableLoad(model.elements, el)) continue;
    const connector = electricalConnectorIds(model.elements, el)[0];
    if (connector === undefined || linkServing(model.elements, el.id, connector)) continue;
    out.push(el.id);
  }
  return out;
}

function liveLink(model: ModelState, id: string | null): ServiceLink | null {
  const el = id ? model.elements[id] : undefined;
  return el?.kind === "service_link" ? el : null;
}

/**
 * The edit that puts one just-placed device on the circuit, through the
 * connect face: the circuit's own spaces name it (join), or none yet (start
 * one). `linkId` is the circuit the device ends up on.
 */
export function planContinueCircuit(model: ModelState, deviceId: string, target: ContinueCircuitTarget): ContinueCircuitPlan {
  const joining = liveLink(model, target.linkId);
  if (target.linkId !== null && !joining) return { ok: false, reason: "That circuit is gone (undone or deleted). Pick another, or start a new one." };
  const panel = distributionEquipment(model.elements).find((p) => p.id === target.panelId);
  if (!panel) return { ok: false, reason: "That panel is gone. Pick another." };
  const plan = electricalConnect(model, { elementId: deviceId as ElementId }, { sourceId: panel.id as ElementId, label: panel.name, distanceMm: 0, ...(joining ? { positions: joining.source.positions } : {}) }, target.newLinkId);
  if (!plan) return { ok: false, reason: `${panel.name} can't take circuits.` };
  if (!plan.ok) return { ok: false, reason: plan.reason };
  const last = plan.labels[plan.labels.length - 1] ?? "add to circuit";
  return { ok: true, commands: plan.commands, label: last, linkId: joining?.id ?? target.newLinkId };
}
