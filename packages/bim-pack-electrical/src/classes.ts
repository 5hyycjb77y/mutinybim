import type { PackClass } from "@permitzip/bim-pack/runtime";

/**
 * First-party Electrical device subclasses under `mep.electrical_device` so
 * power plans can hide lighting controls (`electrical.lighting_control`) and
 * lighting plans can hide receptacles (`electrical.receptacle`) independently
 * through standard view `categoryOverrides`.
 */
export const ELECTRICAL_CLASSES: readonly PackClass[] = [
  {
    id: "electrical.receptacle",
    label: "Receptacles",
    parent: "mep.electrical_device",
    discipline: "electrical",
    ifc: { entity: "IfcOutlet", predefinedType: "POWEROUTLET", typeEntity: "IfcOutletType" },
    recognize: {
      partCategories: ["electrical_device"],
      where: [{ path: "family", op: "contains", value: "receptacle" }],
    },
  },
  {
    id: "electrical.lighting_control",
    label: "Lighting controls & switches",
    parent: "mep.electrical_device",
    discipline: "electrical",
    ifc: { entity: "IfcSwitchingDevice", typeEntity: "IfcSwitchingDeviceType" },
    recognize: {
      partCategories: ["electrical_device"],
      where: [{ path: "param.device_role", op: "equals", value: "lighting_control" }],
    },
  },
];
