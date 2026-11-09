/**
 * @jest-environment node
 *
 * Round 11 C11: an add-on brings its own quantity kind (`UNIT_KIND_POINT`,
 * `units.unit_kind` v1, in `bim-units`). The built-in kinds are rows with
 * their units; an acoustics add-on's kind joins a pack set with no core edit
 * and converts, totals and prints through the set's table; a reader without
 * the add-on keeps the id and names it; the library schema's refinement
 * (`isUnitKindId`) takes both.
 *
 * Fails on round 10's code: `Kind` was a closed list, `bim-library`'s schema
 * was `z.enum(KIND_IDS)`, and there was no point, table or reader.
 */
import { KIND_IDS, convert } from "@permitzip/bim-units";
import { UNIT_KIND_ID_HINT, UNIT_KIND_POINT, UnitKindTable, isUnitKindId, readUnitKind, unitKindRowProblems, type UnitKindDef } from "@permitzip/bim-units/kinds";
import { z } from "zod";
import { PackSet, contribute, definePack, PACK_CONTRACT_VERSION } from "../src/packs";

const SABIN_FT2 = 0.09290304;
const ABSORPTION: UnitKindDef = {
  id: "c11ac.sound_absorption",
  label: "Sound absorption",
  dimension: { L: 2 },
  aggregation: { default: "sum", allowed: ["sum", "max", "min", "none"] },
  disciplines: ["architecture"],
  units: [
    { code: "c11ac.sabin", label: "Sabin", symbol: "sabin", factor: SABIN_FT2 },
    { code: "c11ac.metric_sabin", label: "Metric sabin", symbol: "m² sabin", factor: 1 },
  ],
};
const ACOUSTICS = definePack({ id: "c11ac", name: "Acoustics (test)", version: "1.0.0", kernel: `^${PACK_CONTRACT_VERSION}` }, [contribute(UNIT_KIND_POINT, [ABSORPTION])]);

describe("c11 an add-on's unit kind", () => {
  it("the built-in kinds are rows of the point, with their units", () => {
    const rows = UNIT_KIND_POINT.builtins();
    expect(rows.map((r) => r.id)).toEqual([...KIND_IDS]);
    const table = new UnitKindTable();
    expect(table.convert("length", 10, "ft", "m")).toBeCloseTo(convert(10, "ft", "m"), 12);
    expect(table.unitAllowed("flow_air", "cfm")).toBe(true);
    expect(table.unitAllowed("flow_air", "gpm")).toBe(false);
  });

  it("joins a pack set with no core edit, and converts, totals and prints", () => {
    const table = new UnitKindTable(PackSet.create([ACOUSTICS]).items(UNIT_KIND_POINT));
    expect(table.kind("c11ac.sound_absorption")?.label).toBe("Sound absorption");
    expect(table.toSI("c11ac.sound_absorption", 100, "c11ac.sabin")).toBeCloseTo(9.290304, 9);
    expect(table.convert("c11ac.sound_absorption", 1, "c11ac.metric_sabin", "c11ac.sabin")).toBeCloseTo(1 / SABIN_FT2, 9);
    expect(table.aggregate("c11ac.sound_absorption", [1, 2.5])).toBe(3.5);
    expect(table.format("c11ac.sound_absorption", 9.290304)).toBe("100.00 sabin");
    expect(table.sameDimension("c11ac.sound_absorption", "area")).toBe(true);
    expect(() => table.toSI("c11ac.sound_absorption", 1, "ft2")).toThrow(/Sound absorption can't be written in "ft2"/);
  });

  it("a reader without the add-on keeps the id and names it; a non-id is unreadable", () => {
    expect(readUnitKind("length").status).toBe("known");
    const missing = readUnitKind("c11ac.sound_absorption");
    expect(missing).toMatchObject({ status: "needs_addon", id: "c11ac.sound_absorption" });
    expect(missing.status === "needs_addon" ? missing.words : "").toMatch(/from the c11ac add-on, which this model doesn't have; kept as stored/);
    expect(readUnitKind("Sound Level!").status).toBe("unreadable");
  });

  it("the library schema's refinement takes built-in and add-on kinds and refuses anything else", () => {
    const kindName = z.string().refine(isUnitKindId, UNIT_KIND_ID_HINT);
    expect(kindName.safeParse("flow_air").success).toBe(true);
    expect(kindName.safeParse("c11ac.sound_absorption").success).toBe(true);
    expect(kindName.safeParse("decibels").success).toBe(false);
  });

  it("an add-on can't redefine a built-in kind or name a unit outside its namespace", () => {
    expect(unitKindRowProblems([ABSORPTION])).toEqual([]);
    expect(unitKindRowProblems([{ ...ABSORPTION, id: "length" }])).toEqual(["kind length is built in; an add-on can't redefine it"]);
    expect(unitKindRowProblems([{ ...ABSORPTION, units: [{ code: "other.sabin", label: "Sabin", symbol: "sabin", factor: 1 }] }])).toEqual(['kind c11ac.sound_absorption: unit "other.sabin" must be "c11ac.<name>"']);
    expect(() => new UnitKindTable([{ ...ABSORPTION, units: [] }])).toThrow(/c11ac.sound_absorption has no units/);
  });
});
