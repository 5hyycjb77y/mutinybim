/**
 * @jest-environment node
 */
import { scheduleV2Paper, type ModelState, type ParamValue } from "@permitzip/bim-kernel";
import { PackSet, installedFirstPartyPacks, packFieldRegistry } from "@permitzip/bim-pack";
import { fromCanonical, qty, to } from "@permitzip/bim-units";
import { BEAM_SCHEDULE, STRUCTURAL_FIELD_PROVIDER, sectionById, simpleBeam, structuralLoadPath } from "../src";
import { BEAM_TYPE, twoBayFrame } from "./two-bay-frame";

const SET = PackSet.create([...installedFirstPartyPacks()]);

function frameWithBeamValues(values: Readonly<Record<string, ParamValue>>, beamSection?: string): ModelState {
  const m = twoBayFrame(beamSection ? { beamSection } : {});
  const typeEl = m.elements[BEAM_TYPE];
  if (!typeEl || typeEl.kind !== "element_type") throw new Error("missing BEAM_TYPE");
  return {
    ...m,
    elements: {
      ...m.elements,
      [BEAM_TYPE]: {
        ...typeEl,
        values: { ...typeEl.values, ...values },
      },
    },
  };
}

function readStructuralField(m: ModelState, elementId: string, path: string) {
  const el = m.elements[elementId];
  if (!el) throw new Error(`missing ${elementId}`);
  const f = (STRUCTURAL_FIELD_PROVIDER.fields ?? []).find((item) => item.path === path);
  if (!f?.read) throw new Error(`missing field ${path}`);
  return f.read(el, { elements: m.elements });
}

