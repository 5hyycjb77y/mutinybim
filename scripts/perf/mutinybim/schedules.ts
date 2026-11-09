/**
 * One run of the schedule workload (SCHEDULES-PLAN §11) on a full-BIM tier, in
 * one process: a whole-building air terminal schedule of at least 10,000 rows,
 * then per sample a cold open, a one-cell edit, a window fetch and (fewer
 * samples) a 500-cell paste. Alongside: one compiled formula over a 10k column,
 * 100k cells formatted through the unit library, and class recognition over the
 * tower-14 synthetic.
 *
 *   node --expose-gc --import tsx scripts/perf/mutinybim/schedules.ts --tier=250k --samples=21
 *
 * Prints one `@@perf-result` JSON line. Run through run.ts, one tier per process.
 *
 * The row engine is measured through `ScheduleEngineUnderTest`: the
 * incremental v2 session (`openSchedule` → `apply` / `window`). `V1_REBUILD`
 * (full re-evaluation per revision) stays beside it for comparison runs; the
 * workload and the metric names are the same for both.
 */
import { DEFAULT_SETTINGS, asRevision, builtinRegistryBuilder, buildClassIndex, commandSchema, draftElements, fieldProviderRegistryBuilder, freezeElements, servesOf, type BimElement, type FieldDef, evaluateSchedule, executeCommand, planCommit, type Command, type ModelState, type ScheduleDefinition } from "@permitzip/bim-kernel";
import { openSchedule, scheduleProfile, scheduleV1ToV2, type RowSet, type ScheduleSession } from "@permitzip/bim-kernel/schedules";
import { FULL_BIM_TIERS, createFullBimModel } from "@permitzip/bim-first-party/seed";
import { formulaEngine, type ColumnarInputs, type FieldSignature, type FormulaSchema, type ValueColumn } from "@permitzip/bim-formula";
import { PROFILE_US_DECIMAL_FEET, PROFILE_US_FEET_INCHES, formatter, qty, toSI, type DisplayProfile, type Kind } from "@permitzip/bim-units";
import { sampleMarketLoadPointCommand, sampleMarket } from "../../../packages/bim-kernel/__tests__/fixtures/sample-market";
import { emit, percentile, round, timeSync, type Counts, type Sample } from "./lib";

const args = process.argv.slice(2);
const arg = (name: string, fallback: string): string => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const tier = arg("tier", "250k");
const samplesPerRun = Number(arg("samples", "21"));
if (!(tier in FULL_BIM_TIERS)) throw new Error(`--tier must be one of ${Object.keys(FULL_BIM_TIERS).join(", ")}`);
const opts = FULL_BIM_TIERS[tier as keyof typeof FULL_BIM_TIERS];
const actor = { id: "perf", name: "Perf", kind: "human" as const };

/** The schedule's row floor: every `.10k` metric runs on at least this many rows. */
const SCHEDULE_ROWS = 10_000;
/** One scroll fetch / the first window a grid paints. */
const WINDOW_ROWS = 200;
const PASTE_CELLS = 500;
/** People opening the same schedule at once (the stress.commit.25 drill's head count). */
const JOINERS = 25;
/** The paste is two full passes of 500 edits per sample; a few samples are enough to see it. */
const PASTE_SAMPLES = Math.min(samplesPerRun, 3);
const FORMULA_ROWS = 10_000;
const FORMAT_CELLS = 100_000;
/** The base fields every root class gets (bim-kernel fields/providers/spatial.ts). */
const BASE_FIELD_PATHS = ["mark", "type_name", "family", "level", "room", "count"] as const;
/** tower-14: fixtures/mutinybim/profiles/tower-14.json → authoredOptions(profile), as in the registry test. */
const TOWER_14 = { floors: 14, zonesPerFloor: 2, modelId: "synthetic-tower-14" } as const;

// ------------------------------------------------------------------ engine under test

/** The rows of one open schedule, as a grid or the authority holds them. */
interface ScheduleRows {
  readonly rowCount: number;
  /** Element ids behind each row, in order. */
  readonly elementIds: readonly (readonly string[])[];
  /** `count` rows from `offset`, as cell text. */
  window(model: ModelState, offset: number, count: number): readonly (readonly string[])[];
}

