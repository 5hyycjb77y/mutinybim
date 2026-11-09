import type { PackRefusal } from "../packs/points";
import type { ElementId, ModelState } from "../types";
import type { HostVoid } from "./contract";
import { hostVoidsOf } from "./voids";

/**
 * Host voids (contract 1.11.0, `kernel.host_void` v1): the point, its rows
 * and the void shape are in `contract.ts`; the kernel's own rows in
 * `rows.ts`; the readers over the hosted index in `voids.ts`.
 */

export * from "./contract";

/** The voids cut in one host, in hosted-element id order. Refused, in words, when there is no such element. */
export function voidsOf(model: ModelState, hostId: ElementId): readonly HostVoid[] | PackRefusal {
  if (!model.elements[hostId]) return { refused: `There is no element ${hostId} in this model` };
  return hostVoidsOf(model.elements, hostId);
}
