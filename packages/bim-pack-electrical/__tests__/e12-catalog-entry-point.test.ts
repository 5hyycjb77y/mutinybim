/**
 * @jest-environment node
 *
 * Round 12 lane E: catalog record types are rows. Feeder types and room
 * templates come from the Electrical add-on (`CATALOG_ENTRY_POINT`) with the
 * same stored type and id prefix as before (`etype:feeder:F225`); the kernel
 * keeps only the connection type and the load policy as built-in rows, which
 * no add-on may replace; a transitional row (pipe types until P12 lands) gives
 * way to a registered one. Saving, renaming and deleting go through the same
 * commands for every type.
 *
 * On round 11's code the record types are a closed list in the kernel: there
 * is no row for `feeder_type` (`catalogEntryRow` returns null), Electrical
 * contributes nothing to the point, and the rename words come from a kernel
 * table instead of the row.
 */
import { CATALOG_ENTRY_POINT, catalogElementId, catalogEntryRow, catalogEntryRows, commandSchema, type Command } from "@permitzip/bim-kernel";
import { PackSet, PackSetError, contribute, definePack, withPackSet } from "@permitzip/bim-kernel/packs";
import { z } from "zod";
import { CIRCUIT_TEMPLATE_ROW, DRAFTING_STANDARD_ROW, ELECTRICAL_CATALOG_ROWS, FEEDER_TYPE_ROW, feederTypeOf } from "@permitzip/bim-pack-electrical";
import { Building } from "../../bim-kernel/__tests__/fixtures/electrical-building";

const F225 = { type: "feeder_type", mark: "F225", ratingA: 225, poles: 3, conductors: { sets: 1, phaseSize: "4/0", groundSize: "4", material: "cu" }, insulation: "THHN", conduit: null, conduitBelowGrade: null, description: "" } as const;

describe("e12: catalog record types are rows", () => {
  it("reads Electrical's record types from the add-on, ids unchanged", () => {
    expect(catalogEntryRow("feeder_type")).toBe(FEEDER_TYPE_ROW);
    expect(catalogEntryRow("circuit_template")).toBe(CIRCUIT_TEMPLATE_ROW);
    // Round 13 adds the drafting standard (the typical-label template), after round 12's two.
    expect(ELECTRICAL_CATALOG_ROWS).toEqual([FEEDER_TYPE_ROW, CIRCUIT_TEMPLATE_ROW, DRAFTING_STANDARD_ROW]);
    expect(catalogElementId("feeder_type", " f225 ")).toBe("etype:feeder:F225");
    expect(catalogElementId("circuit_template", "two  bedroom")).toBe("etype:template:TWO BEDROOM");
    expect(catalogElementId("connection_type", "e.05")).toBe("etype:connection:E.05");
    expect(catalogElementId("load_policy", "Project")).toBe("etype:loads:PROJECT");
    expect(catalogEntryRows().map((r) => r.type)).toEqual(expect.arrayContaining(["connection_type", "load_policy", "feeder_type", "circuit_template", "pipe_type", "plumbing_settings"]));
  });

  it("keeps the shared connection type and load policy in the kernel, where no add-on may replace them", () => {
    const impostor = definePack({ id: "zz", name: "ZZ", version: "1.0.0", kernel: "^1.10.0" }, [
      contribute(CATALOG_ENTRY_POINT, [{ type: "connection_type", idPrefix: "zzconn", label: "Mine", schema: z.object({}), nameOf: () => "" }]),
    ]);
    expect(() => PackSet.create([impostor]).items(CATALOG_ENTRY_POINT)).toThrow(PackSetError);
  });

  it("lets a registered row replace a transitional one for the same type", () => {
    const plumbing = definePack({ id: "zzp", name: "ZZP", version: "1.0.0", kernel: "^1.10.0" }, [
      contribute(CATALOG_ENTRY_POINT, [{ type: "zzp.pipe_kind", idPrefix: "zzpipe", label: "Pipe kind", schema: z.object({ type: z.literal("zzp.pipe_kind"), name: z.string() }), nameOf: (e) => String((e as { name?: unknown }).name ?? "") }]),
    ]);
    withPackSet(PackSet.create([plumbing]), () => {
      expect(catalogEntryRow("zzp.pipe_kind")?.idPrefix).toBe("zzpipe");
      expect(catalogEntryRow("pipe_type")?.idPrefix).toBe("pipe");
    });
  });

  it("saves, renames (the feeders naming it follow) and refuses to delete a used feeder type through the row", () => {
    const b = new Building();
    b.place("mdp", "switchboard", { panel_name: "MDP" });
    b.place("h1", "panel480", { panel_name: "H1" });
    b.ok({ type: "save_catalog_entry", entry: F225 } as Command);
    b.ok({ type: "create_service_link", linkId: "f-h1", sourceId: "mdp", positions: [1, 3, 5], members: [{ elementId: "h1" }], electrical: { ratingA: 225, feederType: "F225" } });
    expect(feederTypeOf(b.head.elements, "f225")?.ratingA).toBe(225);
    expect(b.refused({ type: "delete_catalog_entry", entryType: "feeder_type", name: "F225" })).toMatch(/^Feeder type F225 is used by .+; change it first$/);
    b.ok({ type: "save_catalog_entry", entry: { ...F225, mark: "F225A" }, replaces: "F225" } as Command);
    const link = b.head.elements["f-h1"];
    expect(link?.kind === "service_link" ? link.electrical?.feederType : null).toBe("F225A");
    expect(b.head.elements["etype:feeder:F225"]).toBeUndefined();
    expect(b.head.elements["etype:feeder:F225A"]?.kind).toBe("service_catalog");
  });

  it("refuses a record type nothing here reads, in words", () => {
    const r = commandSchema.safeParse({ type: "save_catalog_entry", entry: { type: "zz.unknown_type", name: "X" } });
    expect(r.success ? [] : r.error.issues.map((i) => i.message)).toEqual(['No add-on loaded here reads catalog records of type "zz.unknown_type"']);
  });
});
