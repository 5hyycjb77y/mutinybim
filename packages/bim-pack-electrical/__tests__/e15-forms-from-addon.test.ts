/**
 * @jest-environment node
 *
 * Round 15 lane E15 (E4, FIX closed in lane; shared with P15's gas forms):
 * the form schedule kinds, their names and their built-in templates come
 * from the add-ons' rows, never from the kernel. AUDIT §5 E4: "Panelboard,
 * switchboard, feeder and connection forms live in the kernel"
 * (`schedules/forms/templates.ts`, the closed kind list in `forms/types.ts`).
 *
 * Fails on the old code: `formScheduleKinds` / `formScheduleKindLabel` /
 * `isBoundFormKind` did not exist, the kernel answered a panel template with
 * no add-on loaded, and an outside add-on's form kind was refused by the
 * kernel's closed list.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { builtinFormTemplate, FORM_SCHEDULE_POINT, formScheduleKindLabel, formScheduleKinds, formScheduleSchema, isBoundFormKind, type FormScheduleDef, type FormTemplate } from "@permitzip/bim-kernel";
import { contribute, definePack, PackSet, withPackSet } from "@permitzip/bim-kernel/packs";
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import { PANEL_TEMPLATE } from "../src";

installFirstPartyAddOns();

const KERNEL_FORMS = path.join(__dirname, "../../bim-kernel/src/schedules/forms");

const LIGHTS: FormTemplate = { name: "Zed lights", title: "ZED LIGHTS", header: { columns: 1, fields: [] }, body: { layout: "rows", columns: [{ heading: "MARK", value: "{mark}" }] }, notes: [] };
const ZED_ROWS: FormScheduleDef[] = [
  { kind: "zz_lights", label: "Zed light list", template: LIGHTS, order: 5, evaluate: () => ({ title: "ZED", header: [], headerColumns: 1, grid: { headings: [], aligns: [], widths: [], rows: [], rowIds: [], splitAt: null }, summary: null, totals: [], notes: [], footer: "", problem: null }) },
  { kind: "zz_board", label: "Zed board sheet", template: { ...LIGHTS, name: "Zed board" }, boundTo: "zed board", evaluate: () => { throw new Error("not drawn here"); } },
];
const ZED = definePack({ id: "zz", name: "Zed", version: "1.0.0", kernel: "^1.3.0" }, [contribute(FORM_SCHEDULE_POINT, ZED_ROWS)]);

describe("e15-forms-from-addon", () => {
  it("with every first-party add-on, the kinds are the add-ons' rows, in their order, with their names", () => {
    expect(formScheduleKinds()).toEqual(["panel", "switchboard", "feeder", "connection_types", "equipment_connections", "gas_equipment", "gas_connections"]);
    expect(formScheduleKinds().map(formScheduleKindLabel)).toEqual(["Panel schedule", "Switchboard schedule", "Feeder schedule", "Electrical connection type schedule", "Equipment connection schedule", "Gas equipment schedule", "Gas connection schedule"]);
    expect(formScheduleKinds().filter(isBoundFormKind)).toEqual(["panel", "switchboard"]);
    // Moved verbatim: a schedule made before the move starts from the same template.
    expect(builtinFormTemplate("panel")).toBe(PANEL_TEMPLATE);
    expect(PANEL_TEMPLATE.name).toBe("Panelboard (two-column)");
    expect(PANEL_TEMPLATE.body.layout).toBe("slots");
    expect(PANEL_TEMPLATE.body.columns.map((c) => c.heading)).toEqual(["CKT", "DESCRIPTION", "NOTES", "WIRE", "TYPE", "BKR", "P"]);
  });

  it("an outside add-on adds a form kind with zero kernel edits: listed, named, bound as its row says", () => {
    withPackSet(PackSet.create([ZED]), () => {
      // Ordered rows sort among the first-party ones (order 5: first); a row with no order comes after them.
      expect(formScheduleKinds()[0]).toBe("zz_lights");
      expect(formScheduleKinds().at(-1)).toBe("zz_board");
      expect(formScheduleKindLabel("zz_lights")).toBe("Zed light list");
      expect(formScheduleSchema.safeParse({ kind: "zz_lights", template: LIGHTS }).success).toBe(true);
      const unbound = formScheduleSchema.safeParse({ kind: "zz_board", template: LIGHTS });
      expect(unbound.success).toBe(false);
      if (!unbound.success) expect(unbound.error.issues[0]?.message).toBe("A zed board sheet needs the zed board it is the schedule of");
    });
  });

  it("the kernel's form files name no kind and carry no template", () => {
    expect(existsSync(path.join(KERNEL_FORMS, "templates.ts"))).toBe(false);
    const types = readFileSync(path.join(KERNEL_FORMS, "types.ts"), "utf8");
    for (const word of ['"panel"', '"switchboard"', '"feeder"', '"gas_equipment"', "FORM_SCHEDULE_KINDS", "FORM_SCHEDULE_KIND_LABELS"]) expect(types).not.toContain(word);
  });
});