describe("structural load-path elastic deflection integration", () => {
  it("populates live and total deflection fields and ratios from separate load cases", () => {
    const m = frameWithBeamValues({ "struct.elastic_modulus": 29_000 });
    const lp = structuralLoadPath(m);
    const b2 = lp.beams.find((b) => b.id === "B2");
    expect(b2).toBeDefined();
    expect(b2!.maxDeflection).toBeDefined();
    expect(b2!.maxDeflectionAt).toBeDefined();
    expect(b2!.maxLiveDeflection).toBeDefined();
    expect(b2!.maxLiveDeflectionAt).toBeDefined();

    // Cross-check directly against simpleBeam() with B2's exact uniform load, RTU-1 point load, and W16x26 Ix
    const sec = sectionById("W16x26")!;
    const direct = simpleBeam({
      span: b2!.span,
      uniform: fromCanonical("line_load", b2!.uniformDead + b2!.uniformLive),
      pointLoads: b2!.pointLoads.map((p) => ({ load: p.load, at: p.at, label: p.from })),
      elasticModulus: qty("stress", 29_000, "ksi"),
      momentOfInertia: sec.ix,
    });
    expect(to(b2!.maxDeflection!, "in")).toBeCloseTo(to(direct.maxDeflection!, "in"), 5);
    expect(to(b2!.maxDeflectionAt!, "ft")).toBeCloseTo(to(direct.maxDeflectionAt!, "ft"), 5);
    const liveDirect = simpleBeam({ span: b2!.span, uniform: b2!.uniformLive, pointLoads: [], elasticModulus: qty("stress", 29_000, "ksi"), momentOfInertia: sec.ix });
    expect(to(b2!.maxLiveDeflection!, "in")).toBeCloseTo(to(liveDirect.maxDeflection!, "in"), 5);
    expect(to(b2!.maxLiveDeflectionAt!, "ft")).toBeCloseTo(to(liveDirect.maxDeflectionAt!, "ft"), 5);

    // Inspector fields (registered in packFieldRegistry + readable through provider)
    const reg = packFieldRegistry(SET);
    expect(reg.field("struct.beam", "max_deflection")).toMatchObject({ kind: "length", unit: "in", group: "Loads" });
    expect(reg.field("struct.beam", "deflection_ratio")).toMatchObject({ valueType: "text", group: "Loads" });
    expect(reg.field("struct.beam", "max_live_deflection")).toMatchObject({ kind: "length", unit: "in", group: "Loads" });
    expect(reg.field("struct.beam", "live_deflection_ratio")).toMatchObject({ valueType: "text", group: "Loads" });
    const deflVal = readStructuralField(m, "B2", "max_deflection");
    const ratioVal = readStructuralField(m, "B2", "deflection_ratio");
    const liveDeflVal = readStructuralField(m, "B2", "max_live_deflection");
    const liveRatioVal = readStructuralField(m, "B2", "live_deflection_ratio");
    expect(typeof deflVal).toBe("number");
    expect(deflVal as number).toBeCloseTo(to(direct.maxDeflection!, "in"), 5);
    expect(ratioVal).toBe(`L/${Math.round(b2!.span / Math.abs(b2!.maxDeflection!))}`);
    expect(liveDeflVal as number).toBeCloseTo(to(liveDirect.maxDeflection!, "in"), 5);
    expect(liveRatioVal).toBe(`L/${Math.round(b2!.span / Math.abs(b2!.maxLiveDeflection!))}`);

    // Schedule renders decimal inches (2 decimals) and L/Δ ratio cleanly
    const paper = scheduleV2Paper(m, BEAM_SCHEDULE);
    expect(paper.kind).toBe("list");
    if (paper.kind === "list") {
      const headers = paper.table.evaluated.headings;
      expect(headers).toEqual(expect.arrayContaining(["LIVE DEFL.", "LIVE L/Δ", "TOTAL DEFL.", "TOTAL L/Δ"]));
      const deflIdx = headers.indexOf("TOTAL DEFL.");
      const ratioIdx = headers.indexOf("TOTAL L/Δ");
      const b2Row = paper.table.evaluated.rows.find((r) => r[0] === "B2");
      expect(b2Row).toBeDefined();
      const liveDeflIdx = headers.indexOf("LIVE DEFL.");
      const liveRatioIdx = headers.indexOf("LIVE L/Δ");
      expect(b2Row![liveDeflIdx]).toBe("1.04 in");
      expect(b2Row![liveRatioIdx]).toBe("L/345");
      expect(b2Row![deflIdx]).toBe("1.29 in");
      expect(b2Row![ratioIdx]).toBe("L/279");
    }
  });

  it("omits deflection cleanly without errors when struct.elastic_modulus is absent", () => {
    const m = twoBayFrame();
    const lp = structuralLoadPath(m);
    const b2 = lp.beams.find((b) => b.id === "B2");
    expect(b2).toBeDefined();
    expect(b2!.maxDeflection).toBeUndefined();
    expect(b2!.maxDeflectionAt).toBeUndefined();
    expect(b2!.maxLiveDeflection).toBeUndefined();
    expect(b2!.maxLiveDeflectionAt).toBeUndefined();

    expect(readStructuralField(m, "B2", "max_deflection")).toBeNull();
    expect(readStructuralField(m, "B2", "deflection_ratio")).toBeNull();
    expect(readStructuralField(m, "B2", "max_live_deflection")).toBeNull();
    expect(readStructuralField(m, "B2", "live_deflection_ratio")).toBeNull();
  });

  it("omits deflection cleanly without errors when the beam section is unknown (no catalog Ix)", () => {
    const m = frameWithBeamValues({ "struct.elastic_modulus": 29_000 }, "CUSTOM-BOX-12x6");
    const lp = structuralLoadPath(m);
    const b2 = lp.beams.find((b) => b.id === "B2");
    expect(b2).toBeDefined();
    expect(b2!.maxDeflection).toBeUndefined();
    expect(b2!.maxDeflectionAt).toBeUndefined();
    expect(b2!.maxLiveDeflection).toBeUndefined();
    expect(b2!.maxLiveDeflectionAt).toBeUndefined();

    expect(readStructuralField(m, "B2", "max_deflection")).toBeNull();
    expect(readStructuralField(m, "B2", "deflection_ratio")).toBeNull();
    expect(readStructuralField(m, "B2", "max_live_deflection")).toBeNull();
    expect(readStructuralField(m, "B2", "live_deflection_ratio")).toBeNull();
  });

  it("keeps live response independent of equipment changes", () => {
    const base = frameWithBeamValues({ "struct.elastic_modulus": 29_000 });
    const heavier = frameWithBeamValues({ "struct.elastic_modulus": 29_000 });
    const type = heavier.elements["type-rtu"];
    if (type?.kind !== "part_type") throw new Error("missing RTU type");
    const rtu = heavier.elements["RTU-1"];
    if (rtu?.kind !== "part") throw new Error("missing RTU");
    const changed = { ...heavier, elements: { ...heavier.elements, ["RTU-1"]: { ...rtu, values: { ...rtu.values, weight: 5000 } } } };
    const a = structuralLoadPath(base).beams.find((b) => b.id === "B2")!;
    const b = structuralLoadPath(changed).beams.find((beam) => beam.id === "B2")!;
    expect(to(a.maxLiveDeflection!, "in")).toBeCloseTo(to(b.maxLiveDeflection!, "in"), 10);
    expect(to(a.maxDeflection!, "in")).not.toBeCloseTo(to(b.maxDeflection!, "in"), 3);
  });

  it("reports zero live deflection and em-dash ratio for a known model with no live-loaded deck", () => {
    const m = frameWithBeamValues({ "struct.elastic_modulus": 29_000 }, undefined);
    const { ["DECK-1"]: _removedDeck, ...elements } = m.elements;
    const noLive = { ...m, elements };
    const result = structuralLoadPath(noLive);
    const b2 = result.beams.find((b) => b.id === "B2")!;
    expect(to(b2.maxLiveDeflection!, "in")).toBe(0);
    expect(to(b2.maxLiveDeflectionAt!, "ft")).toBe(0);
    expect(readStructuralField(noLive, "B2", "live_deflection_ratio")).toBe("—");
    expect(result.problems.some((p) => p.includes("has no live load in the Structural pack"))).toBe(false);
  });

  it("omits live deflection and reports incomplete live loading for unknown or missing occupancy", () => {
    const m = frameWithBeamValues({ "struct.elastic_modulus": 29_000 });
    const deck = m.elements["DECK-1"];
    if (deck?.kind !== "slab") throw new Error("missing deck");
    const unknown = { ...m, elements: { ...m.elements, ["DECK-1"]: { ...deck, values: { ...deck.values, "struct.occupancy": "unknown-use" } } } };
    const result = structuralLoadPath(unknown);
    const b2 = result.beams.find((b) => b.id === "B2")!;
    expect(b2.maxLiveDeflection).toBeUndefined();
    expect(b2.maxLiveDeflectionAt).toBeUndefined();
    expect(b2.maxDeflection).toBeDefined();
    expect(readStructuralField(unknown, "B2", "max_live_deflection")).toBeNull();
    expect(readStructuralField(unknown, "B2", "live_deflection_ratio")).toBeNull();
    expect(result.problems.some((p) => p.includes("has no live load in the Structural pack"))).toBe(true);

    const { ["struct.occupancy"]: _omittedUse, ...withoutUseValues } = deck.values ?? {};
    const missingUse = { ...m, elements: { ...m.elements, ["DECK-1"]: { ...deck, values: withoutUseValues } } };
    const missingResult = structuralLoadPath(missingUse);
    const b2Missing = missingResult.beams.find((b) => b.id === "B2")!;
    expect(b2Missing.maxLiveDeflection).toBeUndefined();
    expect(b2Missing.maxLiveDeflectionAt).toBeUndefined();
    expect(missingResult.problems.some((p) => p.includes("has no use"))).toBe(true);
  });

  it("preserves statics when stiffness or v/EI makes deflection nonrepresentable", () => {
    const baseline = structuralLoadPath(frameWithBeamValues({ "struct.elastic_modulus": 29_000 }));
    const before = baseline.beams.find((b) => b.id === "B2")!;

    for (const badE of [Number.MAX_VALUE, 1e-307]) {
      const overflowing = structuralLoadPath(frameWithBeamValues({ "struct.elastic_modulus": badE }));
      const after = overflowing.beams.find((b) => b.id === "B2")!;
      expect(after).toBeDefined();
      expect(after.startReaction).toEqual(before.startReaction);
      expect(after.endReaction).toEqual(before.endReaction);
      expect(after.maxMoment).toEqual(before.maxMoment);
      expect(after.maxDeflection).toBeUndefined();
      expect(after.maxLiveDeflection).toBeUndefined();
      expect(overflowing.columns.find((c) => c.id === "C2A")!.load.total).toEqual(baseline.columns.find((c) => c.id === "C2A")!.load.total);
      expect(overflowing.footings.find((f) => f.id === "F2A")!.load.total).toEqual(baseline.footings.find((f) => f.id === "F2A")!.load.total);
      expect(overflowing.problems.some((p) => p.includes("deflection omitted"))).toBe(true);
    }

    // Bad stiffness itself (E overflow) is reported once per beam, not duplicated across live + total.
    const badStiffness = structuralLoadPath(frameWithBeamValues({ "struct.elastic_modulus": Number.MAX_VALUE }));
    const b2Problems = badStiffness.problems.filter((p) => p.startsWith("B2:") && p.includes("deflection omitted"));
    expect(b2Problems).toHaveLength(1);
  });

  it("caps extremely small deflections at >L/9999", () => {
    const ultraStiff = frameWithBeamValues({ "struct.elastic_modulus": 29_000_000 });
    expect(readStructuralField(ultraStiff, "B2", "live_deflection_ratio")).toBe(">L/9999");
    expect(readStructuralField(ultraStiff, "B2", "deflection_ratio")).toBe(">L/9999");
  });

  it("updates live and total responses when the modeled live-use rate changes", () => {
    const roof = frameWithBeamValues({ "struct.elastic_modulus": 29_000 });
    const office = twoBayFrame({ roofUse: "office_space" });
    const officeType = office.elements[BEAM_TYPE];
    if (officeType?.kind !== "element_type") throw new Error("missing beam type");
    const officeModel = { ...office, elements: { ...office.elements, [BEAM_TYPE]: { ...officeType, values: { ...officeType.values, "struct.elastic_modulus": 29_000 } } } };
    const a = structuralLoadPath(roof).beams.find((b) => b.id === "B2")!;
    const b = structuralLoadPath(officeModel).beams.find((beam) => beam.id === "B2")!;
    expect(to(b.maxLiveDeflection!, "in")).toBeGreaterThan(to(a.maxLiveDeflection!, "in"));
    expect(to(b.maxDeflection!, "in")).toBeGreaterThan(to(a.maxDeflection!, "in"));
  });
});
