/**
 * @jest-environment node
 *
 * Round 15 wave 0: the contracts lanes K15, G15, D15, SH15, U15 and A15 build
 * against (contract 1.13.0). Each new command parses as a kernel command
 * (alone and as a batch step) and, until its lane builds it, refuses in its
 * own words. Part model schema 2 parses beside schema 1, and an old schema 1
 * part reads exactly as before (frozen golden). Script manifests read the new
 * `reads` and old manifests still parse. The library takes title block and
 * keynote table rows from an add-on. The round's peer features are declared
 * and not advertised.
 *
 * Fails on round 14's code: none of the commands, schemas, sections, reads or
 * features exist, and the contract is 1.12.0.
 */
import {
  CONNECT_INTO_NOT_BUILT,
  DOCUMENTS_SHEET_SETS_FEATURE,
  EDIT_SCHEDULE_NOT_BUILT,
  GEOMETRY_SOLID_PROGRAM_2_FEATURE,
  INSERT_LIBRARY_VIEW_NOT_BUILT,
  LIBRARY_ROW_SECTIONS,
  PARTS_CLASS_SOLIDS_FEATURE,
  ROUTING_CONNECT_INTO_FEATURE,
  SCHEDULES_EDIT_STEPS_FEATURE,
  SHEET_SETS_NOT_BUILT,
  WALLS_TOP_CONSTRAINT_FEATURE,
  anyPartModelSchema,
  commandSchema,
  executeCommand,
  partModelSchema,
  partModelSchema2,
  partModelSchemaVersion,
  planConnectInto,
  type Command,
} from "@permitzip/bim-kernel";
import { LIBRARY_ROWS_POINT, PACK_CONTRACT_VERSION, PackSet, contribute, definePack, libraryRowsOf, runPackConformance, withPackSet, type Pack } from "../src";
import { builtinLibraryBundle, keynoteTableItemSchema, scriptManifestSchema, scriptReadsSchema, titleBlockItemSchema } from "@permitzip/bim-library";
import { CLIENT_FEATURES, PROTOCOL_FEATURES, SERVER_FEATURES } from "@permitzip/bim-sync";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";

const model = createDemoModel("r15-wave0");

function parsed(raw: unknown): Command {
  const r = commandSchema.safeParse(raw);
  if (!r.success) throw new Error(`not a command: ${r.error.issues.map((i) => i.message).join("; ")}`);
  return r.data;
}

function refusal(raw: unknown): string {
  const result = executeCommand(model, parsed(raw));
  return result.ok ? "accepted" : result.error.message;
}

/** A schema 1 part model as round 14 stored it. Frozen: never edit; it proves old parts read unchanged. */
const SCHEMA_1_GOLDEN_JSON =
  '{"id":"golden_box","referencePlanes":[{"id":"front","name":"Front","axis":"x","offset":{"param":"length","scale":0.5}},{"id":"back","name":"Back","axis":"x","offset":{"param":"length","scale":-0.5}},{"id":"top","name":"Top","axis":"z","offset":{"param":"height"}}],"sketches":[{"id":"base","name":"Base","plane":"base","points":[{"id":"a","u":-300,"v":-200},{"id":"b","u":300,"v":-200},{"id":"c","u":300,"v":200},{"id":"d","u":-300,"v":200},{"id":"o","u":0,"v":0}],"entities":[{"kind":"rectangle","id":"r","corners":["a","b","c","d"]},{"kind":"circle","id":"hole","center":"o","radius":{"formula":"width / 8"}}],"constraints":[{"kind":"on_plane","point":"a","plane":"back"},{"kind":"on_plane","point":"c","plane":"front"},{"kind":"distance","a":"a","b":"d","value":{"param":"width"},"direction":"vertical"}]}],"features":[{"kind":"extrude","id":"body","name":"Body","operation":"join","sketch":"base","material":"Steel","start":0,"end":{"param":"height"}},{"kind":"revolve","id":"knob","name":"Knob","operation":"cut","sketch":"base","visibility":["fine"],"axis":"r","startAngle":0,"endAngle":360}],"planDisplay":"both","types":[{"name":"Small","values":{"length":600,"width":400,"height":300}},{"name":"Large","values":{"length":900,"width":600,"height":450,"label":"L","fused":true}}]}';

