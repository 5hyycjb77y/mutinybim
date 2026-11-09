/**
 * @jest-environment node
 *
 * Schedule engine v2 (SCHEDULES-PLAN §5, §6): multi-class schedules from the
 * registry, typed columns (fields, formulas, relationship aggregates,
 * expandable sub-lists), totals that refuse to double count, groups,
 * highlights, and the incremental `apply` that must always equal a rebuild.
 *
 * Before Stream E none of this existed: v1 schedules were one hard-coded
 * category, untyped strings, and a full re-index of the model on every edit.
 */
import { toSI } from "@permitzip/bim-units";
import { asElementId, builtinRegistryBuilder, draftElements, drawScheduleV2, elementValues, evaluateScheduleV2, freezeElements, scheduleV2Paper, type BimElement, type FieldProvider, type ModelState, type PartTypeDefinition, type Primitive, type Registry, type ScheduleDefinitionV2, type SchedulePin } from "../src";
import { applyRowPatch, buildRowSet, openSchedule, validateScheduleDefinition, type RowSet, type ScheduleChange } from "../src/schedules/engine";

type Elements = ModelState["elements"];

// ---------------------------------------------------------------- a small plumbing + mechanical registry

function partValue(el: BimElement, name: string): number | string | boolean | undefined {
  return el.kind === "part" ? el.values[name] : undefined;
}

const provider: FieldProvider = {
  id: "test-mep",
  fields: [
    { path: "mark", label: "MARK", classes: ["mep.equipment", "mep.plumbing_fixture"], valueType: "text", writer: { kind: "command", command: "set_mark", argument: "mark" }, read: (el) => (el.kind === "part" ? el.mark : null) },
    { path: "own.mbh", label: "INPUT (MBH)", classes: ["mep.water_heater"], valueType: "quantity", kind: "flow_gas_energy", unit: "MBH", writer: { kind: "parameter", scope: "instance", name: "mbh" }, read: (el) => (typeof partValue(el, "mbh") === "number" ? (partValue(el, "mbh") as number) : null) },
    { path: "own.hp", label: "HP", classes: ["mep.pump"], valueType: "quantity", kind: "power_mechanical", unit: "hp", writer: { kind: "parameter", scope: "type", name: "hp" }, read: (el, ctx) => {
      if (el.kind !== "part") return null;
      const t = ctx.elements[el.typeId];
      const v = t?.kind === "part_type" ? t.definition.typeValues.hp : undefined;
      return typeof v === "number" ? v : null;
    } },
    { path: "load.wsfu", label: "WSFU", classes: ["mep.plumbing_fixture"], valueType: "quantity", kind: "fixture_units_supply", unit: "WSFU", writer: { kind: "parameter", scope: "instance", name: "wsfu" }, read: (el) => (typeof partValue(el, "wsfu") === "number" ? (partValue(el, "wsfu") as number) : null) },
    { path: "zone", label: "ZONE", classes: ["mep.equipment"], valueType: "text", writer: { kind: "parameter", scope: "instance", name: "zone" }, read: (el) => (typeof partValue(el, "zone") === "string" ? (partValue(el, "zone") as string) : null) },
  ],
  resolvers: {
    // What a heater serves: the fixture ids it lists. Real providers walk the network.
    serves: (el) => {
      const ids = partValue(el, "serves_ids");
      return typeof ids === "string" && ids ? ids.split(",").map(asElementId) : [];
    },
  },
};

function testRegistry(): Registry {
  return builtinRegistryBuilder()
    .addClass({ id: "mep.water_heater", label: "Water heaters", discipline: "plumbing", parent: "mep.equipment", source: "builtin", recognize: { partCategories: ["mechanical_equipment"], where: [{ path: "type.param.equipment_kind", op: "equals", value: "water_heater" }] } })
    .addClass({ id: "mep.pump", label: "Pumps", discipline: "plumbing", parent: "mep.equipment", source: "builtin", recognize: { partCategories: ["mechanical_equipment"], where: [{ path: "type.param.equipment_kind", op: "equals", value: "pump" }] } })
    .addProvider(provider)
    .build();
}

// ---------------------------------------------------------------- a synthetic model

function partType(id: string, category: PartTypeDefinition["category"], kind: string, typeValues: Record<string, number | string> = {}): BimElement {
  return {
    id: asElementId(id),
    version: 1,
    authoredRev: {},
    kind: "part_type",
    definition: {
      familyName: kind,
      typeName: id,
      category,
      typeParams: [{ name: "equipment_kind", label: "Kind", kind: "text" }, { name: "hp", label: "HP", kind: "number", unit: "hp" }],
      typeValues: { equipment_kind: kind, ...typeValues },
      instanceParams: [
        { name: "mbh", label: "MBH", kind: "number" },
        { name: "wsfu", label: "WSFU", kind: "number" },
        { name: "serves_ids", label: "Serves", kind: "text" },
        { name: "zone", label: "Zone", kind: "text" },
      ],
      connectors: [],
      geometry: [],
      symbol: [],
      tagFields: [],
      source: { kind: "builtin", libraryVersion: "1" },
    },
  } as BimElement;
}