interface ScheduleEngineUnderTest {
  readonly name: string;
  /** Open the schedule on this model state: every row evaluated. */
  build(model: ModelState, def: ScheduleDefinition): ScheduleRows;
  /** Bring open rows up to date after a commit that changed `changedIds`. */
  apply(rows: ScheduleRows, model: ModelState, def: ScheduleDefinition, changedIds: readonly string[]): ScheduleRows;
}

/**
 * Today: the evaluated rows are kept for the revision they were built on (a
 * window is a slice); any other revision, including after an edit, evaluates
 * the whole schedule again. The kernel caches its per-revision element index,
 * not the rows, sort or text.
 */
const V1_REBUILD: ScheduleEngineUnderTest = {
  name: "v1 evaluateSchedule (full rebuild per revision)",
  build(model, def) {
    const evaluated = evaluateSchedule(model, def);
    return {
      rowCount: evaluated.rows.length,
      elementIds: evaluated.elementIds,
      window: (at, offset, count) => (at.elements === model.elements ? evaluated.rows : evaluateSchedule(at, def).rows).slice(offset, offset + count),
    };
  },
  apply(_rows, model, def) {
    return V1_REBUILD.build(model, def);
  },
};

/**
 * The incremental row engine: the authority holds one session per open
 * schedule; an edit is `session.apply` (cost = the rows the change reaches),
 * a scroll is `session.window` (cost = the window, never the schedule).
 */
const V2_SESSION = new WeakMap<ScheduleRows, ScheduleSession>();
let v2Revision = 0;

function v2Text(set: RowSet, def: ScheduleDefinition): string[][] {
  const profile = scheduleProfile(scheduleV1ToV2(def));
  const columns = set.columns.map((c) => {
    const values = set.values.get(c.id);
    const fmt = c.quantityKind ? formatter(c.quantityKind, profile, c.unit ? { unit: c.unit } : undefined) : null;
    return (i: number): string => {
      if (!values) return "";
      if (values.type === "quantity") {
        const v = values.values[i] ?? Number.NaN;
        return Number.isNaN(v) ? "" : fmt ? fmt(v) : String(v);
      }
      if (values.type === "boolean") return values.values[i] === 1 ? "YES" : values.values[i] === 0 ? "NO" : "";
      return values.values[i] ?? "";
    };
  });
  const out: string[][] = [];
  for (let i = 0; i < set.rowCount; i++) out.push(columns.map((cell) => cell(i)));
  return out;
}

function v2Wrap(session: ScheduleSession, def: ScheduleDefinition, rowCount: number): ScheduleRows {
  const rows: ScheduleRows = {
    rowCount,
    get elementIds() {
      const all = session.rows();
      return all.rowElementIds ?? all.elementIds.map((id) => [id]);
    },
    window: (_model, offset, count) => v2Text(session.window(offset, count), def),
  };
  V2_SESSION.set(rows, session);
  return rows;
}

const V2_INCREMENTAL: ScheduleEngineUnderTest = {
  name: "v2 openSchedule + apply (incremental, read-set driven)",
  build(model, def) {
    const session = openSchedule(model, scheduleV1ToV2(def), { viewId: "perf", revision: ++v2Revision });
    return v2Wrap(session, def, session.window(0, 0).window?.totalRows ?? 0);
  },
  apply(rows, model, def, changedIds) {
    const session = V2_SESSION.get(rows);
    if (!session) return V2_INCREMENTAL.build(model, def);
    const patch = session.apply({ model, revision: ++v2Revision, changedIds });
    return v2Wrap(session, def, patch.order ? patch.order.length : rows.rowCount);
  },
};

const engine: ScheduleEngineUnderTest = V2_INCREMENTAL;

// ------------------------------------------------------------------ helpers

let seq = 0;
function commit(head: ModelState, command: Command): { model: ModelState; changedIds: readonly string[] } {
  seq += 1;
  const d = planCommit(head, [], { idempotencyKey: `perf-schedules-${seq}`, baseRevision: head.revision, actor, command: commandSchema.parse(command) });
  if (!d.ok) throw new Error(`[perf] ${command.type} refused: ${d.error.message}`);
  return { model: d.model, changedIds: [...d.changeset.elements.map((el) => el.id), ...(d.changeset.removedIds ?? [])] };
}

