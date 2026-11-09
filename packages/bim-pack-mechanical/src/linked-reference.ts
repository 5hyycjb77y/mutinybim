import type { LinkedReferenceRow } from "@permitzip/bim-kernel";

/**
 * What a linked building model gives the mechanical engineer besides
 * linework (`kernel.linked_reference`): its walls bound the spaces found from
 * walls and are snapped to, and walls, windows, doors and roofs are read as
 * envelope facts for loads. Read-only: nothing is copied into the model.
 */
export const MECHANICAL_LINKED_REFERENCE: readonly LinkedReferenceRow[] = [
  { id: "mechanical.envelope_walls", label: "Walls (room bounds and envelope)", ifcEntities: ["IFCWALL", "IFCWALLSTANDARDCASE", "IFCWALLELEMENTEDCASE", "IFCCURTAINWALL"], noun: "wall", snap: true, boundsRooms: true, envelope: "wall" },
  { id: "mechanical.envelope_windows", label: "Windows (envelope)", ifcEntities: ["IFCWINDOW", "IFCWINDOWSTANDARDCASE"], noun: "window", snap: true, boundsRooms: false, envelope: "window" },
  { id: "mechanical.envelope_doors", label: "Doors (envelope)", ifcEntities: ["IFCDOOR", "IFCDOORSTANDARDCASE"], noun: "door", snap: true, boundsRooms: false, envelope: "door" },
  { id: "mechanical.envelope_roofs", label: "Roofs (envelope)", ifcEntities: ["IFCROOF"], noun: "roof", snap: false, boundsRooms: false, envelope: "roof" },
];