function part(id: string, typeId: string, mark: string, values: Record<string, number | string>, version = 1): BimElement {
  return { id: asElementId(id), version, authoredRev: {}, kind: "part", typeId: asElementId(typeId), levelId: asElementId("lvl-1"), position: { x: 0, y: 0 }, offsetMm: 0, rotationDeg: 0, mark, values } as BimElement;
}

function baseRecord(): Record<string, BimElement> {
  const level = { id: asElementId("lvl-1"), version: 1, authoredRev: {}, kind: "level", name: "Level 1", elevationMm: 0 } as BimElement;
  return {
    "lvl-1": level,
    "t-wh": partType("t-wh", "mechanical_equipment", "water_heater"),
    "t-pump": partType("t-pump", "mechanical_equipment", "pump", { hp: 0.5 }),
    "t-fix": partType("t-fix", "plumbing_fixture", "fixture"),
  };
}

function freeze(record: Record<string, BimElement>): Elements {
  return freezeElements(record);
}

function commit(prev: Elements, puts: readonly BimElement[], dels: readonly string[]): Elements {
  const d = draftElements(prev);
  for (const el of puts) d[el.id] = el;
  for (const id of dels) delete d[id];
  return freezeElements(d);
}

const ctx = (revision: number, registry: Registry) => ({ viewId: "v-wh", revision, registry });

const HEATERS_AND_PUMPS: ScheduleDefinitionV2 = {
  name: "Water heaters and pumps",
  source: { kind: "classes", classes: ["mep.water_heater", "mep.pump"], includeSubclasses: true },
  columns: [
    { id: "mark", kind: "field", path: "mark" },
    { id: "mbh", kind: "field", path: "own.mbh", total: true },
    { id: "hp", kind: "field", path: "own.hp" },
    { id: "btuh", kind: "formula", expression: "{own.mbh} * 1", unit: "Btu/h" },
    { id: "wsfu", kind: "aggregate", fn: "sum", relationship: "serves", path: "load.wsfu" },
    { id: "served", kind: "aggregate", fn: "count", relationship: "serves" },
    { id: "serves", kind: "expand", relationship: "serves", columns: ["mark", "load.wsfu"], paper: "nested" },
  ],
  filters: [],
  sort: [{ path: "mark", direction: "asc" }],
  groups: [],
  grandTotals: true,
  itemize: true,
  presentation: { kind: "list" },
  display: { textSizeMm: 2.5, emptyText: "NONE" },
};

function sample(): Elements {
  const r = baseRecord();
  r["wh-1"] = part("wh-1", "t-wh", "WH-1", { mbh: 199, serves_ids: "f-1,f-2" });
  r["wh-2"] = part("wh-2", "t-wh", "WH-2", { mbh: 100, serves_ids: "f-3" });
  r["p-1"] = part("p-1", "t-pump", "P-1", {});
  r["f-1"] = part("f-1", "t-fix", "L-1", { wsfu: 1 });
  r["f-2"] = part("f-2", "t-fix", "S-1", { wsfu: 1.5 });
  r["f-3"] = part("f-3", "t-fix", "WC-1", { wsfu: 2.5 });
  return freeze(r);
}

function cells(rows: RowSet, column: string): (number | string | boolean | null)[] {
  const col = rows.values.get(column);
  if (!col) throw new Error(`no column ${column}`);
  if (col.type === "quantity") return Array.from(col.values, (v) => (Number.isNaN(v) ? null : v));
  if (col.type === "boolean") return Array.from(col.values, (v) => (v === -1 ? null : v === 1));
  return [...col.values];
}

