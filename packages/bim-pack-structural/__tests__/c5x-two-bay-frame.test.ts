/**
 * @jest-environment node
 *
 * The 5c-7 proof (STATUS): on a synthetic two-bay frame, the rooftop unit's
 * weight and the roof live load reach the right footings, matching the hand
 * check below, through the pack contract: the pack set, the kernel's derived
 * zones (tributary areas), the kernel's walk of the pack's network
 * (`runPackNetwork` → `serviceNetworkTotals`), the real lint engine
 * (`runPackLint`) and the field registry (`packFieldRegistry`).
 *
 * Hand check (fixture in two-bay-frame.ts; one service-level case, no load
 * factors, no live-load reduction):
 *
 *   Roof live load, ASCE 7-22 Table 4.3-1 ordinary roof: 20 psf.
 *   Deck spans along y between beams on lines 1, 2, 3 (y = 0, 25, 50 ft):
 *     tributary widths  B1 = 12.5 ft, B2 = 25 ft, B3 = 12.5 ft
 *     live line loads   B1 = 20 × 12.5 = 250 plf, B2 = 20 × 25 = 500 plf, B3 = 250 plf
 *   Beam self-weight W16X26: 26 plf × 30 ft = 780 lbf, 390 lbf to each end.
 *   Live reactions (wL/2): B1, B3 = 250 × 30 / 2 = 3,750 lbf; B2 = 500 × 30 / 2 = 7,500 lbf.
 *   RTU-1, 2,000 lb operating weight, on B2 at a = 10 ft of L = 30 ft (b = 20 ft):
 *     end at x = 0 (C2A) = P·b/L = 2,000 × 20 / 30 = 1,333.33 lbf
 *     end at x = 30 (C2B) = P·a/L = 2,000 × 10 / 30 = 666.67 lbf
 *   Column self-weight W8X31: 31 plf × 15 ft = 465 lbf.
 *
 *   Footing     dead (390 + 465)   live     equipment    total
 *   F1A, F1B    855                3,750    0            4,605.00
 *   F2A         855                7,500    1,333.33     9,688.33
 *   F2B         855                7,500    666.67       9,021.67
 *   F3A, F3B    855                3,750    0            4,605.00
 *
 *   Check: dead 6 × 855 = 5,130 = 3 beams × 780 + 6 columns × 465 (2,340 + 2,790);
 *          live 30,000 = 20 psf × 30 × 50 ft; equipment 2,000; total 37,130 lbf.
 */
import { to } from "@permitzip/bim-units";
import { CALC_POINT, CLASS_POINT, DERIVED_ZONE_RULE_POINT, LINT_RULE_POINT, NETWORK_ADAPTER_POINT, PARAMETER_SET_POINT, PackSet, SERVICE_POINT, SPACE_USE_POINT, SPACE_USE_RATE_POINT, SPACE_USE_RATE_VALUE_POINT, ZONE_PURPOSE_POINT, adapterForService, bindModelPacks, unbindModelPacks, contribute, definePack, evaluateParameterRates, networkForService, packFieldRegistry, runPackConformance, runPackLint, runPackNetwork, withPackSet } from "@permitzip/bim-pack";
import { installedFirstPartyPacks } from "@permitzip/bim-pack";
import { installFirstPartyPacks } from "@permitzip/bim-kernel/packs";
import { FIRST_PARTY_ADDONS } from "@permitzip/bim-first-party";

// @mutinybim-bare-kernel: since round 14 Structural is first-party, so in every set. These proofs are
// about the pack's rows inside and outside a set's scope, so this host installs every other first-party
// add-on and Structural stays a pack the set names (what it is to the contract either way).
installFirstPartyPacks(FIRST_PARTY_ADDONS.filter((p) => p.manifest.id !== "struct"));
/** The first-party add-ons this host installs: all but Structural. */
const FIRST_PARTY_PACKS = installedFirstPartyPacks();
import type { ExtensionPoint } from "@permitzip/bim-kernel/packs";
import { withUpgradePolicy } from "@permitzip/bim-kernel";
import { executeCommand } from "@permitzip/bim-kernel/commands";
import { activeClassRegistry, buildClassIndex } from "@permitzip/bim-kernel/registry";
import { serviceById } from "@permitzip/bim-kernel/services";
import { derivedZonePlacements, derivedZoneRule, derivedZonesOfHost, resolveDerivedZone } from "@permitzip/bim-kernel/spaces";
import { asElementId, type BimElement, type ModelState } from "@permitzip/bim-kernel/types";
import { FOOTING_UNSUPPORTED_RULE, LIVE_LOAD_RATE_KEY, LOAD_KEYS, STRUCTURAL_CLASSES, STRUCTURAL_PACK, STRUCT_CLASSES, footingUnsupportedAll, liveLoadRate, structuralLoadPath, type CaseLoads } from "../src";
import { FT, twoBayFrame } from "./two-bay-frame";

