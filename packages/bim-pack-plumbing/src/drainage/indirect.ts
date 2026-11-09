import { resolveConnectors, drainSystemKinds } from "@permitzip/bim-kernel";
import type { RunSegment, BimElement, ElementId } from "@permitzip/bim-kernel";

type Elements = Readonly<Record<string, BimElement>>;

/**
 * Indirect waste (IPC 802): equipment that discharges indirectly (an ice
 * machine, a dishwasher, a prep sink in food service) drains into a receptor
 * such as a floor sink through an air gap or air break, never by a pipe joined
 * to the drain. In the model that is an indirect waste line whose end stays
 * open above the receptor. An end joined to a receptor (a part that drains to
 * the building drain: it has a sanitary or grease waste connection), or to a
 * drain's pipe, is a solid connection with no air gap. An end joined to the
 * equipment's own discharge (an outlet) is where the line starts.
 */

export const INDIRECT_WASTE_KIND = "indirect_waste";

export interface IndirectWasteSolidJoint {
  readonly segmentId: ElementId;
  readonly end: "start" | "end";
  /** The receptor part or drain run the indirect line is joined to. */
  readonly toId: ElementId;
  /** A receptor's drain connection, or another drain's pipe. */
  readonly to: "receptor" | "drain_pipe";
  /** The receptor's connector and its label, when `to` is a receptor. */
  readonly connector: string | null;
  readonly connectorLabel: string | null;
}

function systemKindOf(elements: Elements, systemId: ElementId): string | null {
  const s = elements[systemId];
  return s?.kind === "mep_system" ? s.systemKind : null;
}

/** Whether a segment is on an indirect waste system. */
export function isIndirectWasteSegment(elements: Elements, seg: RunSegment): boolean {
  return systemKindOf(elements, seg.systemId) === INDIRECT_WASTE_KIND;
}

/** The ends of an indirect waste segment joined solid to a drain: each is a missing air gap. Empty for any other segment. */
export function indirectWasteSolidJoints(elements: Elements, seg: RunSegment): readonly IndirectWasteSolidJoint[] {
  if (!isIndirectWasteSegment(elements, seg)) return [];
  const drains = drainSystemKinds();
  const out: IndirectWasteSolidJoint[] = [];
  for (const end of ["start", "end"] as const) {
    const link = seg.links[end];
    if (!link) continue;
    const other = elements[link.elementId];
    if (other?.kind === "part") {
      const type = elements[other.typeId];
      if (type?.kind !== "part_type") continue;
      const connectors = resolveConnectors(type.definition, other.values);
      const c = connectors.find((x) => x.id === link.port);
      if (!c) continue;
      const outlet = type.definition.connectors.find((x) => x.id === c.id)?.flowDirection === "out";
      const drainsToBuilding = connectors.some((x) => x.systemKind !== INDIRECT_WASTE_KIND && drains.has(x.systemKind));
      if (drainsToBuilding && !(outlet && c.systemKind === INDIRECT_WASTE_KIND)) out.push({ segmentId: seg.id, end, toId: other.id, to: "receptor", connector: c.id, connectorLabel: c.label });
      continue;
    }
    if (other?.kind === "run_segment" || other?.kind === "run_fitting") {
      const kind = systemKindOf(elements, other.systemId);
      if (kind !== null && kind !== INDIRECT_WASTE_KIND && drains.has(kind)) out.push({ segmentId: seg.id, end, toId: other.id, to: "drain_pipe", connector: null, connectorLabel: null });
    }
  }
  return out;
}
