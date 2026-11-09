/**
 * @jest-environment node
 *
 * The mutinybim-library v1 format (SCHEDULES-PLAN §3a): round trip, layering
 * and pinning, plain-words refusals (cycles, failing examples, bad hashes) that
 * refuse the whole bundle, and library classes and fields reaching the registry.
 */
import { builtinRegistry } from "@permitzip/bim-kernel";
import {
  AEC_LIBRARY,
  bundleItems,
  checkPin,
  displayProfileOf,
  contentHashOf,
  loadBundle,
  makeItem,
  pinItem,
  pinUpdates,
  pinsAsLayer,
  resolveLayers,
  sha256Hex,
  updatePins,
  type CalculationItem,
  type LibraryBundleInput,
  type LibraryEnvironment,
  type LibraryItem,
  type SharedFieldItem,
} from "../src";
import { bimFormulaEngine, bimUnitsCatalog } from "../src/bim-formula";

const env: LibraryEnvironment = { formula: bimFormulaEngine, units: bimUnitsCatalog };

function loadOk(input: unknown, e: LibraryEnvironment = env) {
  const r = loadBundle(input, e);
  if (!r.ok) throw new Error(r.problems.map((p) => p.message).join("\n"));
  return r;
}

const gasDemand: CalculationItem = {
  id: "0c9a3a52-8f2e-4d1e-9a41-6f0f2b1f0001",
  revision: 1,
  key: "PZ.GasDemand",
  name: "Gas demand at 80% diversity",
  expression: "mbh * 0.8",
  params: [{ name: "mbh", type: { valueType: "quantity", kind: "flow_gas_energy", unit: "MBH" } }],
  result: { valueType: "quantity", kind: "flow_gas_energy", unit: "MBH" },
  appliesTo: ["mep.water_heater"],
  examples: [
    { inputs: { mbh: { value: 199, unit: "MBH" } }, expected: { value: 159.2, unit: "MBH" } },
    { inputs: { mbh: { value: 199, unit: "MBH" } }, expected: { value: 159_200, unit: "Btu/h" } },
  ],
};

function firmBundle(extra: Partial<LibraryBundleInput> = {}): LibraryBundleInput {
  return {
    format: "mutinybim-library",
    version: 1,
    id: "permitzip-firm",
    name: "PermitZIP",
    publisher: "PermitZIP",
    revision: 3,
    classes: [],
    fields: [
      {
        id: "0c9a3a52-8f2e-4d1e-9a41-6f0f2b1f0002",
        revision: 1,
        key: "seismic_restraint_required",
        label: "Seismic restraint required",
        appliesTo: ["mep.equipment"],
        valueType: "boolean",
        editable: true,
        storage: { kind: "parameter", scope: "instance", name: "seismic_restraint_required" },
      },
    ],
    formulas: [gasDemand],
    ...extra,
  };
}