const SET = PackSet.create([...FIRST_PARTY_PACKS, STRUCTURAL_PACK]);
const OTHERS = PackSet.create([...FIRST_PARTY_PACKS]);
const inPack = <R>(fn: () => R): R => withPackSet(SET, fn);

const lbf = (l: CaseLoads) => ({ dead: round(to(l.dead, "lbf")), live: round(to(l.live, "lbf")), equipment: round(to(l.equipment, "lbf")), total: round(to(l.total, "lbf")) });
const round = (v: number) => Math.round(v * 100) / 100;
const footingLoads = (model: ModelState) => Object.fromEntries(inPack(() => structuralLoadPath(model)).footings.map((f) => [f.id, lbf(f.load)]));
/** Newtons to pounds-force: 1 lbf = 0.45359237 kg × 9.80665 m/s² exactly. */
const N_PER_LBF = 4.4482216152605;
const el = (model: ModelState, id: string): BimElement => {
  const e = model.elements[id];
  if (!e) throw new Error(`${id} missing`);
  return e;
};
/**
 * The rows this pack adds at a point. Since round 6 a set's pack items start
 * with the installed first-party add-ons' rows (Electrical's dedicated space,
 * the trades' adapters, calcs and lint rules), unchanged by this pack.
 */
function addedBy<T>(point: ExtensionPoint<T>, key: (item: T) => string): string[] {
  const base = PackSet.create([]).packItems(point).map(key);
  const all = SET.packItems(point).map(key);
  expect(all.slice(0, base.length)).toEqual(base);
  return all.slice(base.length);
}

