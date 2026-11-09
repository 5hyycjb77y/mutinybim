import type { LibraryRow, ScheduleColumnDef, ScheduleDefinitionV2 } from "@permitzip/bim-kernel";

/**
 * The Mechanical add-on's schedule templates (round 15), contributed to the
 * built-in library through `kernel.library_rows` as Architecture's and
 * Plumbing's are: an air device schedule (each diffuser and grille with its
 * airflow from its neck connector) and a mechanical equipment schedule
 * (units and fans with capacity, airflow, electrical, weight, curb,
 * clearance and sequence of operation; the vendor fields in
 * `fields/vendor.ts`). Each is an ordinary class schedule over the kernel's
 * classes, so New schedule… lists them with the add-on on and names them
 * while it is off (`ADDON_UI.scheduleTemplates`).
 */

type ColumnExtra = Partial<Pick<ScheduleColumnDef, "total" | "hideWhenEmpty">>;
const field = (path: string, heading: string, extra: ColumnExtra = {}): ScheduleColumnDef => ({ id: path, kind: "field", path, heading, ...extra });
const param = (path: string, heading: string): ScheduleColumnDef => ({ id: path, kind: "parameter", path, heading, hideWhenEmpty: true });

function list(name: string, classes: readonly string[], columns: readonly ScheduleColumnDef[], grandTotals: boolean): ScheduleDefinitionV2 {
  return {
    name,
    source: { kind: "classes", classes, includeSubclasses: true },
    columns,
    filters: [],
    sort: [{ path: "mark", direction: "asc" }],
    groups: [],
    grandTotals,
    itemize: true,
    presentation: { kind: "list" },
    display: { textSizeMm: 2.5, emptyText: "NONE" },
  };
}

/** Diffusers, registers and grilles: mark, what it is, neck and face, CFM (read from its neck connector, so a CFM edit shows here and in Properties), maker and model. */
export const AIR_DEVICE_SCHEDULE = list(
  "Air device schedule",
  ["mep.air_terminal"],
  [
    field("mark", "MARK"),
    field("family", "DESCRIPTION"),
    field("type_name", "TYPE"),
    param("neck_diameter", "NECK"),
    param("face_size", "FACE"),
    field("cfm", "CFM", { total: true }),
    field("vendor.manufacturer", "MANUFACTURER", { hideWhenEmpty: true }),
    field("vendor.model", "MODEL", { hideWhenEmpty: true }),
    field("room", "ROOM", { hideWhenEmpty: true }),
  ],
  true,
);

/** Units and fans: capacity and airflow, the electrical connection, and the vendor data a permit set and the structural engineer need. */
export const MECHANICAL_EQUIPMENT_SCHEDULE = list(
  "Mechanical equipment schedule",
  ["mep.mechanical_equipment"],
  [
    field("mark", "MARK"),
    field("family", "DESCRIPTION"),
    field("vendor.manufacturer", "MANUFACTURER", { hideWhenEmpty: true }),
    field("vendor.model", "MODEL", { hideWhenEmpty: true }),
    field("own.cooling_capacity", "COOLING", { hideWhenEmpty: true }),
    field("own.heating_capacity", "HEATING", { hideWhenEmpty: true }),
    field("own.cfm", "SUPPLY CFM", { hideWhenEmpty: true }),
    field("own.outdoor_cfm", "OA CFM", { hideWhenEmpty: true }),
    field("own.exhaust_cfm", "EXHAUST CFM", { hideWhenEmpty: true }),
    field("own.hp", "MOTOR", { hideWhenEmpty: true }),
    field("voltage_phase", "VOLTS/PH", { hideWhenEmpty: true }),
    field("own.mca", "MCA", { hideWhenEmpty: true }),
    field("own.mocp", "MOCP", { hideWhenEmpty: true }),
    field("own.weight", "OPER. WEIGHT", { hideWhenEmpty: true }),
    field("vendor.curb_size", "CURB", { hideWhenEmpty: true }),
    field("vendor.service_clearance", "SERVICE CLEARANCE", { hideWhenEmpty: true }),
    field("vendor.sequence_of_operation", "SEQUENCE OF OPERATION", { hideWhenEmpty: true }),
  ],
  false,
);

/** Keys and names, as `ADDON_UI` names them for New schedule… while the add-on is off. */
export const MECHANICAL_SCHEDULE_TEMPLATE_NAMES = [
  { key: "air_device_schedule", name: AIR_DEVICE_SCHEDULE.name },
  { key: "mechanical_equipment_schedule", name: MECHANICAL_EQUIPMENT_SCHEDULE.name },
] as const;

const template = (key: string, definition: ScheduleDefinitionV2, description: string): LibraryRow => ({
  section: "scheduleTemplates",
  item: { id: `mechanical:schedule_template:${key}`, revision: 1, key, name: definition.name, discipline: "mechanical", description, definition: { ...definition } },
});

export const MECHANICAL_SCHEDULE_TEMPLATES: readonly LibraryRow[] = [
  template("air_device_schedule", AIR_DEVICE_SCHEDULE, "Every diffuser, register and grille with its mark, type, neck and face size, airflow (from its connector) and model; total CFM at the foot."),
  template("mechanical_equipment_schedule", MECHANICAL_EQUIPMENT_SCHEDULE, "Every unit and fan with its maker and model, cooling and heating capacity, airflow, motor, volts and phase, MCA and MOCP, operating weight, curb, service clearance and sequence of operation."),
];
