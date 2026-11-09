/**
 * @jest-environment node
 *
 * Outdoor air per space and zone (ROADMAP M1; STATUS decision 13): IMC
 * 403.3.1.1 and ASHRAE 62.1 side by side, one marked governing, from the
 * space-use library rows k3 already ships. Before this change there was no
 * ventilation pack: `packages/bim-calc/src/ventilation` did not exist, no
 * space or zone field printed outdoor air, and the calc registry had no
 * outdoor-air calc, so every test here fails to import on the old tree.
 *
 * @mutinybim-bare-kernel: a case reads through an engine only inside a set
 * whose pack contributes it (`withReader`); the rest prove the not-loaded
 * wording, so the test setup must not install the Mechanical add-on.
 * Since round 6 Mechanical's rows are installed without its engine and
 * targets (`installMechanicalRowsOnly`), as the bare kernel read them before.
 */
import { BUILTIN_SPACE_USES, SPACE_USE_LIBRARY_ID, SPACE_USE_RATE_TARGETS, spaceUseCatalog } from "@permitzip/bim-library";
import { CalcRegistry, pinSpaceUse } from "@permitzip/bim-calc";
import { asElementId, DEFAULT_SETTINGS, fieldProviderRegistry, renderFieldBlock, type BimElement, type ModelState, type PartInstance, type Space, type Zone } from "@permitzip/bim-kernel";
import { to, type Quantity } from "@permitzip/bim-units";
import { PackSet, definePack, withPackSet } from "@permitzip/bim-kernel/packs";
import {
  renderVentilationTable,
  resolveGoverningStandard,
  ventilationOutdoorAirCalc,
  VentilationEngine,
  ventilationReaderContribution,
  ZONE_VENTILATION_TEMPLATE,
  OA_AREA,
  OA_PEOPLE,
  type VentilationUseRow,
  type VentilationUseSource,
} from "../src";
import { installMechanicalRowsOnly } from "./mechanical-rows";

installMechanicalRowsOnly();

const FT = 304.8;
const L1 = asElementId("L1");
const catalog = spaceUseCatalog().catalog;

function pinned(useId: string) {
  const row = BUILTIN_SPACE_USES.find((u) => u.id === useId);
  if (!row) throw new Error(useId);
  const p = pinSpaceUse(SPACE_USE_LIBRARY_ID, row, SPACE_USE_RATE_TARGETS);
  if (typeof p === "string") throw new Error(p);
  return p;
}

/** A drawn rectangle on L1, `w` × `d` feet. */
function space(id: string, number: string, name: string, w: number, d: number, extra: Partial<Pick<Space, "use" | "occupants" | "bounds">> = {}): Space {
  return {
    id: asElementId(id),
    kind: "space",
    version: 1,
    authoredRev: {},
    number,
    name,
    levelId: L1,
    bounds: { kind: "outline", outline: [{ x: 0, y: 0 }, { x: w * FT, y: 0 }, { x: w * FT, y: d * FT }, { x: 0, y: d * FT }] },
    origin: { kind: "drawn" },
    ...extra,
  };
}

function zone(id: string, name: string, spaceIds: readonly string[], servedBy?: string): Zone {
  return { id: asElementId(id), kind: "zone", version: 1, authoredRev: {}, name, purpose: "thermal", spaceIds: spaceIds.map(asElementId), ...(servedBy ? { servedBy: asElementId(servedBy) } : {}) };
}

function rtu(id: string, mark: string, outdoorCfm?: number): PartInstance {
  return { id: asElementId(id), kind: "part", version: 1, authoredRev: {}, typeId: asElementId("type-rtu"), levelId: L1, position: { x: 0, y: 0 }, offsetMm: 0, rotationDeg: 0, mark, values: outdoorCfm === undefined ? {} : { outdoor_cfm: outdoorCfm } };
}

function model(els: readonly BimElement[]): ModelState {
  const level: BimElement = { id: L1, kind: "level", version: 1, authoredRev: {}, name: "Level 1", elevationMm: 0 };
  const elements: Record<string, BimElement> = { [L1]: level };
  for (const el of els) elements[el.id] = el;
  return { modelId: "ventilation", revision: 0 as ModelState["revision"], elements, connections: [], settings: DEFAULT_SETTINGS };
}

const cfm = (v: Quantity<"flow_air"> | null): number | null => (v === null ? null : to(v, "cfm"));

// 40 ft × 25 ft = 1,000 ft²; 25 × 20 = 500 ft².
const dining = () => space("sp-dining", "101", "Dining", 40, 25, { use: pinned("restaurant_dining") });
const kitchen = () => space("sp-kitchen", "102", "Kitchen", 25, 20, { use: pinned("kitchen_cooking") });

