import { readFileSync } from "node:fs";
import path from "node:path";
import type { ServiceRow } from "../../src/services/builtin";
import type { ConnectionTypeInput } from "../../src";

/**
 * Round 13's kernel stand-in lists, frozen as bytes before K14 deleted them
 * (`k14-round13-stand-ins.json`). Tests that compared an add-on's rows with the
 * stand-in compare with these instead.
 */
interface FrozenStandIns {
  readonly services: readonly string[];
  readonly loadSections: readonly { readonly id: string; readonly json: string; readonly keys: readonly string[] }[];
  readonly loadSectionTables: { readonly LOAD_SECTIONS: readonly string[]; readonly LOAD_SECTION_LABELS: Readonly<Record<string, string>>; readonly SECTION_QUANTITIES: Readonly<Record<string, readonly string[]>>; readonly SECTION_TRADE: Readonly<Record<string, string>> };
  readonly electricalReads: readonly { readonly input: ConnectionTypeInput; readonly totals: unknown; readonly view: unknown }[];
  readonly gasTakesShared: readonly { readonly mbh: number; readonly takes: boolean | null }[];
}

const FROZEN = JSON.parse(readFileSync(path.join(__dirname, "k14-round13-stand-ins.json"), "utf8")) as FrozenStandIns;

/** Every round 13 built-in service row, in round 13's order (Other still says Mechanical here; K14 made it "general"). */
export const ROUND13_SERVICE_ROWS: readonly ServiceRow[] = FROZEN.services.map((json) => JSON.parse(json) as ServiceRow);

/** One round 13 service row's bytes, by id. */
export function round13ServiceJson(id: string): string {
  const json = FROZEN.services.find((s) => (JSON.parse(s) as { id: string }).id === id);
  if (!json) throw new Error(`no round 13 service row ${id}`);
  return json;
}

/** One round 13 load section row's bytes (functions dropped, as `JSON.stringify` does) and its keys, by id. */
export function round13LoadSection(id: string): { readonly json: string; readonly keys: readonly string[] } {
  const row = FROZEN.loadSections.find((r) => r.id === id);
  if (!row) throw new Error(`no round 13 load section ${id}`);
  return row;
}

export const ROUND13_LOAD_SECTION_IDS: readonly string[] = FROZEN.loadSections.map((r) => r.id);

/** Round 11's load section tables (`LOAD_SECTIONS`, labels, quantities, trades) as round 13 still exported them. */
export const ROUND13_LOAD_SECTION_TABLES = FROZEN.loadSectionTables;

/** What round 13's electrical load section read from five connection types (totals and view), every first-party add-on installed. */
export const ROUND13_ELECTRICAL_READS = FROZEN.electricalReads;

/** Whether round 13's gas section took a shared quantity at 0 and 120 MBH. */
export const ROUND13_GAS_TAKES_SHARED = FROZEN.gasTakesShared;
