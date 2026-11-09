/**
 * @jest-environment node
 *
 * Round 5b f-equipment: the baseline parameter sets are loaded into the
 * built-in library, and the equipment list is a built-in schedule template
 * whose columns are parameters in one group per facet. Today's thirteen
 * columns are the default columns (same ids, headings, order); a firm field
 * lands in the group its own group names.
 *
 * Fails on the round-5a code: the built-in library had no baseline fields,
 * no schedule templates, and there was no `equipmentListDefinition`.
 */
import { BUILTIN_FACET_REGISTRY, fieldProviderRegistry, withFacetRows, type ScheduleDefinitionV2 } from "@permitzip/bim-kernel";
import { validateScheduleDefinition } from "@permitzip/bim-kernel/schedules";
import { bimFormulaEngine, bimUnitsCatalog } from "../bim-formula";
import { AEC_LIBRARY, BASELINE_PARAMETER_SETS, builtinLibrarySource, EQUIPMENT_DEFAULT_COLUMNS, EQUIPMENT_DRAFT_FIELDS, EQUIPMENT_DRAFT_PARAMETERS, EQUIPMENT_LIST_TEMPLATE, baselineEquipmentFields, columnGroupLabel, equipmentListColumnGroups, equipmentListColumns, equipmentListDefinition, readColumnGroups, withEquipmentColumn } from "../builtin/aec";
import { builtinMepLibrarySource } from "../builtin/mep";
import { FileLibraryProvider } from "../file-provider";

/** The Equipment list's columns before round 5b (components/building-model/schedules/builtin-lists.ts), verbatim. */
const ROUND_5A_COLUMNS = [
  ["mark", "field", "MARK"],
  ["description", "parameter", "DESCRIPTION"],
  ["placement", "field", "PLACEMENT"],
  ["voltage", "parameter", "ELEC VOLTS"],
  ["phases", "parameter", "ELEC PHASE"],
  ["load_va", "parameter", "ELEC LOAD (VA)"],
  ["load_class", "parameter", "ELEC CLASS"],
  ["circuit", "parameter", "ELEC CIRCUIT"],
  ["input_mbh", "parameter", "GAS MBH"],
  ["cw_size", "parameter", "CW"],
  ["hw_size", "parameter", "HW"],
  ["waste_size", "parameter", "WASTE"],
  ["connection", "parameter", "CONNECTION"],
];

const HOOD_ID = { name: "hood_id", label: "Hood ID", group: "Kitchen", key: "param.hood_id" };

