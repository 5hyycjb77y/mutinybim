/**
 * @jest-environment node
 *
 * Kitchen equipment list → proposed plumbing and gas loads (ROADMAP F4, P1).
 * Before this change the list read gas MBH and water sizes into the planned
 * item's values and nothing else: no load existed, so the gas total, the water
 * fixture units and the drainage fixture units never saw the kitchen until
 * someone drew it. `proposeEquipmentLoads` did not exist, so every case here
 * fails on the old code (nothing to import).
 */
import { necEdition } from "@permitzip/bim-calc";
import { proposeEquipmentLoads, readEquipmentSchedule, type EquipmentScheduleRow } from "@permitzip/bim-pack-electrical";

/** 7903 SAMPLE GRILL HARBOR's vendor list. */
const KITCHEN_7903 = [
  "Mark   Description                          Qty   Volts   Ph   kW     Connection",
  "K-1    Dishwasher, door type with booster   1     208     3    15     Hardwired",
  "K-2    Fryer, electric, 50 lb               2     240     1    8      Hardwired",
  "K-3    Griddle, electric, 36 in             1     240     1    6      Hardwired",
  "K-4    Convection oven, full size           1     240     1    5.5    Hardwired",
  "K-5    Hot food holding cabinet             1     120     1    2      Cord and plug",
  "K-6    Walk-in cooler condensing unit       1     240     1    3      Hardwired",
  "K-7    Reach-in refrigerator                2     120     1    0.5    Cord and plug",
  "K-8    Ice maker, 500 lb                    1     120     1    1.5    Cord and plug",
].join("\n");

const nec = necEdition("2023");

function proposals(rows: readonly EquipmentScheduleRow[]) {
  return rows.flatMap((r) => proposeEquipmentLoads({ mark: r.tag, description: r.description, mbh: r.mbh, coldWater: r.coldWater, hotWater: r.hotWater, waste: r.waste, dfu: r.dfu, wsfu: r.wsfu }).map((p) => ({ mark: r.tag, quantity: r.quantity, ...p })));
}

describe("equipment list → proposed plumbing and gas loads", () => {
  it("7903's all-electric kitchen list: the dishwasher and the ice maker propose water and drain loads; no electric item gets gas", () => {
    const rows = readEquipmentSchedule(nec, KITCHEN_7903).rows;
    expect(rows).toHaveLength(8);
    const p = proposals(rows);
    expect(p.map((x) => [x.mark, x.kind, x.connectionType])).toEqual([
      ["K-1", "plumbing", "DW"],
      ["K-8", "plumbing", "IM"],
    ]);
    const dw = p[0];
    expect(dw).toMatchObject({ wsfuTotal: 1.5, dfu: 2, fromStarter: true });
    expect(dw?.basis).toBe("Starter values for a commercial dishwasher (DW): 1.5 WSFU, 2 DFU, 35 gal/h; verify for permit work");
    expect(p[1]).toMatchObject({ wsfuTotal: 0.25, dfu: null });
    // The electric fryer and griddle are not gas appliances.
    expect(p.some((x) => x.kind === "gas")).toBe(false);
  });

  it("the same kitchen with gas cooking: gas rows propose CFH from the list's MBH, or from a matching starter type", () => {
    const text = [
      "Mark\tDescription\tQty\tVolts\tPhase\tkW\tGas MBH\tCW\tHW\tW",
      "K-2\tFryer, gas, 50 lb\t2\t120\t1\t0.5\t80\t\t\t",
      "K-3\tRange, gas, 6 burner\t1\t\t\t\t\t\t\t",
      "K-9\tThree compartment sink\t1\t\t\t\t\t1/2\t1/2\t2",
      "K-10\tWater heater, gas tankless\t1\t120\t1\t0.2\t199\t3/4\t3/4\t",
    ].join("\n");
    const p = proposals(readEquipmentSchedule(nec, text).rows);
    expect(p.map((x) => [x.mark, x.kind, x.connectionType, x.mbh, x.cfh, x.wsfuTotal, x.dfu])).toEqual([
      ["K-2", "gas", null, 80, 80, null, null],
      ["K-3", "gas", "G-RANGE", 220, 220, null, null],
      ["K-9", "plumbing", "SK3", null, null, 2, 4],
      // A water heater is a source of hot water, not a water load; its gas input is a load.
      ["K-10", "gas", null, 199, 199, null, null],
    ]);
    expect(p[1]?.basis).toBe("Starter input for a gas range (G-RANGE), 220 MBH: verify against the cut sheet");
    // The row's own connection sizes ride on the sink's load.
    expect(p[2]?.values).toEqual({ sizes: { cw: '1/2"', hw: '1/2"', w: '2"' } });
    const gasCfh = p.reduce((n, x) => n + (x.cfh ?? 0) * x.quantity, 0);
    expect(gasCfh).toBe(80 * 2 + 220 + 199);
  });

  it("fixture units the row gives win over a starter type, and sizes alone still propose a load to fill in", () => {
    const own = proposeEquipmentLoads({ mark: "P434A", description: "Three compartment sink", mbh: null, coldWater: "", hotWater: "", waste: "", dfu: 3, wsfu: 4 });
    expect(own).toEqual([expect.objectContaining({ kind: "plumbing", connectionType: null, values: { wsfu_total: 4, dfu: 3 }, basis: "4 WSFU, 3 DFU from the list", fromStarter: false })]);
    const sizesOnly = proposeEquipmentLoads({ mark: "K-30", description: "Pot filler", mbh: null, coldWater: '1/2"', hotWater: "", waste: "", dfu: null, wsfu: null });
    expect(sizesOnly).toEqual([expect.objectContaining({ kind: "plumbing", values: { sizes: { cw: '1/2"' } }, basis: "Connection sizes from the list; give its fixture units to count it in sizing" })]);
    expect(proposeEquipmentLoads({ mark: "K-5", description: "Hot food holding cabinet", mbh: null, coldWater: "", hotWater: "", waste: "" })).toEqual([]);
  });
});
