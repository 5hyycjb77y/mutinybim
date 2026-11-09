import type { LibraryRow, ScheduleColumnDef, ScheduleDefinitionV2, ScheduleFilter } from "@permitzip/bim-kernel";

/**
 * The Plumbing add-on's schedule templates (round 15), contributed to the
 * built-in library through `kernel.library_rows` as Architecture's are: a
 * plumbing fixture schedule (with each fixture's WSFU and DFU), a water
 * heater schedule and a pump schedule. Each is an ordinary class schedule
 * (ScheduleDefinitionV2) over the kernel's classes and this add-on's fields
 * (`load.*`, `load.size.*`, `connection_type.*`), so New schedule… lists
 * them with the add-on on and names them while it is off (`ADDON_UI`).
 */

const field = (path: string, heading: string, extra: Partial<Pick<ScheduleColumnDef, "total" | "hideWhenEmpty">> = {}): ScheduleColumnDef => ({ id: path, kind: "field", path, heading, ...extra });
const param = (path: string, heading: string): ScheduleColumnDef => ({ id: path, kind: "parameter", path, heading, hideWhenEmpty: true });

function list(name: string, classes: readonly string[], columns: readonly ScheduleColumnDef[], filters: readonly ScheduleFilter[], grandTotals: boolean): ScheduleDefinitionV2 {
  return {
    name,
    source: { kind: "classes", classes, includeSubclasses: true },
    columns,
    filters,
    sort: [{ path: "mark", direction: "asc" }],
    groups: [],
    grandTotals,
    itemize: true,
    presentation: { kind: "list" },
    display: { textSizeMm: 2.5, emptyText: "NONE" },
  };
}

/** Fixtures (not water heaters): mark, what it is, its fixture units and connection sizes; WSFU and DFU totalled. */
export const PLUMBING_FIXTURE_SCHEDULE = list(
  "Plumbing fixture schedule",
  ["mep.plumbing_fixture"],
  [
    field("mark", "MARK"),
    field("family", "FIXTURE"),
    field("type_name", "TYPE"),
    field("connection_type.mark", "CONN. TYPE", { hideWhenEmpty: true }),
    field("load.wsfu_cold", "CW WSFU", { total: true, hideWhenEmpty: true }),
    field("load.wsfu_hot", "HW WSFU", { total: true, hideWhenEmpty: true }),
    field("load.wsfu_total", "TOTAL WSFU", { total: true, hideWhenEmpty: true }),
    field("load.dfu", "DFU", { total: true, hideWhenEmpty: true }),
    field("load.size.cw", "CW", { hideWhenEmpty: true }),
    field("load.size.hw", "HW", { hideWhenEmpty: true }),
    field("load.size.w", "WASTE", { hideWhenEmpty: true }),
    field("load.size.v", "VENT", { hideWhenEmpty: true }),
    field("room", "ROOM", { hideWhenEmpty: true }),
  ],
  [{ path: "heater_kind", op: "absent" }],
  true,
);

/** Water heaters: kind, gas input, hot water demand served and connections. */
export const WATER_HEATER_SCHEDULE = list(
  "Water heater schedule",
  ["mep.plumbing_fixture"],
  [
    field("mark", "MARK"),
    field("family", "DESCRIPTION"),
    field("type_name", "TYPE"),
    param("heater_kind", "KIND"),
    field("connection_type.mark", "CONN. TYPE", { hideWhenEmpty: true }),
    field("load.mbh", "GAS INPUT (MBH)", { hideWhenEmpty: true }),
    field("load.size.cw", "CW", { hideWhenEmpty: true }),
    field("load.size.hw", "HW", { hideWhenEmpty: true }),
    field("load.size.g", "GAS", { hideWhenEmpty: true }),
    field("room", "ROOM", { hideWhenEmpty: true }),
  ],
  [{ path: "heater_kind", op: "present" }],
  false,
);

/** Pumps on the piping (recirculation and the like): flow and connection size. */
export const PUMP_SCHEDULE = list(
  "Pump schedule",
  ["mep.pipe_accessory"],
  [
    field("mark", "MARK"),
    field("family", "DESCRIPTION"),
    field("type_name", "TYPE"),
    field("connection_type.mark", "CONN. TYPE", { hideWhenEmpty: true }),
    field("load.gpm_fixed", "FLOW (GPM)", { hideWhenEmpty: true }),
    field("load.size.hw", "SIZE", { hideWhenEmpty: true }),
    field("room", "ROOM", { hideWhenEmpty: true }),
  ],
  [{ path: "family", op: "contains", value: "pump" }],
  false,
);

/** Keys and names, as `ADDON_UI` names them for New schedule… while the add-on is off. */
export const PLUMBING_SCHEDULE_TEMPLATE_NAMES = [
  { key: "plumbing_fixture_schedule", name: PLUMBING_FIXTURE_SCHEDULE.name },
  { key: "water_heater_schedule", name: WATER_HEATER_SCHEDULE.name },
  { key: "pump_schedule", name: PUMP_SCHEDULE.name },
] as const;

const template = (key: string, definition: ScheduleDefinitionV2, description: string): LibraryRow => ({
  section: "scheduleTemplates",
  item: { id: `plumbing:schedule_template:${key}`, revision: 1, key, name: definition.name, discipline: "plumbing", description, definition: { ...definition } },
});

export const PLUMBING_SCHEDULE_TEMPLATES: readonly LibraryRow[] = [
  template("plumbing_fixture_schedule", PLUMBING_FIXTURE_SCHEDULE, "Every plumbing fixture with its mark, type, cold, hot and total water fixture units, drainage fixture units and connection sizes; totals at the foot."),
  template("water_heater_schedule", WATER_HEATER_SCHEDULE, "Every water heater with its kind, gas input and cold, hot and gas connections."),
  template("pump_schedule", PUMP_SCHEDULE, "Every pump on the piping with its flow and connection size."),
];
