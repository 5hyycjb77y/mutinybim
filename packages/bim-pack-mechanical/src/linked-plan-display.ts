import type { LinkedPlanDisplayRow } from "@permitzip/bim-kernel";

/**
 * How a linked model's air side shows in plans (`kernel.linked_plan_display`):
 * as Revit draws MEP, cut where the plane passes, seen below it, and seen above
 * it up to the view's top; in ceiling plans too. IFC2x3 exports write every
 * distribution element as one of the generic flow entities, so those rows are
 * here as well.
 */
const MEP_LIKE = { drawAs: "body", cut: true, below: true, above: true, ceilingPlan: true } as const;

export const MECHANICAL_LINKED_PLAN_DISPLAY: readonly LinkedPlanDisplayRow[] = [
  { id: "mechanical.ductwork", label: "Ductwork and fittings", ifcEntities: ["IFCDUCTSEGMENT", "IFCDUCTFITTING", "IFCDUCTSILENCER", "IFCDAMPER"], ...MEP_LIKE },
  { id: "mechanical.terminals", label: "Air terminals", ifcEntities: ["IFCAIRTERMINAL", "IFCAIRTERMINALBOX"], ...MEP_LIKE, drawAs: "symbol" },
  {
    id: "mechanical.equipment",
    label: "Mechanical equipment",
    ifcEntities: ["IFCUNITARYEQUIPMENT", "IFCFAN", "IFCAIRTOAIRHEATRECOVERY", "IFCCOIL", "IFCHUMIDIFIER", "IFCBOILER", "IFCCHILLER", "IFCCOOLINGTOWER", "IFCHEATEXCHANGER", "IFCEVAPORATIVECOOLER", "IFCSPACEHEATER"],
    ...MEP_LIKE,
  },
  {
    id: "mechanical.distribution_ifc2x3",
    label: "Distribution elements (IFC2x3 exports)",
    ifcEntities: ["IFCFLOWSEGMENT", "IFCFLOWFITTING", "IFCFLOWCONTROLLER", "IFCFLOWMOVINGDEVICE", "IFCENERGYCONVERSIONDEVICE", "IFCFLOWTREATMENTDEVICE", "IFCFLOWSTORAGEDEVICE"],
    ...MEP_LIKE,
  },
  { id: "mechanical.terminals_ifc2x3", label: "Terminals (IFC2x3 exports)", ifcEntities: ["IFCFLOWTERMINAL"], ...MEP_LIKE, drawAs: "symbol" },
];