describe("schedule engine v2", () => {
  const registry = testRegistry();

  it("lists several classes in one schedule, each reading its own fields", () => {
    const rows = buildRowSet({ elements: sample(), connections: [] }, HEATERS_AND_PUMPS, ctx(1, registry));
    expect(rows.rowKeys).toEqual(["p-1", "wh-1", "wh-2"]);
    expect(cells(rows, "mark")).toEqual(["P-1", "WH-1", "WH-2"]);
    expect(cells(rows, "mbh")).toEqual([null, toSI(199, "MBH"), toSI(100, "MBH")]);
    expect(cells(rows, "hp")).toEqual([toSI(0.5, "hp"), null, null]);
    const mbh = rows.columns.find((c) => c.id === "mbh");
    expect(mbh).toMatchObject({ valueType: "quantity", quantityKind: "flow_gas_energy", unit: "MBH", writer: { scope: "instance" } });
    expect(rows.columns.find((c) => c.id === "hp")?.writer).toEqual({ scope: "type" });
    // Formula columns are locked and point at their source.
    const btuh = rows.columns.find((c) => c.id === "btuh");
    expect(btuh).toMatchObject({ writer: null, unit: "Btu/h", source: { kind: "formula" } });
    expect(cells(rows, "btuh")[1]).toBeCloseTo(toSI(199, "MBH"), 6);
    expect(rows.totals?.get("mbh")).toEqual({ kind: "flow_gas_energy", value: toSI(299, "MBH") });
  });

  it("a Serves sub-list yields the served fixtures as child rows, and its aggregate sums them", () => {
    const rows = buildRowSet({ elements: sample(), connections: [] }, HEATERS_AND_PUMPS, ctx(1, registry));
    const wh1 = rows.children.get("serves")?.get("wh-1");
    expect(wh1?.rowKeys).toEqual(["f-1", "f-2"]);
    expect(wh1 && cells(wh1, "mark")).toEqual(["L-1", "S-1"]);
    expect(wh1 && cells(wh1, "load.wsfu")).toEqual([1, 1.5]);
    expect(cells(rows, "wsfu")).toEqual([0, 2.5, 2.5]);
    expect(cells(rows, "served")).toEqual([0, 2, 1]);
    expect(rows.columns.find((c) => c.id === "serves")).toMatchObject({ kind: "expand", expandLabel: "Serves", childColumns: [{ id: "mark" }, { id: "load.wsfu", quantityKind: "fixture_units_supply" }] });
  });

  it("refuses a total over what an item serves, in plain words", () => {
    const def: ScheduleDefinitionV2 = { ...HEATERS_AND_PUMPS, columns: [...HEATERS_AND_PUMPS.columns.filter((c) => c.id !== "wsfu"), { id: "wsfu", kind: "aggregate", fn: "sum", relationship: "serves", path: "load.wsfu", total: true }] };
    const problems = validateScheduleDefinition({ elements: sample(), connections: [] }, def, ctx(1, registry));
    expect(problems).toEqual([{ code: "total_refused", message: "Served loads are already counted on the fixtures", columnId: "wsfu" }]);
    const text = validateScheduleDefinition({ elements: sample(), connections: [] }, { ...HEATERS_AND_PUMPS, columns: [{ id: "mark", kind: "field", path: "mark", total: true }] }, ctx(1, registry));
    expect(text[0]?.message).toBe('"mark" is text, so it can\'t have a total.');
  });

  it("refuses unknown fields and unit-mismatched formulas naming the column", () => {
    const problems = validateScheduleDefinition(
      { elements: sample(), connections: [] },
      { ...HEATERS_AND_PUMPS, columns: [{ id: "x", kind: "field", path: "nope" }, { id: "bad", kind: "formula", expression: "{own.mbh} + {own.hp}" }] },
      ctx(1, registry),
    );
    expect(problems.map((p) => [p.code, p.columnId])).toEqual([
      ["unknown_field", "x"],
      ["formula", "bad"],
    ]);
  });

  it("explains a formula cell with its substituted values", () => {
    const s = openSchedule({ elements: sample(), connections: [] }, HEATERS_AND_PUMPS, ctx(1, registry));
    expect(s.explain("wh-1", "btuh")).toMatch(/199/);
    expect(s.explain("wh-1", "mark")).toBeNull();
  });

  it("groups rows with footer totals and highlights rows by a condition", () => {
    let elements = sample();
    elements = commit(elements, [part("wh-1", "t-wh", "WH-1", { mbh: 199, serves_ids: "f-1,f-2", zone: "North" }, 2), part("wh-2", "t-wh", "WH-2", { mbh: 100, serves_ids: "f-3", zone: "South" }, 2), part("wh-3", "t-wh", "WH-3", { mbh: 50, zone: "North" })], []);
    const def: ScheduleDefinitionV2 = {
      ...HEATERS_AND_PUMPS,
      source: { kind: "classes", classes: ["mep.water_heater"], includeSubclasses: true },
      columns: [
        { id: "mark", kind: "field", path: "mark" },
        { id: "mbh", kind: "field", path: "own.mbh", total: true, highlights: [{ when: "{own.mbh} > 150 MBH", tone: "warning", reason: "Over 150 MBH needs a gas permit review" }] },
      ],
      groups: [{ path: "zone", header: true, footer: true, totals: true }],
    };
    const rows = buildRowSet({ elements, connections: [] }, def, ctx(1, registry));
    expect(cells(rows, "mark")).toEqual(["WH-1", "WH-3", "WH-2"]);
    expect(rows.groups?.map((g) => [g.label, g.start, g.count, g.totals?.mbh?.value])).toEqual([
      ["ZONE: North", 0, 2, toSI(249, "MBH")],
      ["ZONE: South", 2, 1, toSI(100, "MBH")],
    ]);
    expect(rows.highlights?.get("mbh")?.get("wh-1")).toEqual({ tone: "warning", reason: "Over 150 MBH needs a gas permit review" });
    expect(rows.highlights?.get("mbh")?.has("wh-2")).toBe(false);
  });

  it("a fixture edit patches only the heater that serves it", () => {
    const elements = sample();
    const s = openSchedule({ elements, connections: [] }, HEATERS_AND_PUMPS, ctx(1, registry));
    const next = commit(elements, [part("f-2", "t-fix", "S-1", { wsfu: 4 }, 2)], []);
    const patch = s.apply({ model: { elements: next, connections: [] }, revision: 2, changedIds: ["f-2"] });
    expect(patch.upserts.map((u) => u.rowKey)).toEqual(["wh-1"]);
    expect(patch.upserts[0]?.values.wsfu).toBe(5);
    expect(patch.order).toBeUndefined();
    expect(patch.removes).toEqual([]);
  });

  it("apply equals a rebuild over 500 random changesets", () => {
    let seed = 20261025;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
    const defs: ScheduleDefinitionV2[] = [
      HEATERS_AND_PUMPS,
      { ...HEATERS_AND_PUMPS, sort: [{ path: "own.mbh", direction: "desc" }], groups: [{ path: "zone", header: true, footer: true, totals: true }], filters: [{ path: "mark", op: "contains", value: "1" }] },
      { ...HEATERS_AND_PUMPS, itemize: false, columns: [{ id: "zone", kind: "field", path: "zone" }, { id: "mbh", kind: "field", path: "own.mbh", total: true }] },
    ];
    for (const def of defs) {
      let elements = sample();
      let revision = 1;
      const session = openSchedule({ elements, connections: [] }, def, ctx(revision, registry));
      let rows = session.rows();
      for (let step = 0; step < 500 / defs.length + 1; step++) {
        const puts: BimElement[] = [];
        const dels: string[] = [];
        const parts = elementValues(elements).filter((e) => e.kind === "part").map((e) => e.id);
        const heaters = parts.filter((id) => (elements[id] as { typeId?: string }).typeId === "t-wh");
        const fixtures = parts.filter((id) => (elements[id] as { typeId?: string }).typeId === "t-fix");
        const op = Math.floor(rand() * 8);
        const n = 100 + step;
        if (op === 0) puts.push(part(`wh-${n}`, "t-wh", `WH-${Math.floor(rand() * 20)}`, { mbh: Math.round(rand() * 300), serves_ids: [pick(fixtures), `f-${n + 1}`].filter(Boolean).join(","), zone: pick(["North", "South", ""]) }));
        else if (op === 1) puts.push(part(`f-${n}`, "t-fix", `F-${n}`, { wsfu: Math.round(rand() * 40) / 10 }));
        else if (op === 2 && heaters.length > 0) {
          const id = pick(heaters);
          const el = elements[id];
          if (el?.kind === "part") puts.push(part(id, "t-wh", el.mark, { ...el.values, mbh: Math.round(rand() * 300), zone: pick(["North", "South", "East"]) }, el.version + 1));
        } else if (op === 3 && fixtures.length > 0) {
          const id = pick(fixtures);
          const el = elements[id];
          if (el?.kind === "part") puts.push(part(id, "t-fix", el.mark, { wsfu: Math.round(rand() * 40) / 10 }, el.version + 1));
        } else if (op === 4 && parts.length > 0) dels.push(pick(parts));
        else if (op === 5 && heaters.length > 0) {
          const id = pick(heaters);
          const el = elements[id];
          if (el?.kind === "part") puts.push(part(id, "t-wh", `WH-${Math.floor(rand() * 20)}`, { ...el.values, serves_ids: fixtures.filter(() => rand() < 0.3).join(",") }, el.version + 1));
        } else if (op === 6) {
          const t = elements["t-pump"];
          if (t?.kind === "part_type") puts.push({ ...t, version: t.version + 1, definition: { ...t.definition, typeValues: { ...t.definition.typeValues, hp: Math.round(rand() * 50) / 10 } } });
          puts.push(part(`p-${n}`, "t-pump", `P-${n}`, { zone: pick(["North", "South"]) }));
        } else if (heaters.length > 1) {
          puts.push(part(pick(heaters), "t-wh", `WH-${Math.floor(rand() * 20)}`, { mbh: 10 }, 99 + step));
          dels.push(pick(fixtures.length > 0 ? fixtures : heaters));
        }
        const removedIds = dels.filter((id) => elements[id] !== undefined && !puts.some((p) => p.id === id));
        elements = commit(elements, puts.filter((p) => !removedIds.includes(p.id)), removedIds);
        revision += 1;
        const change: ScheduleChange = { model: { elements, connections: [] }, revision, changedIds: puts.filter((p) => !removedIds.includes(p.id)).map((p) => p.id), removedIds };
        rows = applyRowPatch(rows, session.apply(change));
        const rebuilt = buildRowSet({ elements, connections: [] }, def, ctx(revision, registry));
        expect(comparable(rows)).toEqual(comparable(rebuilt));
        expect(comparable(session.rows())).toEqual(comparable(rebuilt));
        const offset = Math.floor(rand() * (rebuilt.rowCount + 1));
        const view = session.window(offset, 3);
        expect(view.window).toEqual({ offset, totalRows: rebuilt.rowCount });
        expect(view.rowKeys).toEqual(rebuilt.rowKeys.slice(offset, offset + 3));
        expect(view.elementIds).toEqual(rebuilt.elementIds.slice(offset, offset + 3));
      }
    }
  });
});

