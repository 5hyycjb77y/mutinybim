import { CATALOG_TRADES, ELECTRICAL_LOAD_CLASSES, connectionFieldValue, type ConnectionFieldRecord, type ConnectionFieldRow, type ConnectionFieldValue, type ElectricalLoadClass } from "@permitzip/bim-kernel";

/**
 * Electrical's fields on the shared connection type (`CONNECTION_FIELD_POINT`,
 * round 13): the rated load, the potential and the load class. Stored keys and
 * defaults are the ones the kernel's schema wrote through round 12, so old
 * records read the same and a save writes the same bytes.
 */
declare module "@permitzip/bim-kernel" {
  interface ConnectionTypeFields {
    loadVa: number;
    voltage: number;
    loadClass: ElectricalLoadClass;
  }
}

export const MAX_LOAD_VA = 5_000_000;
export const MAX_VOLTAGE = 1000;
export const DEFAULT_LOAD_VA = 0;
export const DEFAULT_VOLTAGE = 120;
export const DEFAULT_LOAD_CLASS = "other" satisfies ElectricalLoadClass;

const isLoadClass = (v: ConnectionFieldValue): v is ElectricalLoadClass => typeof v === "string" && (ELECTRICAL_LOAD_CLASSES as readonly string[]).includes(v);

const storedTrade = (record: ConnectionFieldRecord): string => (typeof record.trade === "string" ? record.trade : CATALOG_TRADES[0]);

export const LOAD_VA_FIELD: ConnectionFieldRow = {
  id: "electrical.load_va",
  label: "Load",
  key: "loadVa",
  valueType: "number",
  unit: "VA",
  defaultValue: DEFAULT_LOAD_VA,
  standsFor: "va",
  check: (v) => (typeof v === "number" && v >= 0 && v <= MAX_LOAD_VA ? null : `must be 0 to ${MAX_LOAD_VA.toLocaleString("en-US")} VA`),
};

export const VOLTAGE_FIELD: ConnectionFieldRow = {
  id: "electrical.voltage",
  label: "Voltage",
  key: "voltage",
  valueType: "number",
  unit: "V",
  defaultValue: DEFAULT_VOLTAGE,
  check: (v) => (typeof v === "number" && v > 0 && v <= MAX_VOLTAGE ? null : `must be more than 0 and at most ${MAX_VOLTAGE} V`),
};

export const LOAD_CLASS_FIELD: ConnectionFieldRow = {
  id: "electrical.load_class",
  label: "Load class",
  key: "loadClass",
  valueType: "text",
  defaultValue: DEFAULT_LOAD_CLASS,
  check: (v) => (isLoadClass(v) ? null : `must be one of ${ELECTRICAL_LOAD_CLASSES.join(", ")}`),
  // An estimate is matched by class only for an electrical record, or one of another trade that carries a load.
  loadKind: { appliesTo: (record) => storedTrade(record) === "electrical" || num(connectionFieldValue(record, "loadVa")) > 0 },
};

export const ELECTRICAL_CONNECTION_FIELDS: readonly ConnectionFieldRow[] = [LOAD_VA_FIELD, VOLTAGE_FIELD, LOAD_CLASS_FIELD];

function num(v: ConnectionFieldValue): number {
  return typeof v === "number" ? v : 0;
}

export interface ElectricalConnectionFields {
  readonly loadVa: number;
  readonly voltage: number;
  readonly loadClass: ElectricalLoadClass;
}

/** Electrical's three fields on a connection type: as stored, else this add-on's defaults (a record written where Electrical wasn't loaded carries none). */
export function electricalFieldsOf(record: ConnectionFieldRecord): ElectricalConnectionFields {
  const va = record.loadVa;
  const v = record.voltage;
  const cls = record.loadClass;
  return {
    loadVa: typeof va === "number" ? va : DEFAULT_LOAD_VA,
    voltage: typeof v === "number" ? v : DEFAULT_VOLTAGE,
    loadClass: typeof cls === "string" && isLoadClass(cls) ? cls : DEFAULT_LOAD_CLASS,
  };
}
