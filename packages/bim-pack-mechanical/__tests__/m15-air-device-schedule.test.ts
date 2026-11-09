/**
 * @jest-environment node
 *
 * M3 (round 15): the Mechanical add-on brings an air device schedule and a
 * mechanical equipment schedule as library rows, so Views › New schedule… and
 * Mechanical › Documents › New schedule… list them, and each prints its rows
 * from the model: every diffuser with the CFM its neck connector carries.
 * Fails on round 14: Mechanical contributed no schedule template, so New
 * schedule… had no air device or equipment schedule.
 */
import { evaluateScheduleV2, fieldProviderRegistry, libraryRowsOf, type ScheduleDefinitionV2 } from "@permitzip/bim-kernel";
import { buildRowSet, validateScheduleDefinition } from "@permitzip/bim-kernel/schedules";
import { DIFFUSER, FT, K15Model } from "../../bim-kernel/__tests__/k15-fixtures";
import { ADDON_UI, AIR_DEVICE_SCHEDULE, MECHANICAL_SCHEDULE_TEMPLATE_NAMES } from "../src";

function office(): K15Model {
  const m = new K15Model();
  m.place("sd-2", DIFFUSER, 8 * FT, 0, 8 * FT, "SD-2");
  m.place("sd-1", DIFFUSER, 0, 0, 8 * FT, "SD-1");
  m.place("sd-3", DIFFUSER, 16 * FT, 0, 8 * FT, "SD-3");
  return m;
}

function print(m: K15Model, def: ScheduleDefinitionV2) {
  const ctx = { viewId: "m15", revision: m.head.revision, registry: fieldProviderRegistry() };
  expect(validateScheduleDefinition(m.head, def, ctx)).toEqual([]);
  const out = evaluateScheduleV2(buildRowSet(m.head, def, ctx), def);
  const at = (h: string) => out.headings.indexOf(h);
  const body = out.rows.filter((_, i) => (out.elementIds[i]?.length ?? 0) > 0);
  return { headings: out.headings, rows: out.rows, body, at };
}

describe("mechanical schedule templates", () => {
  it("New schedule… lists the two from the Mechanical add-on, and names them while it is off", () => {
    const rows = libraryRowsOf().flatMap((g) => g.rows.filter((r) => r.section === "scheduleTemplates").map((r) => ({ addon: g.packId, key: r.item.key, name: r.item.name })));
    expect(rows.filter((r) => r.addon === "mechanical").map((r) => r.name)).toEqual(["Air device schedule", "Mechanical equipment schedule"]);
    expect(ADDON_UI.scheduleTemplates).toEqual(MECHANICAL_SCHEDULE_TEMPLATE_NAMES);
  });

  it("the air device schedule: every diffuser by mark with its neck and the CFM from its connector, total at the foot", () => {
    const m = office();
    const { headings, rows, body, at } = print(m, AIR_DEVICE_SCHEDULE);
    expect(headings).toEqual(expect.arrayContaining(["MARK", "DESCRIPTION", "TYPE", "NECK", "CFM"]));
    expect(body.map((r) => r[at("MARK")])).toEqual(["SD-1", "SD-2", "SD-3"]);
    expect(body.map((r) => r[at("CFM")])).toEqual(["150", "150", "150"].map((v) => expect.stringContaining(v)));
    expect(rows[rows.length - 1]?.[at("CFM")]).toEqual(expect.stringContaining("450"));
  });

  it("a diffuser's airflow edit shows in its row (the schedule reads the model, not a copy)", () => {
    const m = office();
    m.ok({ type: "set_parameters", id: "sd-2", scope: "instance", values: { airflow: 225 } });
    const { body, at } = print(m, AIR_DEVICE_SCHEDULE);
    expect(body.find((r) => r[at("MARK")] === "SD-2")?.[at("CFM")]).toEqual(expect.stringContaining("225"));
  });
});