describe("c5x the Structural pack goes through the contract", () => {
  it("passes the pack conformance suite", () => {
    expect(runPackConformance(STRUCTURAL_PACK)).toEqual({ ok: true, problems: [] });
  });

  it("a set with the first-party packs and this one builds; its rows are seen inside the scope and not outside it", () => {
    const seen = () => ({
      cls: activeClassRegistry().getClass("struct.beam_steel")?.ifc ?? null,
      service: serviceById("struct.gravity_load")?.regime ?? null,
      rule: derivedZoneRule("struct.tributary")?.label ?? null,
    });
    expect(inPack(seen)).toEqual({ cls: { entity: "IfcBeam", predefinedType: "BEAM", typeEntity: "IfcBeamType" }, service: "structural", rule: "Tributary area" });
    expect(seen()).toEqual({ cls: null, service: null, rule: null });
    expect(addedBy(CLASS_POINT, (c) => c.id)).toEqual([...STRUCTURAL_CLASSES, ...STRUCT_CLASSES].map((c) => c.id));
    expect(addedBy(SERVICE_POINT, (r) => r.id)).toEqual(["struct.gravity_load"]);
    expect(PackSet.create([]).packItems(DERIVED_ZONE_RULE_POINT).map((r) => r.id)).toEqual(["dedicated"]);
    expect(addedBy(DERIVED_ZONE_RULE_POINT, (r) => r.id)).toEqual(["struct.tributary"]);
    expect(addedBy(ZONE_PURPOSE_POINT, (r) => r.id)).toEqual(["struct.tributary"]);
    expect(addedBy(SPACE_USE_RATE_POINT, (r) => r.key)).toEqual(["struct.live_load"]);
    expect(addedBy(SPACE_USE_POINT, (r) => r.id)).toEqual(["struct.roof_ordinary"]);
    expect(addedBy(SPACE_USE_RATE_VALUE_POINT, (r) => r.useId)).toEqual(["office_space", "corridor", "retail_sales", "storage"]);
    expect(addedBy(NETWORK_ADAPTER_POINT, (r) => r.id)).toEqual(["struct.load_path"]);
    expect(addedBy(PARAMETER_SET_POINT, (r) => r.id)).toEqual(["struct.framing"]);
    expect(addedBy(LINT_RULE_POINT, (r) => r.id)).toEqual(["struct.footing_unsupported"]);
    expect(addedBy(CALC_POINT, (c) => c.info.id)).toEqual(["struct.simple_beam"]);
    // The beam class is the pack's own since round 14 (first-party, so built-in in a host that installs it); the electrical adapter is still there.
    expect(inPack(() => activeClassRegistry().getClass("struct.beam")?.source)).toBe("provider:pack:struct");
    expect(inPack(() => adapterForService("power"))).not.toBeNull();
    // The load path is a network to total, not a served-from link trade.
    expect(inPack(() => [adapterForService("struct.gravity_load"), networkForService("struct.gravity_load")?.aggregation?.direction])).toEqual([null, "downward"]);
    expect(networkForService("struct.gravity_load")).toBeNull();
  });

  it("live load is a rate on the pack's roof use and on the built-in office use inside the scope, and on neither outside it", () => {
    const psf = (r: ReturnType<typeof liveLoadRate>) => (r ? to(r.value, "psf") : null);
    expect(inPack(() => [psf(liveLoadRate("struct.roof_ordinary")), psf(liveLoadRate("office_space")), psf(liveLoadRate("storage"))])).toEqual([20, 50, 125].map((v) => expect.closeTo(v, 9)));
    expect([liveLoadRate("struct.roof_ordinary"), liveLoadRate("office_space")]).toEqual([null, null]);
  });

  it("the pack's parameters reach the field registry the Inspector and schedules read, only inside the scope", () => {
    const section = packFieldRegistry(SET).field("struct.beam_steel", "struct.section");
    expect(section).toMatchObject({ key: "struct.section", valueType: "choice", group: "Structural" });
    expect(section?.choices).toContain("W16X26");
    expect(packFieldRegistry(SET).field("struct.roof_deck", "struct.occupancy")?.label).toBe("Live load use");
    expect(packFieldRegistry(OTHERS).field("struct.beam", "struct.section")).toBeUndefined();
  });

  it("the kernel's class index puts each frame element in its pack class (what the IFC exporter and schedules read)", () => {
    const model = twoBayFrame();
    const classes = inPack(() => {
      const index = buildClassIndex(activeClassRegistry(), model);
      return Object.fromEntries(["B2", "C2A", "F2A", "DECK-1"].map((id) => [id, index.classesOf(asElementId(id)).filter((c) => c.startsWith("struct.") && c.includes("_"))]));
    });
    expect(classes).toEqual({ B2: ["struct.beam_steel"], C2A: ["struct.column_steel"], F2A: ["struct.footing_pad"], "DECK-1": ["struct.roof_deck"] });
  });

  it("S-15: the pad footing is a subclass of the footing class", () => {
    const model = twoBayFrame();
    const seen = inPack(() => {
      const reg = activeClassRegistry();
      return { ancestors: reg.ancestors("struct.footing_pad"), source: reg.getClass("struct.footing")?.source, inIndex: buildClassIndex(reg, model).classesOf(asElementId("F2A")).includes("struct.footing") };
    });
    expect(seen).toEqual({ ancestors: expect.arrayContaining(["struct.footing_pad", "struct.footing"]), source: "provider:pack:struct", inIndex: true });
  });

  it("every class carries the IFC hint the exporter reads", () => {
    const ifc = Object.fromEntries(STRUCT_CLASSES.map((c) => [c.id, c.ifc ? `${c.ifc.entity}/${c.ifc.predefinedType ?? ""}` : null]));
    expect(ifc).toEqual({ "struct.beam_steel": "IfcBeam/BEAM", "struct.column_steel": "IfcColumn/COLUMN", "struct.footing_pad": "IfcFooting/PAD_FOOTING", "struct.roof_deck": "IfcSlab/ROOF", "struct.floor_deck": "IfcSlab/FLOOR" });
  });
});

