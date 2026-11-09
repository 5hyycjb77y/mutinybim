import type { PackClass, PackParameterSet, ServiceRow } from "@permitzip/bim-pack/runtime";
import { WIDE_FLANGE_SECTIONS } from "./sections";

/**
 * The pack's classes, parameters and service row, as data.
 *
 * Classes are subclasses of the kernel's own rows (`struct.beam`,
 * `struct.column`, `struct.footing`, `arch.slab`) and carry the IFC 4.3 hints the exporter
 * reads. Elements take a class by their explicit `classId`; the class index
 * honours it, so nothing here is recognised by guessing.
 */

export const STRUCT_CLASSES: readonly PackClass[] = [
  { id: "struct.beam_steel", label: "Steel beams", discipline: "structure", parent: "struct.beam", ifc: { entity: "IfcBeam", predefinedType: "BEAM", typeEntity: "IfcBeamType" }, drawsUnder: "structure", description: "A rolled steel beam placed along a line, with a section from the catalogue." },
  { id: "struct.column_steel", label: "Steel columns", discipline: "structure", parent: "struct.column", ifc: { entity: "IfcColumn", predefinedType: "COLUMN", typeEntity: "IfcColumnType" }, drawsUnder: "structure", description: "A rolled steel column placed along a vertical line from its base to its top." },
  { id: "struct.footing_pad", label: "Pad footings", discipline: "structure", parent: "struct.footing", ifc: { entity: "IfcFooting", predefinedType: "PAD_FOOTING", typeEntity: "IfcFootingType" }, drawsUnder: "structure", description: "A spread footing under one column, placed at a point." },
  { id: "struct.roof_deck", label: "Roof decks", discipline: "structure", parent: "arch.slab", ifc: { entity: "IfcSlab", predefinedType: "ROOF", typeEntity: "IfcSlabType" }, drawsUnder: "structure", description: "A one-way roof deck over an area, spanning between beams in its span direction." },
  { id: "struct.floor_deck", label: "Floor decks", discipline: "structure", parent: "arch.slab", ifc: { entity: "IfcSlab", predefinedType: "FLOOR", typeEntity: "IfcSlabType" }, drawsUnder: "structure", description: "A one-way floor deck over an area, spanning between beams in its span direction." },
];

const MEMBERS = ["struct.beam_steel", "struct.column_steel"];

/** The element kinds a shared section types. */
export const SECTION_TYPE_KINDS = ["beam", "column"] as const;
const DECKS = ["struct.roof_deck", "struct.floor_deck"];

/**
 * The `struct.*` parameter set: what the Inspector, schedules, agent tools
 * and IFC export offer on the pack's elements. Equipment weight is the
 * baseline Structural set's existing `struct.operating_weight`, read by the
 * load path, never redefined here.
 */
export const STRUCT_PARAMETER_SET: PackParameterSet = {
  id: "struct.framing",
  label: "Structural framing",
  parameters: [
    { key: "struct.section", label: "Section", classes: MEMBERS, valueType: "choice", choices: WIDE_FLANGE_SECTIONS.map((s) => s.id), group: "Structural", description: "A wide-flange section from the Structural pack's catalogue.", ifc: { pset: "MutinyBIM_Structural", property: "Section" } },
    { key: "struct.grade", label: "Steel grade", classes: MEMBERS, valueType: "choice", choices: ["A992", "A36", "A572 Gr. 50"], group: "Structural", ifc: { pset: "MutinyBIM_Structural", property: "Grade" } },
    { key: "struct.occupancy", label: "Live load use", classes: DECKS, valueType: "text", group: "Structural", description: "The use the deck's live load comes from (struct.roof_ordinary, office_space).", ifc: { pset: "MutinyBIM_Structural", property: "LiveLoadUse" } },
  ],
};

/** The quantity keys the load path totals, in newtons (the kernel's SI for force). */
export const LOAD_KEYS = { dead: "struct.dead_load", live: "struct.live_load", equipment: "struct.equipment_load" } as const;

/** The network adapter id the gravity-load service names. */
export const LOAD_PATH_ADAPTER_ID = "struct.load_path";
export const GRAVITY_LOAD_SERVICE_ID = "struct.gravity_load";

/** What the gravity load path is, on the service registry. */
export const GRAVITY_LOAD_SERVICE: ServiceRow = {
  id: GRAVITY_LOAD_SERVICE_ID,
  label: "Gravity load path",
  discipline: "structure",
  medium: "structural",
  regime: "structural",
  connector: "member",
  adapter: LOAD_PATH_ADAPTER_ID,
  quantities: [LOAD_KEYS.dead, LOAD_KEYS.live, LOAD_KEYS.equipment],
  asSystem: false,
  asLoad: false,
  ifc: { system: "IfcStructuralAnalysisModel", predefinedType: "LOADING_3D" },
};
