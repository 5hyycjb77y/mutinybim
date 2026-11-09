/**
 * @jest-environment node
 *
 * The plugin envelope: edition resolution (given, from the jurisdiction, or a
 * plain refusal rather than a guessed default), input validation in words,
 * determinism, and every listed calc's example actually running.
 */
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import { PERMITZIP_DESIGN_CRITERIA, builtinCalcRegistry, canonicalJson, fingerprint } from "../src";

// The trade calcs are the first-party add-ons' rows since round 6, as in every host.
installFirstPartyAddOns();
const registry = builtinCalcRegistry();
const FEEDER = { circuit: "feeder", system: "3ph_4w", voltage_v: 480, continuous_load_a: 100, length_ft: 250 };

describe("which NEC edition", () => {
  it("refuses to guess when neither the edition nor the state is given", () => {
    const r = registry.run({ calc: "nec.size_circuit", inputs: FEEDER });
    expect(r).toEqual({ ok: false, reason: "Say which NEC edition the project is under (2020 or 2023), or give its state so the adopted edition is used. (Recording the electrical code in the project's Code Study makes this automatic.)" });
  });

  it("uses the project's own adopted electrical code from Code Study before the state", () => {
    const r = registry.run({ calc: "nec.size_circuit", inputs: FEEDER, state: "VA", projectAdoption: { codeName: "DC Electrical Code", edition: "2023 NEC", status: "unconfirmed" } });
    if (!r.ok) throw new Error(r.reason);
    expect(r.run.code?.edition).toBe("2023");
    expect(r.run.steps[0]?.detail).toBe("The project's Code Study lists DC Electrical Code 2023 NEC (not yet confirmed)");
  });

  it("a project under an edition the pack doesn't cover is refused, not silently run under another", () => {
    const r = registry.run({ calc: "nec.size_circuit", inputs: FEEDER, projectAdoption: { codeName: "NEC", edition: "2017", status: "confirmed" } });
    expect(!r.ok && r.reason).toMatch(/^This project's electrical code is NEC 2017 \(NEC 2017\); the NEC pack covers 2020 and 2023/);
  });

  it("uses the adopted edition for a state on file, and says where that came from", () => {
    const r = registry.run({ calc: "nec.size_circuit", inputs: FEEDER, state: "va" });
    if (!r.ok) throw new Error(r.reason);
    expect(r.run.code).toEqual({ family: "nec", edition: "2020", packVersion: expect.any(String) });
    expect(r.run.steps[0]?.detail).toBe("Virginia adopted NEC 2020 (NEC as amended by Virginia)");
    expect(r.run.citations[0]?.text).toMatch(/^Virginia Electrical Code: NEC 2020, effective 2024-01-18 \(PermitZIP Code Map jurisdiction-codes\.json/);
  });

  it("an explicit edition wins over the state; an unknown state is refused", () => {
    const r = registry.run({ calc: "nec.size_circuit", inputs: FEEDER, state: "VA", necEdition: "2023" });
    expect(r.ok && r.run.code?.edition).toBe("2023");
    const unknown = registry.run({ calc: "nec.size_circuit", inputs: FEEDER, state: "TX" });
    expect(unknown.ok).toBe(false);
    expect(!unknown.ok && unknown.reason).toMatch(/^No NEC adoption is on file for TX \(on file: VA, MD, DC\)/);
  });

  it("method-based calcs need no edition", () => {
    expect(registry.run({ calc: "mech.duct_friction", inputs: { cfm: 400, diameter_in: 10 } }).ok).toBe(true);
  });
});

describe("inputs", () => {
  it("names the bad field in words", () => {
    const r = registry.run({ calc: "nec.voltage_drop", inputs: { size: "13", system: "1ph_2w", voltage_v: 277, load_a: 16, length_ft: 300 }, necEdition: "2023" });
    expect(!r.ok && r.reason).toMatch(/^The inputs for Voltage drop \(NEC Chapter 9 Table 9\) aren't valid: size: "13" isn't a conductor size/);
  });

  it("an unknown calc lists what exists", () => {
    const r = registry.run({ calc: "nec.arc_flash", inputs: {} });
    expect(!r.ok && r.reason).toMatch(/^No calc "nec\.arc_flash"\. Available: mech\.duct_friction/);
  });

  it("model calcs refuse without a model", () => {
    const r = registry.run({ calc: "mech.duct_system_pressure", inputs: { system_id: "s" } });
    expect(!r.ok && r.reason).toBe("Duct system static pressure (fan ESP) reads a model; give the model to run it against.");
  });
});

describe("determinism and versioning", () => {
  it("the same request gives the same bytes and runKey; inputs in a different key order are the same request", () => {
    const a = registry.run({ calc: "nec.size_circuit", inputs: FEEDER, necEdition: "2020" });
    const b = registry.run({ calc: "nec.size_circuit", inputs: Object.fromEntries(Object.entries(FEEDER).reverse()), necEdition: "2020" });
    if (!a.ok || !b.ok) throw new Error("run failed");
    expect(canonicalJson(b.run)).toBe(canonicalJson(a.run));
    expect(a.run.runKey).toMatch(/^[0-9a-f]{16}$/);
  });

  it("the runKey changes with the inputs, the edition, or the design criteria", () => {
    const key = (o: Parameters<typeof registry.run>[0]) => {
      const r = registry.run(o);
      if (!r.ok) throw new Error(r.reason);
      return r.run.runKey;
    };
    const base = key({ calc: "nec.size_circuit", inputs: FEEDER, necEdition: "2020" });
    expect(key({ calc: "nec.size_circuit", inputs: { ...FEEDER, length_ft: 251 }, necEdition: "2020" })).not.toBe(base);
    expect(key({ calc: "nec.size_circuit", inputs: FEEDER, necEdition: "2023" })).not.toBe(base);
    const strict = { id: "p", version: "1", title: "Project", electrical: { branchVoltageDropPct: 2, feederVoltageDropPct: 2, combinedVoltageDropPct: 4, powerFactor: 0.9, ambientC: 30 } };
    expect(key({ calc: "nec.size_circuit", inputs: FEEDER, necEdition: "2020", criteria: strict })).not.toBe(base);
  });

  it("fingerprint is stable across key order", () => {
    expect(fingerprint({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(fingerprint({ b: [1, { d: 3, c: 2 }], a: 1 }));
  });
});

describe("the catalogue", () => {
  const list = registry.list();

  it("lists electrical, mechanical and plumbing calcs with a version, a JSON schema and an example", () => {
    expect(list.map((c) => c.id)).toEqual([
      "mech.duct_friction",
      "mech.duct_system_pressure",
      "mech.makeup_air_heat",
      "mech.pressurization",
      "mech.ventilation_outdoor_air",
      "nec.conductor_ampacity",
      "nec.conduit_fill",
      "nec.demand_load",
      "nec.egc",
      "nec.motor_circuit",
      "nec.service_size",
      "nec.size_circuit",
      "nec.voltage_drop",
      "plumbing.building_sewer",
      "plumbing.gas_system",
      "plumbing.grease_interceptor",
      "plumbing.hunter_demand",
      "plumbing.pipe_system",
      "plumbing.pressure_report",
      "plumbing.sewage_pump",
      "plumbing.size_drain",
      "plumbing.size_gas",
      "plumbing.size_system",
      "plumbing.size_water",
      "plumbing.water_friction",
      "plumbing.water_heater",
      "plumbing.water_meter",
      // Round 14: Structural is first-party.
      "struct.simple_beam",
    ]);
    for (const c of list) {
      // The version is fingerprinted into every runKey. Simple beam shipped (as a Preview add-on) as "1";
      // renaming it "1.0.0" would rekey every run anyone recorded, so that one calc keeps its version.
      // Its next method change takes "2.0.0" (a new key either way). Every other calc, and any new one, is semver.
      if (c.id === "struct.simple_beam") expect(c.version).toBe("1");
      else expect(c.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(c.inputSchema).toEqual(expect.objectContaining({ type: "object" }));
    }
  });

  it("simple beam keeps version \"1\", so a run recorded while Structural was Preview keeps its runKey (round 14)", () => {
    const info = registry.get("struct.simple_beam")?.info;
    const r = registry.run({ calc: "struct.simple_beam", inputs: info?.example });
    if (!r.ok) throw new Error(r.reason);
    const key = (version: string) => fingerprint({ calc: "struct.simple_beam", version, code: null, criteria: [r.run.criteria.id, r.run.criteria.version, PERMITZIP_DESIGN_CRITERIA.electrical], inputs: r.run.inputs, model: null });
    expect(r.run.calc.version).toBe("1");
    expect(r.run.runKey).toBe(key("1"));
    expect(r.run.runKey).not.toBe(key("1.0.0"));
  });

  it.each(list.filter((c) => !c.needsModel).map((c) => [c.id] as const))("%s: its own example runs, with no errors, and every value cites its basis", (id) => {
    const r = registry.run({ calc: id, inputs: registry.get(id)?.info.example, necEdition: "2023", state: "VA" });
    if (!r.ok) throw new Error(r.reason);
    expect(r.run.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(r.run.values.length).toBeGreaterThan(0);
    for (const v of r.run.values) expect([v.key, v.cite.length > 0]).toEqual([v.key, true]);
  });
});