describe("c5x two-bay frame: the load path reaches the right footings (hand check in the header)", () => {
  const model = twoBayFrame();

  it("tributary areas are derived zones the kernel resolves: 375, 750, 375 ft²", () => {
    const areaFt2 = (id: string) =>
      inPack(() =>
        derivedZonesOfHost(model, el(model, id), "struct.tributary").map((r) => {
          const [a, b, c] = r.outline;
          return a && b && c ? Math.round(((Math.hypot(b.x - a.x, b.y - a.y) * Math.hypot(c.x - b.x, c.y - b.y)) / (FT * FT)) * 1000) / 1000 : Number.NaN;
        }),
      );
    expect([areaFt2("B1"), areaFt2("B2"), areaFt2("B3")]).toEqual([[375], [750], [375]]);
    expect(inPack(() => resolveDerivedZone(model, asElementId("B2"), "struct.tributary"))).toMatchObject({ ok: true });
    expect(resolveDerivedZone(model, asElementId("B2"), "struct.tributary")).toMatchObject({ ok: false });
  });

  it("the kernel totals the pack's network to the hand-checked footing loads (runPackNetwork)", () => {
    const walked = runPackNetwork(model, SET, "struct.gravity_load");
    if (!walked.ok) throw new Error(walked.reason);
    expect(walked).toMatchObject({ direction: "downward", quantities: [LOAD_KEYS.dead, LOAD_KEYS.live, LOAD_KEYS.equipment] });
    const at = (id: string) => {
      const q = walked.totals.get(id) ?? {};
      return [LOAD_KEYS.dead, LOAD_KEYS.live, LOAD_KEYS.equipment].map((k) => round((q[k] ?? 0) / N_PER_LBF));
    };
    expect(Object.fromEntries(["F1A", "F1B", "F2A", "F2B", "F3A", "F3B"].map((id) => [id, at(id)]))).toEqual({
      F1A: [855, 3750, 0],
      F1B: [855, 3750, 0],
      F2A: [855, 7500, 1333.33],
      F2B: [855, 7500, 666.67],
      F3A: [855, 3750, 0],
      F3B: [855, 3750, 0],
    });
    expect(at("C2A")).toEqual(at("F2A"));
    expect(runPackNetwork(model, OTHERS, "struct.gravity_load").ok).toBe(false);
  });

  it("S-14: a beam is one node on two columns; across hands each column its end's reaction, case by case", () => {
    const walked = runPackNetwork(model, SET, "struct.gravity_load");
    if (!walked.ok) throw new Error(walked.reason);
    const at = (id: string) => [LOAD_KEYS.dead, LOAD_KEYS.live, LOAD_KEYS.equipment].map((k) => round((walked.totals.get(id)?.[k] ?? 0) / N_PER_LBF));
    // B2 carries its whole load: 26 × 30 = 780, 500 × 30 = 15,000, and the 2,000 lb unit.
    expect(at("B2")).toEqual([780, 15000, 2000]);
    // C2A takes the start: 390 + 7,500 + 1,333.33, plus its own 465 dead. The uniform cases split 50/50; the unit 2/3 : 1/3.
    expect(at("C2A")).toEqual([855, 7500, 1333.33]);
    expect(at("C2B")).toEqual([855, 7500, 666.67]);
    // Every node is an element.
    expect([...walked.totals.keys()].filter((k) => !model.elements[k])).toEqual([]);
  });

  it("every footing carries its hand-checked dead, live and equipment load", () => {
    expect(footingLoads(model)).toEqual({
      F1A: { dead: 855, live: 3750, equipment: 0, total: 4605 },
      F1B: { dead: 855, live: 3750, equipment: 0, total: 4605 },
      F2A: { dead: 855, live: 7500, equipment: 1333.33, total: 9688.33 },
      F2B: { dead: 855, live: 7500, equipment: 666.67, total: 9021.67 },
      F3A: { dead: 855, live: 3750, equipment: 0, total: 4605 },
      F3B: { dead: 855, live: 3750, equipment: 0, total: 4605 },
    });
  });

  it("reports the beams, columns and a clean walk", () => {
    const r = inPack(() => structuralLoadPath(model));
    expect(r.problems).toEqual([]);
    expect(r.unsupportedBeamEnds).toEqual([]);
    const b2 = r.beams.find((b) => b.id === "B2");
    expect(b2 && { start: b2.startColumnId, end: b2.endColumnId, live: round(to(b2.uniformLive, "plf")), dead: round(to(b2.uniformDead, "plf")), rtu: b2.pointLoads.map((p) => [p.from, round(to(p.load, "lbf")), round(to(p.at, "ft"))]) }).toEqual({ start: "C2A", end: "C2B", live: 500, dead: 26, rtu: [["RTU-1", 2000, 10]] });
    // B2's peak moment under 526 plf + 2,000 lbf at 10 ft: 69.6 kip-ft at 13.73 ft (c5x-simple-beam).
    expect(b2 && round(to(b2.maxMoment, "kip.ft"))).toBeCloseTo(69.6, 1);
    expect(r.columns.map((c) => [c.id, c.bearsOn?.id])).toEqual([
      ["C1A", "F1A"],
      ["C1B", "F1B"],
      ["C2A", "F2A"],
      ["C2B", "F2B"],
      ["C3A", "F3A"],
      ["C3B", "F3B"],
    ]);
    const total = r.footings.reduce((a, f) => a + to(f.load.total, "lbf"), 0);
    expect(total).toBeCloseTo(37130, 6);
  });

  it("the RTU's weight moves with it: on the deck between B1 and B2 it splits by the lever rule", () => {
    // At (10, 12.5) ft, halfway between B1 (y = 0) and B2 (y = 25): 1,000 lbf to each, at 10 ft along each.
    // B1 and B2 each send 1,000 × 20/30 = 666.67 to the x = 0 end and 333.33 to the x = 30 end.
    const moved = twoBayFrame({ rtuAt: { x: 10, y: 12.5 }, rtuHost: { kind: "slab", elementId: asElementId("DECK-1") } });
    const eq = Object.fromEntries(Object.entries(footingLoads(moved)).map(([k, v]) => [k, v.equipment]));
    expect(eq).toEqual({ F1A: 666.67, F1B: 333.33, F2A: 666.67, F2B: 333.33, F3A: 0, F3B: 0 });
  });

  it("S-16: a beam bearing on a column stacked on another column hands its share down both", () => {
    // C2B is split at 7.5 ft: C2B (7.5 to 15 ft, carrying B2's end) stands on C2Bx (0 to 7.5 ft) on F2B.
    // The live load is unchanged by the split: B2's end 7,500 lbf reaches C2B, C2Bx and F2B.
    const m = twoBayFrame();
    const c = m.elements["C2B"];
    if (c?.kind !== "column" || c.placement?.kind !== "line") throw new Error("C2B is a line-placed column");
    const lower = { ...c, id: asElementId("C2Bx"), values: { mark: "C2Bx" }, placement: { ...c.placement, startOffsetMm: 0, endOffsetMm: 7.5 * FT, topLevelId: undefined } };
    const upper = { ...c, placement: { ...c.placement, startOffsetMm: 7.5 * FT } };
    const stacked: ModelState = { ...m, elements: { ...m.elements, C2B: upper, C2Bx: lower } };
    const walked = runPackNetwork(stacked, SET, "struct.gravity_load");
    if (!walked.ok) throw new Error(walked.reason);
    const live = (id: string) => round((walked.totals.get(id)?.[LOAD_KEYS.live] ?? 0) / N_PER_LBF);
    expect({ C2B: live("C2B"), C2Bx: live("C2Bx"), F2B: live("F2B") }).toEqual({ C2B: 7500, C2Bx: 7500, F2B: 7500 });
    // The column's own weight still adds up: 31 plf × (7.5 + 7.5) ft = 465, plus B2's 390.
    expect(round((walked.totals.get("F2B")?.[LOAD_KEYS.dead] ?? 0) / N_PER_LBF)).toBe(855);
  });

  it("S-11: the RTU stands on its beam at its station, not wherever it is drawn", () => {
    // Station 20 ft on B2 (a = 20, b = 10): 2,000 × 10/30 = 666.67 to C2A, 2,000 × 20/30 = 1,333.33 to C2B.
    const at20 = twoBayFrame({ rtuHost: { kind: "element", elementId: asElementId("B2"), stationMm: 20 * FT } });
    const eq = Object.fromEntries(Object.entries(footingLoads(at20)).map(([k, v]) => [k, v.equipment]));
    expect(eq).toEqual({ F1A: 0, F1B: 0, F2A: 666.67, F2B: 1333.33, F3A: 0, F3B: 0 });
    // Drawn 12.5 ft off B2 but hosted on it: the host wins.
    const drawnElsewhere = twoBayFrame({ rtuAt: { x: 10, y: 12.5 } });
    expect(footingLoads(drawnElsewhere).F2A?.equipment).toBe(1333.33);
    // Hosted on a line the pack doesn't carry loads on: reported, not guessed.
    const onDeckEdge = inPack(() => structuralLoadPath(twoBayFrame({ rtuHost: { kind: "element", elementId: asElementId("DECK-1"), stationMm: 0 } })));
    expect(onDeckEdge.problems).toContain("RTU-1 stands on DECK-1, which isn't a beam the Structural pack reads, so its weight isn't in the load path");
  });

  it("S-13: the beams share one section type; changing it changes every beam's self-weight", () => {
    // W18X35: 35 plf × 30 ft / 2 = 525 per end, + 465 column = 990 lbf dead at every footing.
    const heavier = footingLoads(twoBayFrame({ beamSection: "W18X35" }));
    expect(Object.values(heavier).map((f) => f.dead)).toEqual(Array(6).fill(990));
    const r = inPack(() => structuralLoadPath(twoBayFrame({ beamSection: "W18X35" })));
    expect(r.beams.map((b) => round(to(b.uniformDead, "plf")))).toEqual([35, 35, 35]);
  });

  it("S-13: create_element_type and set_element_type re-section the beams in a model bound to the pack", () => {
    const m0 = twoBayFrame();
    bindModelPacks(m0.modelId, SET);
    try {
      const step = (m: ModelState, command: Parameters<typeof executeCommand>[1]): ModelState => {
        // A model server whose peers all read element types (`elements:types`).
        const r = withUpgradePolicy(() => true, () => executeCommand(m, command));
        if (!r.ok) throw new Error(r.error.message);
        return r.model;
      };
      let m = step(m0, { type: "create_element_type", typeId: "type-w18", name: "W18X35", classId: "struct.beam_steel", forKinds: ["beam"], values: { "struct.section": "W18X35" } });
      m = step(m, { type: "set_element_type", elementIds: ["B1", "B2", "B3"], typeId: "type-w18" });
      // 35 plf × 30 ft / 2 = 525 per end, + 465 column = 990 lbf dead at every footing.
      expect(Object.values(footingLoads(m)).map((f) => f.dead)).toEqual(Array(6).fill(990));
    } finally {
      unbindModelPacks(m0.modelId);
    }
  });

  it("pinned psf rates: a space whose use pins the pack's live load totals it over its area", () => {
    // Office, 50 psf = 538.196 lbf/m² as the use pins it; over 1,000 ft² (92.903 m²): 50,000 lbf.
    const space = { use: { libraryId: "builtin", useId: "office_space", name: "Office", rates: [], parameterRates: [{ key: LIVE_LOAD_RATE_KEY, per: "area" as const, value: 50 / (FT / 1000) ** 2 }] } };
    const r = evaluateParameterRates(space, { areaM2: 1000 * (FT / 1000) ** 2, occupants: null });
    expect(r.missing).toEqual([]);
    expect(r.values[LIVE_LOAD_RATE_KEY]).toBeCloseTo(50000, 3);
  });

  it("outside the pack scope nothing is totalled, and it says so", () => {
    const r = structuralLoadPath(model);
    expect(r.problems).toContain("Tributary areas aren't computed for this model (the Structural pack isn't in its pack set), so no live load reaches the beams");
    expect(r.problems).toContain('The gravity load path wasn\'t totalled: "struct.gravity_load" isn\'t a service this model knows');
    expect(r.footings.every((f) => to(f.load.total, "lbf") === 0)).toBe(true);
  });

  it("a deck with a use the pack doesn't know carries no live load, and the walk says which", () => {
    const r = inPack(() => structuralLoadPath(twoBayFrame({ roofUse: "struct.helipad" })));
    expect(r.problems).toContain('DECK-1\'s use "struct.helipad" has no live load in the Structural pack, so it carries none');
  });
});

