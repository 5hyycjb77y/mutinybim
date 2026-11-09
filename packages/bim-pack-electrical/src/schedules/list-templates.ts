import type { LibraryRow, ScheduleColumnDef, ScheduleDefinitionV2 } from "@permitzip/bim-kernel";

/**
 * The Electrical add-on's list schedule templates (round 15, E3), in the
 * built-in library through `kernel.library_rows` as Plumbing's and
 * Architecture's are. The lighting fixture schedule is an ordinary class
 * schedule (ScheduleDefinitionV2) over the kernel's lighting class, the
 * fixture type's own parameters and this add-on's fields (`circuit`,
 * `voltage_phase`, `load`), grouped by type so each type prints once with
 * its count. New schedule… lists it with the add-on on and names it while
 * it is off (`ADDON_UI.scheduleTemplates`).
 */

const field = (path: string, heading: string, extra: Partial<Pick<ScheduleColumnDef, "total" | "hideWhenEmpty">> = {}): ScheduleColumnDef => ({ id: path, kind: "field", path, heading, ...extra });
const param = (path: string, heading: string, extra: Partial<Pick<ScheduleColumnDef, "total">> = {}): ScheduleColumnDef => ({ id: path, kind: "parameter", path, heading, hideWhenEmpty: true, ...extra });

/** Every lighting fixture: type, what it is, lamp output and input power, voltage, emergency battery, circuit and load; load totalled. */
export const LIGHTING_FIXTURE_SCHEDULE: ScheduleDefinitionV2 = {
  name: "Lighting fixture schedule",
  source: { kind: "classes", classes: ["mep.lighting_fixture"], includeSubclasses: true },
  columns: [
    field("mark", "MARK"),
    field("family", "DESCRIPTION"),
    field("type_name", "TYPE"),
    param("lumens", "LUMENS"),
    param("watts", "WATTS", { total: true }),
    param("voltage", "VOLTS"),
    param("emergency", "EM"),
    field("circuit", "CIRCUIT", { hideWhenEmpty: true }),
    field("load", "LOAD (VA)", { total: true, hideWhenEmpty: true }),
    field("room", "ROOM", { hideWhenEmpty: true }),
  ],
  filters: [],
  sort: [{ path: "mark", direction: "asc" }],
  groups: [],
  grandTotals: true,
  itemize: true,
  presentation: { kind: "list" },
  display: { textSizeMm: 2.5, emptyText: "NONE" },
};

/** Keys and names, as `ADDON_UI` names them for New schedule… while the add-on is off. */
export const ELECTRICAL_SCHEDULE_TEMPLATE_NAMES = [{ key: "lighting_fixture_schedule", name: LIGHTING_FIXTURE_SCHEDULE.name }] as const;

const template = (key: string, definition: ScheduleDefinitionV2, description: string): LibraryRow => ({
  section: "scheduleTemplates",
  item: { id: `electrical:schedule_template:${key}`, revision: 1, key, name: definition.name, discipline: "electrical", description, definition: { ...definition } },
});

export const ELECTRICAL_SCHEDULE_TEMPLATES: readonly LibraryRow[] = [
  template("lighting_fixture_schedule", LIGHTING_FIXTURE_SCHEDULE, "Every lighting fixture with its type, lumens, watts, voltage, emergency battery, circuit and load; watts and load totalled."),
];
