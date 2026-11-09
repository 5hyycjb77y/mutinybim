import { builtinCalcRegistry, necEdition } from "@permitzip/bim-calc";
import { demandLoad, faultCurrent, parseEquipmentList, serviceSize, suggestLoadClass } from "@permitzip/bim-pack-electrical";

const nec = necEdition("2023");

/** A restaurant kitchen consultant's schedule plus the mechanical list, as pasted from a spreadsheet (40 items). */
const RESTAURANT = [
  "Tag\tDescription\tQty\tVolts\tPhase\tkW\tAmps\tHP",
  "K-1\tWalk-in cooler evaporator\t1\t120\t1\t\t6.0\t",
  "K-2\tWalk-in cooler condensing unit\t1\t208\t3\t\t12.5\t",
  "K-3\tWalk-in freezer evaporator\t1\t120\t1\t\t7.0\t",
  "K-4\tWalk-in freezer condensing unit\t1\t208\t3\t\t15.2\t",
  "K-5\tReach-in refrigerator\t2\t120\t1\t\t8.5\t",
  "K-6\tReach-in freezer\t1\t120\t1\t1.32\t\t",
  "K-7\tSandwich/salad prep refrigerator\t2\t120\t1\t\t4.2\t",
  "K-8\tFryer, electric\t2\t208\t3\t17\t\t",
  "K-9\tGriddle\t1\t208\t3\t10.8\t\t",
  "K-10\tBroiler, upright\t1\t208\t3\t12\t\t",
  "K-11\tConvection oven\t2\t208\t3\t11\t\t",
  "K-12\tCombi oven\t1\t208\t3\t18\t\t",
  "K-13\tRange, 6 burner with oven\t1\t208\t3\t21\t\t",
  "K-14\tSteam kettle\t1\t208\t3\t12\t\t",
  "K-15\tFood warmer\t2\t120\t1\t1.2\t\t",
  "K-16\tHeat lamp\t3\t208\t1\t1.0\t\t",
  "K-17\tHolding cabinet\t1\t120\t1\t2.0\t\t",
  "K-18\tDishwasher, door type\t1\t208\t3\t15\t\t",
  "K-19\tBooster heater\t1\t208\t3\t18\t\t",
  "K-20\tIce machine\t1\t208\t1\t\t14\t",
  "K-21\tDisposer\t1\t208\t3\t\t\t2",
  "K-22\tMixer, 20 qt\t1\t115\t1\t\t\t1/2",
  "K-23\tSlicer\t1\t120\t1\t\t3\t",
  "K-24\tCoffee brewer\t1\t208\t1\t6\t\t",
  "K-25\tEspresso machine\t1\t208\t1\t5\t\t",
  "K-26\tToaster, conveyor\t1\t208\t1\t3.3\t\t",
  "K-27\tMicrowave\t2\t120\t1\t1.8\t\t",
  "K-28\tBlender\t2\t120\t1\t\t12\t",
  "K-29\tRefrigerated merchandiser\t1\t120\t1\t\t9\t",
  "K-30\tBeverage cooler\t1\t120\t1\t\t6\t",
  "K-31\tRethermalizer\t1\t208\t1\t3\t\t",
  "K-32\tInduction range\t1\t208\t3\t10\t\t",
  "EF-1\tHood exhaust fan\t1\t208\t3\t\t\t3",
  "MAU-1\tMake-up air unit\t1\t208\t3\t\t28\t",
  "RTU-1\tRooftop unit, dining\t1\t208\t3\t\t46\t",
  "RTU-2\tRooftop unit, kitchen\t1\t208\t3\t\t38\t",
  "WH-1\tWater heater, electric\t1\t208\t3\t27\t\t",
  "L-1\tLighting, dining and kitchen\t1\t120\t1\t6\t\t",
  "R-1\tReceptacles, general\t1\t120\t1\t7.2\t\t",
  "UH-1\tUnit heater, back door\t1\t208\t3\t5\t\t",
].join("\n");

