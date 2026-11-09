import { componentBeyond, fixtureKeyOf, loadPointLoad, loadPointTotals, loadTypicalOf, paramValue, resolveConnectors, typicalFactor, type BimElement, type CouplingCarry, type LoadPointElement, type NetworkCouplingDef, type PartInstance } from "@permitzip/bim-kernel";

type Elements = Readonly<Record<string, BimElement>>;
/** A run graph node: a run element id, a load point id, or `part#connector`. */
type Node = string;

/** The water heater kind a part's type says ("tank", "gas_tankless", "electric_tankless"), or null. */
export function waterHeaterKind(elements: Elements, part: PartInstance): string | null {
  const type = elements[part.typeId];
  if (type?.kind !== "part_type") return null;
  const v = paramValue(type.definition, part.values, "heater_kind");
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function connectorKind(elements: Elements, part: PartInstance, connectorId: string): string | null {
  const type = elements[part.typeId];
  if (type?.kind !== "part_type") return null;
  return resolveConnectors(type.definition, part.values).find((c) => c.id === connectorId)?.systemKind ?? null;
}

/** A water heater's hot outlet: the source of its hot water system (the walk's root), as a meter or panel is. */
export function isHeaterOutlet(elements: Elements, part: PartInstance, connectorId: string): boolean {
  if (!waterHeaterKind(elements, part)) return false;
  const kind = connectorKind(elements, part, connectorId);
  return kind === "domestic_hot_water";
}

/** A water heater's cold inlet: on the cold system it carries everything its hot side serves. */
export function isHeaterInlet(elements: Elements, part: PartInstance, connectorId: string): boolean {
  if (!waterHeaterKind(elements, part)) return false;
  return connectorKind(elements, part, connectorId) === "domestic_cold_water";
}

const isPartNode = (n: Node) => n.includes("#");

/**
 * Water: a heater's cold inlet carries its hot side's load point units; a
 * fixture whose cold and hot sides are both below a pipe counts its total
 * units there, not cold + hot (the difference is added once, at the node where
 * its two sides meet).
 */
function carryThroughHeaters({ elements, tree, systemKind, neighbours, own, alsoRead }: CouplingCarry): void {
  if (systemKind !== "domestic_cold_water") return;
  const coldPoints: LoadPointElement[] = [];
  for (const n of tree.order) {
    const el = elements[n];
    if (el?.kind === "load_point") coldPoints.push(el);
  }
  for (const n of tree.order) {
    if (!isPartNode(n)) continue;
    const partId = n.slice(0, n.indexOf("#"));
    const part = elements[partId];
    if (part?.kind !== "part" || !isHeaterInlet(elements, part, n.slice(n.indexOf("#") + 1))) continue;
    // The heater's hot side: every hot load point its outlets reach.
    const hot = new Map<string, number>();
    let hotTotal = 0;
    for (const [connector, link] of Object.entries(part.links ?? {})) {
      if (!isHeaterOutlet(elements, part, connector)) continue;
      for (const m of componentBeyond(elements, partId, link.elementId, neighbours)) {
        const el = elements[m];
        if (!isPartNode(m)) alsoRead.push(m);
        if (el?.kind !== "load_point") continue;
        const h = loadPointLoad(elements, el);
        // A typical unit's hot points count once per instance at a heater outside the unit (F6).
        hotTotal += h * typicalFactor(loadTypicalOf(elements, el, [el.host?.elementId, el.attachedPartId]).typical, part.groupId);
        const key = fixtureKeyOf(el);
        if (key) hot.set(key, (hot.get(key) ?? 0) + h);
      }
    }
    own.set(n, (own.get(n) ?? 0) + hotTotal);
    if (hot.size === 0) continue;
    const ancestors = new Set<Node>();
    for (let a: Node | null | undefined = n; a !== null && a !== undefined; a = tree.parent.get(a)) ancestors.add(a);
    for (const cold of coldPoints) {
      const key = fixtureKeyOf(cold);
      const h = key ? hot.get(key) : undefined;
      if (h === undefined) continue;
      const t = loadPointTotals(elements, cold);
      if (t.wsfu_total <= 0) continue;
      const adj = t.wsfu_total - t.wsfu_cold - h;
      if (adj === 0) continue;
      let meet: Node | null | undefined = cold.id;
      while (meet !== null && meet !== undefined && !ancestors.has(meet)) meet = tree.parent.get(meet);
      if (meet === null || meet === undefined) continue;
      const meetGroup = elements[meet.includes("#") ? meet.slice(0, meet.indexOf("#")) : meet]?.groupId;
      own.set(meet, (own.get(meet) ?? 0) + adj * typicalFactor(loadTypicalOf(elements, cold, [cold.host?.elementId, cold.attachedPartId]).typical, meetGroup));
    }
  }
}

/** A water heater as a network coupling: the source of its hot system, and its cold inlet carries the hot side (with the combined-units adjustment). */
export const WATER_HEATER_COUPLING: NetworkCouplingDef = {
  id: "water_heater",
  couples: (elements, part) => waterHeaterKind(elements, part) !== null,
  isOutlet: isHeaterOutlet,
  carry: carryThroughHeaters,
};
