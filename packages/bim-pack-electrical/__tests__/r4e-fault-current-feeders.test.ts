/**
 * @jest-environment node
 *
 * Fault current and feeder sizing wired to the model (ROADMAP E5), hand
 * calculated here with the numbers written out.
 *
 * Old code: `faultCurrent` took a hand-typed node list and nothing read the
 * model, so `faultCurrentAt`, `conductorFaultStep`, `transformerFaultStep`
 * and `sizeFeederFromDemand` did not exist and every expectation below fails.
 */
import { type ParamDef, type PartTypeDefinition } from "@permitzip/bim-kernel";
import { necEdition, PERMITZIP_DESIGN_CRITERIA } from "@permitzip/bim-calc";
import { conductorFaultStep, FEEDER_SIZING_NEEDS_EDITION, faultCurrentAt, faultCurrentSummary, sizeFeederFromDemand, transformerFaultStep } from "@permitzip/bim-pack-electrical";
import { Building, distributionType, TRANSFORMER } from "../../bim-kernel/__tests__/fixtures/electrical-building";

const SQRT3 = Math.sqrt(3);
const num = (name: string, label: string, unit?: ParamDef["unit"]): ParamDef => ({ name, label, kind: "number", ...(unit ? { unit } : {}), min: 0 });
const withParams = (def: PartTypeDefinition, ...extra: ParamDef[]): PartTypeDefinition => ({ ...def, instanceParams: [...def.instanceParams, ...extra] });

const SWBD = withParams(distributionType("Switchboard", "800A 480Y/277V", 480, "3", 30, 800, "800A MCB"), num("aic", "AIC", "a"), num("available_fault_current", "Available fault current", "a"));
const XFMR = withParams(TRANSFORMER, num("impedance_pct", "Impedance"));
const PANEL208 = withParams(distributionType("Panelboard", "225A 208Y/120V", 208, "3", 42, 225, "225A MCB"), num("aic", "AIC", "a"));

function service(opts: { readonly mdpAic?: number; readonly zPct?: number } = {}): Building {
  const b = new Building();
  b.ok({ type: "place_part", partId: "mdp", typeId: "t-swbd", partType: SWBD, levelId: "lvl-1", position: { x: 0, y: 0 }, mark: "MDP", values: { panel_name: "MDP", aic: opts.mdpAic ?? 65_000, available_fault_current: 22_000 } });
  b.ok({ type: "place_part", partId: "t1", typeId: "t-xfmr", partType: XFMR, levelId: "lvl-1", position: { x: 3000, y: 0 }, mark: "T1", values: { panel_name: "T1", ...(opts.zPct !== undefined ? { impedance_pct: opts.zPct } : {}) } });
  b.ok({ type: "place_part", partId: "l1", typeId: "t-l1", partType: PANEL208, levelId: "lvl-1", position: { x: 6000, y: 0 }, mark: "L1", values: { panel_name: "L1", aic: 10_000 } });
  b.ok({ type: "create_service_link", linkId: "f-t1", sourceId: "mdp", positions: [2, 4, 6], members: [{ elementId: "t1" }], electrical: { ratingA: 125, lengthFt: 25, conductors: { sets: 1, phaseSize: "1", groundSize: "6", material: "cu" } } });
  b.ok({ type: "create_service_link", linkId: "f-l1", sourceId: "t1", members: [{ elementId: "l1" }] });
  return b;
}

describe("point to point, by hand", () => {
  it("a feeder: 22,000 A through 25 ft of #1 Cu (non-magnetic, C = 8,127) at 480 V 3-phase", () => {
    // f = √3 × 25 × 22,000 / (8,127 × 1 × 480) = 952,628 / 3,900,960 = 0.24420
    // M = 1 / (1 + 0.24420) = 0.80373;  I = 22,000 × 0.80373 = 17,682 A
    const s = conductorFaultStep(22_000, { lengthFt: 25, size: "1", material: "copper", raceway: "nonmagnetic", sets: 1, voltageV: 480, phases: 3 });
    expect(s?.c).toBe(8127);
    expect(s?.f).toBeCloseTo((SQRT3 * 25 * 22_000) / (8127 * 480), 10);
    expect(s?.f).toBeCloseTo(0.2442, 4);
    expect(s?.m).toBeCloseTo(0.80373, 5);
    expect(Math.round(s?.availableA ?? 0)).toBe(17_682);
  });

  it("a 75 kVA, 5.75 %Z transformer, 480 to 208 V, with 17,682 A at its primary", () => {
    // f = 17,682 × 480 × √3 × 5.75 / (100,000 × 75) = 11.2704;  M = 1 / 12.2704 = 0.081497
    // I secondary = 480 / 208 × 0.081497 × 17,682 = 3,325 A (infinite bus would be 208 A / 0.0575 = 3,621 A)
    const t = transformerFaultStep(17_681.995, { kva: 75, primaryV: 480, secondaryV: 208, impedancePct: 5.75, phases: 3 });
    expect(t.f).toBeCloseTo(11.2704, 4);
    expect(t.m).toBeCloseTo(0.081497, 6);
    expect(Math.round(t.availableA)).toBe(3325);
  });
});