describe("mutinybim-library v1", () => {
  it("loads the built-in AEC library, classes and fields for every discipline", () => {
    const { registry, items } = loadOk(AEC_LIBRARY);
    expect(items.every((i) => i.body.contentHash === contentHashOf(i))).toBe(true);
    for (const id of ["mep.water_heater", "fp.sprinkler_head", "struct.footing", "civil.structure", "gc.takeoff_item"]) expect(registry.getClass(id)).toBeDefined();
    expect(registry.fieldsFor("arch.door").map((f) => f.path)).toEqual(expect.arrayContaining(["arch.fire_rating", "hardware_set"]));
    expect(registry.field("fp.sprinkler_head", "k_factor")).toMatchObject({ valueType: "quantity", kind: "k_factor", writer: { kind: "parameter", scope: "instance", name: "k_factor" } });
  });

  it("round-trips a bundle: export, reload, the same items and hashes", () => {
    const first = loadOk(JSON.stringify(firmBundle(), null, 2), { ...env, registry: loadOk(AEC_LIBRARY).registry });
    const text = JSON.stringify(first.bundle);
    const second = loadOk(text, { ...env, registry: loadOk(AEC_LIBRARY).registry });
    expect(second.bundle).toEqual(first.bundle);
    expect(second.items.map((i) => i.body.contentHash)).toEqual(first.items.map((i) => i.body.contentHash));
    expect(bundleItems(second.bundle)).toHaveLength(2);
  });

  it("adds a firm's class with its own fields: fp.sprinkler_head with K-factor and temperature rating", () => {
    const base = builtinRegistry();
    expect(base.getClass("fp.sprinkler_head")).toBeUndefined();
    const { registry } = loadOk(
      firmBundle({
        formulas: [],
        fields: [
          { id: "f-k", revision: 1, key: "k_factor", label: "K-factor", appliesTo: ["fp.sprinkler_head"], valueType: "quantity", kind: "k_factor", unit: "gpm/psi^0.5", editable: true, storage: { kind: "parameter", scope: "type", name: "k_factor" } },
          { id: "f-t", revision: 1, key: "temperature_rating", label: "Temperature rating", appliesTo: ["fp.sprinkler_head"], valueType: "quantity", kind: "temperature", unit: "degF", editable: true, storage: { kind: "parameter", scope: "type", name: "temperature_rating" } },
        ],
        classes: [{ id: "c-sprk", revision: 1, key: "fp.sprinkler_head", label: "Sprinkler heads", discipline: "fire_protection", ifc: { entity: "IfcFireSuppressionTerminal", predefinedType: "SPRINKLER" } }],
      }),
      { ...env, registry: base },
    );
    expect(registry.listClasses().map((c) => c.id)).toContain("fp.sprinkler_head");
    expect(registry.listClasses({ discipline: "fire_protection" }).map((c) => c.id)).toEqual(["fp.sprinkler_head"]);
    expect(registry.fieldsFor("fp.sprinkler_head").map((f) => [f.path, f.kind, f.unit])).toEqual([
      ["k_factor", "k_factor", "gpm/psi^0.5"],
      ["temperature_rating", "temperature", "degF"],
    ]);
    expect(registry.field("fp.sprinkler_head", "k_factor")?.source).toBe("library:f-k@1");
  });

  it("gives mep.water_heater the fields a firm puts on mep.equipment", () => {
    const aec = loadOk(AEC_LIBRARY);
    const { registry } = loadOk(firmBundle(), { ...env, registry: aec.registry });
    expect(registry.isA("mep.water_heater", "mep.equipment")).toBe(true);
    expect(registry.fieldsFor("mep.water_heater").map((f) => f.path)).toContain("seismic_restraint_required");
    expect(registry.fieldsFor("mep.electrical_equipment").map((f) => f.path)).toContain("seismic_restraint_required");
    expect(registry.fieldsFor("mep.plumbing_fixture").map((f) => f.path)).not.toContain("seismic_restraint_required");
  });

  it("refuses a cycle between two calculations, naming both", () => {
    const a = { ...gasDemand, id: "calc-a", key: "PZ.Alpha", name: "Alpha", expression: "PZ.Beta(mbh) * 1", examples: [] };
    const b = { ...gasDemand, id: "calc-b", key: "PZ.Beta", name: "Beta", expression: "PZ.Alpha(mbh) * 1", examples: [] };
    const r = loadBundle(firmBundle({ formulas: [a, b] }), { ...env, registry: loadOk(AEC_LIBRARY).registry });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]?.message).toMatch(/Calculations PZ\.(Alpha|Beta) and PZ\.(Alpha|Beta) use each other in a circle/);
    expect(r.problems[0]?.message).toContain("PZ.Alpha");
    expect(r.problems[0]?.message).toContain("PZ.Beta");
  });

  it("refuses the whole bundle when one example fails, and says which", () => {
    const wrong: CalculationItem = { ...gasDemand, examples: [...(gasDemand.examples ?? []).slice(0, 1), { inputs: { mbh: { value: 100, unit: "MBH" } }, expected: { value: 100, unit: "MBH" } }] };
    const text = JSON.stringify(firmBundle({ formulas: [wrong] }), null, 2);
    const r = loadBundle(text, { ...env, registry: loadOk(AEC_LIBRARY).registry });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems).toEqual([
      expect.objectContaining({
        itemKey: "PZ.GasDemand",
        message: "Calculation PZ.GasDemand: Example 2 expected 100 MBH but got 80 MBH.",
        line: text.split("\n").findIndex((l) => l.includes(`"id": "${gasDemand.id}"`)) + 1,
      }),
    ]);
    expect("registry" in r).toBe(false);
  });

  it("refuses a unit that doesn't measure its kind, a result of the wrong kind, and a stale hash", () => {
    const body: SharedFieldItem = { id: "f-x", revision: 1, key: "x", label: "X", appliesTo: ["gen.generic_model"], valueType: "text", editable: true, storage: { kind: "provided" } };
    const stale = { ...body, contentHash: `sha256:${"0".repeat(64)}` };
    const r = loadBundle(
      firmBundle({
        fields: [stale, { id: "f-p", revision: 1, key: "pressure_drop", label: "Pressure drop", appliesTo: ["gen.generic_model"], valueType: "quantity", kind: "pressure", unit: "ft", editable: false, storage: { kind: "provided" } }],
        formulas: [{ ...gasDemand, result: { valueType: "quantity", kind: "length", unit: "ft" }, examples: [] }],
      }),
      { ...env, registry: loadOk(AEC_LIBRARY).registry },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const messages = r.problems.map((p) => p.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        "Shared field x: its contentHash doesn't match its content. Remove the hash or publish the item again.",
        'Shared field pressure_drop: It is a pressure, and "ft" is not a pressure unit.',
        'Calculation PZ.GasDemand: PZ.GasDemand works out to a gas input (MBH) but says it returns a length (ft) (characters 1–9 of "mbh * 0.8").',
      ]),
    );
  });

  it("carries a firm's display profile in the units library's shape, refusing a unit its kind can't use", () => {
    const profile = {
      id: "profile-pz",
      revision: 1,
      key: "permitzip.us",
      name: "PermitZIP US",
      kinds: { length: { unit: "ft", precision: { kind: "fraction", denominator: 16 }, format: "feet_inches" }, flow_gas_energy: { unit: "MBH", precision: { kind: "decimals", digits: 0 }, label: "heading" } },
      label: "suffix",
      thousands: ",",
      decimal: ".",
    } as const;
    const ok = loadOk(firmBundle({ formulas: [], fields: [], units: [profile] }));
    const item = ok.items[0];
    expect(item?.type === "unit_profile" ? displayProfileOf(item.body) : null).toEqual({
      id: "permitzip.us",
      name: "PermitZIP US",
      kinds: profile.kinds,
      label: "suffix",
      thousands: ",",
      decimal: ".",
    });
    const bad = loadBundle(firmBundle({ formulas: [], fields: [], units: [{ ...profile, kinds: { length: { unit: "psi", precision: { kind: "decimals", digits: 2 } } } }] }), env);
    expect(bad.ok ? [] : bad.problems.map((p) => p.message)).toEqual(['Display profile permitzip.us: Its length entry is a length, and "psi" is not a length unit.']);
  });

  it("names the item and the field when the schema refuses one", () => {
    const text = JSON.stringify(firmBundle({ formulas: [{ ...gasDemand, key: "not a key" }] }), null, 2);
    const r = loadBundle(text, env);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems[0]).toMatchObject({ itemId: gasDemand.id, itemType: "formula", message: expect.stringContaining('Calculation not a key "key": a name such as PZ.GasDemandBtuh') });
    expect(r.problems[0]?.line).toBeGreaterThan(1);
  });
});

