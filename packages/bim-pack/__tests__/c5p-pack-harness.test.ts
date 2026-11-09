/**
 * @jest-environment node
 *
 * Batch 5c lane A, round 2: what a pack can now prove through the real
 * engines from `@permitzip/bim-pack` alone, and the contract gaps the proof
 * packs found (calc values in bim-units units, a pack rate on a built-in
 * space use pinned in the parameter's unit, a physical network the kernel
 * totals, parameters in the field registry). Each fails on the code before:
 * the harness, the points and the open units didn't exist.
 */
import { z } from "zod";
import { pinSpaceUse } from "@permitzip/bim-calc";
import { spaceUseCatalog, spaceUseRateTargets } from "@permitzip/bim-library";

import { CALC_POINT, LINT_RULE_POINT, NETWORK_ADAPTER_POINT, PARAMETER_SET_POINT, PackSet, SERVICE_POINT, SPACE_USE_RATE_POINT, SPACE_USE_RATE_VALUE_POINT, contribute, defineCalc, definePack, packFieldRegistry, runPackCalc, runPackConformance, runPackLint, runPackNetwork, withPackSet, type RuleDef, type ServiceRow } from "../src";
import { FIRST_PARTY_ADDONS as FIRST_PARTY_PACKS } from "@permitzip/bim-first-party";
import { createFullBimModel, FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";

const reaction = defineCalc({
  id: "zz.reaction",
  version: "1.0.0",
  domain: "zz",
  title: "Reaction",
  summary: "Half the load",
  codeFamily: null,
  needsModel: false,
  input: z.object({ load_lbf: z.number(), unit: z.string().default("lbf") }),
  example: { load_lbf: 100 },
  // `unit` lets a test make the calc answer in a unit nobody knows; the cast is that deliberate bad output.
  run: (i) => ({ values: [{ key: "start_reaction", label: "Start reaction", value: i.load_lbf / 2, unit: i.unit === "lbf" ? "lbf" : (i.unit as "lbf"), cite: [] }], steps: [], issues: [], detail: null }),
});

const wallRule: RuleDef = {
  id: "zz.wall_seen",
  version: 1,
  pack: "zz",
  severity: "info",
  title: "Walls the test pack sees",
  scope: "element",
  kinds: ["wall"],
  run: (ctx, el) => ctx.emit({ rule: "zz.wall_seen", severity: "info", elementIds: [el.id], at: { level: ctx.levelNameOf(el), x_ft: 0, y_ft: 0, z_ft: 0 }, message: `Seen ${ctx.name(el.id)}` }),
};

const loadPathService: ServiceRow = { id: "zz.gravity_load", label: "Gravity load", discipline: "structure", medium: "structural", regime: "structural", connector: "member", adapter: "zz.load_path", quantities: ["zz.dead"], asSystem: true, asLoad: false, ifc: { system: "IfcStructuralAnalysisModel", predefinedType: "LOADING_3D" } };

const ZZ = definePack({ id: "zz", name: "Test structure", version: "1.0.0", kernel: "^1.0.0" }, [
  contribute(CALC_POINT, [reaction]),
  contribute(LINT_RULE_POINT, [wallRule]),
  contribute(SERVICE_POINT, [loadPathService]),
  contribute(NETWORK_ADAPTER_POINT, [{ id: "zz.load_path", aggregation: { quantities: ["zz.dead"], direction: "downward", over: ["physical"], network: () => ({ roots: () => ["f"], children: (n) => (n === "f" ? ["b"] : []), ownQuantities: (n) => (n === "b" ? { "zz.dead": 300 } : { "zz.dead": 50 }) }) } }]),
  contribute(PARAMETER_SET_POINT, [{ id: "zz.framing", label: "Framing", parameters: [{ key: "zz.section", label: "Section", classes: ["arch.wall"], valueType: "text", group: "Structural" }] }]),
  contribute(SPACE_USE_RATE_POINT, [{ key: "zz.live_load", quantity: "zz.live_load_total", per: "area", kind: "area_load", label: "Live load", unit: "lbf" }]),
  contribute(SPACE_USE_RATE_VALUE_POINT, [{ useId: "office_space", key: "zz.live_load", value: 50, unit: "psf", cite: { code: "ASCE 7", edition: "2022", clause: "Table 4.3-1", verified: false } }]),
]);
const set = PackSet.create([...FIRST_PARTY_PACKS, ZZ]);
const model = createFullBimModel({ ...FULL_BIM_TIERS.XS, modelId: "c5p-harness" });

describe("c5p the pack harness runs the real engines inside the set", () => {
  it("runPackLint: the pack's rule fires through the lint engine", () => {
    const findings = runPackLint(model, set);
    expect(findings.some((f) => f.rule === "zz.wall_seen")).toBe(true);
    expect(runPackLint(model, PackSet.create([...FIRST_PARTY_PACKS])).some((f) => f.rule === "zz.wall_seen")).toBe(false);
  });

  it("runPackCalc: a value carries a bim-units unit; an unknown unit fails loudly", () => {
    const ok = runPackCalc(set, { calc: "zz.reaction", inputs: { load_lbf: 1000 } });
    expect(ok.ok && ok.run.values[0]).toMatchObject({ value: 500, unit: "lbf" });
    const spy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const bad = runPackCalc(set, { calc: "zz.reaction", inputs: { load_lbf: 1, unit: "furlong" } });
    expect(bad).toEqual({ ok: false, reason: expect.stringContaining('"furlong", which isn\'t a unit MutinyBIM knows') });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("runPackNetwork: the kernel walks and totals the pack's physical network", () => {
    const r = runPackNetwork(model, set, "zz.gravity_load");
    expect(r.ok && r.totals.get("f")).toEqual({ "zz.dead": 350 });
  });

  it("packFieldRegistry: the pack's parameter is a field on the class", () => {
    expect(packFieldRegistry(set).field("arch.wall", "zz.section")?.writer).toEqual({ kind: "command", command: "set_element_values", argument: "zz.section" });
  });
});

describe("c5p a pack's rate on a built-in space use", () => {
  it("the office row gains the live load inside the scope only, and pins in the parameter's unit", () => {
    const outside = spaceUseCatalog().catalog.get("office_space");
    expect(outside?.rates.some((r) => r.key === "zz.live_load")).toBe(false);
    withPackSet(set, () => {
      const { catalog, issues } = spaceUseCatalog();
      expect(issues).toEqual([]);
      const office = catalog.get("office_space");
      if (!office) throw new Error("no office row");
      expect(office.rates.find((r) => r.key === "zz.live_load")).toMatchObject({ value: 50, unit: "psf" });
      const pinned = pinSpaceUse("builtin:space-uses", office, spaceUseRateTargets());
      if (typeof pinned === "string") throw new Error(pinned);
      // 50 lbf/ft² is 538.196 lbf/m².
      expect(pinned.parameterRates?.filter((r) => r.key.startsWith("zz."))).toEqual([{ key: "zz.live_load_total", per: "area", value: expect.closeTo(538.196, 2) }]);
      expect(pinned.rates.map((r) => r.key)).toEqual(expect.arrayContaining(["cfm", "va"]));
    });
  });

  it("built-in rows pin only the first-party add-ons' parameter rates (Structural's live load since round 14)", () => {
    const office = spaceUseCatalog().catalog.get("office_space");
    if (!office) throw new Error("no office row");
    const pinned = pinSpaceUse("builtin:space-uses", office, spaceUseRateTargets());
    expect(typeof pinned !== "string" && (pinned.parameterRates ?? []).map((r) => r.key)).toEqual(["struct.live_load"]);
  });
});

describe("c5p conformance covers the new points", () => {
  it("the test pack passes", () => {
    expect(runPackConformance(ZZ)).toEqual({ ok: true, problems: [] });
  });

  it("a network adapter with neither face, a parameter outside the namespace and a rate in the wrong unit are listed", () => {
    const broken = definePack({ id: "yy", name: "Broken", version: "1.0.0", kernel: "^1.0.0" }, [
      contribute(NETWORK_ADAPTER_POINT, [{ id: "yy.nothing" }]),
      contribute(PARAMETER_SET_POINT, [{ id: "yy.set", label: "S", parameters: [{ key: "zz.stolen", label: "Stolen", classes: ["arch.wall"], valueType: "text" }] }]),
      contribute(SPACE_USE_RATE_POINT, [{ key: "yy.live", quantity: "yy.total", per: "area", kind: "area_load", label: "Live", unit: "lbf" }]),
      contribute(SPACE_USE_RATE_VALUE_POINT, [{ useId: "office_space", key: "yy.live", value: 1, unit: "cfm", cite: { code: "X", edition: null, clause: "1", verified: false } }]),
    ]);
    expect(runPackConformance(broken).problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining("yy.nothing has neither link rules"),
        expect.stringContaining('parameter zz.stolen (in yy.set) must start with "yy."'),
        expect.stringContaining('"cfm" isn\'t a unit for live'),
      ]),
    );
  });
});