const COLLATOR = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/**
 * The smallest run of levels (bottom up) holding at least SCHEDULE_ROWS air
 * terminals, as a filter: the schedule stays whole-building in shape (several
 * storeys, every zone) at a row count that does not grow with the tier.
 */
function levelFilterForRows(levelOfRow: readonly string[], floor: number): ScheduleDefinition["filters"] {
  const perLevel = new Map<string, number>();
  for (const level of levelOfRow) perLevel.set(level, (perLevel.get(level) ?? 0) + 1);
  const levels = [...perLevel.keys()].sort((a, b) => COLLATOR.compare(a, b));
  let rows = 0;
  for (let i = 0; i < levels.length; i++) {
    rows += perLevel.get(levels[i] as string) ?? 0;
    const next = levels[i + 1];
    if (rows >= floor && next !== undefined) return [{ field: "level", op: "less_than", value: next }];
  }
  return [];
}

function cfmFor(i: number): number {
  return 100 + (i % 40) * 5;
}

// ------------------------------------------------------------------ formula + units workloads

const FORMULA_FIELDS: Readonly<Record<string, FieldSignature>> = {
  "own.mbh": { type: { type: "quantity", kind: "flow_gas_energy", unit: "MBH" } },
  load: { type: { type: "quantity", kind: "current", unit: "A" } },
  capacity_a: { type: { type: "quantity", kind: "current", unit: "A" } },
  load_class: { type: { type: "text" } },
};
const formulaSchema: FormulaSchema = { field: (path) => FORMULA_FIELDS[path], relationship: () => undefined };

function formulaInputs(): ColumnarInputs {
  const mbh = new Float64Array(FORMULA_ROWS);
  const load = new Float64Array(FORMULA_ROWS);
  const capacity = new Float64Array(FORMULA_ROWS);
  const classes: (string | null)[] = [];
  for (let i = 0; i < FORMULA_ROWS; i++) {
    mbh[i] = qty("flow_gas_energy", 40 + (i % 160), "MBH");
    load[i] = qty("current", 5 + (i % 40), "A");
    capacity[i] = i % 97 === 0 ? Number.NaN : qty("current", 20 + (i % 30), "A");
    classes.push(i % 4 === 0 ? "Motor" : "Lighting");
  }
  const fields = new Map<string, ValueColumn>([
    ["own.mbh", { type: "quantity", kind: "flow_gas_energy", values: mbh }],
    ["load", { type: "quantity", kind: "current", values: load }],
    ["capacity_a", { type: "quantity", kind: "current", values: capacity }],
    ["load_class", { type: "text", values: classes }],
  ]);
  return { rowCount: FORMULA_ROWS, fields, relations: new Map() };
}

/** Column kinds a schedule uses: a scaled own load, a motor 125% rule, a conditional highlight. */
const FORMULA_CASES: ReadonlyArray<readonly [string, string]> = [
  ["scale", "{own.mbh} * 1000"],
  ["motor_125", 'if({load_class} = "Motor", {load} * 1.25, {load})'],
  ["highlight", '{load} > 0.8 * coalesce({capacity_a}, 100 A) and not ({load_class} = "Spare")'],
];

function formatCases(): ReadonlyArray<readonly [string, Kind, DisplayProfile, Float64Array]> {
  return [
    ["cfm_grouped", "flow_air", PROFILE_US_DECIMAL_FEET, Float64Array.from({ length: FORMAT_CELLS }, (_, i) => toSI(50 + ((i * 7919) % 20000) + (i % 10) / 10, "cfm"))],
    ["mbh_1dp", "flow_gas_energy", PROFILE_US_DECIMAL_FEET, Float64Array.from({ length: FORMAT_CELLS }, (_, i) => toSI(((i * 31) % 4000) + 0.25, "MBH"))],
    ["ft_in_16th", "length", PROFILE_US_FEET_INCHES, Float64Array.from({ length: FORMAT_CELLS }, (_, i) => toSI(((i * 104729) % 50000) / 37, "ft"))],
  ];
}

// ------------------------------------------------------------------ main

