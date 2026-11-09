import type { LinkedPlanDisplayRow } from "@permitzip/bim-kernel";

/**
 * How the architect's linked model shows in plans (`kernel.linked_plan_display`):
 * walls and the rest of the building cut where the plane passes and seen below
 * it; doors and furniture by the exporter's plan symbol; floors and roofs seen
 * below only (everything stands on them); ceilings in ceiling plans only.
 */
export const ARCHITECTURE_LINKED_PLAN_DISPLAY: readonly LinkedPlanDisplayRow[] = [
  {
    id: "architecture.walls",
    label: "Walls, windows, railings and stairs",
    ifcEntities: ["IFCWALL", "IFCWALLSTANDARDCASE", "IFCCURTAINWALL", "IFCWINDOW", "IFCRAILING", "IFCSTAIR", "IFCSTAIRFLIGHT"],
    drawAs: "body",
    cut: true,
    below: true,
    above: false,
    ceilingPlan: true,
  },
  {
    id: "architecture.symbols",
    label: "Doors, furniture and generic models",
    ifcEntities: ["IFCDOOR", "IFCFURNITURE", "IFCFURNISHINGELEMENT", "IFCBUILDINGELEMENTPROXY"],
    drawAs: "symbol",
    cut: true,
    below: true,
    above: false,
    ceilingPlan: false,
  },
  {
    id: "architecture.floors",
    label: "Floors and roofs",
    ifcEntities: ["IFCSLAB", "IFCROOF"],
    drawAs: "body",
    cut: false,
    below: true,
    above: false,
    ceilingPlan: false,
    occludes: false,
  },
  {
    id: "architecture.ceilings",
    label: "Ceilings",
    ifcEntities: ["IFCCOVERING"],
    drawAs: "body",
    cut: true,
    below: false,
    above: false,
    ceilingPlan: true,
  },
];