const SCHEMA_2_SAMPLE = {
  schema: 2,
  id: "sample_body",
  referencePlanes: [{ id: "mid", name: "Middle", axis: "y", offset: 0 }],
  sketches: [
    {
      id: "plate",
      name: "Plate",
      plane: "base",
      points: [
        { id: "o", u: 0, v: 0 },
        { id: "a", u: -100, v: -100 },
        { id: "b", u: 100, v: -100 },
        { id: "c", u: 100, v: 100 },
        { id: "d", u: -100, v: 100 },
      ],
      entities: [
        { kind: "rectangle", id: "edge", corners: ["a", "b", "c", "d"] },
        { kind: "circle", id: "bore", center: "o", radius: 20 },
      ],
      constraints: [],
    },
  ],
  profiles: [{ id: "plate_p", name: "Plate", sketch: "plate", outer: { edges: ["edge"] }, holes: [{ edges: ["bore"] }] }],
  features: [
    { kind: "extrude", id: "slab", name: "Slab", operation: "join", profile: "plate_p", start: 0, end: 25 },
    { kind: "sweep", id: "rail", name: "Rail", operation: "join", profile: "plate_p", path: { sketch: "plate", edges: ["edge"] } },
    { kind: "imported", id: "vendor", name: "Vendor body", operation: "join", body: { fileId: "file-1", format: "gltf", contentHash: "sha256:abc", mmPerUnit: 1000 }, at: { x: 0, y: 0, z: 25 } },
    { kind: "pattern", id: "row", name: "Row", features: ["slab"], arrangement: { kind: "linear", axis: "x", count: 3, spacing: 300 } },
    { kind: "mirror", id: "flip", name: "Flip", features: ["row"], plane: "mid" },
  ],
  symbols: [{ id: "plan_sym", name: "Plan symbol", view: "plan", detailLevels: ["coarse", "medium"], sketch: "plate" }],
  planDisplay: "symbol",
  types: [{ name: "Standard", values: {} }],
};

function itemIds(rows: readonly unknown[] | undefined): string[] {
  return (rows ?? []).flatMap((r) => (typeof r === "object" && r !== null && "id" in r && typeof r.id === "string" ? [r.id] : []));
}

function outside(id: string, contributions: Pack["contributions"]): Pack {
  return definePack({ id, name: id.toUpperCase(), version: "1.0.0", kernel: "^1.13.0" }, contributions);
}

