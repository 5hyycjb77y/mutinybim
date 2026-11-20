import { CLASS_POINT, LIBRARY_ROWS_POINT, PARAMETER_SET_POINT, PART_TYPE_POINT, TAG_STYLE_PRESET_POINT, contribute, definePack, type LibraryEntry, type LibraryRow, type PackClass, type PackParameterSet, type TagStylePresetRow } from "@permitzip/bim-pack/runtime";

export const PLANTER_CLASS = "garden.planter";
export const PLANTER_TYPE_ID = "garden:planter@1";

export const PLANTER_CLASSES: readonly PackClass[] = [{
  id: PLANTER_CLASS,
  label: "Planter",
  parent: "gen.generic_model",
  discipline: "architecture",
  recognize: { elementKinds: ["part"], where: [{ path: "classId", op: "equals", value: PLANTER_CLASS }] },
  description: "A synthetic planter for learning the add-on contract.",
}];

export const PLANTER_PARAMETERS: readonly PackParameterSet[] = [{
  id: "garden.planter_properties",
  label: "Planter properties",
  parameters: [
    { key: "garden.soil_volume", label: "Soil volume", classes: [PLANTER_CLASS], valueType: "quantity", kind: "volume", unit: "m3", group: "Garden" },
    { key: "garden.plant", label: "Plant", classes: [PLANTER_CLASS], valueType: "text", group: "Garden" },
  ],
}];

/** Fixed synthetic geometry in mm. Soil volume is metadata, not a geometry driver. */
export const PLANTER_TYPE: LibraryEntry = {
  id: PLANTER_TYPE_ID,
  definition: {
    familyName: "Tutorial planter",
    typeName: "600 mm square",
    category: "generic",
    typeParams: [],
    typeValues: {},
    instanceParams: [],
    connectors: [],
    geometry: [{ kind: "box", center: [0, 0, 300], size: [600, 600, 600] }],
    symbol: [{ kind: "polyline", closed: true, points: [[-300, -300], [300, -300], [300, 300], [-300, 300], [-300, -300]] }],
    tagFields: ["mark"],
    source: { kind: "builtin", libraryVersion: "garden-0.1.0" },
  },
};

export const PLANTER_SCHEDULE: LibraryRow = {
  section: "scheduleTemplates",
  item: {
    id: "garden:schedule_template:planters",
    revision: 1,
    key: "garden.planters",
    name: "Planters",
    discipline: "architecture",
    description: "The tutorial's planters, with plant and soil volume.",
    definition: {
      name: "Planters",
      source: { kind: "classes", classes: [PLANTER_CLASS], includeSubclasses: true },
      columns: [
        { id: "mark", kind: "field", path: "mark", heading: "MARK" },
        { id: "plant", kind: "field", path: "garden.plant", heading: "PLANT" },
        { id: "soil", kind: "field", path: "garden.soil_volume", heading: "SOIL VOLUME" },
      ],
      filters: [], sort: [{ path: "mark", direction: "asc" }], groups: [], grandTotals: false, itemize: true,
      presentation: { kind: "list" }, display: { textSizeMm: 2.5, emptyText: "NONE" },
    },
  },
};

export const PLANTER_TAGS: readonly TagStylePresetRow[] = [{
  id: "garden.planter",
  rank: 10,
  preset: { id: "garden.planter", trade: "general", name: "Planter mark and type", description: "The planter's mark and type name.", lines: ["{mark}", "{type}"], box: "box", appliesTo: ["part"] },
}];

export const PLANTER_PACK = definePack(
  { id: "garden", name: "Tutorial garden", version: "0.1.0", kernel: "^1.13.0", description: "A synthetic planter, its properties, schedule and tag." },
  [
    contribute(CLASS_POINT, PLANTER_CLASSES),
    contribute(PARAMETER_SET_POINT, PLANTER_PARAMETERS),
    contribute(PART_TYPE_POINT, [{ entry: PLANTER_TYPE }]),
    contribute(LIBRARY_ROWS_POINT, [PLANTER_SCHEDULE]),
    contribute(TAG_STYLE_PRESET_POINT, PLANTER_TAGS),
  ],
);