/** Run `fn` with `engine` as the outdoor-air reader in force: a pack's row since round 6, read per model. */
function withReader<R>(engine: VentilationEngine, fn: () => R): R {
  return withPackSet(PackSet.create([definePack({ id: "vent_test", name: "Ventilation test", version: "1.0.0", kernel: "^1.3.0" }, [ventilationReaderContribution(engine)])]), fn);
}

describe("outdoor air per space", () => {
  it("1,000 ft² dining at the IMC default density (70 per 1,000 ft²): 70 people, Vbz = 7.5 × 70 + 0.18 × 1,000 = 525 + 180 = 705 cfm, Voz = 705 / 1.0, and ASHRAE 62.1 prints the same 705", () => {
    const m = model([dining()]);
    const r = new VentilationEngine({ uses: catalog }).space(m.elements, asElementId("sp-dining"));
    if (!r) throw new Error("no result");
    expect(r.occupants).toBe(70);
    expect(r.occupantsBasis).toBe("use_default");
    const imc = r.standards.imc;
    expect(imc.status).toBe("ok");
    if (!imc.rp || !imc.ra) throw new Error("no rates");
    expect(to(imc.rp.value, "cfm/occ")).toBeCloseTo(7.5, 9);
    expect(to(imc.ra.value, "cfm/ft2")).toBeCloseTo(0.18, 9);
    expect(cfm(imc.vbz)).toBeCloseTo(705, 6);
    expect(cfm(imc.voz)).toBeCloseTo(705, 6);
    expect(imc.arithmetic).toBe("Vbz = 7.5 cfm/person × 70 people + 0.18 cfm/ft² × 1,000 ft² = 705 cfm");
    expect(imc.cites.map((c) => c.text)).toEqual(expect.arrayContaining(["IMC 2021 Table 403.3.1.1 (not verified)", "IMC 2021 403.3.1.1.1, Equation 4-1 (not verified)"]));
    expect(cfm(r.standards.ashrae_62_1.voz)).toBeCloseTo(705, 6);
    expect(r.standards.ashrae_62_1.cites.map((c) => c.text)).toContain("ASHRAE 62.1 2019 Table 6-1 (not verified)");
    expect(r.governing.standard).toBe("imc");
    expect(r.inputs).toEqual(expect.arrayContaining(["area 1,000 ft² from the outline", "use Restaurant dining rooms (builtin:space-uses, revision 1)"]));
  });

  it("500 ft² kitchen: 10 people (20 per 1,000 ft²), Vbz = 7.5 × 10 + 0.12 × 500 = 75 + 60 = 135 cfm", () => {
    const r = new VentilationEngine({ uses: catalog }).space(model([kitchen()]).elements, asElementId("sp-kitchen"));
    expect(r?.occupants).toBe(10);
    expect(cfm(r?.standards.imc.voz ?? null)).toBeCloseTo(135, 6);
  });

  it("a space with no use says why under both standards and prints no number, never a zero", () => {
    const m = model([space("sp-x", "103", "Storage", 10, 10)]);
    const r = new VentilationEngine({ uses: catalog }).space(m.elements, asElementId("sp-x"));
    for (const s of [r?.standards.imc, r?.standards.ashrae_62_1]) {
      expect(s?.status).toBe("missing");
      expect(s?.voz).toBeNull();
      expect(s?.reasons.join(" ")).toMatch(/No use set/);
    }
  });

  it("a space typed into a table (not drawn, no occupants) names both missing inputs", () => {
    const m = model([space("sp-t", "104", "Bar", 0, 0, { use: pinned("bar_cocktail"), bounds: { kind: "none" } })]);
    const r = new VentilationEngine({ uses: catalog }).space(m.elements, asElementId("sp-t"));
    expect(r?.standards.imc.status).toBe("missing");
    expect(r?.standards.imc.reasons.join(" ")).toMatch(/no occupants/);
    expect(r?.standards.imc.reasons.join(" ")).toMatch(/isn't drawn yet/);
  });

  it("a public toilet needs no outdoor air by area or person (exhaust is per fixture) and says so", () => {
    const m = model([space("sp-wc", "105", "Toilet", 8, 10, { use: pinned("toilet_public") })]);
    const r = new VentilationEngine({ uses: catalog }).space(m.elements, asElementId("sp-wc"));
    expect(r?.standards.imc.status).toBe("not_required");
    expect(cfm(r?.standards.imc.voz ?? null)).toBe(0);
    expect(r?.standards.imc.reasons[0]).toMatch(/per water closet/);
    expect(r?.standards.imc.exhaust).toBeNull();
    expect(r?.standards.imc.exhaustReason).toMatch(/no area exhaust rate/);
  });

  it("an Ez override of 0.8 with a reason gives Voz = 705 / 0.8 = 881.25 cfm; without a reason it is refused in words", () => {
    const m = model([dining()]);
    const ok = new VentilationEngine({ uses: catalog, overrides: { "sp-dining": { ez: { value: 0.8, reason: "ceiling supply of warm air, ceiling return" } } } }).space(m.elements, asElementId("sp-dining"));
    expect(cfm(ok?.standards.imc.voz ?? null)).toBeCloseTo(881.25, 6);
    expect(ok?.standards.imc.ez.from).toBe("override");
    const bad = new VentilationEngine({ uses: catalog, overrides: { "sp-dining": { ez: { value: 0.8, reason: " " } } } }).space(m.elements, asElementId("sp-dining"));
    expect(bad?.standards.imc.status).toBe("missing");
    expect(bad?.standards.imc.reasons.join(" ")).toMatch(/no reason/);
  });

  it("refuses rates pinned from an older library row instead of quietly using the new ones", () => {
    const row = catalog.get("restaurant_dining") as VentilationUseRow;
    const newer: VentilationUseSource = { libraryId: SPACE_USE_LIBRARY_ID, get: (id) => (id === row.id ? { ...row, revision: 2 } : catalog.get(id)) };
    const r = new VentilationEngine({ uses: newer }).space(model([dining()]).elements, asElementId("sp-dining"));
    expect(r?.standards.imc.status).toBe("missing");
    expect(r?.standards.imc.reasons[0]).toMatch(/changed since this use was set \(pinned revision 1, now 2\)/);
  });
});

describe("governing standard", () => {
  // A firm row where the two standards differ: IMC Rp 7.5, ASHRAE Rp 5, both Ra 0.06.
  const FIRM: VentilationUseRow = {
    id: "firm_lounge",
    revision: 1,
    name: "Lounge (firm)",
    rates: [
      { key: OA_PEOPLE, value: 7.5, unit: "cfm/occ", cite: { code: "IMC", edition: "2021", clause: "Table 403.3.1.1", verified: false } },
      { key: OA_PEOPLE, value: 5, unit: "cfm/occ", cite: { code: "ASHRAE 62.1", edition: "2019", clause: "Table 6-1", verified: false } },
      { key: OA_AREA, value: 0.06, unit: "cfm/ft2", cite: { code: "IMC", edition: "2021", clause: "Table 403.3.1.1", verified: false }, alsoCites: [{ code: "ASHRAE 62.1", edition: "2019", clause: "Table 6-1", verified: false }] },
    ],
  };
  const uses: VentilationUseSource = { libraryId: "firm:uses", get: (id) => (id === FIRM.id ? FIRM : undefined) };
  const lounge = space("sp-l", "201", "Lounge", 40, 25, { use: { libraryId: "firm:uses", useId: FIRM.id, name: FIRM.name, revision: 1 }, occupants: 5 });

  it("marks the adopted code governing and switching flips the marked result: IMC 7.5 × 5 + 0.06 × 1,000 = 97.5 cfm, ASHRAE 5 × 5 + 60 = 85 cfm", () => {
    const m = model([lounge]);
    const engine = new VentilationEngine({ uses, governing: resolveGoverningStandard({ state: "VA" }) });
    const imc = engine.space(m.elements, lounge.id);
    expect(imc?.governing.text).toMatch(/IMC 2021 governs \(Virginia adopted the 2021 IMC as the Virginia Mechanical Code\)/);
    const registry = fieldProviderRegistry();
    const field = registry.field("gen.space", "ventilation.oa_required_cfm");
    expect(withReader(engine, () => field?.read?.(lounge, { elements: m.elements }))).toBeCloseTo(97.5, 6);

    const switched = engine.withGoverning(resolveGoverningStandard({ asked: "ashrae_62_1" }));
    const ashrae = switched.space(m.elements, lounge.id);
    expect(ashrae?.governing.standard).toBe("ashrae_62_1");
    expect(cfm(ashrae?.standards.ashrae_62_1.voz ?? null)).toBeCloseTo(85, 6);
    expect(withReader(switched, () => field?.read?.(lounge, { elements: m.elements }))).toBeCloseTo(85, 6);
    expect(withReader(switched, () => registry.field("gen.space", "ventilation.governing")?.read?.(lounge, { elements: m.elements }))).toBe("ASHRAE 62.1-2019");
    // The switch reuses the kept results: nothing is recomputed.
    expect(switched.evaluations).toBe(engine.evaluations);
  });

  it("takes ASHRAE 62.1 as governing when the project's Code Study names it, IMC by default otherwise, and says which", () => {
    expect(resolveGoverningStandard({ projectAdoption: { codeName: "ASHRAE 62.1", edition: "2019", status: "confirmed" } }).standard).toBe("ashrae_62_1");
    const d = resolveGoverningStandard();
    expect(d).toMatchObject({ standard: "imc", from: "default" });
    expect(d.text).toMatch(/by default: no adopted mechanical code was given/);
  });
});

describe("incremental reads", () => {
  it("editing one space's occupants recomputes only that space; an unrelated edit recomputes nothing", () => {
    const spaces = [dining(), kitchen(), space("sp-3", "103", "Bar", 20, 20, { use: pinned("bar_cocktail") })];
    let m = model([...spaces, zone("z1", "Zone 1", ["sp-dining", "sp-kitchen"])]);
    const engine = new VentilationEngine({ uses: catalog });
    engine.table(m.elements, { kind: "model" });
    expect(engine.evaluations).toBe(3);

    const edited: Space = { ...(m.elements["sp-kitchen"] as Space), occupants: 14, version: 2 };
    m = { ...m, elements: { ...m.elements, [edited.id]: edited } };
    expect(engine.advance(m.elements, [edited.id]).recomputed).toEqual([edited.id]);
    expect(engine.evaluations).toBe(4);
    // 7.5 × 14 + 0.12 × 500 = 105 + 60 = 165 cfm.
    expect(cfm(engine.space(m.elements, edited.id)?.standards.imc.voz ?? null)).toBeCloseTo(165, 6);
    engine.table(m.elements, { kind: "model" });
    expect(engine.evaluations).toBe(4);

    const renamed: Zone = { ...(m.elements.z1 as Zone), name: "Zone 1 Front", version: 2 };
    m = { ...m, elements: { ...m.elements, z1: renamed } };
    expect(engine.advance(m.elements, [renamed.id]).recomputed).toEqual([]);
    engine.table(m.elements, { kind: "model" });
    expect(engine.evaluations).toBe(4);
  });
});

describe("zones and serving units", () => {
  it("sums its spaces (705 + 135 = 840 cfm), compares RTU-1's outdoor air and says when it is short", () => {
    const short = model([dining(), kitchen(), zone("z1", "Zone 1", ["sp-dining", "sp-kitchen"], "rtu-1"), rtu("rtu-1", "RTU-1", 800)]);
    const engine = new VentilationEngine({ uses: catalog });
    const z = engine.zone(short.elements, asElementId("z1"));
    expect(cfm(z?.standards.imc.voz ?? null)).toBeCloseTo(840, 6);
    expect(z?.servedBy).toMatchObject({ mark: "RTU-1", comparison: "short", zoneCount: 1 });
    expect(z?.systemNote).toMatch(/single-zone system, Vot = Voz/);
    const enough = model([dining(), kitchen(), zone("z1", "Zone 1", ["sp-dining", "sp-kitchen"], "rtu-1"), rtu("rtu-1", "RTU-1", 900)]);
    expect(engine.zone(enough.elements, asElementId("z1"))?.servedBy?.comparison).toBe("meets");
  });

  it("a unit serving two zones says multi-zone system efficiency is not calculated yet", () => {
    const m = model([dining(), kitchen(), zone("z1", "Dining", ["sp-dining"], "rtu-1"), zone("z2", "Kitchen", ["sp-kitchen"], "rtu-1"), rtu("rtu-1", "RTU-1", 900)]);
    const z = new VentilationEngine({ uses: catalog }).zone(m.elements, asElementId("z2"));
    expect(z?.systemNote).toMatch(/serves 2 zones: multi-zone system efficiency \(Ev, IMC 2021 403\.3\.1\.1\.2\.3\.3\) not calculated yet/);
    // 900 cfm against the uncorrected 705 + 135.
    expect(z?.servedBy?.comparison).toBe("meets");
  });

  it("a zone with a space that can't be calculated has no total and names the space", () => {
    const m = model([dining(), space("sp-x", "103", "Storage", 10, 10), zone("z1", "Zone 1", ["sp-dining", "sp-x"])]);
    const z = new VentilationEngine({ uses: catalog }).zone(m.elements, asElementId("z1"));
    expect(z?.standards.imc.voz).toBeNull();
    expect(z?.standards.imc.missing.map((x) => x.label)).toEqual(["103 Storage"]);
  });
});

describe("the live table and blocks", () => {
  it("renders a table block whose text, unresolved list and dependencies follow the model", () => {
    const m = model([dining(), kitchen(), space("sp-x", "103", "Storage", 10, 10), zone("z1", "Zone 1", ["sp-dining", "sp-kitchen"], "rtu-1"), rtu("rtu-1", "RTU-1", 900)]);
    withReader(new VentilationEngine({ uses: catalog }), () => {
      const r = renderVentilationTable(m, { kind: "ventilation", scope: { kind: "level", levelId: L1 } });
      const lines = r.text.split("\n");
      expect(lines[0]).toMatch(/IMC 2021 governs by default/);
      expect(lines).toContain("101 Dining | Restaurant dining rooms | 1,000 ft² | 70 | Rp 7.5 | Ra 0.18 | Vbz 705 | Ez 1 | Voz 705 | Exh — | IMC 705 / 62.1 705");
      expect(lines.find((l) => l.startsWith("103 Storage"))).toMatch(/can't calculate \(IMC 2021\): No use set/);
      expect(lines.find((l) => l.startsWith("Zone 1"))).toMatch(/Σ Voz 840 cfm .*RTU-1 outdoor air 900 cfm, enough/);
      expect(r.unresolved).toEqual(["103 Storage"]);
      expect(r.dependsOn).toEqual(["L1", "rtu-1", "sp-dining", "sp-kitchen", "sp-x", "type-rtu", "z1"]);
      // Deterministic: the same elements give the same bytes.
      expect(renderVentilationTable(m, { kind: "ventilation", scope: { kind: "level", levelId: L1 } })).toEqual(r);
    });
  });

  it("prints one zone's summary through an ordinary field block once the provider is in the registry", () => {
    const m = model([dining(), kitchen(), zone("z1", "Zone 1", ["sp-dining", "sp-kitchen"], "rtu-1"), rtu("rtu-1", "RTU-1", 800)]);
    withReader(new VentilationEngine({ uses: catalog }), () => {
      const registry = fieldProviderRegistry();
      const r = renderFieldBlock(m, { template: ZONE_VENTILATION_TEMPLATE, subjectId: asElementId("z1") }, { registry });
      expect(r.text.split("\n").slice(0, 3)).toEqual(["Zone 1: outdoor air 840 cfm (IMC 2021 governs)", "IMC 840 cfm · ASHRAE 62.1 840 cfm · exhaust — cfm", "RTU-1: outdoor air 800 cfm"]);
      expect(r.unresolved).toEqual([]);
    });
  });

  it("with no pack loaded every field reads empty and the basis says why", () => {
    const m = model([dining()]);
    const registry = fieldProviderRegistry();
    const el = m.elements["sp-dining"] as Space;
    expect(registry.field("gen.space", "ventilation.oa_required_cfm")?.read?.(el, { elements: m.elements })).toBeNull();
    expect(registry.field("gen.space", "ventilation.basis")?.read?.(el, { elements: m.elements })).toMatch(/isn't loaded/);
  });
});

describe("the calc plugin", () => {
  it("runs by id with the run envelope: totals per standard, the steps' arithmetic and a stable run key", () => {
    const m = model([dining(), kitchen()]);
    withReader(new VentilationEngine({ uses: catalog }), () => {
      const registry = new CalcRegistry().register(ventilationOutdoorAirCalc);
      const a = registry.run({ calc: "mech.ventilation_outdoor_air", inputs: { scope: "model" }, model: m });
      if (!a.ok) throw new Error(a.reason);
      expect(a.run.values.find((v) => v.key === "imc_oa_cfm")?.value).toBe(840);
      expect(a.run.values.find((v) => v.key === "governing")?.value).toBe("IMC 2021");
      expect(a.run.steps.map((s) => s.detail)).toContain("Vbz = 7.5 cfm/person × 70 people + 0.18 cfm/ft² × 1,000 ft² = 705 cfm");
      const b = registry.run({ calc: "mech.ventilation_outdoor_air", inputs: { scope: "model" }, model: m });
      expect(b.ok && b.run.runKey).toBe(a.run.runKey);
    });
  });

  it("says the pack isn't loaded rather than returning zeros", () => {
    const registry = new CalcRegistry().register(ventilationOutdoorAirCalc);
    const r = registry.run({ calc: "mech.ventilation_outdoor_air", inputs: { scope: "model" }, model: model([dining()]) });
    expect(r.ok && r.run.issues[0]?.message).toMatch(/isn't loaded/);
    expect(r.ok && r.run.values).toEqual([]);
  });
});