describe("early service sizing from an equipment list", () => {
  const rows = parseEquipmentList(nec, RESTAURANT);

  it("reads all 40 items with their load in VA and how it was found", () => {
    expect(rows).toHaveLength(40);
    expect(rows.filter((r) => r.problem)).toEqual([]);
    const by = (tag: string) => rows.find((r) => r.tag === tag);
    expect(by("K-6")?.va).toBe(1320);
    expect(by("K-2")?.va).toBe(Math.round(12.5 * 208 * Math.sqrt(3)));
    expect(by("K-2")?.vaBasis).toBe("12.5 A x 208 V x √3");
    // Motors from the NEC tables: 2 hp at 208 V 3-phase is 7.5 A (Table 430.250); 1/2 hp at 115 V 1-phase is 9.8 A (Table 430.248).
    expect(by("K-21")?.va).toBe(Math.round(7.5 * 208 * Math.sqrt(3)));
    expect(by("K-22")?.va).toBe(Math.round(9.8 * 115));
    expect(by("K-5")?.quantity).toBe(2);
  });

  it("suggests a load class per row from its words; the engineer confirms", () => {
    const cls = Object.fromEntries(rows.map((r) => [r.tag, r.suggestedClass]));
    expect(rows.filter((r) => r.suggestedClass === "kitchen").map((r) => r.tag)).toEqual(Array.from({ length: 32 }, (_, i) => `K-${i + 1}`));
    expect([cls["EF-1"], cls["MAU-1"], cls["RTU-1"], cls["RTU-2"], cls["WH-1"], cls["L-1"], cls["R-1"], cls["UH-1"]]).toEqual(["motor", "hvac", "hvac", "hvac", "other", "lighting", "receptacle", "heating"]);
    expect(suggestLoadClass("Sandwich prep refrigerator").basis).toBe('"prep" in the description');
  });

  it("a 40-item kitchen list produces a service size with the calc trail (220.56 by count, 25% of the largest motor, 230.42 / 230.79)", () => {
    const out = serviceSize(nec, {
      voltage_v: 208,
      phases: 3,
      occupancy: "other",
      spare_pct: 0,
      items: rows.map((r) => ({ label: `${r.tag} ${r.description}`, class: r.suggestedClass, va: r.va ?? 0, quantity: r.quantity })),
    });
    const kitchen = out.detail.demand.rows.find((r) => r.key === "kitchen");
    expect(out.detail.demand.kitchenUnits).toBe(41);
    expect(kitchen?.factor).toBeCloseTo(0.65, 5);
    expect(out.steps.map((s) => s.label)).toEqual(expect.arrayContaining(["Kitchen equipment count", "Largest motor (+25%)", "Sizing load", "Service size"]));
    expect(out.steps.find((s) => s.label === "Kitchen equipment count")?.detail).toBe("41 kitchen units below Service → 65%");
    expect(out.steps.find((s) => s.label === "Service size")?.cite.map((c) => c.text)).toEqual(["NEC 2023 230.42(A), not less than the calculated load per Article 220", "NEC 2023 230.79, service disconnect rated not less than the calculated load"]);
    expect(out.detail.serviceA).not.toBeNull();
    expect(out.detail.serviceA ?? 0).toBeGreaterThanOrEqual(out.detail.requiredA);
    expect(out.detail.label).toBe(`${out.detail.serviceA} A, 120/208 V 3-phase 4-wire`);
    // UH-1 (5 kW unit heater) is continuous since #34: + 25% x 5,000 VA = 1,250 VA, about 3.5 A more at 208 V (677 → 680 A).
    // UH-1 (5 kW unit heater) is continuous since #34: + 25% x 5,000 VA = 1,250 VA, about 3.5 A more at 208 V (677 → 680 A).
    expect({ requiredA: Math.round(out.detail.requiredA), service: out.detail.label }).toMatchSnapshot();
  });

  it("text copied out of a PDF (columns of spaces, units in the cells) reads the same way", () => {
    const pdf = ["K-10   SANDWICH/SALAD PREP REFRIGERATOR   120V/1PH   4.2A", "K-14B  FRYER, ELECTRIC (2)   208V/3PH   17 KW", "RTU-1  ROOFTOP UNIT   208V 3PH   46 A MCA"].join("\n");
    const r = parseEquipmentList(nec, pdf);
    expect(r.map((x) => [x.tag, x.va, x.suggestedClass])).toEqual([
      ["K-10", Math.round(4.2 * 120), "kitchen"],
      ["K-14B", 17000, "kitchen"],
      ["RTU-1", Math.round(46 * 208 * Math.sqrt(3)), "hvac"],
    ]);
  });

  it("is the nec.service_size calc plugin, run through the registry with citations", () => {
    const reg = builtinCalcRegistry();
    const r = reg.run({ calc: "nec.service_size", inputs: { voltage_v: 480, phases: 3, items: [{ label: "RTU-1", class: "hvac", va: 40000 }] }, necEdition: "2023" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.run.values.find((v) => v.key === "service_a")?.value).toBe(100);
    expect(reg.get("elec.fault_current_p2p")).toBeNull();
    expect(builtinCalcRegistry({ preview: true }).get("elec.fault_current_p2p")).not.toBeNull();
  });
});

describe("fixed electric space heating is a continuous load (bug log #34)", () => {
  const PATIO = "Equipment,Qty,Volts,Watts\nDSS-35B1-C25 electric infrared patio heater,6,230,2500";

  it("heater words suggest heating; a water heater is not space heating", () => {
    for (const d of ["electric infrared patio heater", "Unit heater", "Space heater, wall", "Infrared heater", "Radiant heater"]) expect(suggestLoadClass(d).cls).toBe("heating");
    expect(suggestLoadClass("Water heater, electric").cls).toBe("other");
    const rows = parseEquipmentList(nec, PATIO, { voltageV: 208, phases: 3 });
    expect(rows.map((r) => [r.line, r.quantity, r.va, r.suggestedClass])).toEqual([[2, 6, 2500, "heating"]]);
  });

  for (const edition of ["2020", "2023"] as const) {
    it(`NEC ${edition}: 6 x 2,500 W = 15,000 VA at 100% (220.51); sized at 125% (424.4(B), 230.42(A)(1)): 18,750 / (√3 x 208) = 52.0 A → 100 A`, () => {
      const code = necEdition(edition);
      const out = serviceSize(code, { voltage_v: 208, phases: 3, occupancy: "other", spare_pct: 0, items: [{ label: "patio heater", class: "heating", va: 2500, quantity: 6 }] });
      // I = 15,000 / (√3 x 208) = 41.64 A calculated; x 1.25 = 52.04 A minimum ampacity.
      expect(out.detail.demand.demandA).toBeCloseTo(15000 / (Math.sqrt(3) * 208), 6);
      expect(out.detail.requiredA).toBeCloseTo((15000 * 1.25) / (Math.sqrt(3) * 208), 6);
      expect(Math.round(out.detail.requiredA * 10) / 10).toBe(52);
      expect(out.detail.serviceA).toBe(100);
      const heating = out.steps.find((s) => s.label === "Heating");
      expect(heating?.cite.map((c) => c.clause)).toContain("220.51");
      const sizing = out.steps.find((s) => s.label === "Sizing load");
      expect(sizing?.detail).toBe("0 VA noncontinuous + 125% of 15000 VA continuous = 18750 VA = 52 A at 208 V 3-phase");
      expect(sizing?.cite.map((c) => c.text)).toEqual([`NEC ${edition} 230.42(A)(1), noncontinuous load plus 125% of the continuous load`, `NEC ${edition} 424.4(B), fixed electric space-heating equipment is a continuous load`]);
      expect(out.steps.find((s) => s.label === "Service size")?.detail).toBe("Minimum required ampacity 52 A; the next standard rating at or above it is 100 A, 120/208 V 3-phase 4-wire");
    });
  }

  it("a feeder (no service) cites 215.2(A)(1)(a) for the 125%; an explicit continuous: false is kept", () => {
    const panel = demandLoad(nec, { node: "P1", occupancy: "other", voltage_v: 208, phases: 3, loads: [{ class: "heating", va: 15000, quantity: 1 }] });
    expect(panel.steps.find((s) => s.label === "Sizing load")?.cite.map((c) => c.clause)).toEqual(["215.2(A)(1)(a)", "424.4(B)"]);
    expect(panel.detail.sizingVa).toBe(18750);
    const notContinuous = demandLoad(nec, { occupancy: "other", voltage_v: 208, phases: 3, loads: [{ class: "heating", va: 15000, quantity: 1, continuous: false }] });
    expect(notContinuous.detail.sizingVa).toBe(15000);
  });
});

describe("point-to-point fault current (preview)", () => {
  it("transformer secondary on an infinite bus, then MDP and L1 by the Eaton Bussmann method", () => {
    const out = faultCurrent({
      source: { kind: "transformer", kva: 500, voltage_v: 208, phases: 3, impedance_pct: 5 },
      nodes: [
        { name: "L1", fed_from: "MDP", size: "3/0", material: "copper", sets: 1, raceway: "steel", length_ft: 80, aic_ka: 22 },
        { name: "MDP", fed_from: "source", size: "500", material: "copper", sets: 4, raceway: "steel", length_ft: 25, aic_ka: 65 },
      ],
    });
    const fla = 500_000 / (Math.sqrt(3) * 208);
    expect(out.detail.sourceA).toBeCloseTo(fla / 0.05, 3);
    const mdp = out.detail.nodes.find((n) => n.name === "MDP");
    const fMdp = (Math.sqrt(3) * 25 * (fla / 0.05)) / (38988 * 4 * 208);
    expect(mdp?.availableA).toBeCloseTo((fla / 0.05) / (1 + fMdp), 3);
    const l1 = out.detail.nodes.find((n) => n.name === "L1");
    const fL1 = (Math.sqrt(3) * 80 * (mdp?.availableA ?? 0)) / (14777 * 208);
    expect(l1?.availableA).toBeCloseTo((mdp?.availableA ?? 0) / (1 + fL1), 3);
    expect(l1?.passes).toBe(true);
    expect(out.issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  it("flags a panel whose interrupting rating is below the fault current", () => {
    const out = faultCurrent({ source: { kind: "utility", available_a: 42_000, voltage_v: 480, phases: 3 }, nodes: [{ name: "H1", fed_from: "source", size: "4/0", material: "copper", sets: 1, raceway: "steel", length_ft: 10, aic_ka: 14 }] });
    expect(out.detail.nodes[0]?.passes).toBe(false);
    expect(out.issues.some((i) => i.severity === "error" && i.message.startsWith("H1:"))).toBe(true);
  });
});
