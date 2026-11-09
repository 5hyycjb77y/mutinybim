import type { LinkedReferenceRow } from "@permitzip/bim-kernel";

/** A linked model's columns and framing as snap and dimension references (`kernel.linked_reference`): corners and faces of columns, faces and centre lines of beams in plan. */
export const STRUCTURAL_LINKED_REFERENCE: readonly LinkedReferenceRow[] = [
  { id: "struct.columns", label: "Columns", ifcEntities: ["IFCCOLUMN", "IFCCOLUMNSTANDARDCASE"], noun: "column", snap: true, boundsRooms: false },
  { id: "struct.framing", label: "Beams and members", ifcEntities: ["IFCBEAM", "IFCBEAMSTANDARDCASE", "IFCMEMBER"], noun: "beam", snap: true, boundsRooms: false },
];