describe("windows and cell edits", () => {
  const registry = testRegistry();

  it("a window reads only its rows, at the session's revision", () => {
    const s = openSchedule({ elements: sample(), connections: [] }, HEATERS_AND_PUMPS, ctx(1, registry));
    const w = s.window(1, 5);
    expect(w.rowKeys).toEqual(["wh-1", "wh-2"]);
    expect(w.window).toEqual({ offset: 1, totalRows: 3 });
    expect(cells(w, "mark")).toEqual(["WH-1", "WH-2"]);
    expect(w.children.get("serves")?.get("wh-1")?.rowKeys).toEqual(["f-1", "f-2"]);
    expect(w.totals?.get("mbh")?.value).toBeCloseTo(toSI(299, "MBH"), 6);
    expect(s.window(10, 5).rowKeys).toEqual([]);
  });

  it("plans a cell edit through the field's writer, asking before a type-wide change", () => {
    let elements = sample();
    elements = commit(elements, [part("p-2", "t-pump", "P-2", {})], []);
    const s = openSchedule({ elements, connections: [] }, HEATERS_AND_PUMPS, ctx(1, registry));
    expect(s.planEdit({ rowKey: "wh-1", columnId: "mbh", value: toSI(150, "MBH") })).toEqual({
      ok: true,
      commands: [{ type: "set_parameters", id: "wh-1", scope: "instance", values: { mbh: expect.closeTo(150, 9) } }],
      scope: "instance",
      affectedElementIds: ["wh-1"],
      confirm: null,
    });
    const typeWide = s.planEdit({ rowKey: "p-1", columnId: "hp", value: toSI(2, "hp") });
    expect(typeWide).toMatchObject({ ok: true, scope: "type", affectedElementIds: ["p-1", "p-2"], confirm: "Changes all 2 parts of type t-pump", commands: [{ type: "set_parameters", id: "p-1", scope: "type" }] });
    expect(s.planEdit({ rowKey: "wh-1", columnId: "mbh", value: "lots" })).toEqual({ ok: false, reason: '"INPUT (MBH)" takes a number (MBH).' });
    expect(s.planEdit({ rowKey: "wh-1", columnId: "btuh", value: 1 })).toEqual({ ok: false, reason: "Calculated: {own.mbh} * 1" });
    expect(s.planEdit({ rowKey: "wh-1", columnId: "mark", value: "WH-9" })).toEqual({ ok: false, reason: 'This column is changed with "set_mark", which a schedule can\'t send yet. Change it from the element.' });
    expect(s.planEdit({ rowKey: "gone", columnId: "mbh", value: 1 })).toMatchObject({ ok: false });
  });

  it("a combined row edits every element behind it", () => {
    const def: ScheduleDefinitionV2 = { ...HEATERS_AND_PUMPS, source: { kind: "classes", classes: ["mep.water_heater"], includeSubclasses: true }, itemize: false, columns: [{ id: "mbh", kind: "field", path: "own.mbh" }] };
    let elements = sample();
    elements = commit(elements, [part("wh-3", "t-wh", "WH-3", { mbh: 100 })], []);
    const s = openSchedule({ elements, connections: [] }, def, ctx(1, registry));
    const row = s.rows().rowKeys.find((_k, i) => s.rows().rowElementIds?.[i]?.length === 2);
    expect(row).toBeDefined();
    const plan = s.planEdit({ rowKey: row ?? "", columnId: "mbh", value: toSI(120, "MBH") });
    expect(plan).toMatchObject({ ok: true, affectedElementIds: ["wh-2", "wh-3"], confirm: "Changes all 2 items on this row" });
  });
});