describe("r15 wave 0 contracts", () => {
  it("is contract 1.13.0", () => {
    expect(PACK_CONTRACT_VERSION).toBe("1.13.0");
  });

  it("connect_into parses as a command and a batch step; K15 built it, so each source it can't join is named in words", () => {
    const raw = { type: "connect_into", from: [{ elementId: "p-1", port: "c1" }, { elementId: "r-9", port: "end" }], into: "nearest", idPrefix: "ci" };
    expect(refusal(raw)).not.toBe(CONNECT_INTO_NOT_BUILT);
    expect(commandSchema.safeParse({ ...raw, from: [] }).success).toBe(false);
    expect(commandSchema.safeParse({ ...raw, extra: 1 }).success).toBe(false);
    const plan = planConnectInto(model, { from: raw.from, into: "r-1", idPrefix: "ci" });
    expect(plan.commands).toEqual([]);
    expect(plan.sources).toEqual(raw.from.map((source) => ({ source, refused: `There is no ${source.elementId} in the model` })));
  });

  it("sheet set commands parse and refuse until D15 builds them", () => {
    expect(refusal({ type: "create_sheet_set", setId: "set-1", name: "Permit set", sheetIds: ["s1", "s2"], purpose: "Permit" })).toBe("Sheet sets aren't built yet");
    expect(refusal({ type: "update_sheet_set", setId: "set-1", sheetIds: ["s2", "s1"], purpose: null })).toBe(SHEET_SETS_NOT_BUILT);
    expect(refusal({ type: "delete_sheet_set", setId: "set-1" })).toBe(SHEET_SETS_NOT_BUILT);
    const twice = commandSchema.safeParse({ type: "create_sheet_set", setId: "set-2", name: "Bid", sheetIds: ["s1", "s1"] });
    expect(twice.success ? "parsed" : twice.error.issues.map((i) => i.message).join("; ")).toMatch(/A sheet is in a set at most once/);
  });

  it("edit_schedule steps take the stored schedule shapes; SC15 built them, so a missing view is named in words", () => {
    const steps = [
      { op: "add_column", column: { id: "mark", kind: "field", path: "mark", heading: "Mark" }, at: 0 },
      { op: "move_column", columnId: "mark", to: 2 },
      { op: "remove_column", columnId: "old" },
      { op: "filter", filters: [{ path: "level", op: "equals", value: "L1" }] },
      { op: "sort", sort: [{ path: "mark", direction: "asc" }] },
      { op: "group", groups: [{ path: "level", header: true, footer: false, totals: true }] },
      { op: "totals", columnId: "mark", show: false },
      { op: "totals", show: true },
    ];
    expect(refusal({ type: "edit_schedule", viewId: "v-sched", steps })).toBe("There is no view v-sched.");
    expect(EDIT_SCHEDULE_NOT_BUILT).toBe("Editing a schedule step by step isn't built yet");
    expect(commandSchema.safeParse({ type: "edit_schedule", viewId: "v", steps: [{ op: "rename_column", columnId: "mark", heading: "TAG" }] }).success).toBe(true);
    expect(commandSchema.safeParse({ type: "edit_schedule", viewId: "v", steps: [{ op: "rename_everything" }] }).success).toBe(false);
    expect(commandSchema.safeParse({ type: "edit_schedule", viewId: "v", steps: [{ op: "add_column", column: { id: "x", kind: "field" } }] }).success).toBe(false);
  });

  it("insert_library_view carries the pinned library item and refuses until D15 builds it", () => {
    const raw = { type: "insert_library_view", viewId: "v-detail", idPrefix: "lib", item: { itemId: "firm:detail:roof_curb", revision: 3, contentHash: "sha256:0", body: { items: [] } } };
    expect(refusal(raw)).toBe("Inserting a view from the library isn't built yet");
    expect(INSERT_LIBRARY_VIEW_NOT_BUILT).toBe("Inserting a view from the library isn't built yet");
    expect(commandSchema.safeParse({ ...raw, item: { itemId: "x", revision: 0, contentHash: "h", body: {} } }).success).toBe(false);
  });

  it("an old schema 1 part model reads exactly as before (frozen golden)", () => {
    const golden: unknown = JSON.parse(SCHEMA_1_GOLDEN_JSON);
    const v1 = partModelSchema.parse(golden);
    expect(JSON.stringify(v1)).toBe(SCHEMA_1_GOLDEN_JSON);
    const any = anyPartModelSchema.parse(golden);
    expect(JSON.stringify(any)).toBe(SCHEMA_1_GOLDEN_JSON);
    expect(partModelSchemaVersion(any)).toBe(1);
  });

  it("part model schema 2 parses profiles with holes, sweeps, imported bodies, repeats and symbols", () => {
    const v2 = partModelSchema2.parse(SCHEMA_2_SAMPLE);
    expect(partModelSchemaVersion(anyPartModelSchema.parse(SCHEMA_2_SAMPLE))).toBe(2);
    expect(v2.profiles[0]?.holes).toEqual([{ edges: ["bore"] }]);
    expect(v2.features.map((f) => f.kind)).toEqual(["extrude", "sweep", "imported", "pattern", "mirror"]);
    // A schema 2 body never passes as schema 1 (its features name profiles, not sketches).
    expect(partModelSchema.safeParse(SCHEMA_2_SAMPLE).success).toBe(false);
    expect(partModelSchema2.safeParse({ ...SCHEMA_2_SAMPLE, features: [{ kind: "loft", id: "l", name: "L", operation: "join", profiles: ["plate_p"] }] }).success).toBe(false);
    expect(partModelSchema2.safeParse({ ...SCHEMA_2_SAMPLE, symbols: [{ id: "s", name: "S", view: "sideways", detailLevels: ["fine"], sketch: "plate" }] }).success).toBe(false);
  });

  it("script manifests read fields, rows, calc results and footprints; old manifests still parse", () => {
    const old = { kind: "layout", parameters: {}, reads: { levels: true, kinds: ["wall"], ids: "selection" } };
    expect(scriptManifestSchema.parse(old).reads).toEqual(old.reads);
    const reads = { levels: true, fields: ["fire_rating", "values.flow"], rows: ["v-sched"], calc: ["pressure_loss"], footprint: true };
    expect(scriptReadsSchema.parse(reads)).toEqual(reads);
    expect(scriptReadsSchema.safeParse({ calc: ["Not A Calc"] }).success).toBe(false);
    expect(scriptReadsSchema.safeParse({ fields: ["9bad"] }).success).toBe(false);
    expect(scriptReadsSchema.safeParse({ everything: true }).success).toBe(false);
  });

  it("an add-on contributes title block and keynote table rows, and the library joins them", () => {
    expect(LIBRARY_ROW_SECTIONS).toEqual(expect.arrayContaining(["titleBlocks", "keynoteTables"]));
    const titleBlock = { id: "zz:title_block:standard", revision: 1, key: "zz:standard", name: "ZZ standard", paperSizes: ["ARCH D", "ARCH E1"], definition: {} };
    const keynotes = { id: "zz:keynote_table:general", revision: 1, key: "zz:general", name: "General", keynotes: [{ key: "1", text: "Patch and paint to match.", group: "General" }] };
    const pack = outside("zz", [contribute(LIBRARY_ROWS_POINT, [{ section: "titleBlocks", item: titleBlock }, { section: "keynoteTables", item: keynotes }])]);
    expect(runPackConformance(pack).problems).toEqual([]);
    withPackSet(PackSet.create([pack]), () => {
      expect(libraryRowsOf().at(-1)?.rows.map((r) => r.section)).toEqual(["titleBlocks", "keynoteTables"]);
      const bundle = builtinLibraryBundle();
      expect(itemIds(bundle.titleBlocks)).toContain("zz:title_block:standard");
      expect(itemIds(bundle.keynoteTables)).toContain("zz:keynote_table:general");
    });
    expect(titleBlockItemSchema.safeParse({ ...titleBlock, paperSizes: [] }).success).toBe(false);
    const twice = keynoteTableItemSchema.safeParse({ ...keynotes, keynotes: [...keynotes.keynotes, { key: "1", text: "Again" }] });
    expect(twice.success ? "parsed" : twice.error.issues.map((i) => i.message).join("; ")).toMatch(/Each keynote key is listed once/);
  });

  it("the round's peer features are declared and not advertised", () => {
    expect(PROTOCOL_FEATURES.geometrySolidProgram2).toBe(GEOMETRY_SOLID_PROGRAM_2_FEATURE);
    expect(PROTOCOL_FEATURES.routingConnectInto).toBe(ROUTING_CONNECT_INTO_FEATURE);
    expect(PROTOCOL_FEATURES.documentsSheetSets).toBe(DOCUMENTS_SHEET_SETS_FEATURE);
    expect(PROTOCOL_FEATURES.schedulesEditSteps).toBe(SCHEDULES_EDIT_STEPS_FEATURE);
    expect(PROTOCOL_FEATURES.wallsTopConstraint).toBe(WALLS_TOP_CONSTRAINT_FEATURE);
    expect(PROTOCOL_FEATURES.partsClassSolids).toBe(PARTS_CLASS_SOLIDS_FEATURE);
    const declared = [GEOMETRY_SOLID_PROGRAM_2_FEATURE, ROUTING_CONNECT_INTO_FEATURE, DOCUMENTS_SHEET_SETS_FEATURE, SCHEDULES_EDIT_STEPS_FEATURE, WALLS_TOP_CONSTRAINT_FEATURE, PARTS_CLASS_SOLIDS_FEATURE];
    expect(declared).toEqual(["geometry:solid_program_2", "routing:connect_into", "documents:sheet_sets", "schedules:edit_steps", "walls:top_constraint", "parts:class_solids"]);
    // Lane K15 built connect_into (writer and readers): both peers advertise it.
    expect(SERVER_FEATURES).toContain(ROUTING_CONNECT_INTO_FEATURE);
    expect(CLIENT_FEATURES).toContain(ROUTING_CONNECT_INTO_FEATURE);
    // Lane G15 built the solid program's engine and every reader (screen, sheets, clash, IFC): both peers advertise it.
    expect(SERVER_FEATURES).toContain(GEOMETRY_SOLID_PROGRAM_2_FEATURE);
    expect(CLIENT_FEATURES).toContain(GEOMETRY_SOLID_PROGRAM_2_FEATURE);
    // Lane SC15 built edit_schedule (the kernel writes it; grid, agent and scripts send it): both peers advertise it.
    expect(SERVER_FEATURES).toContain(SCHEDULES_EDIT_STEPS_FEATURE);
    expect(CLIENT_FEATURES).toContain(SCHEDULES_EDIT_STEPS_FEATURE);
    // The Architecture follow-ups built wall tops tied to a level (create, placement, level moves): both peers advertise it.
    expect(SERVER_FEATURES).toContain(WALLS_TOP_CONSTRAINT_FEATURE);
    expect(CLIENT_FEATURES).toContain(WALLS_TOP_CONSTRAINT_FEATURE);
    for (const feature of declared.filter((f) => f !== ROUTING_CONNECT_INTO_FEATURE && f !== GEOMETRY_SOLID_PROGRAM_2_FEATURE && f !== SCHEDULES_EDIT_STEPS_FEATURE && f !== WALLS_TOP_CONSTRAINT_FEATURE)) {
      expect(SERVER_FEATURES).not.toContain(feature);
      expect(CLIENT_FEATURES).not.toContain(feature);
    }
  });
});
