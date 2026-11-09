import { type BimElement, linkServing, serviceLinkName, type ConductorSet } from "@permitzip/bim-kernel";
import { linkConstruction } from "../catalog/feeder-types";
import { equipmentNameplate, type EquipmentNameplate } from "./equipment";
import { electricalConnectorIds, electricalConnectorOf, electricalName } from "./systems";

/** Kept apart from `equipment.ts`: the nameplate feeds the trade adapter, and the circuit name reads the adapter table. */

type Elements = Readonly<Record<string, BimElement>>;

/** One equipment connection as a schedule prints it. */
export interface EquipmentConnection {
  readonly elementId: string;
  readonly name: string;
  readonly connector: string;
  readonly voltage: number | null;
  readonly poles: number | null;
  readonly nameplate: EquipmentNameplate;
  /** The circuit it is on ("H1-13,15,17"), with its breaker and conductors. */
  readonly circuit: { readonly linkId: string; readonly name: string; readonly ratingA: number | null; readonly conductors: ConductorSet | null } | null;
}

/** A part's equipment connection: what it needs and what it is on. Null for parts with no electrical connection. */
export function equipmentConnectionOf(elements: Elements, partId: string): EquipmentConnection | null {
  const el = elements[partId];
  if (el?.kind !== "part") return null;
  const connector = electricalConnectorIds(elements, el)[0];
  if (!connector) return null;
  const demand = electricalConnectorOf(elements, el, connector);
  const link = linkServing(elements, el.id, connector);
  return {
    elementId: el.id,
    name: electricalName(elements, el),
    connector,
    voltage: demand?.voltage ?? null,
    poles: demand?.poles ?? null,
    nameplate: equipmentNameplate(elements, el),
    circuit: link ? { linkId: link.id, name: serviceLinkName(elements, link), ratingA: link.electrical?.ratingA ?? null, conductors: linkConstruction(elements, link).conductors } : null,
  };
}
