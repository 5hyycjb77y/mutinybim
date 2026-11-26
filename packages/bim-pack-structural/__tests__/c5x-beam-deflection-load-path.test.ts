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
  it("populates maxDeflection, maxDeflectionAt, max_deflection, and deflection_ratio matching simpleBeam() when E and catalog Ix are set", () => {
    const m = frameWithBeamValues({ "struct.elastic_modulus": 29_000 });
    const lp = structuralLoadPath(m);
    const b2 = lp.beams.find((b) => b.id === "B2");
    expect(b2).toBeDefined();
    expect(b2!.maxDeflection).toBeDefined();
    expect(b2!.maxDeflectionAt).toBeDefined();

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

    // Inspector fields (registered in packFieldRegistry + readable through provider)
    const reg = packFieldRegistry(SET);
    expect(reg.field("struct.beam", "max_deflection")).toMatchObject({ kind: "length", unit: "in", group: "Loads" });
    expect(reg.field("struct.beam", "deflection_ratio")).toMatchObject({ valueType: "text", group: "Loads" });
    const deflVal = readStructuralField(m, "B2", "max_deflection");
    const ratioVal = readStructuralField(m, "B2", "deflection_ratio");
    expect(typeof deflVal).toBe("number");
    expect(deflVal as number).toBeCloseTo(to(direct.maxDeflection!, "in"), 5);
    expect(ratioVal).toBe(`L/${Math.round(b2!.span / Math.abs(b2!.maxDeflection!))}`);

    // Schedule renders decimal inches (2 decimals) and L/Δ ratio cleanly
    const paper = scheduleV2Paper(m, BEAM_SCHEDULE);
    expect(paper.kind).toBe("list");
    if (paper.kind === "list") {
      const headers = paper.table.evaluated.headings;
      expect(headers).toContain("MAX DEFL.");
      expect(headers).toContain("L/Δ");
      const deflIdx = headers.indexOf("MAX DEFL.");
      const ratioIdx = headers.indexOf("L/Δ");
      const b2Row = paper.table.evaluated.rows.find((r) => r[0] === "B2");
      expect(b2Row).toBeDefined();
      expect(b2Row![deflIdx]).toMatch(/^\d+\.\d{2}(?: in|")$/);
      expect(b2Row![ratioIdx]).toMatch(/^L\/\d+$/);
    }
  });

  it("omits deflection cleanly without errors when struct.elastic_modulus is absent", () => {
    const m = twoBayFrame();
    const lp = structuralLoadPath(m);
    const b2 = lp.beams.find((b) => b.id === "B2");
    expect(b2).toBeDefined();
    expect(b2!.maxDeflection).toBeUndefined();
    expect(b2!.maxDeflectionAt).toBeUndefined();

    expect(readStructuralField(m, "B2", "max_deflection")).toBeNull();
    expect(readStructuralField(m, "B2", "deflection_ratio")).toBeNull();
  });

  it("omits deflection cleanly without errors when the beam section is unknown (no catalog Ix)", () => {
    const m = frameWithBeamValues({ "struct.elastic_modulus": 29_000 }, "CUSTOM-BOX-12x6");
    const lp = structuralLoadPath(m);
    const b2 = lp.beams.find((b) => b.id === "B2");
    expect(b2).toBeDefined();
    expect(b2!.maxDeflection).toBeUndefined();
    expect(b2!.maxDeflectionAt).toBeUndefined();

    expect(readStructuralField(m, "B2", "max_deflection")).toBeNull();
    expect(readStructuralField(m, "B2", "deflection_ratio")).toBeNull();
  });
});
