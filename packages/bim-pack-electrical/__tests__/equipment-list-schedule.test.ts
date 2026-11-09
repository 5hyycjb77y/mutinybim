/**
 * The Equipment list reads a kitchen vendor's schedule with every trade's
 * columns in one pass (NEXT-BATCH §5 step 1). Before Oct 27 there was no
 * `readEquipmentSchedule`: the service-size reader folded MBH, CW, HW and
 * waste cells into the description and gave a gas-only fryer "No load".
 */
import { necEdition } from "@permitzip/bim-calc";
import { loadFromText, readEquipmentList, readEquipmentSchedule } from "@permitzip/bim-pack-electrical";

const nec = necEdition("2023");

const KITCHEN = [
  "Mark\tDescription\tQty\tVolts\tPhase\tkW\tAmps\tGas MBH\tCW\tHW\tW\tConnection",
  "K-1\tFryer, gas\t2\t120\t1\t\t2\t80\t\t\t\tCord and plug",
  "K-2\tDishwasher, door type\t1\t208\t3\t15\t\t\t1/2\t3/4\t2\tHardwired",
  "K-3\tHand sink\t2\t\t\t\t\t\t1/2\t1/2\t1 1/2\t",
  "K-4\tRange, 6 burner\t1\t\t\t\t\t210\t\t\t\t",
].join("\n");

describe("an equipment schedule with every trade's columns", () => {
  const { rows, headerLine } = readEquipmentSchedule(nec, KITCHEN, { voltageV: 240, phases: 1 });

  it("reads each row's electrical, gas, water and drain facets and how it connects", () => {
    expect(headerLine).toBe(1);
    expect(rows.map((r) => [r.tag, r.description, r.quantity])).toEqual([
      ["K-1", "Fryer, gas", 2],
      ["K-2", "Dishwasher, door type", 1],
      ["K-3", "Hand sink", 2],
      ["K-4", "Range, 6 burner", 1],
    ]);
    const by = (tag: string) => rows.find((r) => r.tag === tag);
    expect(by("K-1")).toMatchObject({ va: 240, loadText: "2 A", mbh: 80, connection: "Cord and plug", problem: null });
    expect(by("K-2")).toMatchObject({ va: 15000, voltageV: 208, phases: 3, coldWater: '1/2"', hotWater: '3/4"', waste: '2"', connection: "Hardwired" });
    expect(by("K-3")).toMatchObject({ va: null, mbh: null, coldWater: '1/2"', waste: '1 1/2"', problem: null });
    // Gas only: no electrical load is not a problem.
    expect(by("K-4")).toMatchObject({ va: null, mbh: 210, problem: null });
  });

  it("text copied out of a PDF keeps an empty cell empty: each value lands under the header it sits beneath", () => {
    // Found in the browser on 7352: by position, the charbroiler's 180 MBH landed in Volts and the dishwasher's CW in Gas.
    const pdf = [
      "MARK  DESCRIPTION              QTY  VOLTS  PH  KW   GAS MBH  CW    HW    W",
      "K-1   Fryer, gas, 50 lb        2    120    1   0.5  122",
      "K-2   Charbroiler, gas         1                    180",
      "K-3   Dishwasher, door type    1    208    3   15            1/2   3/4   2",
      "K-5   Hand sink                2                             1/2   1/2   1 1/2",
    ].join("\n");
    const r = readEquipmentSchedule(nec, pdf).rows;
    const by = (tag: string) => r.find((x) => x.tag === tag);
    expect(by("K-1")).toMatchObject({ voltageV: 120, va: 500, mbh: 122 });
    expect(by("K-2")).toMatchObject({ voltageV: null, va: null, mbh: 180, problem: null });
    expect(by("K-3")).toMatchObject({ voltageV: 208, phases: 3, va: 15000, mbh: null, coldWater: '1/2"', hotWater: '3/4"', waste: '2"' });
    expect(by("K-5")).toMatchObject({ voltageV: null, mbh: null, coldWater: '1/2"', hotWater: '1/2"', waste: '1 1/2"' });
  });

  it("a row with nothing to add up says so in plain words", () => {
    const r = readEquipmentSchedule(nec, "Mark\tDescription\tQty\nK-9\tWork table\t1").rows;
    expect(r[0]?.problem).toBe("Nothing to add up: give a load (kW, W, VA, A or hp), gas MBH, or water and drain sizes");
  });

  it("service size still reads the same list's electrical columns only, unchanged", () => {
    const e = readEquipmentList(nec, "Tag\tDescription\tQty\tVolts\tPhase\tkW\nK-8\tFryer, electric\t2\t208\t3\t17").rows;
    expect(e.map((r) => [r.tag, r.va, r.quantity, r.suggestedClass])).toEqual([["K-8", 17000, 2, "kitchen"]]);
  });
});

describe("a load typed in the preview grid", () => {
  it("reads kW, W, A and hp with the row's voltage and phase", () => {
    expect(loadFromText(nec, "17 kW", 208, 3)).toMatchObject({ va: 17000, problem: null });
    expect(loadFromText(nec, "4.2 A", 120, 1)).toMatchObject({ va: 504, problem: null });
    expect(loadFromText(nec, "1,320 W", 120, 1)).toMatchObject({ va: 1320 });
    expect(loadFromText(nec, "2 hp", 208, 3).va).toBe(Math.round(7.5 * 208 * Math.sqrt(3)));
  });

  it("refuses a bare number or words instead of guessing the unit", () => {
    expect(loadFromText(nec, "17", 208, 3)).toMatchObject({ va: null, problem: "Say what 17 is: kW, W, VA, A or hp" });
    expect(loadFromText(nec, "TBD", 208, 3).problem).toBe('"TBD" isn\'t a load: write it like 17 kW, 1,320 W, 4.2 A or 2 hp');
    expect(loadFromText(nec, "4 A", null, null).problem).toBe("4 A: give the voltage");
    expect(loadFromText(nec, "", 208, 3)).toEqual({ va: null, vaBasis: "", problem: null });
  });
});
