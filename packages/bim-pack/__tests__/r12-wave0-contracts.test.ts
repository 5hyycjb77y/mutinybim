/**
 * @jest-environment node
 *
 * Round 12 wave 0: the contracts lanes E12, M12, P12 and S12 build against
 * (contract 1.10.0). Each new point is known to the conformance suite with
 * its version, refuses malformed rows in words, and is readable by an
 * add-on that isn't first-party with no kernel edit. The two network faces
 * are asked through the adapter row; design limits resolve project over
 * firm over add-on default by id, most specific first. Behaviour the lanes
 * own refuses with "isn't built yet".
 *
 * Fails on round 11's code: none of these points, faces or subpaths exist,
 * and the contract is 1.9.0.
 */
import { z } from "zod";
import {
  CATALOG_ENTRY_POINT,
  DIAGRAM_LAYOUT_POINT,
  FITTING_FAMILY_POINT,
  KNOWN_POINTS,
  NETWORK_ADAPTER_POINT,
  PACK_CONTRACT_VERSION,
  PackSet,
  RATING_KIND_POINT,
  ROUTE_CONSTRAINT_POINT,
  VIEW_GRAPHICS_POINT,
  CALC_SHEET_POINT,
  DESIGN_LIMIT_DEFAULT_POINT,
  INTAKE_COLUMN_POINT,
  assemblyStubs,
  calcSheetSpecProblems,
  catalogEntryRow,
  checkRouteSpan,
  contribute,
  definePack,
  designLimitsFor,
  diagramLayoutRow,
  evaluateCalcSheet,
  intakeHeadingKey,
  isPackRefusal,
  outsideBand,
  packFittingDefault,
  packFittingFamily,
  proposeIntakeRows,
  ratingOf,
  routeConstraintsFor,
  runPackConformance,
  sourcesFor,
  translateThroughNetworks,
  viewGraphicsRows,
  withPackSet,
  type CalcSheetSpec,
  type DesignLimit,
  type Pack,
  type RouteConstraintRow,
  type TranslateContext,
} from "../src";
import { type BimElement, type ElementId, type FittingFamily } from "@permitzip/bim-kernel";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";

const TEST_KERNEL = "^1.10.0";

function outside(id: string, contributions: Pack["contributions"]): Pack {
  return definePack({ id, name: id.toUpperCase(), version: "1.0.0", kernel: TEST_KERNEL }, contributions);
}

const model = createDemoModel("r12-wave0");

const limit = (id: string, max: number, appliesTo: DesignLimit["appliesTo"], extra: Partial<DesignLimit> = {}): DesignLimit => ({
  id,
  label: id,
  quantity: "velocity",
  unit: "ft/s",
  appliesTo,
  band: { max },
  severity: "warning",
  citation: { source: "Test practice" },
  ...extra,
});