describe("layering and pinning", () => {
  const fieldBody = (revision: number, label: string): SharedFieldItem => ({
    id: "shared-1",
    revision,
    key: "seismic_zone",
    label,
    appliesTo: ["gen.generic_model"],
    valueType: "text",
    editable: true,
    storage: { kind: "parameter", scope: "instance", name: "seismic_zone" },
  });
  const field = (revision: number, label: string): LibraryItem => makeItem("field", fieldBody(revision, label));

  it("keeps the model's pinned copy over a newer firm revision, and offers the update", () => {
    const pinned = pinItem({ ...field(2, "Seismic zone"), scope: "firm:permitzip" });
    const firmNow = field(3, "Seismic design category");
    const resolved = resolveLayers([
      { kind: "builtin", scope: "builtin", items: [] },
      { kind: "firm", scope: "firm:permitzip", items: [firmNow] },
      pinsAsLayer([pinned]),
    ]);
    const winner = resolved.byId("shared-1");
    expect(winner?.layer).toBe("model");
    expect(winner?.item.body.revision).toBe(2);
    expect(winner?.shadows).toEqual([{ scope: "firm:permitzip", id: "shared-1", revision: 3 }]);
    expect(resolved.byKey("field", "seismic_zone")?.item.body).toMatchObject({ label: "Seismic zone" });

    const summary = { id: "shared-1", type: "field" as const, key: "seismic_zone", name: "Seismic design category", revision: 3, contentHash: contentHashOf(firmNow), scope: "firm:permitzip", deprecated: false };
    expect(pinUpdates([pinned], [summary])).toEqual([{ pin: pinned, latest: summary }]);
    const updated = updatePins([pinned], [{ ...firmNow, scope: "firm:permitzip" }]);
    expect(updated[0]?.revision).toBe(3);
    expect(pinUpdates(updated, [summary])).toEqual([]);
  });

  it("lets a project's item override the firm's under the same key, and notices a tampered pin", () => {
    const firm = field(1, "Firm");
    const project = makeItem("field", { ...fieldBody(1, "Project"), id: "shared-project" });
    const resolved = resolveLayers([
      { kind: "firm", scope: "firm", items: [firm] },
      { kind: "project", scope: "project:7301", items: [project] },
    ]);
    expect(resolved.byKey("field", "seismic_zone")?.item.body.id).toBe("shared-project");
    expect(resolved.items).toHaveLength(1);

    const pin = pinItem({ ...firm, scope: "firm" });
    expect(checkPin(pin)).toBeNull();
    const tampered = { ...pin, item: field(1, "Edited in place") };
    expect(checkPin(tampered)?.message).toContain("was changed after it was pinned");
  });

  it("hashes with SHA-256", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("a".repeat(1000))).toBe("41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3");
  });
});
