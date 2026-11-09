import type { LibraryRow } from "@permitzip/bim-pack/runtime";

/**
 * Structural's rows in the built-in library (`kernel.library_rows`, contract
 * 1.12.0): the footing class the library recognises and the beam's camber
 * field. They used to sit in the built-in AEC bundle; ids, revisions and
 * every field are byte-identical, so a model or firm library that stored
 * them reads them unchanged. With Structural off they are absent.
 */

/** Kept in the element's own `values` (then its element type's), written with `set_element_values`. */
const VALUES = { kind: "values" } as const;

export const STRUCT_LIBRARY_ROWS: readonly LibraryRow[] = [
  {
    section: "classes",
    item: {
      id: "aec:class:struct.footing",
      revision: 1,
      key: "struct.footing",
      // The kernel has the same built-in row since 5c; the library keeps its item (and its revision) by replacing it.
      replaces: true,
      label: "Footings",
      discipline: "structure",
      ifc: { entity: "IfcFooting" },
      recognize: { elementKinds: ["component"], where: [{ path: "category", op: "equals", value: "footing" }] },
    },
  },
  {
    section: "fields",
    item: { id: "aec:field:struct.beam.camber", revision: 2, key: "struct.camber", aliases: ["camber"], label: "Camber", appliesTo: ["struct.beam"], valueType: "quantity", kind: "length", unit: "in", group: "Dimensions", editable: true, storage: VALUES },
  },
];
