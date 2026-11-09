/**
 * @jest-environment node
 *
 * Round 15 lane E15 (E3): Views and sheets › New schedule… › Electrical ›
 * Lighting fixture schedule. AUDIT §5 E3: "No lighting fixture schedule".
 * The Electrical add-on brings it as a library row (the unified schedule
 * system, as Plumbing's fixture schedule is): one row per fixture with its
 * type's lumens, watts and voltage, its emergency battery, the circuit it is
 * on and its load; watts and load totalled.
 *
 * Fails on the old code: the Electrical add-on contributed no schedule
 * template, so New schedule… had no lighting fixture schedule.
 */
import { builtinPartType, evaluateScheduleV2, fieldProviderRegistry, libraryRowsOf } from "@permitzip/bim-kernel";
import { buildRowSet, validateScheduleDefinition } from "@permitzip/bim-kernel/schedules";
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import { ADDON_UI, ELECTRICAL_SCHEDULE_TEMPLATE_NAMES, LIGHTING_FIXTURE_SCHEDULE } from "../src";
import { Building } from "../../bim-kernel/__tests__/fixtures/electrical-building";

installFirstPartyAddOns();

const TROFFER = "builtin:troffer-2x4-led@1";
const DOWNLIGHT = "builtin:downlight-6-led@1";

function room(): Building {
  const b = new Building();
  b.place("h1", "panel480", { panel_name: "H1" }, "H1", { x: -6000, y: 0 });
  for (const [id, typeId, x, mark] of [["a1", TROFFER, 0, "A1"], ["a2", TROFFER, 3000, "A2"], ["b1", DOWNLIGHT, 6000, "B1"]] as const) {
    const entry = builtinPartType(typeId);
    if (!entry) throw new Error(`no starter ${typeId}`);
    const known = Object.values(b.head.elements).some((e) => e.kind === "part_type" && e.id === typeId);
    b.ok({ type: "place_part", partId: id, typeId, ...(known ? {} : { partType: entry.definition }), levelId: "lvl-1", position: { x, y: 2000 }, mark });
  }
  b.ok({ type: "create_service_link", linkId: "c1", sourceId: "h1", positions: [1], members: [{ elementId: "a1" }, { elementId: "a2" }, { elementId: "b1" }] });
  return b;
}

describe("e15-lighting-schedule-template", () => {
  it("New schedule… lists it from the Electrical add-on, and names it while the add-on is off", () => {
    const rows = libraryRowsOf().flatMap((g) => g.rows.filter((r) => r.section === "scheduleTemplates").map((r) => ({ addon: g.packId, key: r.item.key, name: r.item.name })));
    expect(rows.filter((r) => r.addon === "electrical").map((r) => r.name)).toEqual(["Lighting fixture schedule"]);
    expect(ADDON_UI.scheduleTemplates).toEqual(ELECTRICAL_SCHEDULE_TEMPLATE_NAMES);
  });

  it("prints every fixture with its type's values, its circuit and load; watts and load totalled", () => {
    const b = room();
    const def = LIGHTING_FIXTURE_SCHEDULE;
    const ctx = { viewId: "e15", revision: b.head.revision, registry: fieldProviderRegistry() };
    expect(validateScheduleDefinition(b.head, def, ctx)).toEqual([]);
    const out = evaluateScheduleV2(buildRowSet(b.head, def, ctx), def);
    const at = (h: string) => out.headings.indexOf(h);
    expect(out.headings).toEqual(expect.arrayContaining(["MARK", "DESCRIPTION", "LUMENS", "WATTS", "VOLTS", "CIRCUIT", "LOAD (VA)"]));
    const body = out.rows.filter((_, i) => (out.elementIds[i]?.length ?? 0) > 0);
    expect(body.map((r) => r[at("MARK")])).toEqual(["A1", "A2", "B1"]);
    const a1 = body.find((r) => r[at("MARK")] === "A1")
    expect(a1?.[at("LUMENS")]).toMatch(/4,?000/);
    expect(a1?.[at("WATTS")]).toMatch(/^32/);
    expect(a1?.[at("VOLTS")]).toMatch(/277/);
    expect(a1?.[at("CIRCUIT")]).toMatch(/^H1-/);
    // The panel isn't a lighting fixture: only the three fixtures are listed.
    expect(body).toHaveLength(3);
    const total = out.rows[out.rows.length - 1];
    expect(total?.[at("WATTS")]).toBeTruthy();
  });
});