describe("pins, units and paper", () => {
  const registry = testRegistry();
  const DEMAND: SchedulePin = {
    id: "lib-gas-demand",
    type: "formula",
    revision: 3,
    contentHash: "sha256:test",
    body: {
      key: "PZ.GasDemandBtuh",
      expression: "{input} * {factor}",
      params: [
        { name: "input", type: { valueType: "quantity", kind: "flow_gas_energy", unit: "MBH" } },
        { name: "factor", type: { valueType: "quantity", kind: "dimensionless", unit: "1" } },
      ],
      result: { valueType: "quantity", kind: "flow_gas_energy", unit: "Btu/h" },
    },
  };
  const withDemand = (pins: readonly SchedulePin[] | undefined): ScheduleDefinitionV2 => ({
    ...HEATERS_AND_PUMPS,
    source: { kind: "classes", classes: ["mep.water_heater"], includeSubclasses: true },
    columns: [
      { id: "mark", kind: "field", path: "mark" },
      { id: "demand", kind: "formula", expression: "PZ.GasDemandBtuh({own.mbh}, 0.8)", calculation: "PZ.GasDemandBtuh", unit: "Btu/h" },
    ],
    ...(pins ? { pins } : {}),
  });

  it("a formula calls a library calculation only through the model's pinned copy", () => {
    const rows = buildRowSet({ elements: sample(), connections: [] }, withDemand([DEMAND]), ctx(1, registry));
    expect(cells(rows, "demand")[0]).toBeCloseTo(toSI(199 * 0.8, "MBH"), 6);
    expect(rows.columns.find((c) => c.id === "demand")?.source).toEqual({ kind: "calculation", label: "PZ.GasDemandBtuh", target: "PZ.GasDemandBtuh" });
    expect(validateScheduleDefinition({ elements: sample(), connections: [] }, withDemand(undefined), ctx(1, registry))).toEqual([
      { code: "pin", message: "PZ.GasDemandBtuh isn't pinned in this model, so column demand can't use it. Add it from the library.", columnId: "demand" },
    ]);
    const broken = validateScheduleDefinition({ elements: sample(), connections: [] }, withDemand([{ ...DEMAND, body: { key: "PZ.GasDemandBtuh", expression: "1" } }]), ctx(1, registry));
    expect(broken[0]).toEqual({ code: "pin", message: "The model's copy of PZ.GasDemandBtuh isn't a calculation a schedule can read. Update it from the library." });
    const twice = validateScheduleDefinition({ elements: sample(), connections: [] }, withDemand([DEMAND, { ...DEMAND, revision: 4 }]), ctx(1, registry));
    expect(twice[0]?.message).toBe("PZ.GasDemandBtuh is pinned twice (revisions 3 and 4); keep one.");
  });

  it("refuses a display unit that doesn't measure the column", () => {
    const problems = validateScheduleDefinition({ elements: sample(), connections: [] }, { ...HEATERS_AND_PUMPS, columns: [{ id: "mbh", kind: "field", path: "own.mbh", heading: "INPUT", unit: "cfm" }, { id: "mark", kind: "field", path: "mark", unit: "ft" }] }, ctx(1, registry));
    expect(problems.map((p) => [p.code, p.columnId])).toEqual([
      ["unit", "mbh"],
      ["unit", "mark"],
    ]);
    expect(problems[1]?.message).toBe('"mark" isn\'t a quantity, so it can\'t have a unit.');
  });

  it("prints a Serves sub-list nested, as a count, or not at all, with totals rows", () => {
    const def = (paper: "nested" | "summary" | "hidden"): ScheduleDefinitionV2 => ({
      ...HEATERS_AND_PUMPS,
      source: { kind: "classes", classes: ["mep.water_heater"], includeSubclasses: true },
      columns: [
        { id: "mark", kind: "field", path: "mark" },
        { id: "mbh", kind: "field", path: "own.mbh", total: true, unit: "MBH", precision: { kind: "decimals", digits: 0 } },
        { id: "serves", kind: "expand", relationship: "serves", columns: ["mark", "load.wsfu"], paper },
      ],
    });
    const model = { elements: sample(), connections: [] };
    const nested = evaluateScheduleV2(buildRowSet(model, def("nested"), ctx(1, registry)), def("nested"));
    expect(nested.headings).toEqual(["MARK", "INPUT (MBH)", "SERVES MARK", "SERVES WSFU"]);
    expect(nested.rows).toEqual([
      ["WH-1", "199 MBH", "", ""],
      ["", "", "› L-1", "1.0 WSFU"],
      ["", "", "› S-1", "1.5 WSFU"],
      ["WH-2", "100 MBH", "", ""],
      ["", "", "› WC-1", "2.5 WSFU"],
      ["GRAND TOTAL", "299 MBH", "", ""],
    ]);
    expect(nested.rowStyles).toEqual(["item", "child", "child", "item", "child", "total"]);
    expect(nested.elementIds).toEqual([["wh-1"], ["f-1"], ["f-2"], ["wh-2"], ["f-3"], []]);
    const summary = evaluateScheduleV2(buildRowSet(model, def("summary"), ctx(1, registry)), def("summary"));
    expect(summary.headings).toEqual(["MARK", "INPUT (MBH)", "SERVES"]);
    expect(summary.rows.slice(0, 2)).toEqual([
      ["WH-1", "199 MBH", "2"],
      ["WH-2", "100 MBH", "1"],
    ]);
    const hidden = evaluateScheduleV2(buildRowSet(model, def("hidden"), ctx(1, registry)), def("hidden"));
    expect(hidden.headings).toEqual(["MARK", "INPUT (MBH)"]);
  });

  it("prints group headings and footers, drops empty columns when asked, and lays out on paper", () => {
    let elements = sample();
    elements = commit(elements, [part("wh-1", "t-wh", "WH-1", { mbh: 199, zone: "North" }, 2), part("wh-2", "t-wh", "WH-2", { mbh: 100, zone: "South" }, 2), part("wh-3", "t-wh", "WH-3", { mbh: 50, zone: "North" })], []);
    const def: ScheduleDefinitionV2 = {
      ...HEATERS_AND_PUMPS,
      name: "Water heaters",
      source: { kind: "classes", classes: ["mep.water_heater"], includeSubclasses: true },
      columns: [
        { id: "mark", kind: "field", path: "mark" },
        { id: "mbh", kind: "field", path: "own.mbh", total: true, unit: "MBH", precision: { kind: "decimals", digits: 0 }, widthMm: 30 },
        { id: "wsfu", kind: "aggregate", fn: "sum", relationship: "serves", path: "load.wsfu", hideWhenEmpty: true },
        { id: "hp", kind: "field", path: "zone", heading: "NOTES", hideWhenEmpty: true },
      ],
      groups: [{ path: "zone", header: true, footer: true, totals: true }],
    };
    const rows = buildRowSet({ elements, connections: [] }, def, ctx(1, registry));
    const printed = evaluateScheduleV2(rows, def);
    // The serves sum is 0 (not empty) so it stays; NOTES has text so it stays too.
    expect(printed.headings).toEqual(["MARK", "INPUT (MBH)", "SERVES SUM", "NOTES"]);
    expect(printed.rows.map((r) => r[0])).toEqual(["ZONE: NORTH", "WH-1", "WH-3", "TOTAL", "ZONE: SOUTH", "WH-2", "TOTAL", "GRAND TOTAL"]);
    expect(printed.rows[3]?.[1]).toBe("249 MBH");
    expect(printed.rowStyles).toEqual(["group", "item", "item", "footer", "group", "item", "footer", "total"]);
    // In the sample nobody has a zone yet: the hide-when-empty NOTES column drops out.
    const noZones: ScheduleDefinitionV2 = { ...def, groups: [] };
    expect(evaluateScheduleV2(buildRowSet({ elements: sample(), connections: [] }, noZones, ctx(1, registry)), noZones).headings).toEqual(["MARK", "INPUT (MBH)", "SERVES SUM"]);
    const paper = scheduleV2Paper({ elements }, def, ctx(1, registry));
    expect(paper.kind).toBe("list");
    if (paper.kind !== "list") return;
    expect(paper.table.columnWidths[1]).toBe(30);
    const prims: Primitive[] = [];
    drawScheduleV2(prims, paper, { x: 0, y: 0 });
    const texts = prims.flatMap((p) => (p.kind === "text" ? [p.text] : []));
    expect(texts).toEqual(expect.arrayContaining(["WATER HEATERS", "ZONE: NORTH", "GRAND TOTAL", "249 MBH"]));
    // A group heading spans the table: no column rule crosses it.
    const headingRow = prims.find((p) => p.kind === "text" && p.text === "ZONE: NORTH");
    expect(headingRow && headingRow.kind === "text" && headingRow.anchor).toBe("start");
  });

  it("a definition that can't build prints its problems instead of a blank box", () => {
    const paper = scheduleV2Paper({ elements: sample() }, withDemand(undefined), ctx(1, registry));
    expect(paper.kind === "list" && paper.table.evaluated.rows).toEqual([["PZ.GasDemandBtuh isn't pinned in this model, so column demand can't use it. Add it from the library."]]);
  });
});