describe("c5x struct.footing_unsupported", () => {
  it("flags the column with no footing, and its load reaches no footing", () => {
    const model = twoBayFrame({ withoutFooting: "C2B" });
    expect(footingUnsupportedAll(model).map((f) => [f.rule, f.elementIds, f.message])).toEqual([["struct.footing_unsupported", ["C2B"], "C2B has no footing below it, so its load reaches no foundation"]]);
    const r = inPack(() => structuralLoadPath(model));
    expect(r.footings.map((f) => f.id)).not.toContain("F2B");
    expect(r.columns.find((c) => c.id === "C2B")?.bearsOn).toBeNull();
    expect(footingUnsupportedAll(twoBayFrame())).toEqual([]);
  });

  it("runs in the real lint engine with the pack's set, and not without it", () => {
    const model = twoBayFrame({ withoutFooting: "C1A" });
    const mine = (set: PackSet) => runPackLint(model, set).filter((f) => f.rule === "struct.footing_unsupported");
    expect(mine(SET).map((f) => [f.severity, f.elementIds, f.message])).toEqual([["error", ["C1A"], "C1A has no footing below it, so its load reaches no foundation"]]);
    expect(mine(OTHERS)).toEqual([]);
    expect(runPackLint(twoBayFrame(), SET).filter((f) => f.rule === "struct.footing_unsupported")).toEqual([]);
  });

  it("S-10: deleting a footing re-flags its column on the next run, though the column isn't near the edit", () => {
    const model = twoBayFrame();
    const { F2B: _gone, ...rest } = model.elements;
    const after: ModelState = { ...model, elements: rest };
    // The edit's scope is the removed footing alone (it has no box any more).
    const flagged = (set: PackSet) => runPackLint(after, set, { ids: ["F2B"] }).filter((f) => f.rule === "struct.footing_unsupported").map((f) => f.elementIds.join(","));
    expect(FOOTING_UNSUPPORTED_RULE.reads).toEqual(["component", "column"]);
    expect(flagged(SET)).toEqual(["C2B"]);
    // The same rule without `reads` (the old contract) leaves C2B unflagged until someone touches it.
    const noReads = definePack({ id: "nreads", name: "No reads", version: "1.0.0", kernel: "^1.2.0" }, [contribute(LINT_RULE_POINT, [{ ...FOOTING_UNSUPPORTED_RULE, id: "nreads.footing_unsupported", pack: "nreads", reads: undefined }])]);
    const without = PackSet.create([...FIRST_PARTY_PACKS, noReads]);
    expect(runPackLint(after, without, { ids: ["F2B"] }).filter((f) => f.elementIds.includes("C2B"))).toEqual([]);
  });
});

