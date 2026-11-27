import type { LibraryRow, ScheduleColumnDef, ScheduleDefinitionV2 } from "@permitzip/bim-kernel";
import { CIVIL_CLASS, CIVIL_PARAM, STRUCTURE_CLASSES } from "./ids";

/**
 * Civil schedule templates (`kernel.library_rows`), contributed by the Civil
 * add-on: Storm Structure Schedule, Storm Pipe Schedule, Storm Catchment
 * Schedule, and Grading Surface Schedule. Every column reads live civil
 * parameters or solved gravity/TIN fields from the model.
 */

type FieldColumn = Extract<ScheduleColumnDef, { readonly kind: "field" }>;

const field = (path: string, heading: string, extra?: Partial<Omit<FieldColumn, "id" | "kind" | "path" | "heading">>): FieldColumn => ({
  id: path,
  kind: "field",
  path,
  heading,
  ...extra,
});

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
  display: { textSizeMm: 2.2, emptyText: "NONE" },
});

export const STORM_STRUCTURE_SCHEDULE = list(
  "STORM STRUCTURE SCHEDULE",
  STRUCTURE_CLASSES,
  [
    field("mark", "MARK"),
    field("civil.structure_type", "TYPE"),
    field(CIVIL_PARAM.rimElevation, "RIM ELEV.", { unit: "ft", precision: { kind: "decimals", digits: 2 } }),
    field(CIVIL_PARAM.invertElevation, "INV. ELEV.", { unit: "ft", precision: { kind: "decimals", digits: 2 } }),
    field("civil.structure_depth", "DEPTH", { unit: "ft", precision: { kind: "decimals", digits: 2 } }),
    field(CIVIL_PARAM.inletCapacity, "CAP. (CFS)", { unit: "cfs", precision: { kind: "decimals", digits: 2 } }),
    field("civil.total_runoff", "FLOW (CFS)", { unit: "cfs", precision: { kind: "decimals", digits: 2 } }),
    field("civil.downstream_structure", "DRAINS TO"),
  ],
  "mark",
);

export const STORM_PIPE_SCHEDULE = list(
  "STORM PIPE SCHEDULE",
  [CIVIL_CLASS.stormPipe],
  [
    field("civil.pipe_from", "FROM"),
    field("civil.pipe_to", "TO"),
    field("civil.pipe_diameter", "DIA.", { unit: "in", precision: { kind: "decimals", digits: 0 } }),
    field("civil.pipe_length", "LENGTH", { unit: "ft", precision: { kind: "decimals", digits: 1 } }),
    field("civil.pipe_slope", "SLOPE (%)", { unit: "%", precision: { kind: "decimals", digits: 2 } }),
    field("civil.pipe_flow", "FLOW (CFS)", { unit: "cfs", precision: { kind: "decimals", digits: 2 } }),
    field("civil.pipe_capacity", "CAP. (CFS)", { unit: "cfs", precision: { kind: "decimals", digits: 2 } }),
    field("civil.pipe_status", "STATUS"),
  ],
  "civil.pipe_from",
);

export const STORM_CATCHMENT_SCHEDULE = list(
  "STORM CATCHMENT SCHEDULE",
  [CIVIL_CLASS.catchment],
  [
    field("civil.catchment_name", "CATCHMENT"),
    field("civil.catchment_area", "AREA (FT²)", { unit: "ft2", precision: { kind: "decimals", digits: 0 } }),
    field(CIVIL_PARAM.surface, "SURFACE"),
    field("civil.effective_c", "C", { precision: { kind: "decimals", digits: 2 } }),
    field("civil.drains_to", "INLET"),
    field("civil.catchment_runoff", "PEAK Q (CFS)", { unit: "cfs", precision: { kind: "decimals", digits: 2 } }),
  ],
  "civil.catchment_name",
);

export const GRADING_SURFACE_SCHEDULE = list(
  "GRADING SURFACE SCHEDULE",
  [CIVIL_CLASS.gradingSurface],
  [
    field("civil.surface_name", "SURFACE"),
    field("civil.surface_role", "ROLE"),
    field("civil.surface_vertices", "POINTS", { precision: { kind: "decimals", digits: 0 } }),
    field("civil.surface_faces", "FACES", { precision: { kind: "decimals", digits: 0 } }),
    field("civil.surface_area", "AREA (FT²)", { unit: "ft2", precision: { kind: "decimals", digits: 0 } }),
    field("civil.surface_min_elevation", "MIN ELEV.", { unit: "ft", precision: { kind: "decimals", digits: 2 } }),
    field("civil.surface_max_elevation", "MAX ELEV.", { unit: "ft", precision: { kind: "decimals", digits: 2 } }),
  ],
  "civil.surface_name",
);

const template = (key: string, definition: ScheduleDefinitionV2, description: string): LibraryRow => ({
  section: "scheduleTemplates",
  item: {
    id: `civil:schedule_template:${key}`,
    revision: 1,
    key,
    name: definition.name,
    discipline: "civil",
    description,
    definition: { ...definition },
  },
});

export const CIVIL_SCHEDULE_TEMPLATES: readonly LibraryRow[] = [
  template("storm_structure_schedule", STORM_STRUCTURE_SCHEDULE, "Every storm inlet, manhole, and outfall with rim/invert elevations, structure depth, inlet capacity, accumulated runoff, and downstream connection."),
  template("storm_pipe_schedule", STORM_PIPE_SCHEDULE, "Every site storm pipe with upstream/downstream structures, diameter, length, slope, design flow, Manning full-flow capacity, and hydraulic status."),
  template("storm_catchment_schedule", STORM_CATCHMENT_SCHEDULE, "Every drainage catchment with plan area, surface type, runoff coefficient C, receiving inlet, and peak rational runoff."),
  template("grading_surface_schedule", GRADING_SURFACE_SCHEDULE, "Every imported LandXML grading TIN with role (existing/proposed), point/face counts, plan area, and elevation range."),
];
