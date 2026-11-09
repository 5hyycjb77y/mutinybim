/**
 * @jest-environment node
 *
 * Round 14 lane K14 step 4: the kernel's three stand-in lists are gone. The
 * service rows, load sections and catalog record types every model reads now
 * come only from the first-party add-ons (Electrical's power, lighting, data
 * and fire alarm rows; Fire protection's wet and dry rows), and they are round
 * 13's rows byte for byte, in round 13's order (frozen in
 * `fixtures/k14-round13-stand-ins.json` before the files were deleted). The
 * kernel keeps one row of its own, Other, under its stored id; its discipline
 * is now "general" instead of claiming Mechanical.
 *
 * Fails on round 13's code: the three files exist, Electrical and Fire
 * protection contribute no service rows, and Other is listed as Mechanical's.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  BUILTIN_SERVICE_REGISTRY,
  activeServiceRegistry,
  catalogEntryRows,
  connectionTypeSchema,
  connectorDomainIds,
  firstPartyServiceRegistry,
  loadSectionRows,
  loadServiceIds,
  serviceById,
  serviceRowOwner,
  systemKindIds,
  systemKindLook,
  systemRules,
  totalsOf,
  type ConnectionTypeInput,
  type QuantityTotals,
} from "@permitzip/bim-kernel";
import { installedFirstPartyPacks } from "@permitzip/bim-kernel/packs";
import { ELECTRICAL_SERVICE_ROWS } from "@permitzip/bim-pack-electrical";

interface Frozen {
  readonly services: readonly string[];
  readonly loadSections: readonly { readonly id: string; readonly json: string; readonly keys: readonly string[] }[];
  readonly loadSectionTables: { readonly LOAD_SECTIONS: readonly string[]; readonly LOAD_SECTION_LABELS: Record<string, string>; readonly SECTION_QUANTITIES: Record<string, readonly string[]>; readonly SECTION_TRADE: Record<string, string> };
  readonly electricalReads: readonly { readonly input: ConnectionTypeInput; readonly totals: unknown; readonly view: unknown }[];
  readonly gasTakesShared: readonly { readonly mbh: number; readonly takes: boolean | null }[];
  readonly catalogEntries: readonly string[];
}

const FROZEN = JSON.parse(readFileSync(path.join(__dirname, "fixtures", "k14-round13-stand-ins.json"), "utf8")) as Frozen;
const SRC = path.resolve(__dirname, "../src");
const frozenRow = (id: string): Record<string, unknown> => {
  const json = FROZEN.services.find((s) => (JSON.parse(s) as { id: string }).id === id);
  if (!json) throw new Error(`no frozen row ${id}`);
  return JSON.parse(json) as Record<string, unknown>;
};

describe("k14-stand-ins-gone", () => {
  it("the three stand-in files are gone", () => {
    for (const file of ["services/builtin-fallback.ts", "requirements/facet-fallback.ts", "catalog/entry-fallback.ts"]) expect({ file, exists: existsSync(path.join(SRC, file)) }).toEqual({ file, exists: false });
  });

  it("the kernel's own service rows are Other alone, under its stored id, discipline general", () => {
    expect(BUILTIN_SERVICE_REGISTRY.rows.map((r) => r.id)).toEqual(["other"]);
    expect(BUILTIN_SERVICE_REGISTRY.rows[0]).toEqual({ ...frozenRow("other"), discipline: "general" });
    expect(serviceRowOwner({ id: "other" })).toBeNull();
    // Still routes and draws as round 13's Other did.
    expect(systemRules("other")).toEqual({ domain: "pipe", discipline: "mechanical", label: "Other", branch: "tee", flowUnit: "", branchMayEqualTrunk: true });
    expect(systemKindLook("other")).toEqual({ colour: "#2ea86b", pattern: "solid" });
  });

  it("with the first-party add-ons on, every model reads round 13's service rows byte for byte, in round 13's order", () => {
    expect(installedFirstPartyPacks().map((p) => p.manifest.id)).toEqual(["electrical", "plumbing_gas", "mechanical", "fire_protection", "architecture", "struct"]);
    const base = firstPartyServiceRegistry();
    expect(activeServiceRegistry()).toBe(base);
    const want = FROZEN.services.map((json) => {
      const row = JSON.parse(json) as { id: string };
      return row.id === "other" ? JSON.stringify({ ...row, discipline: "general" }) : json;
    });
    // `struct.gravity_load` (Structural, first-party since round 14) is a namespaced pack row after them.
    const builtins = base.rows.filter((r) => !/[.:]/.test(r.id));
    expect(builtins.map((r) => JSON.stringify(r))).toEqual(want);
    expect(base.rows.slice(builtins.length).map((r) => r.id)).toEqual(["struct.gravity_load"]);
    expect(systemKindIds(base).slice(0, 28)).toEqual(FROZEN.services.map((j) => JSON.parse(j) as { id: string; asSystem: boolean }).filter((r) => r.asSystem).map((r) => r.id));
    expect(loadServiceIds(base).slice(0, 10)).toEqual(["power", "cold_water", "hot_water", "sanitary", "grease_waste", "gas", "supply_air", "outside_air", "exhaust_air", "heat_gain"]);
    expect(connectorDomainIds(base)).toEqual(["duct", "pipe", "electrical"]);
  });

  it("power, lighting, data and fire alarm are Electrical's rows; wet and dry sprinklers are Fire protection's", () => {
    expect(ELECTRICAL_SERVICE_ROWS.map((r) => r.id)).toEqual(["power", "lighting", "data", "fire_alarm"]);
    for (const row of ELECTRICAL_SERVICE_ROWS) {
      expect([row.id, JSON.stringify(row)]).toEqual([row.id, JSON.stringify(frozenRow(row.id))]);
      expect([row.id, serviceRowOwner(row)]).toEqual([row.id, "electrical"]);
      expect(serviceById(row.id)).toBe(row);
    }
    for (const id of ["fire_protection_wet", "fire_protection_dry"]) {
      expect([id, serviceRowOwner({ id })]).toEqual([id, "fire_protection"]);
      expect(JSON.stringify(serviceById(id))).toBe(JSON.stringify(frozenRow(id)));
    }
  });

  it("load sections are the add-ons' rows, equal to round 13's, and read connection types the same way", () => {
    const rows = loadSectionRows();
    expect(rows.map((r) => ({ id: r.id, json: JSON.stringify(r), keys: Object.keys(r).sort() }))).toEqual(FROZEN.loadSections);
    const t = FROZEN.loadSectionTables;
    expect(rows.map((r) => r.id)).toEqual(t.LOAD_SECTIONS);
    for (const r of rows) expect([r.id, r.label, r.quantities, r.trade]).toEqual([r.id, t.LOAD_SECTION_LABELS[r.id], t.SECTION_QUANTITIES[r.id], t.SECTION_TRADE[r.id]]);
    const electrical = rows.find((r) => r.id === "electrical");
    for (const read of FROZEN.electricalReads) {
      const entry = connectionTypeSchema.parse(read.input);
      const totals = electrical?.connectionTotals?.(entry, totalsOf(entry.quantities));
      expect(totals).toEqual(read.totals);
      expect(totals ? electrical?.connectionView?.(entry, totals) : null).toEqual(read.view);
    }
    const gas = rows.find((r) => r.id === "gas");
    const bag = (mbh: number): QuantityTotals => new Proxy({} as QuantityTotals, { get: (_t, key) => (key === "mbh" ? mbh : 0) });
    for (const g of FROZEN.gasTakesShared) expect([g.mbh, gas?.takesShared?.(bag(g.mbh)) ?? null]).toEqual([g.mbh, g.takes]);
  });

  it("catalog record types come from the set's rows alone (the stand-in list was already empty)", () => {
    expect(FROZEN.catalogEntries).toEqual([]);
    expect(catalogEntryRows().map((r) => r.type)).toEqual(expect.arrayContaining(["pipe_type", "plumbing_settings"]));
  });
});
