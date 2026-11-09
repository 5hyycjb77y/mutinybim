/**
 * @jest-environment node
 *
 * Round 5b f-equipment: a library field kept as a part parameter reads from
 * the part, so a column or agent read named by its key (`param.mca`,
 * `param.hood_id`) shows the value instead of an empty column.
 *
 * Fails on the round-5a code: `fieldDefOf` gave such fields no reader, so
 * the row engine read `param.mca` as nothing.
 */
import { DEFAULT_SETTINGS, executeCommand, fieldProviderRegistry, type Command, type ModelState, type PartTypeDefinition, type ScheduleDefinitionV2 } from "@permitzip/bim-kernel";
import { buildRowSet } from "@permitzip/bim-kernel/schedules";
import { extendRegistry, fieldDefOf, parameterAliases, parameterRead } from "../apply";
import { baselineParameterFields } from "../builtin/parameter-sets";
import { makeItem, type SharedFieldItem } from "../schema";

const HOOD_ID: SharedFieldItem = { id: "firm:field:hood_id", revision: 1, key: "param.hood_id", label: "Hood ID", appliesTo: ["mep.equipment", "mep.plumbing_fixture"], valueType: "text", group: "Kitchen", editable: true, storage: { kind: "parameter", scope: "instance", name: "hood_id" } };

const RTU: PartTypeDefinition = {
  familyName: "Rooftop unit",
  typeName: "RTU",
  category: "mechanical_equipment",
  typeParams: [{ name: "weight", label: "Operating weight", kind: "number", unit: "lb", min: 0 }],
  typeValues: { weight: 640 },
  instanceParams: [
    { name: "mca", label: "MCA", kind: "number", unit: "a", min: 0 },
    { name: "hood_id", label: "Hood ID", kind: "text" },
  ],
  connectors: [],
  geometry: [{ kind: "box", center: [0, 0, 450], size: [600, 600, 900] }],
  symbol: [{ kind: "rect", center: [0, 0], size: [600, 600] }],
  tagFields: ["mark"],
  source: { kind: "builtin", libraryVersion: "test@1" },
};

function model(): ModelState {
  let m: ModelState = { modelId: "r5e", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  const run = (c: Command) => {
    const r = executeCommand(m, c);
    if (!r.ok) throw new Error(r.error.message);
    m = r.model;
  };
  run({ type: "create_level", levelId: "lvl", name: "Level 1", elevationMm: 0 });
  run({ type: "plan_part", partId: "rtu-1", typeId: "type:rtu", partType: RTU, mark: "RTU-1", values: { mca: 52, hood_id: "H-1" } });
  run({ type: "plan_part", partId: "rtu-2", typeId: "type:rtu", mark: "RTU-2", values: {} });
  return m;
}

describe("r5e library fields kept as part parameters read from the part", () => {
  it("instance, type and missing values, in the field's unit", () => {
    const m = model();
    const mca = baselineParameterFields().find((f) => f.key === "elec.mca");
    const weight = baselineParameterFields().find((f) => f.key === "struct.operating_weight");
    if (!mca || !weight) throw new Error("baseline fields missing");
    const rtu1 = m.elements["rtu-1"];
    const rtu2 = m.elements["rtu-2"];
    if (!rtu1 || !rtu2) throw new Error("parts missing");
    expect(parameterRead(mca)?.(rtu1, { elements: m.elements })).toBe(52);
    expect(parameterRead(mca)?.(rtu2, { elements: m.elements })).toBeNull();
    expect(parameterRead(weight)?.(rtu2, { elements: m.elements })).toBe(640);
    expect(parameterRead(HOOD_ID)?.(rtu1, { elements: m.elements })).toBe("H-1");
    expect(parameterRead({ ...HOOD_ID, storage: { kind: "provided" } })).toBeUndefined();
    expect(fieldDefOf(HOOD_ID, "library:firm:field:hood_id@1").read).toBeDefined();
  });

  it("a schedule column named by the library key reads the value (round 5a: empty)", () => {
    const m = model();
    const layered = extendRegistry(fieldProviderRegistry(), [makeItem("field", HOOD_ID), ...baselineParameterFields().map((f) => makeItem("field", f))]);
    if (!layered.ok) throw new Error(layered.problems.map((p) => p.message).join("; "));
    const def: ScheduleDefinitionV2 = {
      name: "Keys",
      source: { kind: "classes", classes: ["mep.mechanical_equipment"], includeSubclasses: true },
      columns: [
        { id: "mark", kind: "field", path: "mark" },
        { id: "hood", kind: "field", path: "param.hood_id" },
        // The namespaced key and the 5a spelling a stored firm template may hold: both read the same value.
        { id: "elec_mca", kind: "field", path: "elec.mca" },
        { id: "mca", kind: "field", path: "param.mca" },
        { id: "bare_mca", kind: "parameter", path: "mca" },
      ],
      filters: [],
      sort: [{ path: "mark", direction: "asc" }],
      groups: [],
      grandTotals: false,
      itemize: true,
      presentation: { kind: "list" },
      display: { textSizeMm: 2.5, emptyText: "NONE" },
    };
    const rs = buildRowSet(m, def, { viewId: "v", revision: m.revision, registry: layered.registry });
    const hood = rs.values.get("hood");
    expect(hood?.type === "text" ? [...hood.values] : null).toEqual(["H-1", null]);
    for (const id of ["elec_mca", "mca", "bare_mca"]) {
      const amps = rs.values.get(id);
      expect({ id, values: amps?.type === "quantity" ? Array.from(amps.values, (v) => (Number.isNaN(v) ? null : v)) : null }).toEqual({ id, values: [52, null] });
    }
  });

  it("D2: baseline keys are namespaced with their param.<name> alias; a firm field keyed param.* has no alias to add", () => {
    const mca = baselineParameterFields().find((f) => f.key === "elec.mca");
    if (!mca) throw new Error("no elec.mca");
    expect(parameterAliases(mca)).toEqual(["param.mca"]);
    expect(fieldDefOf(mca, "builtin").aliases).toEqual(["param.mca"]);
    expect(parameterAliases(HOOD_ID)).toEqual([]);
    const layered = extendRegistry(fieldProviderRegistry(), baselineParameterFields().map((f) => makeItem("field", f)));
    if (!layered.ok) throw new Error("not layered");
    expect(layered.registry.field("mep.mechanical_equipment", "param.mca")?.key).toBe("elec.mca");
    expect(layered.registry.field("mep.mechanical_equipment", "param.weight")?.key).toBe("struct.operating_weight");
  });
});
