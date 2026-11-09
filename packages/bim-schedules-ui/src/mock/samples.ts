import { toSI } from "@permitzip/bim-units";
import type { CellValue, RowSetColumn } from "../contracts";
import type { MockRow, MockSchedule } from "./connection";

/**
 * Sample schedules for the demo and tests, one per trade family, so the grid
 * is exercised on more than plumbing: water heaters with what they serve
 * (plumbing), doors (architecture) and sprinkler heads (fire protection).
 * Values are canonical SI, as the engine delivers them.
 */

const FIXTURE_COLUMNS: readonly RowSetColumn[] = [
  { id: "mark", heading: "Mark", kind: "field", valueType: "text", writer: { scope: "instance" }, under: "mark" },
  { id: "connection", heading: "Connection", kind: "field", valueType: "text", writer: null, lockedReason: "Set by the fixture's part type.", source: { kind: "field", label: "Part type", target: "type.connection" }, under: "type" },
  { id: "dev_len", heading: "Length from source", kind: "field", valueType: "quantity", quantityKind: "length", writer: null, lockedReason: "Measured along the piping from the heater.", source: { kind: "relationship", label: "Source path", target: "source.developed_length" }, under: "level" },
  { id: "wsfu", heading: "Load", kind: "field", valueType: "quantity", quantityKind: "fixture_units_supply", writer: { scope: "instance" }, under: "serves_wsfu" },
];

export const WATER_HEATER_COLUMNS: readonly RowSetColumn[] = [
  { id: "mark", heading: "Mark", kind: "field", valueType: "text", writer: { scope: "instance" }, width: 90 },
  { id: "type", heading: "Type", kind: "field", valueType: "choice", choices: ["WH-1", "WH-2", "WH-3"], writer: { scope: "instance" }, width: 90 },
  { id: "level", heading: "Level", kind: "field", valueType: "text", writer: null, lockedReason: "Move the heater to another level to change this.", source: { kind: "field", label: "Level", target: "level" } },
  { id: "storage", heading: "Storage", kind: "parameter", valueType: "quantity", quantityKind: "volume", unit: "gal", writer: { scope: "type" } },
  { id: "mbh", heading: "Gas input", kind: "parameter", valueType: "quantity", quantityKind: "flow_gas_energy", unit: "MBH", writer: { scope: "type" } },
  {
    id: "btuh",
    heading: "Gas input",
    kind: "formula",
    valueType: "quantity",
    quantityKind: "flow_gas_energy",
    unit: "Btu/h",
    writer: null,
    source: { kind: "formula", label: "{own.mbh} * 1000", target: "{own.mbh} * 1000" },
  },
  {
    id: "serves_wsfu",
    heading: "Serves load",
    kind: "aggregate",
    valueType: "quantity",
    quantityKind: "fixture_units_supply",
    writer: null,
    lockedReason: "Totalled from the fixtures this heater serves. Served loads are already counted on the fixtures.",
    source: { kind: "relationship", label: "Serves", target: "sum(serves, {load.wsfu_total})" },
  },
  { id: "serves", heading: "Serves", kind: "expand", valueType: "text", writer: null, expandLabel: "Serves", childColumns: FIXTURE_COLUMNS },
];

const LEVELS = ["Level 1", "Level 2", "Level 3", "Level 4", "Roof"];

function fixtures(heater: number, count: number): MockRow[] {
  return Array.from({ length: count }, (_, k) => ({
    key: `wh${heater}-f${k}`,
    elementId: `fx-${heater}-${k}`,
    values: {
      mark: `${["L", "WC", "SH", "S"][k % 4]}-${heater * 10 + k + 1}`,
      connection: ["Lavatory, 1/2\" HW", "Water closet, 1\" CW", "Shower, 1/2\" HW", "Sink, 1/2\" HW"][k % 4] ?? null,
      wsfu: [1, 2.5, 2, 1.5][k % 4] ?? 1,
      dev_len: toSI(12 + k * 7.5 + (heater % 9), "ft"),
    },
  }));
}

function sumWsfu(row: MockRow): CellValue {
  const kids = row.children?.serves ?? [];
  let total = 0;
  for (const k of kids) total += typeof k.values.wsfu === "number" ? k.values.wsfu : 0;
  return kids.length ? total : null;
}