describe("c5x tributary zones recompute only when what they depend on changes", () => {
  it("moving a neighbouring beam re-derives B2's strip; an unrelated edit reuses it", () => {
    const model = twoBayFrame();
    const width = (m: ModelState) =>
      inPack(() =>
        derivedZonesOfHost(m, el(m, "B2"), "struct.tributary").map((r) => {
          const [a, b] = r.outline;
          return a && b ? Math.round((Math.hypot(b.x - a.x, b.y - a.y) / FT) * 1000) / 1000 : Number.NaN;
        }),
      );
    expect(width(model)).toEqual([25]);
    const before = derivedZonePlacements();
    const rtu = el(model, "RTU-1");
    const heavier: ModelState = { ...model, elements: { ...model.elements, "RTU-1": rtu.kind === "part" ? { ...rtu, values: { weight: 3000 } } : rtu } };
    expect(width(heavier)).toEqual([25]);
    expect(derivedZonePlacements()).toBe(before);
    // B3 from y = 50 to y = 40: B2's strip runs 12.5 → 32.5 ft, 20 ft wide.
    const b3 = el(model, "B3");
    const moved: ModelState =
      b3.kind === "beam" && b3.placement?.kind === "line"
        ? { ...model, elements: { ...model.elements, B3: { ...b3, start: { x: 0, y: 40 * FT }, end: { x: 30 * FT, y: 40 * FT }, placement: { ...b3.placement, start: { x: 0, y: 40 * FT }, end: { x: 30 * FT, y: 40 * FT } } } } }
        : model;
    expect(width(moved)).toEqual([20]);
    expect(derivedZonePlacements()).toBe(before + 1);
  });
});
