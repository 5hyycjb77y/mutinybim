import type { PackClass } from "@permitzip/bim-pack/runtime";

/**
 * The building classes, moved out of the kernel (round 13). Ids, hints and
 * order unchanged, so every classified record keeps its class and
 * recognition answers as before. The kernel lists them just ahead of its
 * fallback `gen.building_element`, so with this add-on on they win, and with
 * it off the element still classifies, draws and bounds.
 */

export const ARCHITECTURE_CLASSES: readonly PackClass[] = [
  { id: "arch.wall", label: "Walls", discipline: "architecture", ifc: { entity: "IfcWall", typeEntity: "IfcWallType" }, recognize: { elementKinds: ["wall"] } },
  { id: "arch.slab", label: "Floors and slabs", discipline: "architecture", ifc: { entity: "IfcSlab", typeEntity: "IfcSlabType" }, recognize: { elementKinds: ["slab"] } },
  { id: "arch.door", label: "Doors", discipline: "architecture", ifc: { entity: "IfcDoor", typeEntity: "IfcDoorType" }, recognize: { elementKinds: ["opening"], where: [{ path: "openingType", op: "equals", value: "door" }] } },
  { id: "arch.window", label: "Windows", discipline: "architecture", ifc: { entity: "IfcWindow", typeEntity: "IfcWindowType" }, recognize: { elementKinds: ["opening"], where: [{ path: "openingType", op: "equals", value: "window" }] } },
  { id: "arch.room", label: "Rooms", discipline: "architecture", ifc: { entity: "IfcSpace", predefinedType: "INTERNAL" }, recognize: { elementKinds: ["room"] } },
  { id: "arch.component", label: "Components", discipline: "architecture", ifc: { entity: "IfcFurnishingElement" }, recognize: { elementKinds: ["component"] } },
  {
    id: "arch.ceiling",
    label: "Ceilings",
    discipline: "architecture",
   
    ifc: { entity: "IfcCovering", predefinedType: "CEILING" },
    recognize: { elementKinds: ["ceiling"] },
    description: "Typed horizontal surfaces: flat, sloped, clouds, soffits and open to structure, with what they are made of as an element type.",
  },
  { id: "arch.roof", label: "Roofs", discipline: "architecture", ifc: { entity: "IfcRoof", predefinedType: "FLAT_ROOF", typeEntity: "IfcRoofType" }, recognize: { elementKinds: ["architecture.roof"] } },
  { id: "arch.stair", label: "Stairs", discipline: "architecture", ifc: { entity: "IfcStair", predefinedType: "STRAIGHT_RUN_STAIR", typeEntity: "IfcStairType" }, recognize: { elementKinds: ["architecture.stair"] } },
];
