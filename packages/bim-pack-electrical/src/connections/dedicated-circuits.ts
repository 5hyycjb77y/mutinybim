import { executeCommand, type Command, type BimElement, type ModelState, type PartInstance, serviceLinkName } from "@permitzip/bim-kernel";
import { branchSizingA, type ElectricalLoadEngine } from "./engine";
import { distributionOf, electricalConnectorIds } from "./systems";
import { existingPhaseOf, isCircuitableLoad, memberName } from "./panel";

type Elements = Readonly<Record<string, BimElement>>;

/**
 * Each chosen load on a circuit of its own (ROADMAP E1): kitchen equipment and
 * rooftop units from the equipment list go on the panel one per circuit, in
 * the free slots that best balance its phases, with the breaker sized for the
 * load. It works the same for planned (not placed yet) and placed parts, with
 * the ordinary circuit command, so placing a planned item later keeps its
 * circuit. Every item is tried against the model as it stands after the ones
 * before it; one that can't go on this panel is named with the reason and the
 * rest still go, all in one undo step.
 */

export interface DedicatedCircuit {
  readonly partId: string;
  /** "K-2.1". */
  readonly name: string;
  readonly linkId: string;
  /** "MDP-1,3". */
  readonly circuitName: string;
  readonly poles: number;
  readonly va: number;
  /** The current the breaker is sized for (continuous loads at 125%). */
  readonly sizingA: number;
  /** The breaker set on the circuit; null: the panel's default (the unit's maximum overcurrent protection, else 20 A). */
  readonly breakerA: number | null;
  readonly planned: boolean;
}

export interface DedicatedCircuitRefusal {
  readonly partId: string;
  readonly name: string;
  readonly reason: string;
}

export interface DedicatedCircuitsPlan {
  /** One `batch_edits` making every circuit; null when none can be made. */
  readonly command: Command | null;
  readonly circuits: readonly DedicatedCircuit[];
  readonly refused: readonly DedicatedCircuitRefusal[];
  /** "Put 9 items on circuits of MDP". */
  readonly label: string;
}

export interface DedicatedCircuitOptions {
  /** The new circuit's id for a part (stable while a dialog is open, so a retry makes the same circuits). */
  readonly linkIdFor: (partId: string) => string;
  /** The engine the panel's loads are read with (the project's code rules). */
  readonly engine: ElectricalLoadEngine;
  /** The breaker for a sizing current: the next standard rating under the project's code; null keeps the default. */
  readonly breakerFor?: (sizingA: number) => number | null;
}

type EditStep = Extract<Command, { type: "batch_edits" }>["commands"][number];

function onACircuit(elements: Elements, part: PartInstance): string | null {
  for (const linkId of Object.values(part.served ?? {})) {
    const link = elements[linkId];
    if (link?.kind !== "service_link" || link.trade !== "electrical" || link.role !== "branch") continue;
    const phase = existingPhaseOf(elements, link);
    return phase === null ? serviceLinkName(elements, link) : `existing circuit ${serviceLinkName(elements, link)} (made in ${phase}), which keeps its panel and number on this renovation`;
  }
  return null;
}

export function planDedicatedCircuits(model: ModelState, partIds: readonly string[], panelId: string, opts: DedicatedCircuitOptions): DedicatedCircuitsPlan {
  const panel = model.elements[panelId];
  const panelInfo = panel?.kind === "part" ? distributionOf(model.elements, panel) : null;
  const panelName = panelInfo?.name ?? panelId;
  const circuits: DedicatedCircuit[] = [];
  const refused: DedicatedCircuitRefusal[] = [];
  const steps: EditStep[] = [];
  if (!panelInfo) return { command: null, circuits, refused: partIds.map((partId) => ({ partId, name: partId, reason: "Pick the panel they go on." })), label: "" };
  let at = model;
  for (const partId of partIds) {
    const part = at.elements[partId];
    if (part?.kind !== "part") {
      refused.push({ partId, name: partId, reason: "It is gone; it was deleted since the list was opened." });
      continue;
    }
    const name = memberName(at.elements, part);
    if (!isCircuitableLoad(at.elements, part)) {
      refused.push({ partId, name, reason: electricalConnectorIds(at.elements, part).length === 0 ? `${name} has no electrical load to circuit (give it volts and a load).` : `${name} is distribution equipment; feed it instead.` });
      continue;
    }
    const already = onACircuit(at.elements, part);
    if (already) {
      refused.push({ partId, name, reason: `${name} is already on ${already}; change it from its circuit.` });
      continue;
    }
    const linkId = opts.linkIdFor(partId);
    const bare = { type: "create_service_link" as const, linkId, sourceId: panelId, members: [{ elementId: partId }], description: name };
    const first = executeCommand(at, bare);
    if (!first.ok) {
      refused.push({ partId, name, reason: first.error.message });
      continue;
    }
    const link = opts.engine.loads(first.model, panelId)?.links.find((l) => l.linkId === linkId);
    const sizingA = link ? branchSizingA(link, panelInfo.system) : 0;
    const breakerA = link && link.inventory.va > 0 && opts.breakerFor ? opts.breakerFor(sizingA) : null;
    const step = breakerA !== null ? { ...bare, electrical: { ratingA: breakerA } } : bare;
    const done = breakerA !== null ? executeCommand(at, step) : first;
    if (!done.ok) {
      refused.push({ partId, name, reason: done.error.message });
      continue;
    }
    at = done.model;
    steps.push(step);
    const made = at.elements[linkId];
    circuits.push({
      partId,
      name,
      linkId,
      circuitName: made?.kind === "service_link" ? serviceLinkName(at.elements, made) : linkId,
      poles: link?.positions.length ?? 0,
      va: link?.inventory.va ?? 0,
      sizingA,
      breakerA,
      planned: part.planned !== undefined,
    });
  }
  const label = `Put ${circuits.length} item${circuits.length === 1 ? "" : "s"} on circuits of ${panelName}`;
  return { command: steps.length > 0 ? { type: "batch_edits", label, commands: steps } : null, circuits, refused, label };
}