/** `count` water heaters; every 10th serves a few fixtures (sub-list). */
export function waterHeaterSchedule(count = 40, viewId = "sched-water-heaters"): MockSchedule {
  const rows: MockRow[] = Array.from({ length: count }, (_, i) => {
    const type = `WH-${(i % 3) + 1}`;
    const mbh = [199, 120, 76][i % 3] ?? 199;
    const kids = i % 10 === 0 ? fixtures(i, 3 + (i % 4)) : [];
    const row: MockRow = {
      key: `wh${i}`,
      elementId: `el-wh-${i}`,
      typeId: type,
      values: {
        mark: `WH-${i + 1}`,
        type,
        level: LEVELS[i % LEVELS.length] ?? "Level 1",
        storage: toSI([100, 75, 50][i % 3] ?? 100, "gal"),
        mbh: toSI(mbh, "MBH"),
        btuh: toSI(mbh, "MBH"),
        serves_wsfu: null,
      },
      ...(kids.length ? { children: { serves: kids } } : {}),
    };
    return { ...row, values: { ...row.values, serves_wsfu: sumWsfu(row) } };
  });
  const perType = (t: string) => rows.filter((r) => r.typeId === t).length;
  return {
    viewId,
    columns: WATER_HEATER_COLUMNS,
    rows,
    types: {
      "WH-1": { label: "WH-1", instanceCount: Math.max(14, perType("WH-1")) },
      "WH-2": { label: "WH-2", instanceCount: perType("WH-2") },
      "WH-3": { label: "WH-3", instanceCount: perType("WH-3") },
    },
    derive: (row) => ({ btuh: row.values.mbh ?? null, serves_wsfu: sumWsfu(row) }),
    explain: (row, columnId) => {
      if (columnId === "btuh" && typeof row.values.mbh === "number") {
        const mbh = Math.round(row.values.mbh / toSI(1, "MBH"));
        return `${mbh} MBH × 1000 = ${(mbh * 1000).toLocaleString("en-US")} Btu/h`;
      }
      if (columnId === "serves_wsfu") {
        const kids = row.children?.serves ?? [];
        return kids.length ? `${kids.map((k) => String(k.values.wsfu)).join(" + ")} = ${String(sumWsfu(row))} WSFU` : null;
      }
      return null;
    },
    validate: (row, columnId, value) => {
      if (columnId === "mark" && typeof value === "string" && rows.some((r) => r.key !== row.key && r.values.mark === value)) return `${value} is already used by another water heater.`;
      return null;
    },
  };
}

export const DOOR_COLUMNS: readonly RowSetColumn[] = [
  { id: "mark", heading: "Mark", kind: "field", valueType: "text", writer: { scope: "instance" }, width: 80 },
  { id: "room", heading: "Room", kind: "field", valueType: "text", writer: null, lockedReason: "The room the door opens into, from the model.", source: { kind: "relationship", label: "In room", target: "in_room.name" } },
  { id: "width", heading: "Width", kind: "parameter", valueType: "quantity", quantityKind: "length", writer: { scope: "type" } },
  { id: "height", heading: "Height", kind: "parameter", valueType: "quantity", quantityKind: "length", writer: { scope: "type" } },
  { id: "rating", heading: "Fire rating", kind: "parameter", valueType: "choice", choices: ["None", "20 min", "45 min", "90 min"], writer: { scope: "instance" } },
  { id: "closer", heading: "Closer", kind: "parameter", valueType: "boolean", writer: { scope: "instance" } },
];

export function doorSchedule(count = 60, viewId = "sched-doors"): MockSchedule {
  return {
    viewId,
    columns: DOOR_COLUMNS,
    rows: Array.from({ length: count }, (_, i) => ({
      key: `d${i}`,
      elementId: `el-door-${i}`,
      typeId: i % 2 ? "D-36" : "D-30",
      values: { mark: `${100 + i}`, room: `Room ${100 + Math.floor(i / 2)}`, width: toSI(i % 2 ? 36 : 30, "in"), height: toSI(84, "in"), rating: ["None", "20 min", "45 min", "90 min"][i % 4] ?? "None", closer: i % 3 === 0 },
    })),
    types: { "D-36": { label: "D-36", instanceCount: Math.ceil(count / 2) }, "D-30": { label: "D-30", instanceCount: Math.floor(count / 2) } },
  };
}

export const SPRINKLER_COLUMNS: readonly RowSetColumn[] = [
  { id: "mark", heading: "Mark", kind: "field", valueType: "text", writer: { scope: "instance" } },
  { id: "k", heading: "K-factor", kind: "parameter", valueType: "quantity", quantityKind: "k_factor", writer: { scope: "type" } },
  { id: "temp", heading: "Temperature rating", kind: "parameter", valueType: "quantity", quantityKind: "temperature", writer: { scope: "type" } },
  { id: "coverage", heading: "Coverage", kind: "parameter", valueType: "quantity", quantityKind: "area", writer: { scope: "instance" } },
];

export function sprinklerSchedule(count = 80, viewId = "sched-sprinklers"): MockSchedule {
  return {
    viewId,
    columns: SPRINKLER_COLUMNS,
    rows: Array.from({ length: count }, (_, i) => ({
      key: `s${i}`,
      elementId: `el-spk-${i}`,
      typeId: i % 5 ? "SP-56" : "SP-80",
      values: { mark: `SP-${i + 1}`, k: toSI(i % 5 ? 5.6 : 8, "gpm/psi^0.5"), temp: toSI(155, "degF"), coverage: toSI(i % 5 ? 130 : 196, "ft2") },
    })),
    types: { "SP-56": { label: "SP-56", instanceCount: count - Math.ceil(count / 5) }, "SP-80": { label: "SP-80", instanceCount: Math.ceil(count / 5) } },
  };
}
