import type { FormNote, FormTemplate } from "@permitzip/bim-kernel";

/**
 * The Electrical add-on's built-in form templates (moved from the kernel's
 * `schedules/forms/templates.ts` in round 15): what a firm starts from before
 * it saves its own default. Layouts follow common US practice (two-column
 * panelboard schedule with per-phase loads, switchboard feeder list, feeder
 * and connection-type catalogs). Every value is a field path. Moved
 * verbatim: a schedule made before the move prints the same.
 */

const PANEL_NOTES: readonly FormNote[] = [
  { mark: "A", text: "AFCI breaker", when: "afci" },
  { mark: "G", text: "GFCI breaker", when: "gfci" },
  { mark: "M", text: "Motor load: HACR or motor-rated breaker", when: "load_class=Motor" },
  { mark: "BL", text: "Breaker lock", when: "breaker_lock" },
];

const DISTRIBUTION_HEADER = {
  columns: 3,
  fields: [
    { label: "SUPPLY FROM", value: "{supply_from}" },
    { label: "VOLTAGE", value: "{volts}" },
    { label: "PHASE / WIRE", value: "{phases_wires}" },
    { label: "BUS", value: "{bus}" },
    { label: "MAINS", value: "{mains_text}" },
    { label: "AIC RATING", value: "{kaic}" },
    { label: "MOUNTING", value: "{mounting}" },
    { label: "ENCLOSURE", value: "{enclosure}" },
    { label: "LOCATION", value: "{level}" },
  ],
} as const;

export const PANEL_TEMPLATE: FormTemplate = {
  name: "Panelboard (two-column)",
  title: "PANEL {name}",
  header: DISTRIBUTION_HEADER,
  body: {
    layout: "slots",
    phaseLoads: true,
    columns: [
      { heading: "CKT", value: "{number}", align: "center" },
      { heading: "DESCRIPTION", value: "{description}", align: "left" },
      { heading: "NOTES", value: "{notes}", align: "center" },
      { heading: "WIRE", value: "{conductors}", align: "left" },
      { heading: "TYPE", value: "{material}", align: "center" },
      { heading: "BKR", value: "{rating_a}", align: "center" },
      { heading: "P", value: "{poles}", align: "center" },
    ],
  },
  summary: { loadClasses: true, totals: true, phaseTotals: true },
  notes: PANEL_NOTES,
};

export const SWITCHBOARD_TEMPLATE: FormTemplate = {
  name: "Switchboard",
  title: "SWITCHBOARD {name}",
  header: DISTRIBUTION_HEADER,
  body: {
    layout: "rows",
    columns: [
      { heading: "CKT", value: "{number}", align: "center" },
      { heading: "SERVES", value: "{fed}", align: "left" },
      { heading: "DESCRIPTION", value: "{description}", align: "left" },
      { heading: "P", value: "{poles}", align: "center" },
      { heading: "FRAME", value: "{frame}", align: "center" },
      { heading: "TRIP", value: "{rating_a}", align: "center" },
      { heading: "FEEDER", value: "{type}", align: "center" },
      { heading: "CONDUCTORS", value: "{conductors}", align: "left" },
      { heading: "LOAD (kVA)", value: "{load_kva}", align: "right" },
    ],
  },
  summary: { loadClasses: true, totals: true, phaseTotals: true },
  notes: [],
};

export const FEEDER_TEMPLATE: FormTemplate = {
  name: "Feeder schedule",
  title: "FEEDER SCHEDULE",
  header: { columns: 1, fields: [] },
  body: {
    layout: "rows",
    columns: [
      { heading: "FEEDER", value: "{mark}", align: "center" },
      { heading: "CONDUCTORS", value: "{conductors}", align: "left" },
      { heading: "TYPE", value: "{material}", align: "center" },
      { heading: "CONDUIT BELOW GRADE", value: "{conduit_below_grade}", align: "left" },
      { heading: "CONDUIT ABOVE GRADE", value: "{conduit_above_grade}", align: "left" },
      { heading: "FEEDERS", value: "{feeders}", align: "center" },
    ],
  },
  notes: [],
};

export const CONNECTION_TYPES_TEMPLATE: FormTemplate = {
  name: "Electrical connection types",
  title: "ELECTRICAL CONNECTION TYPE SCHEDULE",
  header: { columns: 1, fields: [] },
  body: {
    layout: "rows",
    columns: [
      { heading: "DESIGNATOR", value: "{designator}", align: "center" },
      { heading: "DESCRIPTION", value: "{type_description}", align: "left" },
      { heading: "CONNECTION", value: "{connection}", align: "left" },
      { heading: "LOAD (VA)", value: "{load}", align: "right" },
      { heading: "VOLTS / PH", value: "{voltage_phase}", align: "center" },
      { heading: "POLES", value: "{poles}", align: "center" },
      { heading: "LOAD CLASS", value: "{load_class}", align: "left" },
      { heading: "QTY", value: "{count}", align: "center" },
    ],
  },
  notes: [],
};

export const EQUIPMENT_CONNECTIONS_TEMPLATE: FormTemplate = {
  name: "Equipment connections",
  title: "EQUIPMENT CONNECTION SCHEDULE",
  header: { columns: 1, fields: [] },
  body: {
    layout: "rows",
    columns: [
      { heading: "MARK", value: "{mark}", align: "center" },
      { heading: "DESCRIPTION", value: "{type_description}", align: "left" },
      { heading: "VOLTS / PH", value: "{voltage_phase}", align: "center" },
      { heading: "LOAD (VA)", value: "{load}", align: "right" },
      { heading: "MCA", value: "{mca}", align: "center" },
      { heading: "MOCP", value: "{mocp}", align: "center" },
      { heading: "DISCONNECT", value: "{disconnect}", align: "left" },
      { heading: "CIRCUIT", value: "{circuit}", align: "center" },
    ],
  },
  notes: [],
};