describe("schedule engine v2 performance (SCHEDULES-PLAN §11)", () => {
  const registry = testRegistry();
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? Number.NaN;

  function big(heaters: number, fixturesPer: number): Elements {
    const r = baseRecord();
    for (let i = 0; i < heaters; i++) {
      const fx: string[] = [];
      for (let k = 0; k < fixturesPer; k++) {
        const id = `f-${i}-${k}`;
        r[id] = part(id, "t-fix", `F-${i}-${k}`, { wsfu: 1 + (k % 3) });
        fx.push(id);
      }
      r[`wh-${i}`] = part(`wh-${i}`, "t-wh", `WH-${i}`, { mbh: 50 + (i % 200), zone: i % 2 ? "North" : "South", serves_ids: fx.join(",") });
    }
    return freeze(r);
  }

  function edits(elements: Elements, ids: readonly string[], make: (id: string, step: number) => BimElement, def: ScheduleDefinitionV2) {
    const s = openSchedule({ elements, connections: [] }, def, ctx(1, registry));
    let at = elements;
    const times: number[] = [];
    ids.forEach((id, step) => {
      at = commit(at, [make(id, step)], []);
      const t0 = performance.now();
      s.apply({ model: { elements: at, connections: [] }, revision: step + 2, changedIds: [id] });
      times.push(performance.now() - t0);
    });
    return times;
  }

  it("schedule.grid.cold.10k, schedule.patch.one_edit.10k and schedule.formula.column.10k stay in budget", () => {
    const elements = big(10_000, 0);
    const def: ScheduleDefinitionV2 = { ...HEATERS_AND_PUMPS, source: { kind: "classes", classes: ["mep.water_heater"], includeSubclasses: true }, columns: [{ id: "mark", kind: "field", path: "mark" }, { id: "mbh", kind: "field", path: "own.mbh", total: true }, { id: "zone", kind: "field", path: "zone" }, { id: "btuh", kind: "formula", expression: "{own.mbh} * 1000", unit: "Btu/h" }] };
    const cold: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      buildRowSet({ elements, connections: [] }, def, ctx(1, registry));
      cold.push(performance.now() - t0);
    }
    const ids = Array.from({ length: 40 }, (_, i) => `wh-${(i * 251) % 10_000}`);
    const times = edits(elements, ids, (id, step) => part(id, "t-wh", id.toUpperCase(), { mbh: 75 + step, zone: "North" }, 2 + step), def);
    console.info(`[schedule-perf] cold.10k median ${median(cold).toFixed(1)} ms; one_edit.10k median ${median(times).toFixed(2)} ms, max ${Math.max(...times).toFixed(2)} ms`);
    expect(median(cold)).toBeLessThanOrEqual(300);
    expect(median(times)).toBeLessThanOrEqual(5);
  });

  it("schedule.paste.500 (engine side): 500 edited rows of a 10k schedule in one apply stay in budget and equal a rebuild", () => {
    const elements = big(10_000, 0);
    const def: ScheduleDefinitionV2 = { ...HEATERS_AND_PUMPS, source: { kind: "classes", classes: ["mep.water_heater"], includeSubclasses: true }, columns: [{ id: "mark", kind: "field", path: "mark" }, { id: "mbh", kind: "field", path: "own.mbh", total: true }, { id: "btuh", kind: "formula", expression: "{own.mbh} * 1000", unit: "Btu/h" }] };
    const s = openSchedule({ elements, connections: [] }, def, ctx(1, registry));
    let rows = s.rows();
    let at = elements;
    const times: number[] = [];
    for (let sample = 0; sample < 5; sample++) {
      const ids = Array.from({ length: 500 }, (_, i) => `wh-${(sample * 500 + i * 13) % 10_000}`);
      at = commit(at, ids.map((id, i) => part(id, "t-wh", id.toUpperCase(), { mbh: 60 + ((i + sample) % 90) }, 10 + sample)), []);
      const t0 = performance.now();
      const patch = s.apply({ model: { elements: at, connections: [] }, revision: sample + 2, changedIds: ids });
      times.push(performance.now() - t0);
      rows = applyRowPatch(rows, patch);
    }
    expect(comparable(rows)).toEqual(comparable(buildRowSet({ elements: at, connections: [] }, def, ctx(6, registry))));
    console.info(`[schedule-perf] paste.500 apply median ${median(times).toFixed(2)} ms, max ${Math.max(...times).toFixed(2)} ms`);
    expect(median(times)).toBeLessThanOrEqual(100);
  });

  it("schedule.patch.serves_expand.2k: a fixture edit updates its heater's aggregate and sub-rows in budget", () => {
    const elements = big(2_000, 4);
    const ids = Array.from({ length: 40 }, (_, i) => `f-${(i * 37) % 2_000}-${i % 4}`);
    const heatersOnly: ScheduleDefinitionV2 = {
      ...HEATERS_AND_PUMPS,
      source: { kind: "classes", classes: ["mep.water_heater"], includeSubclasses: true },
      columns: HEATERS_AND_PUMPS.columns.filter((c) => c.id !== "hp"),
    };
    const s = openSchedule({ elements, connections: [] }, heatersOnly, ctx(1, registry));
    const times = edits(elements, ids, (id, step) => part(id, "t-fix", id.toUpperCase(), { wsfu: 2 + step }, 2 + step), heatersOnly);
    // The edit lands on exactly one heater: its aggregate and its sub-row change, nothing else.
    const id = "f-7-1";
    const next = commit(elements, [part(id, "t-fix", "F-7-1", { wsfu: 9 }, 50)], []);
    const patch = s.apply({ model: { elements: next, connections: [] }, revision: 2, changedIds: [id] });
    expect(patch.upserts.map((u) => u.rowKey)).toEqual(["wh-7"]);
    expect(patch.upserts[0]?.values.wsfu).toBe(1 + 9 + 3 + 1);
    const child = patch.upserts[0]?.children?.serves;
    expect(child && cells(child, "load.wsfu")).toEqual([1, 9, 3, 1]);
    console.info(`[schedule-perf] serves_expand.2k median ${median(times).toFixed(2)} ms, max ${Math.max(...times).toFixed(2)} ms`);
    expect(median(times)).toBeLessThanOrEqual(10);
  });
});

/** A RowSet as plain data, for deep equality (typed arrays and maps flattened). Child sets keep the revision they were read at. */
function comparable(rows: RowSet, child = false): unknown {
  const values = [...rows.values].map(([k, v]) => [k, v.type, Array.from(v.values as ArrayLike<number | string | null>, (x) => (typeof x === "number" && Number.isNaN(x) ? "NaN" : x))]);
  const children = [...rows.children].map(([k, m]) => [k, [...m].map(([key, set]) => [key, comparable(set, true)])]);
  const highlights = [...(rows.highlights ?? new Map())].map(([k, m]) => [k, [...m]]);
  return {
    revision: child ? null : rows.revision,
    rowKeys: rows.rowKeys,
    elementIds: rows.elementIds,
    values,
    children,
    highlights,
    totals: rows.totals ? [...rows.totals] : null,
    groups: rows.groups ?? null,
    rowElementIds: rows.rowElementIds ?? null,
  };
}