describe("r12 wave 0 contracts", () => {
  it("is contract 1.10.0 and the conformance suite knows every new point at version 1", () => {
    // 1.10.0 or a later 1.x (round 13 is 1.11.0): the points stay at version 1.
    const [major, minor] = PACK_CONTRACT_VERSION.split(".").map(Number);
    expect([major, (minor ?? 0) >= 10]).toEqual([1, true]);
    const ids = new Map(KNOWN_POINTS.map((p) => [p.id, p.version] as const));
    for (const id of ["kernel.catalog_entry", "kernel.diagram_layout", "kernel.view_graphics", "kernel.rating_kind", "kernel.route_constraint", "kernel.fitting_family", "kernel.calc_sheet", "kernel.design_limit_default", "kernel.intake_column"]) {
      expect([id, ids.get(id)]).toEqual([id, 1]);
    }
  });

  it("an outside add-on's rows at every new point pass conformance and are read with no kernel edit", () => {
    const family: FittingFamily = { id: "zz.bend.long", name: "Long bend", smacnaType: "Bend", domain: "pipe", fittingTypes: ["elbow"], shapes: ["pipe"], params: [], geometry: "radius_elbow", loss: "radius_elbow", description: "A test bend." };
    const rule: RouteConstraintRow = { form: "crossing", id: "zz.stop_at_rated", label: "Stop at rated walls", routes: ["run_segment"], ratingKind: "zz.rated", atLeast: 1, requires: { id: "zz.stop", label: "a stop" } };
    const pack = outside("zz", [
      contribute(CATALOG_ENTRY_POINT, [{ type: "zz.rack_type", idPrefix: "zzrack", label: "Rack type", schema: z.object({ name: z.string() }), nameOf: (e) => String((e as { name?: unknown }).name ?? "") }]),
      contribute(DIAGRAM_LAYOUT_POINT, [{ kind: "zz.riser", label: "Test riser", check: () => null, layout: () => ({ items: [], extent: { min: { x: 0, y: 0 }, max: { x: 0, y: 0 } }, nodes: [] }) }]),
      contribute(VIEW_GRAPHICS_POINT, [{ id: "zz.loop_lines", label: "Loop lines", hintsKey: "zzLoops", order: 10, draw: () => undefined }]),
      contribute(RATING_KIND_POINT, [{ id: "zz.rated", label: "Test rating", unit: "hour", levels: [1, 2], parameterKeys: ["zz.rating"], read: (el) => (el.id === "wall-1" ? 2 : null) }]),
      contribute(ROUTE_CONSTRAINT_POINT, [rule]),
      contribute(FITTING_FAMILY_POINT, [{ family, defaults: [{ scope: "zz.loop", slot: "elbow_round", choice: { family: "zz.bend.long" } }] }]),
      contribute(CALC_SHEET_POINT, [{ id: "zz.beam_check", label: "Beam check", build: () => ({ refused: "no beam" }) }]),
      contribute(DESIGN_LIMIT_DEFAULT_POINT, [limit("zz.loop_velocity", 8, { systems: ["zz.loop"] })]),
      contribute(INTAKE_COLUMN_POINT, [{ id: "zz.amps_in", label: "Input", headings: ["INPUT", "IN"], field: "zz.input" }]),
    ]);
    const result = runPackConformance(pack);
    expect(result.problems).toEqual([]);
    const set = PackSet.create([pack]);
    withPackSet(set, () => {
      expect(catalogEntryRow("zz.rack_type")?.idPrefix).toBe("zzrack");
      expect(diagramLayoutRow("zz.riser")?.label).toBe("Test riser");
      expect(viewGraphicsRows().map((r) => r.id)).toContain("zz.loop_lines");
      const wall = { id: "wall-1" } as BimElement;
      expect(ratingOf({}, wall, "zz.rated")).toBe(2);
      expect(ratingOf({}, { id: "wall-2" } as BimElement, "zz.rated")).toBeNull();
      // First-party rows (Mechanical's rated-wall rules, round 13) sit beside the outside add-on's.
      expect(routeConstraintsFor("run_segment").map((r) => r.id)).toContain("zz.stop_at_rated");
      expect(packFittingFamily("zz.bend.long")?.name).toBe("Long bend");
      expect(packFittingDefault("zz.loop", "elbow_round")).toEqual({ family: "zz.bend.long" });
      expect(designLimitsFor({ quantity: "velocity", system: "zz.loop" }, undefined).map((r) => r.limit.id)).toEqual(["zz.loop_velocity"]);
    });
  });

  it("malformed rows are refused in words", () => {
    const bad = outside("yy", [
      contribute(CATALOG_ENTRY_POINT, [
        { type: "yy.a", idPrefix: "Bad Prefix", label: "A", schema: z.object({}), nameOf: () => "" },
        { type: "yy.b", idPrefix: "dup", label: " ", schema: z.object({}), nameOf: () => "" },
        { type: "yy.c", idPrefix: "dup", label: "C", schema: z.object({}), nameOf: () => "" },
      ]),
      contribute(RATING_KIND_POINT, [{ id: "yy.r", label: "R", unit: "h", levels: [2, 1], parameterKeys: [], read: () => null }]),
      contribute(INTAKE_COLUMN_POINT, [
        { id: "yy.one", label: "One", headings: ["Volts"], field: "yy.v" },
        { id: "yy.two", label: "Two", headings: ["VOLTS "], field: "yy.w" },
      ]),
      contribute(DESIGN_LIMIT_DEFAULT_POINT, [limit("yy.l", 1, {}, { band: {} })]),
    ]);
    const problems = runPackConformance(bad).problems.join("\n");
    expect(problems).toMatch(/id prefix "Bad Prefix"/);
    expect(problems).toMatch(/catalog record type yy.b has no label/);
    expect(problems).toMatch(/id prefix "dup" is already taken/);
    expect(problems).toMatch(/rating kind yy.r: levels must be finite and rising/);
    expect(problems).toMatch(/heading "VOLTS " is already yy.one's/);
    expect(problems).toMatch(/design limit yy.l: band set a minimum, a maximum or a target/);
  });

  it("source candidates and translate are asked through the network adapter row", () => {
    const end = { elementId: "dev-1" as ElementId };
    const pack = outside("xx", [
      contribute(NETWORK_ADAPTER_POINT, [
        {
          id: "xx.loop",
          sourcesFor: (_m, e) => (e.elementId === "dev-1" ? { sourceWord: "loop", prompt: "Needs a source. Drag to a loop", candidates: [{ sourceId: "lp-1" as ElementId, label: "L1", distanceMm: 1200 }], refused: [{ sourceId: "lp-2" as ElementId, label: "L2", reason: "L2 is full" }] } : null),
          translate: (ctx, id, delta) => {
            if (id !== "dev-1") return false;
            ctx.author({ elementId: id, field: "position", value: delta });
            return true;
          },
        },
      ]),
    ]);
    expect(runPackConformance(pack).problems).toEqual([]);
    withPackSet(PackSet.create([pack]), () => {
      const answer = sourcesFor(model, end);
      expect(answer?.prompt).toBe("Needs a source. Drag to a loop");
      expect(answer?.refused[0]?.reason).toBe("L2 is full");
      expect(sourcesFor(model, { elementId: "other" as ElementId })).toBeNull();
      const writes: unknown[] = [];
      const ctx: TranslateContext = { model, current: () => ({ id: "dev-1" }) as BimElement, set: () => undefined, author: (w) => writes.push(w) };
      expect(translateThroughNetworks(ctx, "dev-1" as ElementId, { x: 10, y: 0 })).toBe(true);
      expect(translateThroughNetworks(ctx, "nope" as ElementId, { x: 10, y: 0 })).toBe(false);
      expect(writes).toEqual([{ elementId: "dev-1", field: "position", value: { x: 10, y: 0 } }]);
    });
  });

  it("design limits: project over firm over add-on by id, most specific first, stage-bound and unknown fields left out", () => {
    const pack = outside("ww", [
      contribute(DESIGN_LIMIT_DEFAULT_POINT, [
        limit("ww.water_velocity", 10, { discipline: "ww" }),
        limit("ww.hot_velocity", 5, { discipline: "ww", systems: ["hot"] }),
        limit("ww.recirc_velocity", 2, { discipline: "ww", systems: ["recirc"] }),
        limit("ww.sd_cushion", 30, { discipline: "ww" }, { quantity: "ratio", unit: "%", stages: ["sd"] }),
      ]),
    ]);
    withPackSet(PackSet.create([pack]), () => {
      const firm = [limit("ww.water_velocity", 8, { discipline: "ww" }, { setBy: { name: "Firm", at: "2026-11-03T00:00:00Z" } })];
      const project = [limit("ww.hot_velocity", 4, { discipline: "ww", systems: ["hot"] })];
      const hot = designLimitsFor({ quantity: "velocity", discipline: "ww", system: "hot" }, "cd", { firm, project });
      expect(hot.map((r) => [r.limit.id, r.layer, r.limit.band.max, r.specificity])).toEqual([
        ["ww.hot_velocity", "project", 4, 2],
        ["ww.water_velocity", "firm", 8, 1],
      ]);
      expect(hot[0]?.replaces).toEqual(["addon"]);
      // No system known: the system-specific limits don't apply, the general one does.
      expect(designLimitsFor({ quantity: "velocity", discipline: "ww" }, "cd", { firm }).map((r) => r.limit.id)).toEqual(["ww.water_velocity"]);
      expect(designLimitsFor({ quantity: "ratio", discipline: "ww" }, "cd").map((r) => r.limit.id)).toEqual([]);
      expect(designLimitsFor({ quantity: "ratio", discipline: "ww" }, "sd").map((r) => r.limit.id)).toEqual(["ww.sd_cushion"]);
    });
    expect(outsideBand({ max: 8 }, 9.2)).toBe("above");
    expect(outsideBand({ min: 2, max: 8 }, 1)).toBe("below");
    expect(outsideBand({ max: 8 }, 8)).toBeNull();
  });

  it("calculation sheet specs name only keys defined before them", () => {
    const spec: CalcSheetSpec = {
      template: "zz.beam_check",
      title: "Beam check",
      inputs: [{ key: "span", label: "Span", unit: "ft", bind: { from: "typed", value: 20 } }],
      lookups: [{ key: "cap", label: "Capacity", table: { slot: "zz.table" }, row: { input: "span", match: "next_up" }, column: { input: "size", match: "exact" }, unit: "lb" }],
      steps: [{ key: "ratio", label: "Ratio", formula: "cap / span", unit: "ratio" }],
      checks: [{ key: "ok", label: "OK", value: "missing", limit: { quantity: "ratio" } }],
      citations: [{ section: "Test 1.1" }],
      result: { key: "ratio", label: "Ratio" },
    };
    expect(calcSheetSpecProblems(spec)).toEqual(["Beam check: lookup cap reads size, which isn't an input", "Beam check: check ok compares missing, which isn't defined"]);
  });

  it("headings compare by letters and digits only", () => {
    expect(intakeHeadingKey("Rated  Input (kW)")).toBe("RATEDINPUTKW");
  });

  it("checkRouteSpan is built (round 13 M13): no rule for a kind answers an empty list", () => {
    expect(checkRouteSpan(model, { kind: "run_segment", levelId: "L1", start: { x: 0, y: 0 }, end: { x: 1000, y: 0 }, bottomMm: 2700, topMm: 3000, widthMm: 300 })).toEqual([]);
  });

  it("S12's behaviour is built: sheets, stubs and intake answer in words, never 'not built yet'", () => {
    const sheet = evaluateCalcSheet(model, { template: "t", title: "T", inputs: [], lookups: [], steps: [], checks: [], citations: [], result: { key: "r", label: "R" } }, { tables: { table: () => null }, limits: {} });
    expect(sheet).toEqual({ refused: "T: the result r isn't defined" });
    const typed = evaluateCalcSheet(model, { template: "t", title: "T", inputs: [{ key: "a", label: "A", unit: "ft", bind: { from: "typed", value: 3 } }], lookups: [], steps: [{ key: "b", label: "B", formula: "{a} * 2", unit: "ft" }], checks: [], citations: [], result: { key: "b", label: "B" } }, { tables: { table: () => null }, limits: {} });
    expect(isPackRefusal(typed) ? typed.refused : typed.values.b).toBe(6);
    expect(assemblyStubs(model, "g-1" as ElementId)).toEqual({ refused: "g-1 isn't a group in this model" });
    expect(proposeIntakeRows({ source: { name: "x.png", kind: "image" }, pages: [], cells: [], headerRow: null, notes: [] })).toEqual({ refused: "No table was found in this picture. Try a picture that shows the whole schedule." });
  });
});