async function main(): Promise<void> {
  const samples: Sample[] = [];
  const add = (metric: string, values: number[], counts?: Counts, note?: string, variant?: string): void => {
    samples.push({ metric, ...(variant ? { variant } : {}), values: values.map((v) => round(v, 3)), ...(counts ? { counts } : {}), ...(note ? { note } : {}) });
  };

  // Formula and units first: small heaps, no model in memory yet.
  const inputs = formulaInputs();
  for (const [label, source] of FORMULA_CASES) {
    const compiled = formulaEngine.compile(source, formulaSchema);
    if (!compiled.ok) throw new Error(`[perf] formula ${label} refused: ${compiled.errors.map((e) => e.message).join("; ")}`);
    for (let i = 0; i < 20; i++) formulaEngine.evaluateColumn(compiled.formula, inputs);
    const ms: number[] = [];
    for (let i = 0; i < Math.max(samplesPerRun, 40); i++) ms.push(timeSync(() => formulaEngine.evaluateColumn(compiled.formula, inputs)).ms);
    add("schedule.formula.column.10k", ms, { affectedElements: FORMULA_ROWS }, `evaluateColumn of "${source}" over ${FORMULA_ROWS.toLocaleString("en-US")} rows, compiled once. affected = rows.`, label);
  }
  for (const [label, kind, profile, values] of formatCases()) {
    const format = formatter(kind, profile);
    let chars = 0;
    const once = () => {
      chars = 0;
      for (let i = 0; i < values.length; i++) chars += format(values[i] as number).length;
    };
    once();
    if (chars <= values.length) throw new Error(`[perf] units.format ${label}: formatter returned empty strings`);
    const ms: number[] = [];
    for (let i = 0; i < samplesPerRun; i++) ms.push(timeSync(once).ms);
    add("units.format.100k", ms, { affectedElements: FORMAT_CELLS }, `formatter(${kind}, ${profile.id}) over ${FORMAT_CELLS.toLocaleString("en-US")} cells. affected = cells.`, label);
  }

  // Class recognition: a fresh registry per sample, so every sample builds the index cold.
  {
    let tower: ModelState | null = createFullBimModel(TOWER_14);
    const towerElements = Object.keys(tower.elements).length;
    const ms: number[] = [];
    let classes = 0;
    for (let i = 0; i < samplesPerRun; i++) {
      const registry = builtinRegistryBuilder().build();
      const model: ModelState = tower;
      const t = timeSync(() => buildClassIndex(registry, model));
      ms.push(t.ms);
      classes = registry.listClasses().length;
    }
    add("registry.recognize.tower14", ms, { totalElements: towerElements }, `buildClassIndex over the tower-14 synthetic (${towerElements.toLocaleString("en-US")} elements, ${classes} built-in classes), cold: a fresh registry per sample.`);

    // Base fields (mark, type, family, level, room, count) read for every element through the provider registry, on a record nothing has read.
    const buildMs: number[] = [];
    for (let i = 0; i < 5; i++) buildMs.push(timeSync(() => fieldProviderRegistryBuilder().build()).ms);
    const providers = fieldProviderRegistryBuilder().build();
    const recognized = buildClassIndex(providers, tower);
    const readers: { readonly el: BimElement; readonly read: NonNullable<FieldDef["read"]> }[] = [];
    for (const el of Object.values(tower.elements)) {
      const cls = recognized.classesOf(el.id)[0];
      if (cls === undefined) continue;
      for (const path of BASE_FIELD_PATHS) {
        const read = providers.field(cls, path)?.read;
        if (read) readers.push({ el, read });
      }
    }
    const baseMs: number[] = [];
    let readElements = 0;
    for (let i = 0; i < samplesPerRun; i++) {
      const ctx = { elements: freezeElements(draftElements(tower.elements)) };
      readElements = new Set(readers.map((r) => r.el.id)).size;
      baseMs.push(timeSync(() => {
        let filled = 0;
        for (const r of readers) if (r.read(r.el, ctx) !== null) filled++;
        return filled;
      }).ms);
    }
    add("fields.base.read.tower", baseMs, { totalElements: towerElements, affectedElements: readElements }, `Base fields (${BASE_FIELD_PATHS.join(", ")}) read through fieldProviderRegistry() for every recognized element of tower-14 (${readers.length.toLocaleString("en-US")} reads), on a fresh record each sample. Registry build alone: p50 ${round(percentile(buildMs, 0.5) ?? Number.NaN, 2)} ms. affected = elements read.`);
    tower = null;
  }

  // The serves walk on the sample market: the water heater's served fixtures, on a revision nothing has read.
  {
    const build = sampleMarket();
    let market: ModelState = { modelId: "sample-market", revision: asRevision(0), elements: {}, connections: [], settings: DEFAULT_SETTINGS };
    for (const command of [...build.setup, sampleMarketLoadPointCommand(build.points)]) market = commit(market, command).model;
    const heater = market.elements[build.ids.heater];
    if (!heater) throw new Error("[perf] the sample market build has no water heater");
    const ms: number[] = [];
    let served = 0;
    for (let i = 0; i < Math.max(samplesPerRun, 40); i++) {
      const elements = freezeElements(draftElements(market.elements));
      const t = timeSync(() => servesOf(elements, heater).length);
      served = t.value;
      ms.push(t.ms);
    }
    if (served === 0) throw new Error("[perf] the sample market's water heater serves nothing");
    add("serves.index.sample_market", ms, { totalElements: Object.keys(market.elements).length, affectedElements: served }, `servesOf(water heater) on the sample market (${served} served, cold: a fresh record per sample, so gas, piping and electrical indexes build first). affected = served elements.`);
  }

  // ---------------------------------------------------------------- the schedule
  let head: ModelState = createFullBimModel(opts);
  const totalElements = Object.keys(head.elements).length;
  const columns = [{ field: "mark" }, { field: "type" }, { field: "level" }, { field: "cfm" }] as const;
  const whole = evaluateSchedule(head, { category: "air_terminal", columns });
  const levelColumn = whole.rows.map((r) => r[2] ?? "");
  const def: ScheduleDefinition = { category: "air_terminal", title: "Air terminal schedule (perf)", columns, filters: levelFilterForRows(levelColumn, SCHEDULE_ROWS) };
  let rows = engine.build(head, def);
  if (rows.rowCount < SCHEDULE_ROWS) throw new Error(`[perf] tier ${tier} has ${rows.rowCount} air terminal rows; the schedule metrics need ${SCHEDULE_ROWS}`);
  const rowCount = rows.rowCount;
  const inSchedule = new Set(rows.elementIds.flat());
  const outside = whole.elementIds.flat().filter((id) => !inSchedule.has(id));
  const editTargets = rows.elementIds.map((ids) => ids[0]).filter((id): id is string => id !== undefined);
  const counts: Counts = { totalElements, visibleSolids: rowCount };

  // Cold open: an edit outside the schedule makes a new revision, so nothing about this element record is cached.
  const coldMs: number[] = [];
  for (let i = 0; i < samplesPerRun; i++) {
    const target = outside[i % Math.max(1, outside.length)] ?? editTargets[i % editTargets.length];
    if (target === undefined) throw new Error("[perf] no terminal to edit");
    head = commit(head, { type: "set_terminal_cfm", terminalId: target, cfm: cfmFor(i) }).model;
    const model = head;
    const t = timeSync(() => {
      const opened = engine.build(model, def);
      return opened.window(model, 0, WINDOW_ROWS).length;
    });
    if (t.value !== WINDOW_ROWS) throw new Error(`[perf] first window returned ${t.value} rows`);
    coldMs.push(t.ms);
  }
  add("schedule.grid.cold.10k", coldMs, counts, `${engine.name}: open the schedule on a revision nothing has read yet, then the first ${WINDOW_ROWS}-row window. visible = schedule rows.`);

  // One cell edit: commit set_terminal_cfm on a row, then bring the open rows up to date (timed: the schedule side only).
  rows = engine.build(head, def);
  const patchMs: number[] = [];
  let lastChanged = 0;
  for (let i = 0; i < samplesPerRun; i++) {
    const target = editTargets[(i * 7919) % editTargets.length];
    if (target === undefined) throw new Error("[perf] no row to edit");
    const c = commit(head, { type: "set_terminal_cfm", terminalId: target, cfm: cfmFor(i + 1) });
    head = c.model;
    lastChanged = c.changedIds.length;
    const model = head;
    const before = rows;
    const t = timeSync(() => engine.apply(before, model, def, c.changedIds));
    rows = t.value;
    patchMs.push(t.ms);
  }
  add("schedule.patch.one_edit.10k", patchMs, { ...counts, affectedElements: lastChanged }, `${engine.name}: after a committed set_terminal_cfm on one row, the open rows brought up to date. affected = elements the commit changed.`);

  // Scroll fetch on open rows at the same revision.
  const windowMs: number[] = [];
  for (let i = 0; i < samplesPerRun; i++) {
    const offset = ((i * 104729) % Math.max(1, rowCount - WINDOW_ROWS)) | 0;
    const model = head;
    const open = rows;
    const t = timeSync(() => open.window(model, offset, WINDOW_ROWS).length);
    if (t.value !== WINDOW_ROWS) throw new Error(`[perf] window at ${offset} returned ${t.value} rows`);
    windowMs.push(t.ms);
  }
  add("schedule.authority.window.200", windowMs, counts, `${engine.name}: one ${WINDOW_ROWS}-row window from open rows at the current revision (a scroll).`);

  // 25 people join an open schedule at once: each gets the first window from the one shared session, back to back (one event-loop turn).
  const joinMs: number[] = [];
  for (let i = 0; i < samplesPerRun; i++) {
    const model = head;
    const open = rows;
    const t = timeSync(() => {
      let served = 0;
      for (let j = 0; j < JOINERS; j++) served += open.window(model, 0, WINDOW_ROWS).length;
      return served;
    });
    if (t.value !== JOINERS * WINDOW_ROWS) throw new Error(`[perf] ${JOINERS} joins served ${t.value} rows`);
    joinMs.push(t.ms);
  }
  add("schedule.join.25", joinMs, counts, `${engine.name}: ${JOINERS} first ${WINDOW_ROWS}-row windows from one open session, back to back (25 people opening the same schedule; the authority's event loop is held for the whole run).`);

  // Paste a 500-cell CFM column. Preview: the local prediction of every cell, then the rows. Commit: the durable path, then the rows.
  const previewMs: number[] = [];
  const pasteCommitMs: number[] = [];
  for (let s = 0; s < PASTE_SAMPLES; s++) {
    const cells: { type: "set_terminal_cfm"; terminalId: string; cfm: number }[] = [];
    for (let i = 0; i < PASTE_CELLS; i++) {
      const target = editTargets[(s * PASTE_CELLS + i * 13) % editTargets.length];
      if (target === undefined) throw new Error("[perf] no row to paste into");
      cells.push({ type: "set_terminal_cfm", terminalId: target, cfm: cfmFor(s + i + 2) });
    }
    const paste: Command = commandSchema.parse({ type: "batch_edits", label: `Paste ${PASTE_CELLS} CFM values`, commands: cells });
    const base = head;
    const preview = timeSync(() => {
      const r = executeCommand(base, paste);
      if (!r.ok) throw new Error(`[perf] paste preview refused: ${r.error.message}`);
      return engine.apply(rows, r.model, def, r.changedIds).rowCount;
    });
    previewMs.push(preview.ms);
    const committed = timeSync(() => {
      const c = commit(base, paste);
      return { model: c.model, open: engine.apply(rows, c.model, def, c.changedIds) };
    });
    head = committed.value.model;
    rows = committed.value.open;
    pasteCommitMs.push(committed.ms);
  }
  add("schedule.paste.500.preview", previewMs, { ...counts, affectedElements: PASTE_CELLS }, `${engine.name}: one batch_edits of ${PASTE_CELLS} set_terminal_cfm predicted (executeCommand), then the open rows.`);
  add("schedule.paste.500.commit", pasteCommitMs, { ...counts, affectedElements: PASTE_CELLS }, `${engine.name}: the same batch committed through planCommit (one revision, one changeset, one undo step), then the open rows.`);

  emit({
    suite: "schedules",
    workload: {
      tier,
      engine: engine.name,
      schedule: { category: def.category, rows: rowCount, filters: def.filters, columns: def.columns.map((c) => c.field) },
      windowRows: WINDOW_ROWS,
      pasteCells: PASTE_CELLS,
      pasteSamples: PASTE_SAMPLES,
      formulaRows: FORMULA_ROWS,
      formatCells: FORMAT_CELLS,
      tower14: TOWER_14,
    },
    network: "none (in-process)",
    participants: 1,
    samples,
  });
}

main().catch((err) => {
  console.error("[perf] schedules suite failed", err);
  process.exit(1);
});
