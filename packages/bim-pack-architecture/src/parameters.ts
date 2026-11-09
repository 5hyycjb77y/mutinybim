import type { PackParameterSet } from "@permitzip/bim-pack/runtime";

/** Room bounding is the kernel's own parameter (`room_bounding`, beside the bounding point): a wall type sets it under that key. */
export { ROOM_BOUNDING_INSTANCE_KEY as ROOM_BOUNDING_KEY } from "@permitzip/bim-pack/runtime";

/**
 * Type parameters for walls, doors, windows, floors and ceilings. Set on the
 * element type (an instance's own value wins); each maps to its IFC4 common
 * property set by name. Ratings that the AEC library already defines (a
 * wall's `arch.fire_resistance`, a door's `arch.fire_rating`) are read, not
 * redefined. Enumerated values are IFC schema identifiers.
 */

export const SMOKE_BARRIER_KEY = "architecture.smoke_barrier";

const WALL_FUNCTIONS = ["STANDARD", "PARTITIONING", "PLUMBINGWALL", "SHEAR", "PARAPET", "MOVABLE", "SOLIDWALL", "ELEMENTEDWALL", "POLYGONAL", "RETAININGWALL", "WAVEWALL", "USERDEFINED", "NOTDEFINED"];
const DOOR_OPERATIONS = [
  "SINGLE_SWING_LEFT",
  "SINGLE_SWING_RIGHT",
  "DOUBLE_DOOR_SINGLE_SWING",
  "DOUBLE_SWING_LEFT",
  "DOUBLE_SWING_RIGHT",
  "DOUBLE_DOOR_DOUBLE_SWING",
  "SLIDING_TO_LEFT",
  "SLIDING_TO_RIGHT",
  "DOUBLE_DOOR_SLIDING",
  "FOLDING_TO_LEFT",
  "FOLDING_TO_RIGHT",
  "DOUBLE_DOOR_FOLDING",
  "REVOLVING",
  "ROLLINGUP",
  "SWING_FIXED_LEFT",
  "SWING_FIXED_RIGHT",
  "USERDEFINED",
  "NOTDEFINED",
];
const WINDOW_PARTITIONING = ["SINGLE_PANEL", "DOUBLE_PANEL_VERTICAL", "DOUBLE_PANEL_HORIZONTAL", "TRIPLE_PANEL_VERTICAL", "TRIPLE_PANEL_HORIZONTAL", "TRIPLE_PANEL_BOTTOM", "TRIPLE_PANEL_TOP", "TRIPLE_PANEL_LEFT", "TRIPLE_PANEL_RIGHT", "USERDEFINED", "NOTDEFINED"];
const SLAB_FUNCTIONS = ["FLOOR", "ROOF", "LANDING", "BASESLAB", "USERDEFINED", "NOTDEFINED"];

const OWN_PSET = "MutinyBIM_Architecture";

export const ARCHITECTURE_PARAMETER_SET: PackParameterSet = {
  id: "architecture.types",
  label: "Architecture types",
  parameters: [
    { key: "architecture.wall_function", label: "Wall function", classes: ["arch.wall"], valueType: "choice", choices: WALL_FUNCTIONS, group: "Identity", description: "What the wall is for (a plumbing wall, a shear wall); its IFC wall type.", ifc: { pset: OWN_PSET, property: "WallFunction" } },
    { key: "architecture.total_thickness", label: "Total thickness", classes: ["arch.wall"], valueType: "quantity", kind: "length", unit: "mm", group: "Dimensions", description: "The type's thickness, from its layers when it has them.", ifc: { qto: "Qto_WallBaseQuantities", quantity: "Width" } },
    { key: "architecture.is_external", label: "External", classes: ["arch.wall", "arch.door", "arch.window", "arch.slab"], valueType: "boolean", group: "Identity", ifc: { pset: "Pset_WallCommon", property: "IsExternal" } },
    { key: "architecture.load_bearing", label: "Load bearing", classes: ["arch.wall", "arch.slab"], valueType: "boolean", group: "Identity", ifc: { pset: "Pset_WallCommon", property: "LoadBearing" } },
    { key: "architecture.acoustic_rating", label: "Acoustic rating", classes: ["arch.wall", "arch.door", "arch.window", "arch.ceiling"], valueType: "text", group: "Ratings", description: "A sound class (STC 50).", ifc: { pset: "Pset_WallCommon", property: "AcousticRating" } },
    { key: SMOKE_BARRIER_KEY, label: "Smoke barrier", classes: ["arch.wall", "arch.door"], valueType: "boolean", group: "Ratings", ifc: { pset: OWN_PSET, property: "SmokeBarrier" } },
    { key: "architecture.door_operation", label: "Operation", classes: ["arch.door"], valueType: "choice", choices: DOOR_OPERATIONS, group: "Identity", ifc: { pset: OWN_PSET, property: "OperationType" } },
    { key: "architecture.frame_depth", label: "Frame depth", classes: ["arch.door", "arch.window"], valueType: "quantity", kind: "length", unit: "mm", group: "Dimensions", description: "How deep the frame is across the wall; blank: as deep as the wall." },
    { key: "architecture.window_partitioning", label: "Partitioning", classes: ["arch.window"], valueType: "choice", choices: WINDOW_PARTITIONING, group: "Identity", ifc: { pset: OWN_PSET, property: "PartitioningType" } },
    { key: "architecture.slab_function", label: "Floor function", classes: ["arch.slab"], valueType: "choice", choices: SLAB_FUNCTIONS, group: "Identity", description: "A floor, a roof, a landing or a base slab; its IFC slab type.", ifc: { pset: OWN_PSET, property: "SlabFunction" } },
  ],
};
