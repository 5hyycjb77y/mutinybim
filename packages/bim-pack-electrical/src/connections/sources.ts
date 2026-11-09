import { elementsOfKind, linkServing, occupiedPositions, type BimElement, type ModelState, type PartInstance, type SourceCandidate, type SourceCandidates, type SourceEndRef, type SourceRefusal } from "@permitzip/bim-kernel";
import { bestBalancedGroup, membersVa } from "./balance";
import { isCircuitableLoad, slotChoices } from "./panel";
import { distributionOf, electricalConnectorIds, electricalConnectorOf, electricalName, loadRefusal, voltageSystemLabel } from "./systems";

type Elements = Readonly<Record<string, BimElement>>;

/** What a person drags a device to, in the grip's words. */
export const ELECTRICAL_SOURCE_WORD = "panel";
export const ELECTRICAL_SOURCE_PROMPT = "Needs a source. Drag to a panel";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Which panels could take an unserved device (Electrical's answer to the
 * network adapter's `sourcesFor`, round 12): every panel with a free group of
 * spaces for the device's poles at a voltage that serves it, nearest first;
 * every other panel with the reason in words ("P2 is full: 0 spare poles",
 * "P3 is 480Y/277 V 3-phase 4-wire; …"). Null when the element isn't a device
 * that goes on a circuit, or its connector is already on one.
 */
export function electricalSourcesFor(model: Pick<ModelState, "elements">, end: SourceEndRef): SourceCandidates | null {
  const elements: Elements = model.elements;
  const el = elements[end.elementId];
  if (el?.kind !== "part" || !isCircuitableLoad(elements, el)) return null;
  const connector = end.end ?? electricalConnectorIds(elements, el)[0];
  if (connector === undefined || linkServing(elements, el.id, connector)) return null;
  const demand = electricalConnectorOf(elements, el, connector);
  if (!demand) return null;
  const who = electricalName(elements, el);
  const candidates: SourceCandidate[] = [];
  const refused: SourceRefusal[] = [];
  const panelTypes = new Set<string>();
  for (const t of elementsOfKind(elements, "part_type")) if (t.definition.category === "electrical_equipment") panelTypes.add(t.id);
  for (const panel of elementsOfKind(elements, "part")) {
    if (!panelTypes.has(panel.typeId) || panel.id === el.id) continue;
    const d = distributionOf(elements, panel);
    if (!d || d.port !== "bus" || d.spaces === null) continue;
    const label = d.name;
    const why = loadRefusal(who, demand, label, d.system);
    if (why) {
      refused.push({ sourceId: panel.id, label, reason: why });
      continue;
    }
    const spare = Math.max(0, d.spaces - occupiedPositions(elements, panel.id).size);
    const groups = slotChoices(elements, panel.id, demand.poles);
    // The spaces a drop on the panel takes: the free ones that leave its phases most even, as Add to circuit picks (not simply the lowest).
    const first = groups.length > 1 ? (bestBalancedGroup(elements, panel, groups, membersVa(elements, [{ part: el, connector }], "branch")) ?? groups[0]) : groups[0];
    if (!first) {
      refused.push({ sourceId: panel.id, label, reason: spare === 0 ? `${label} is full: 0 spare poles` : `${label} has ${plural(spare, "spare pole", "spare poles")}, but none of them take a ${demand.poles}-pole breaker` });
      continue;
    }
    candidates.push({ sourceId: panel.id, label, distanceMm: Math.round(distance(el, panel)), positions: first, note: `${label}: ${spare} spare, ${voltageSystemLabel(d.system)}` });
  }
  candidates.sort((a, b) => a.distanceMm - b.distanceMm || a.label.localeCompare(b.label, undefined, { numeric: true }));
  refused.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  return { sourceWord: ELECTRICAL_SOURCE_WORD, prompt: ELECTRICAL_SOURCE_PROMPT, candidates, refused };
}

function distance(a: PartInstance, b: PartInstance): number {
  return Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y);
}
