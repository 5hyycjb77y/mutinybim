import type { LinkedPlanDisplayRow } from "@permitzip/bim-kernel";

/** How a linked model's piping shows in plans (`kernel.linked_plan_display`): as MEP, up to the view's top and in ceiling plans; fixtures by their plan symbol. */
export const PLUMBING_LINKED_PLAN_DISPLAY: readonly LinkedPlanDisplayRow[] = [
  {
    id: "plumbing_gas.piping",
    label: "Pipes, fittings, valves and equipment",
    ifcEntities: ["IFCPIPESEGMENT", "IFCPIPEFITTING", "IFCVALVE", "IFCPUMP", "IFCTANK", "IFCINTERCEPTOR", "IFCFLOWMETER"],
    drawAs: "body",
    cut: true,
    below: true,
    above: true,
    ceilingPlan: true,
  },
  {
    id: "plumbing_gas.fixtures",
    label: "Plumbing fixtures",
    ifcEntities: ["IFCSANITARYTERMINAL", "IFCWASTETERMINAL"],
    drawAs: "symbol",
    cut: true,
    below: true,
    above: false,
    ceilingPlan: false,
  },
];
