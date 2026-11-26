import type { LibraryRow, ScheduleColumnDef, ScheduleDefinitionV2 } from "@permitzip/bim-kernel";

/**
 * Structural schedule templates (`kernel.library_rows`), contributed by the
 * Structural add-on: Column Schedule, Beam Framing Schedule, and Pad Footing
 * Schedule. Each reads live geometry, AISC section metadata, and service-level
 * gravity load path totals (`struct.gravity_load`) directly from the model.
 */

const field = (path: string, heading: string): ScheduleColumnDef => ({ id: path, kind: "field", path, heading });

const list = (name: string, classes: readonly string[], columns: readonly ScheduleColumnDef[], sortPath: string): ScheduleDefinitionV2 => ({
  name,
  source: { kind: "classes", classes, includeSubclasses: true },
  columns,
  filters: [],
  sort: [{ path: sortPath, direction: "asc" }],
  groups: [],
  grandTotals: false,
  itemize: true,
  presentation: { kind: "list" },
  display: { textSizeMm: 2.3, emptyText: "NONE" },
});

export const COLUMN_SCHEDULE = list(
  "STRUCTURAL COLUMN SCHEDULE",
  ["struct.column"],
  [
    field("mark", "MARK"),
    field("section", "SECTION"),
    field("grade", "GRADE"),
    field("level", "BASE LEVEL"),
    field("top_level", "TOP LEVEL"),
    field("height", "HEIGHT"),
    field("gravity_total", "GRAVITY LOAD"),
  ],
  "mark",
);

export const BEAM_SCHEDULE = list(
  "STRUCTURAL BEAM FRAMING SCHEDULE",
  ["struct.beam"],
  [
    field("mark", "MARK"),
    field("section", "SECTION"),
    field("grade", "GRADE"),
    field("level", "LEVEL"),
    field("length", "SPAN"),
    field("depth", "DEPTH"),
    field("max_moment", "MAX MOMENT"),
    field("end_reaction", "END REACTION"),
    { id: "max_deflection", kind: "field", path: "max_deflection", heading: "MAX DEFL.", unit: "in", precision: { kind: "decimals", digits: 2 } },
    field("deflection_ratio", "L/Δ"),
  ],
  "mark",
);

export const FOOTING_SCHEDULE = list(
  "PAD FOOTING SCHEDULE",
  ["struct.footing"],
  [
    field("mark", "MARK"),
    field("width", "WIDTH"),
    field("depth", "LENGTH"),
    field("thickness", "THICKNESS"),
    field("gravity_dead", "DEAD"),
    field("gravity_live", "LIVE"),
    field("gravity_equipment", "EQUIP."),
    field("gravity_total", "TOTAL LOAD"),
  ],
  "mark",
);

const template = (key: string, definition: ScheduleDefinitionV2, description: string): LibraryRow => ({
  section: "scheduleTemplates",
  item: {
    id: `struct:schedule_template:${key}`,
    revision: 1,
    key,
    name: definition.name,
    discipline: "structure",
    description,
    definition: { ...definition },
  },
});

export const STRUCTURAL_SCHEDULE_TEMPLATES: readonly LibraryRow[] = [
  template("column_schedule", COLUMN_SCHEDULE, "Every structural column with its mark, AISC section, grade, base/top levels, height, and live gravity load."),
  template("beam_schedule", BEAM_SCHEDULE, "Every structural beam with its mark, AISC section, grade, level, span, depth, maximum moment, end reaction, elastic deflection, and L/Δ ratio."),
  template("footing_schedule", FOOTING_SCHEDULE, "Every pad footing with its mark, plan dimensions, thickness, and service-level dead, live, equipment, and total gravity loads."),
];
