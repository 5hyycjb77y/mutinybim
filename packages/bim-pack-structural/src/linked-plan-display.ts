import type { LinkedPlanDisplayRow } from "@permitzip/bim-kernel";

/** How a linked model's columns and framing members show in plans (`kernel.linked_plan_display`): cut where the plane passes, seen below it. */
export const STRUCTURAL_LINKED_PLAN_DISPLAY: readonly LinkedPlanDisplayRow[] = [
  {
    id: "struct.columns",
    label: "Columns, members and plates",
    ifcEntities: ["IFCCOLUMN", "IFCMEMBER", "IFCPLATE"],
    drawAs: "body",
    cut: true,
    below: true,
    above: false,
    ceilingPlan: true,
  },
];
