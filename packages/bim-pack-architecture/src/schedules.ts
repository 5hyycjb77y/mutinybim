import type { LibraryRow, ScheduleColumnDef, ScheduleDefinitionV2 } from "@permitzip/bim-kernel";

/**
 * The Architecture add-on's schedule templates (round 14), contributed to
 * the built-in library through `kernel.library_rows`: a door schedule, a
 * window schedule and a wall-type schedule. Each is an ordinary class
 * schedule (ScheduleDefinitionV2) on the add-on's own classes; with the
 * add-on off, the library has none of them and New schedule… says where
 * they come from. Item bodies are the library's `schedule_template` shape.
 */

const field = (path: string, heading: string): ScheduleColumnDef => ({ id: path, kind: "field", path, heading });

const list = (name: string, classes: readonly string[], columns: readonly ScheduleColumnDef[], itemize: boolean): ScheduleDefinitionV2 => ({
  name,
  source: { kind: "classes", classes, includeSubclasses: true },
  columns,
  filters: [],
  sort: [{ path: columns[0]?.id ?? "mark", direction: "asc" }],
  groups: [],
  grandTotals: false,
  itemize,
  presentation: { kind: "list" },
  display: { textSizeMm: 2.5, emptyText: "NONE" },
});

export const DOOR_SCHEDULE = list("Door schedule", ["arch.door"], [field("mark", "MARK"), field("type", "TYPE"), field("width", "WIDTH"), field("height", "HEIGHT"), field("fire_rating", "RATING"), field("swing", "SWING")], true);

/** Size prints as width and height so each length follows the model's units. */
export const WINDOW_SCHEDULE = list("Window schedule", ["arch.window"], [field("mark", "MARK"), field("type", "TYPE"), field("width", "SIZE W"), field("height", "SIZE H"), field("sill", "SILL"), field("head", "HEAD")], true);

/** One row per wall type: walls whose shown values match combine (`itemize: false`). */
export const WALL_TYPES_SCHEDULE = list(
  "Wall types",
  ["arch.wall"],
  [field("type", "TYPE"), field("function", "FUNCTION"), field("total_thickness", "TOTAL THICKNESS"), field("fire_rating", "RATING"), field("bounds_rooms", "ROOM BOUNDING")],
  false,
);

const template = (key: string, definition: ScheduleDefinitionV2, description: string): LibraryRow => ({
  section: "scheduleTemplates",
  item: { id: `architecture:schedule_template:${key}`, revision: 1, key, name: definition.name, discipline: "architecture", description, definition: { ...definition } },
});

export const ARCHITECTURE_SCHEDULE_TEMPLATES: readonly LibraryRow[] = [
  template("door_schedule", DOOR_SCHEDULE, "Every door with its mark, type, width, height, fire rating and swing."),
  template("window_schedule", WINDOW_SCHEDULE, "Every window with its mark, type, size, sill and head heights."),
  template("wall_types", WALL_TYPES_SCHEDULE, "One row per wall type: its function, total thickness, fire rating and whether it bounds rooms."),
];
