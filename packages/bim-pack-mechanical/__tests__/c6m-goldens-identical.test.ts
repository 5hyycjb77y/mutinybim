/**
 * @jest-environment node
 *
 * Mechanical left the kernel (round 6, lane M) with every number and stored
 * shape identical. The kernel's generic hubs now reach the add-on's rows
 * (block tables, calcs, fields, lint, commands); each case reads the 7303
 * fixture (kitchen −220, building +100) through the hub and directly
 * through the add-on, and pins the numbers the m1 suites pinned before the
 * move. Before the move there were no add-on rows: `renderTableBlock` printed
 * "No add-on in this model draws … tables", the calc registry had no
 * `mech.*` pack rows, and `set_run_insulation` was a kernel-typed command.
 */
import {
  canonicalJson,
  commandSchema,
  fieldProviderRegistry,
  renderTableBlock,
  type PressurizationTableSpec,
  type VentilationTableSpec,
} from "@permitzip/bim-kernel";
import { to } from "@permitzip/bim-units";
import { activeLintRules } from "@permitzip/bim-lint";
import { builtinCalcRegistry } from "@permitzip/bim-calc";
import { balanceRules, MECHANICAL_CALCS, OUTDOOR_AIR_ENGINE, PRESSURIZATION_CALCS, pressurizationCalc, pressurizationOf, renderPressurizationTable, renderVentilationTable, sizingCriteriaFor, suggestDuctSize, VENTILATION_CALCS } from "../src";
import { sampleGrill, restaurantTargets, withTargets } from "../../bim-kernel/__tests__/m1-fixtures";

const IN = 25.4;
const MODEL: PressurizationTableSpec = { kind: "pressurization", scope: { kind: "model" } };
const VENT: VentilationTableSpec = { kind: "ventilation", scope: { kind: "model" } };

describe("Mechanical goldens through the add-on", () => {
  it("7303 pressurization: building +100 positive, kitchen −220 negative; the block hub prints the add-on's table byte for byte", () =>
    withTargets(restaurantTargets, () => {
      const model = sampleGrill().head;
      const report = pressurizationOf(model.elements);
      const kitchen = report.zones.find((z) => z.id === "z-kitchen");
      expect(kitchen?.state).toBe("negative");
      expect(report.building.state).toBe("positive");
      const viaHub = renderTableBlock(model, MODEL);
      const direct = renderPressurizationTable(model, MODEL);
      expect(canonicalJson(viaHub)).toBe(canonicalJson(direct));
      expect(viaHub.text).not.toMatch(/No add-on/);
      expect(viaHub.text).toContain("KEF-1");
    }));

  it("the calc registry runs the add-on's own pressurization calc: same object, same 7303 numbers", () =>
    withTargets(restaurantTargets, () => {
      const registry = builtinCalcRegistry();
      expect(registry.get("mech.pressurization")).toBe(pressurizationCalc);
      const r = registry.run({ calc: "mech.pressurization", inputs: { scope: "model" }, model: sampleGrill().head });
      if (!r.ok) throw new Error(r.reason);
      const value = (key: string) => r.run.values.find((v) => v.key === key)?.value;
      expect(value("building_net_cfm")).toBe(100);
      expect(value("zone:z-kitchen:net_cfm")).toBe(-220);
      const ids = registry.list().map((c) => c.id);
      for (const calc of [...MECHANICAL_CALCS, ...VENTILATION_CALCS, ...PRESSURIZATION_CALCS]) expect(ids).toContain(calc.info.id);
    }));

  it("outdoor air: the ventilation table and fields read the add-on's engine, the same through the hub as direct", () => {
    const model = sampleGrill().head;
    expect(canonicalJson(renderTableBlock(model, VENT))).toBe(canonicalJson(renderVentilationTable(model, VENT, OUTDOOR_AIR_ENGINE)));
    const dining = model.elements["sp-dining"];
    if (!dining) throw new Error("7303 fixture has no dining space");
    const read = fieldProviderRegistry().field("gen.space", "ventilation.oa_required_cfm")?.read;
    const direct = OUTDOOR_AIR_ENGINE.space(model.elements, dining.id);
    if (!read || !direct) throw new Error("the dining room has no outdoor-air field or result through the add-on");
    const voz = direct.standards[direct.governing.standard].voz;
    expect(read(dining, { elements: model.elements })).toEqual(voz === null ? null : to(voz, "cfm"));
  });

  it("the balance lint rules run from the add-on, with their stored ids", () => {
    const ids = activeLintRules().map((r) => r.id);
    for (const rule of balanceRules) expect(ids).toContain(rule.id);
    expect(balanceRules.map((r) => r.id)).toEqual(["zone-pressure-off-target", "building-pressure-off-target", "pressurization-airflow-missing", "makeup-air-tempering-unknown"]);
  });

  it("duct sizing: 1,200 CFM round at the supply defaults is 16\" (859 fpm)", () => {
    const s = suggestDuctSize({ cfm: 1200, shape: "round", criteria: sizingCriteriaFor("supply_air", undefined) });
    if (!s.ok) throw new Error(s.reason);
    expect(s.best.size).toEqual({ shape: "round", diameter: 16 * IN });
    expect(Math.round(s.best.velocityFpm)).toBe(859);
  });

  it("stored insulation commands parse byte-identical", () => {
    const run = { type: "set_run_insulation", elementId: "seg-1", insulation: { kind: "liner", thicknessMm: 25.4, surface: "faced" }, scope: "run" };
    const pipes = { type: "set_pipe_insulation", systemId: "sys-1", label: "From the schedule", pieces: [{ segmentId: "p-1", insulation: { kind: "wrap", thicknessMm: 38.1 } }, { segmentId: "p-2", insulation: null }] };
    for (const raw of [run, pipes]) {
      const r = commandSchema.safeParse(raw);
      if (!r.success) throw new Error(r.error.message);
      expect(canonicalJson(r.data)).toBe(canonicalJson(raw));
    }
  });
});
