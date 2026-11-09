/**
 * @jest-environment node
 *
 * ROADMAP E1 on 7303 (7903 locally): Electrical › Service size › Fill from
 * the model reads the planned equipment list and the space estimates already
 * in the model, so the size check and the service's Load summary (once the
 * items are circuited, packages/bim-kernel/__tests__/e2-load-study.test.ts)
 * say the same connected number: 82 kW = 342 A at 240 V single-phase.
 *
 * Before this change Service size only read pasted text (it had no way to
 * see the model) and its result carried no connected figure at all, only the
 * demand-based size.
 */
import type { Command, ParamDef, PartTypeDefinition } from "@permitzip/bim-kernel";
import { necEdition } from "@permitzip/bim-calc";
import { modelLoadListText, modelLoadRows, parseEquipmentList, serviceSize } from "@permitzip/bim-pack-electrical";
import { Building } from "../../bim-kernel/__tests__/fixtures/electrical-building";

const nec = necEdition("2023");
const num = (name: string, unit: ParamDef["unit"]): ParamDef => ({ name, label: name, kind: "number", unit, min: 0 });

const LISTED: PartTypeDefinition = {
  familyName: "Equipment, from an equipment list",
  typeName: "Listed item",
  category: "mechanical_equipment",
  typeParams: [],
  typeValues: {},
  instanceParams: [{ name: "description", label: "Description", kind: "text" }, num("voltage", "v"), num("phases", "none"), num("load_va", "va")],
  connectors: [],
  geometry: [{ kind: "box", center: [0, 0, 450], size: [600, 600, 900] }],
  symbol: [{ kind: "rect", center: [0, 0], size: [600, 600] }],
  tagFields: ["mark"],
  source: { kind: "builtin", libraryVersion: "equipment-list@1" },
};

const LIST: ReadonlyArray<readonly [string, string, number, number, number]> = [
  ["K-1", "Dishwasher, door type with booster", 208, 3, 15000],
  ["K-2.1", "Fryer, electric, 50 lb", 240, 1, 8000],
  ["K-2.2", "Fryer, electric, 50 lb", 240, 1, 8000],
  ["K-3", "Griddle, electric, 36 in", 240, 1, 6000],
  ["K-4", "Convection oven, full size", 240, 1, 5500],
  ["K-5", "Hot food holding cabinet", 120, 1, 2000],
  ["K-6", "Walk-in cooler condensing unit", 240, 1, 3000],
  ["K-7.1", "Reach-in refrigerator", 120, 1, 500],
  ["K-7.2", "Reach-in refrigerator", 120, 1, 500],
  ["K-8", "Ice maker, 500 lb", 120, 1, 1500],
  ["RTU-1", "Rooftop unit", 240, 1, 12500],
  ["RTU-2", "Rooftop unit", 240, 1, 12500],
];

function model() {
  const b = new Building();
  LIST.forEach(([mark, description, voltage, phases, load_va], i) => b.ok({ type: "plan_part", partId: `item-${mark}`, typeId: "type:listed", ...(i === 0 ? { partType: LISTED } : {}), mark, values: { description, voltage, phases, load_va } }));
  b.ok({ type: "create_space", spaces: [{ spaceId: "sp-kitchen", number: "101", name: "Kitchen" }] } as Command);
  for (const [designator, loadClass] of [["E-LTG", "lighting"], ["E-REC", "receptacle"]] as const) b.ok({ type: "save_connection_type", entry: { designator, loadClass, description: designator } });
  b.ok({
    type: "create_load",
    loads: [
      { id: "est-ltg", anchor: { kind: "space", id: "sp-kitchen" }, connectionType: "E-LTG", values: { va: 5000 } },
      { id: "est-rec", anchor: { kind: "space", id: "sp-kitchen" }, connectionType: "E-REC", values: { va: 2000 } },
    ],
  } as Command);
  return b.head;
}

describe("Service size, filled from the model", () => {
  it("lists the planned items and the estimates, and reads 82 kW = 342 A at 240 V single-phase", () => {
    const rows = modelLoadRows(model());
    expect(rows).toHaveLength(14);
    expect(rows.find((r) => r.tag === "RTU-1")).toMatchObject({ va: 12500, voltageV: 240, phases: 1, from: "planned item" });
    expect(rows.find((r) => r.description === "Lighting estimate (Kitchen)")).toMatchObject({ va: 5000, from: "estimate on Kitchen" });

    const parsed = parseEquipmentList(nec, modelLoadListText(rows), { voltageV: 240, phases: 1 });
    expect(parsed.filter((r) => r.problem)).toEqual([]);
    expect(parsed.find((r) => r.description === "Lighting estimate (Kitchen)")?.suggestedClass).toBe("lighting");
    expect(parsed.find((r) => r.description === "Receptacle estimate (Kitchen)")?.suggestedClass).toBe("receptacle");
    const out = serviceSize(nec, { voltage_v: 240, phases: 1, occupancy: "other", spare_pct: 0, items: parsed.map((r) => ({ label: `${r.tag} ${r.description}`, class: r.suggestedClass, va: r.va ?? 0, quantity: r.quantity })) });
    expect(out.detail.connectedVa).toBe(82000);
    // 82,000 / 240 = 341.67 A, under the 400 A service.
    expect(out.detail.connectedA).toBeCloseTo(341.67, 2);
    expect(out.detail.serviceA).not.toBeNull();
    expect(out.detail.serviceA ?? Infinity).toBeLessThanOrEqual(400);
  });

  it("a model with nothing planned and no estimates gives no rows", () => {
    expect(modelLoadRows(new Building().head)).toEqual([]);
  });
});