describe("r5e equipment list template", () => {
  it("the built-in AEC library carries every baseline parameter as a shared field", () => {
    const ids = new Set((AEC_LIBRARY.fields ?? []).map((f) => f.id));
    for (const set of BASELINE_PARAMETER_SETS) for (const { field } of set.parameters) expect({ id: field.id, loaded: ids.has(field.id) }).toEqual({ id: field.id, loaded: true });
  });

  it("the built-in library still loads, layered over the kernel's providers, with the template and baseline fields", async () => {
    const provider = new FileLibraryProvider({ sources: [builtinMepLibrarySource(), builtinLibrarySource()], env: { formula: bimFormulaEngine, units: bimUnitsCatalog, registry: fieldProviderRegistry() } });
    await provider.load();
    const templates = await provider.list("builtin", { type: "schedule_template" });
    expect(templates.map((t) => t.key)).toContain("equipment_list");
    const fields = await provider.list("builtin", { type: "field" });
    expect(fields.map((f) => f.key)).toEqual(expect.arrayContaining(["elec.voltage", "elec.mca", "elec.mocp", "core.manufacturer", "struct.operating_weight"]));
    const { registry } = await provider.resolved();
    expect(registry.field("mep.mechanical_equipment", "elec.mca")?.label).toBe("Minimum circuit ampacity");
    // The 5a spelling still resolves, to the same parameter.
    expect(registry.field("mep.mechanical_equipment", "param.mca")?.key).toBe("elec.mca");
  });

  it("today's thirteen columns are the default columns: same ids, kinds, headings and order", () => {
    expect(EQUIPMENT_DEFAULT_COLUMNS.map((c) => [c.column.id, c.column.kind, c.column.heading])).toEqual(ROUND_5A_COLUMNS);
    const def = equipmentListDefinition();
    const ids = def.columns.map((c) => c.id);
    const shared = ids.filter((id) => ROUND_5A_COLUMNS.some(([r]) => r === id));
    expect(shared).toEqual(ROUND_5A_COLUMNS.map(([id]) => id));
  });

  it("baseline columns sit in their facet group and stay hidden until a row has a value", () => {
    const cols = equipmentListColumns();
    const facets = cols.map((c) => c.facet);
    // Groups are contiguous: once a facet ends it never comes back.
    const seen: string[] = [];
    for (const f of facets) if (seen[seen.length - 1] !== f) seen.push(f);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(["identity", "electrical", "gas", "water", "drainage", "mechanical", "structural", "other:other"]);
    const mca = cols.find((c) => c.column.id === "mca");
    expect(mca?.facet).toBe("electrical");
    expect(mca?.column).toMatchObject({ kind: "parameter", path: "mca", heading: "MINIMUM CIRCUIT AMPACITY", hideWhenEmpty: true });
    expect(cols.find((c) => c.column.id === "weight")?.facet).toBe("structural");
    expect(cols.find((c) => c.column.id === "supply_cfm")?.facet).toBe("mechanical");
  });

  it("a firm field appears in its own group with no code change, once", () => {
    const def = equipmentListDefinition([HOOD_ID, HOOD_ID]);
    expect(def.columns.filter((c) => c.id === "hood_id")).toHaveLength(1);
    expect(def.columns.find((c) => c.id === "hood_id")).toMatchObject({ kind: "parameter", path: "hood_id", heading: "HOOD ID" });
    expect(equipmentListColumns([HOOD_ID]).find((c) => c.column.id === "hood_id")?.facet).toBe("other:kitchen");
    // A firm field under a known group joins that group.
    const elec = equipmentListColumns([{ name: "panel_note", label: "Panel note", group: "Electrical" }]);
    const at = elec.findIndex((c) => c.column.id === "panel_note");
    expect(elec[at - 1]?.facet).toBe("electrical");
    expect(elec[at + 1]?.facet).not.toBe("identity");
  });

  it("Add column puts the field after the last column of its facet in an existing list, and never twice", () => {
    const today: ScheduleDefinitionV2 = { ...equipmentListDefinition(), columns: EQUIPMENT_DEFAULT_COLUMNS.map((c) => c.column) };
    const withMca = withEquipmentColumn(today, { name: "mca", label: "MCA", group: "Electrical" });
    expect(withMca?.columns.map((c) => c.id).slice(3, 9)).toEqual(["voltage", "phases", "load_va", "load_class", "circuit", "mca"]);
    expect(withMca ? withEquipmentColumn(withMca, { name: "mca", label: "MCA" }) : "missing").toBeNull();
    // The firm's own group sits after the known facets and before the ungrouped Connection.
    const withHood = withEquipmentColumn(today, HOOD_ID);
    expect(withHood?.columns.slice(-2).map((c) => c.id)).toEqual(["hood_id", "connection"]);
  });

  it("column groups are stored by facet id; a Fire protection field joins that facet; an unknown stored id reads in raw words", () => {
    const groups = equipmentListColumnGroups(equipmentListColumns([...baselineEquipmentFields(), HOOD_ID, { name: "k_factor", label: "K-factor", group: "Fire protection" }]));
    expect(groups.map((g) => g.facet)).toEqual(["identity", "electrical", "gas", "water", "drainage", "mechanical", "structural", "fire_protection", "other:kitchen", "other:other"]);
    expect(groups.find((g) => g.facet === "fire_protection")?.columns).toEqual(["k_factor"]);
    expect(groups.find((g) => g.facet === "electrical")?.columns).toEqual(["voltage", "phases", "load_va", "load_class", "circuit", "mca", "mocp"]);
    // Stored groups read back tolerantly; a newer peer's facet keeps its id and shows raw words.
    const stored = readColumnGroups([{ facet: "fa.notification", columns: ["strobe_cd"] }, { facet: "Not An Id", columns: [] }, 3]);
    expect(stored).toEqual([{ facet: "fa.notification", columns: ["strobe_cd"] }]);
    expect(columnGroupLabel("fa.notification")).toBe("Notification");
    expect(columnGroupLabel("other:kitchen")).toBe("Kitchen");
    // A firm facet row orders its group with no code change.
    const firm = withFacetRows(BUILTIN_FACET_REGISTRY, [{ id: "firm:kitchen", label: "Kitchen", order: 25 }]);
    expect(equipmentListColumnGroups(equipmentListColumns([...baselineEquipmentFields(), HOOD_ID], firm)).map((g) => g.facet).slice(1, 3)).toEqual(["electrical", "firm:kitchen"]);
  });

  it("the template's definition validates over the kernel's fields on a model with no equipment yet", () => {
    const def = EQUIPMENT_LIST_TEMPLATE.definition as unknown as ScheduleDefinitionV2;
    const problems = validateScheduleDefinition({ elements: {} }, def, { viewId: "v", revision: 0, registry: fieldProviderRegistry() });
    expect(problems).toEqual([]);
  });

  it("the paste grid's eleven columns map to parameter keys, in the grid's order", () => {
    expect(EQUIPMENT_DRAFT_FIELDS).toEqual(["mark", "description", "quantity", "voltage", "phase", "load", "gasMbh", "coldWater", "hotWater", "waste", "connection"]);
    expect(EQUIPMENT_DRAFT_FIELDS.map((f) => EQUIPMENT_DRAFT_PARAMETERS[f].parameter)).toEqual([null, "description", null, "voltage", "phases", "load_va", "input_mbh", "cw_size", "hw_size", "waste_size", "connection"]);
  });
});
