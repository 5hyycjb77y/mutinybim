import type { ModelState } from "@permitzip/bim-kernel";
import type { PackReadDef } from "@permitzip/bim-kernel/packs";
import { electricalConnections, isCircuitableLoad } from "./connections/panel";

/**
 * What the electrical add-on says about a planned row in the Not placed yet
 * list (a pack read the tool server merges into the row, see
 * `notPlacedYet` in @permitzip/bim-mcp): its circuit as the list's Circuit
 * button reads it, its name or "none yet", and nothing for a part with no
 * electrical load. A row with no circuit yet is counted as waiting.
 */
export const ELECTRICAL_PLANNED_ROW_FACTS: PackReadDef = {
  id: "electrical.planned_row_facts",
  label: "A planned part's circuit",
  run(model: ModelState, input: unknown) {
    const elementId = typeof input === "object" && input !== null && "elementId" in input ? (input as { elementId: unknown }).elementId : null;
    if (typeof elementId !== "string") return null;
    const part = model.elements[elementId];
    if (part?.kind !== "part" || !isCircuitableLoad(model.elements, part)) return null;
    const circuit = electricalConnections(model.elements, elementId).find((c) => c.circuit)?.circuit?.name ?? "none yet";
    return { facts: { circuit }, ...(circuit === "none yet" ? { waiting: "waiting_for_a_circuit" } : {}) };
  },
};