describe("fault current read from the model", () => {
  it("a 65 kAIC MDP with 22 kA entered passes, as entered", () => {
    const mdp = faultCurrentAt(service().head.elements, "mdp");
    expect(mdp).toMatchObject({ availableA: 22_000, ratingA: 65_000, passes: true, entered: true, reason: null });
    if (!mdp) throw new Error("MDP is distribution equipment");
    expect(faultCurrentSummary(mdp)).toBe("22,000 A available (entered), 65 kAIC: OK");
  });

  it("lowering MDP to 18 kAIC fails it", () => {
    const mdp = faultCurrentAt(service({ mdpAic: 18_000 }).head.elements, "mdp");
    expect(mdp?.passes).toBe(false);
    if (!mdp) throw new Error("MDP is distribution equipment");
    expect(faultCurrentSummary(mdp)).toBe("22,000 A available (entered), 18 kAIC: rating below the available fault current");
  });

  it("through T1 (with its %Z) to L1, the trail names every step; L1's unlengthed feeder is taken as 0 ft", () => {
    const l1 = faultCurrentAt(service({ zPct: 5.75 }).head.elements, "l1");
    expect(Math.round(l1?.availableA ?? 0)).toBe(3325);
    expect(l1?.passes).toBe(true);
    expect(l1?.trail).toEqual([
      "MDP: 22,000 A available, as entered (from the utility or a study)",
      "Feeder MDP-2,4,6: #1 Cu in non-magnetic raceway (raceway not stated: non-magnetic, the higher fault current), 25 ft, C = 8,127, 480 V 3-phase: f = 0.2442, M = 0.8037 → 17,682 A",
      "T1 secondary: 75 kVA, 5.75% Z, 480/208 V: f = 11.2704, M = 0.0815 → 3,325 A",
      "Feeder T1 to L1: no length, taken as 0 ft, so L1 sees all 3,325 A (the most it could)",
    ]);
    expect(l1?.chain).toEqual(["22,000 A at MDP", "25 ft #1 Cu", "T1 75 kVA 5.75%Z", "no length (0 ft)"]);
  });

  it("without the transformer's %Z, L1 is not calculated, and says why (no guess)", () => {
    const l1 = faultCurrentAt(service().head.elements, "l1");
    expect(l1?.availableA).toBeNull();
    expect(l1?.passes).toBeNull();
    expect(l1?.reason).toBe("T1's impedance (%Z, from its nameplate) isn't entered, so the fault current on its secondary can't be calculated");
  });

  it("with nothing entered at the service, it says where the utility's figure goes", () => {
    const b = new Building();
    b.ok({ type: "place_part", partId: "p", typeId: "t-l1", partType: PANEL208, levelId: "lvl-1", position: { x: 0, y: 0 }, mark: "P1", values: { panel_name: "P1", aic: 10_000 } });
    expect(faultCurrentAt(b.head.elements, "p")?.reason).toBe("Nothing feeds P1 and no available fault current is entered on it (the utility's figure goes on the service equipment)");
  });
});

describe("feeder sizing from a panel's calculated load", () => {
  const SYS = { lineToLine: 480, lineToNeutral: 277, phases: 3 as const, wires: 4 as const };

  it("100 kVA continuous at 480Y/277 V: 120.3 A × 125% = 150.4 A → 175 A breaker, 2/0 Cu (175 A at 75°C), #6 EGC → F175", () => {
    // I = 100,000 / (√3 × 480) = 120.28 A; continuous × 1.25 = 150.35 A (215.2(A)(1)(a)).
    // 150 A is under 150.35 A, so the next standard rating is 175 A (240.6(A)); 1/0 (150 A) is too small, 2/0 carries 175 A.
    // Table 250.122: a 175 A device needs #6 copper.
    const s = sizeFeederFromDemand(necEdition("2023"), PERMITZIP_DESIGN_CRITERIA, { system: SYS, demandVa: 100_000, continuousVa: 100_000 });
    expect(s.refusal).toBeNull();
    expect(s.entry?.mark).toBe("F175");
    expect(s.entry?.ratingA).toBe(175);
    expect(s.entry?.conductors).toEqual({ sets: 1, phaseSize: "2/0", neutralSize: "2/0", groundSize: "6", material: "cu" });
  });

  it("refuses with the plain next step when the project has no NEC edition", () => {
    const s = sizeFeederFromDemand(null, PERMITZIP_DESIGN_CRITERIA, { system: SYS, demandVa: 100_000, continuousVa: 100_000 });
    expect(s.entry).toBeNull();
    expect(s.refusal).toBe(FEEDER_SIZING_NEEDS_EDITION);
    expect(FEEDER_SIZING_NEEDS_EDITION).toBe("Set the NEC edition in the Code Study to size feeders.");
  });

  it("refuses when there is no load to size for", () => {
    expect(sizeFeederFromDemand(necEdition("2023"), PERMITZIP_DESIGN_CRITERIA, { system: SYS, demandVa: 0, continuousVa: 0 }).refusal).toMatch(/no calculated load yet/);
  });
});
