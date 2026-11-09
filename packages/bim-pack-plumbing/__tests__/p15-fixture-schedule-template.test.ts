/**
 * @jest-environment node
 *
 * P15 (round 15) step 3: the Plumbing add-on brings a plumbing fixture
 * schedule (with each fixture's WSFU and DFU and totals), a water heater
 * schedule and a pump schedule as library rows, so Views › New schedule… ›
 * Plumbing lists them and each prints its rows from the model.
 *
 * Fails on round 14: Plumbing contributed no schedule template (only gas
 * forms), so New schedule… had no plumbing fixture schedule.
 */
import { evaluateScheduleV2, fieldProviderRegistry, libraryRowsOf, type ScheduleDefinitionV2 } from "@permitzip/bim-kernel";
import { buildRowSet, validateScheduleDefinition } from "@permitzip/bim-kernel/schedules";
import { ADDON_UI, PLUMBING_FIXTURE_SCHEDULE, PLUMBING_STARTER_CONNECTION_TYPES, PLUMBING_SCHEDULE_TEMPLATE_NAMES, PUMP_SCHEDULE, WATER_HEATER_SCHEDULE } from "../src";
import { CLOSETS, FT, starter, toiletRoom } from "./p15-fixtures";

/** The room with the project's catalog holding the starter connection types it uses (the values the engineer adopts). */
function room() {
  const m = toiletRoom();
  for (const designator of ["WC-FT", "LAV", "WH-T", "RP"]) {
    const entry = PLUMBING_STARTER_CONNECTION_TYPES.find((t) => t.designator === designator);
    if (!entry) throw new Error(`no starter ${designator}`);
    m.ok({ type: "save_catalog_entry", entry });
  }
  m.place("lav-1", starter("lavatory"), 2 * FT, 10 * FT, 0, "L-1");
  m.place("lav-2", starter("lavatory"), 6 * FT, 10 * FT, 0, "L-2");
  m.place("wh-1", starter("water-heater-tank"), 30 * FT, 10 * FT, 0, "WH-1");
  m.place("rp-1", starter("recirc-pump"), 30 * FT, 14 * FT, 0, "RP-1");
  return m;
}

function print(def: ScheduleDefinitionV2) {
  const m = room();
  const ctx = { viewId: "p15", revision: m.head.revision, registry: fieldProviderRegistry() };
  expect(validateScheduleDefinition(m.head, def, ctx)).toEqual([]);
  const out = evaluateScheduleV2(buildRowSet(m.head, def, ctx), def);
  return { headings: out.headings, rows: out.rows, ids: out.elementIds };
}

describe("plumbing schedule templates", () => {
  it("New schedule… lists the three from the Plumbing add-on, and names them while it is off", () => {
    const rows = libraryRowsOf().flatMap((g) => g.rows.filter((r) => r.section === "scheduleTemplates").map((r) => ({ addon: g.packId, key: r.item.key, name: r.item.name })));
    const plumbing = rows.filter((r) => r.addon === "plumbing_gas");
    expect(plumbing.map((r) => r.name)).toEqual(["Plumbing fixture schedule", "Water heater schedule", "Pump schedule"]);
    expect(ADDON_UI.scheduleTemplates).toEqual(PLUMBING_SCHEDULE_TEMPLATE_NAMES);
  });

  it("the fixture schedule: four closets and two lavatories with their WSFU and DFU, totals at the foot, no water heater", () => {
    const { headings, rows, ids } = print(PLUMBING_FIXTURE_SCHEDULE);
    expect(headings).toEqual(expect.arrayContaining(["MARK", "FIXTURE", "CW WSFU", "TOTAL WSFU", "DFU", "CW", "WASTE", "VENT"]));
    const at = (h: string) => headings.indexOf(h);
    const body = rows.filter((_, i) => (ids[i]?.length ?? 0) > 0);
    expect(body.map((r) => r[at("MARK")])).toEqual(["L-1", "L-2", "WC-1", "WC-2", "WC-3", "WC-4"]);
    const wc = body.find((r) => r[at("MARK")] === "WC-1");
    expect([wc?.[at("TOTAL WSFU")], wc?.[at("DFU")], wc?.[at("CW")], wc?.[at("WASTE")], wc?.[at("VENT")]]).toEqual(["5.0 WSFU", "4.0 DFU", '1/2"', '3"', '2"']);
    expect(body.find((r) => r[at("MARK")] === "L-1")?.[at("DFU")]).toBe("1.0 DFU");
    // Grand total: 4 × 4 + 2 × 1 = 18 DFU; 4 × 5 + 2 × 2 = 24 WSFU.
    const total = rows[rows.length - 1];
    expect([total?.[at("DFU")], total?.[at("TOTAL WSFU")]]).toEqual(["18.0 DFU", "24.0 WSFU"]);
    expect(CLOSETS.every((id) => ids.some((row) => row.includes(id)))).toBe(true);
    expect(ids.some((row) => row.includes("wh-1"))).toBe(false);
  });

  it("the water heater schedule lists the heater with its gas input and connections; the pump schedule its flow", () => {
    const heaters = print(WATER_HEATER_SCHEDULE);
    expect(heaters.rows.map((r) => r[heaters.headings.indexOf("MARK")])).toEqual(["WH-1"]);
    expect(heaters.rows[0]?.[heaters.headings.indexOf("GAS INPUT (MBH)")]).toBe("199.0 MBH");
    const pumps = print(PUMP_SCHEDULE);
    expect(pumps.rows.map((r) => r[pumps.headings.indexOf("MARK")])).toEqual(["RP-1"]);
    expect(pumps.rows[0]?.[pumps.headings.indexOf("FLOW (GPM)")]).toMatch(/^2(\.0)? gpm$/);
  });
});
