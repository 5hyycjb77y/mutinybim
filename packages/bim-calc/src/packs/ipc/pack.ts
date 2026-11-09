import type { Citation, CodeEdition } from "../../types";
import * as tables from "./tables";

/**
 * The plumbing code pack. Its tables come from the code library's Virginia
 * Plumbing Code 2021 (the 2021 IPC as amended by Virginia), so 2021 is the
 * one edition with data. A project under the 2021 IPC elsewhere (Maryland,
 * DC) reads the same tables under its own code name, with a note that local
 * amendments are not in the library. 2018 and 2024 are refused until the
 * library holds them (or a firm imports them).
 */

export const IPC_EDITIONS = ["2021"] as const;
export type IpcEditionYear = (typeof IPC_EDITIONS)[number];

export const IPC_PACK_VERSION = "2026.10.23";

export type IpcClause =
  | "fixture_flow_pressure"
  | "fixture_min_size"
  | "water_sizing"
  | "drain_slope"
  | "dfu_fixtures"
  | "dfu_traps"
  | "dfu_unlisted"
  | "building_drain"
  | "building_drain_wc_min"
  | "drain_no_reduction"
  | "branch_stack"
  | "stack_reduction"
  | "grease_capacity"
  | "grease_interceptor"
  | "water_heater"
  | "backflow"
  | "vent_stack"
  | "vent_branch"
  | "vent_length"
  | "rainfall"
  | "storm_leader"
  | "storm_drain";

const CLAUSES: Readonly<Record<IpcClause, string>> = {
  fixture_flow_pressure: "Table 604.3",
  fixture_min_size: "Table 604.5",
  water_sizing: "604.3",
  drain_slope: "Table 704.1",
  dfu_fixtures: "Table 709.1",
  dfu_traps: "Table 709.2",
  dfu_unlisted: "709.4",
  building_drain: "Table 710.1(1)",
  building_drain_wc_min: "Table 710.1(1), note a",
  drain_no_reduction: "704.2",
  branch_stack: "Table 710.1(2)",
  stack_reduction: "Table 710.1(2), note b",
  grease_capacity: "Table 1003.3.5.1",
  grease_interceptor: "1003.3.5",
  water_heater: "Chapter 5",
  backflow: "608",
  vent_stack: "906.1, Table 906.1",
  vent_branch: "906.2",
  vent_length: "906.3",
  rainfall: "1106.1",
  storm_leader: "Table 1106.2(1)",
  storm_drain: "Table 1106.3",
};

export interface IpcAdoption {
  /** Name used in citations: "VPC", "IPC", "Maryland Plumbing Code". */
  readonly code: string;
  /** True when the tables are the adopting jurisdiction's own text (Virginia); false when they stand in for another 2021 IPC adoption. */
  readonly libraryText: boolean;
}

export interface IpcEdition extends CodeEdition<IpcClause, typeof tables> {
  readonly family: "ipc";
  readonly edition: IpcEditionYear;
  readonly adoption: IpcAdoption;
}

export function isIpcYear(v: string): v is IpcEditionYear {
  return (IPC_EDITIONS as readonly string[]).includes(v);
}

export function ipcEdition(year: IpcEditionYear, adoption: IpcAdoption = { code: "VPC", libraryText: true }): IpcEdition {
  return { family: "ipc", code: adoption.code, edition: year, packVersion: IPC_PACK_VERSION, clauses: CLAUSES, tables, adoption };
}

export function isIpcEdition(code: CodeEdition | null): code is IpcEdition {
  return code !== null && code.family === "ipc";
}

/** "VPC 2021 Table 709.1 (2021 IPC as amended by Virginia, code library)". */
export function ipcCite(ed: IpcEdition, clause: IpcClause, detail?: string): Citation {
  const where = ed.adoption.libraryText ? "2021 IPC as amended by Virginia, PermitZIP code library" : "values from the Virginia adoption of the 2021 IPC in the PermitZIP code library; check local amendments";
  return { source: "code", code: ed.code, edition: ed.edition, clause: ed.clauses[clause], ...(detail ? { detail } : {}), text: `${ed.code} ${ed.edition} ${ed.clauses[clause]}${detail ? `, ${detail}` : ""} (${where})` };
}
