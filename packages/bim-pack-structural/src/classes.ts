import type { PackClass } from "@permitzip/bim-pack/runtime";

/**
 * The structural classes, moved out of the kernel (round 14). Ids, hints and
 * order unchanged, so every classified record keeps its class and
 * recognition answers as before. They take no element kind away from the
 * kernel's fallback class, so the kernel lists them just after it, where
 * they always sat; `drawsUnder` carries the view category the kernel's own
 * table gave them.
 */
export const STRUCTURAL_CLASSES: readonly PackClass[] = [
  { id: "struct.grid", label: "Grids", discipline: "structure", ifc: { entity: "IfcGrid" }, recognize: { elementKinds: ["grid"] }, drawsUnder: "grids" },
  { id: "struct.column", label: "Columns", discipline: "structure", ifc: { entity: "IfcColumn" }, recognize: { elementKinds: ["column"] }, drawsUnder: "structure" },
  { id: "struct.beam", label: "Beams", discipline: "structure", ifc: { entity: "IfcBeam" }, recognize: { elementKinds: ["beam"] }, drawsUnder: "structure" },
  // The AEC library's row of the same id (Structural's library rows) replaces it with the same content.
  { id: "struct.footing", label: "Footings", discipline: "structure", ifc: { entity: "IfcFooting" }, recognize: { elementKinds: ["component"], where: [{ path: "category", op: "equals", value: "footing" }] } },
];
