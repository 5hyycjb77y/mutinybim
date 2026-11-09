/**
 * @jest-environment node
 *
 * own / serves / source (SCHEDULES-PLAN §5d, Stream F) over the walks the
 * trades already run: a water heater serves what is beyond its hot outlets
 * (the walk that makes its inlet carry its hot side), a gas source or
 * regulator serves the appliances downstream of it (the Gas agent's zone
 * walk), a panel serves what its circuits and feeders serve. Formulas run
 * through `@permitzip/bim-formula` against the kernel registry, as a schedule
 * column does. Golden numbers: the 7492 sheets (fixtures/sample-market-*.ts).
 */
import { formulaEngine, type FormulaSchema, type RowValues } from "@permitzip/bim-formula";
import { fromCanonical, fromSI, toSI, type UnitCode } from "@permitzip/bim-units";
import { DEFAULT_SETTINGS, applyChangeset, buildClassIndex, canonicalJson, fieldProviderRegistry, loadPointId, planCommit, resolveField, type BimElement, type Changeset, type ClassIndex, type Command, type ModelState, type Registry } from "../src";
import { gasConnectionRows, gasNetwork } from "@permitzip/bim-pack-plumbing";
import { referenceBuilding, referenceDistribution } from "./fixtures/electrical-building";
import { SAMPLE_MARKET_FIXTURES, SAMPLE_MARKET_TOTALS, sampleMarketLoadPointCommand, sampleMarket } from "./fixtures/sample-market";
import { SAMPLE_MARKET_GAS_SYSTEM, SAMPLE_MARKET_GAS_TOTAL_MBH, buildSampleMarketGas } from "./fixtures/sample-market-gas";

type Elements = ModelState["elements"];

const registry = fieldProviderRegistry();
const r2 = (v: number) => Math.round(v * 100) / 100;

class Model {
  head: ModelState = { modelId: "serves", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  private readonly log: Changeset[] = [];
  private seq = 0;
  ok(command: Command): void {
    const d = planCommit(this.head, [], { idempotencyKey: `serves-${++this.seq}`, baseRevision: this.head.revision, actor: { id: "avery", name: "Avery", kind: "human" }, command }, () => "2026-10-25T00:00:00.000Z", this.log);
    if (!d.ok) throw new Error(`${command.type}: ${d.error.message}`);
    expect(canonicalJson(applyChangeset(this.head, d.changeset))).toBe(canonicalJson(d.model));
    this.head = d.model;
    this.log.push(d.changeset);
  }
}

function sampleMarketModel(): { m: Model; build: ReturnType<typeof sampleMarket> } {
  const m = new Model();
  const build = sampleMarket();
  for (const c of build.setup) m.ok(c);
  m.ok(sampleMarketLoadPointCommand(build.points));
  return { m, build };
}

// ---------------------------------------------------------------- the registry as a formula column sees it

function classesFor(index: ClassIndex, el: BimElement): readonly string[] {
  return index.classesOf(el.id);
}

function fieldOf(classes: readonly string[], path: string) {
  for (const c of classes) {
    const f = registry.field(c, path);
    if (f) return f;
  }
  return undefined;
}

function schemaFor(reg: Registry, classes: readonly string[], depth = 0): FormulaSchema {
  return {
    field: (path) => {
      const f = fieldOf(classes, path);
      if (!f) return undefined;
      if (f.valueType === "quantity" && f.kind && f.unit) return { type: { type: "quantity", kind: f.kind, unit: f.unit } };
      return { type: f.valueType === "boolean" ? { type: "boolean" } : { type: "text" } };
    },
    relationship: (name) => {
      const rel = reg.relationship(name);
      if (!rel?.resolve || depth > 1) return undefined;
      const to = rel.to === "any" ? reg.listClasses({ includeAbstract: true }).map((c) => c.id) : rel.to;
      return { label: rel.label, target: schemaFor(reg, to, depth + 1) };
    },
  };
}

function rowOf(elements: Elements, index: ClassIndex, el: BimElement): RowValues {
  const classes = classesFor(index, el);
  return {
    field: (path) => {
      const f = fieldOf(classes, path);
      const v = f?.read?.(el, { elements });
      if (typeof v === "number") return f?.kind && f.unit ? fromCanonical(f.kind, toSI(v, f.unit)) : null;
      return typeof v === "string" || typeof v === "boolean" ? v : null;
    },
    related: (name) => {
      const ids = registry.relationship(name)?.resolve?.(el, { elements }) ?? [];
      return ids.flatMap((id) => {
        const t = elements[id];
        return t ? [rowOf(elements, index, t)] : [];
      });
    },
  };
}

/** A formula column's value on one element, in `unit`. */
function evaluate(elements: Elements, id: string, expression: string, unit: UnitCode): number | null {
  const el = elements[id];
  if (!el) throw new Error(`no element ${id}`);
  const index = buildClassIndex(registry, { elements });
  const compiled = formulaEngine.compile(expression, schemaFor(registry, classesFor(index, el)));
  if (!compiled.ok) throw new Error(compiled.errors.map((e) => e.message).join("; "));
  const v = formulaEngine.evaluateRow(compiled.formula, rowOf(elements, index, el));
  return v.type === "quantity" ? fromSI(v.value, unit) : null;
}

const rel = (elements: Elements, id: string, name: string): readonly string[] => {
  const el = elements[id];
  if (!el) throw new Error(`no element ${id}`);
  return registry.relationship(name)?.resolve?.(el, { elements }) ?? [];
};

const read = (elements: Elements, id: string, cls: string, path: string) => {
  const el = elements[id];
  if (!el) throw new Error(`no element ${id}`);
  return registry.field(cls, path)?.read?.(el, { elements }) ?? null;
};

// ---------------------------------------------------------------- water heater

const HOT_FIXTURE_TOTAL = r2(SAMPLE_MARKET_FIXTURES.filter((r) => r.hot > 0).reduce((a, r) => a + r.qty * r.total, 0));

describe("a water heater serves what is beyond its hot outlets", () => {
  it("WH sum(serves, wsfu_total) is the fixtures on its hot side; sum of their hot units is what its inlet carries", () => {
    const { m, build } = sampleMarketModel();
    const els = m.head.elements;
    const hotPoints = build.points.filter((p) => p.system === "hot").map((p) => loadPointId(p.hostId, p.port));
    expect([...rel(els, build.ids.heater, "serves")].sort()).toEqual([...hotPoints].sort());
    expect(r2(evaluate(els, build.ids.heater, "sum(serves, {load.wsfu_total})", "WSFU") ?? NaN)).toBe(HOT_FIXTURE_TOTAL);
    expect(r2(evaluate(els, build.ids.heater, "sum(serves, {load.wsfu_hot})", "WSFU") ?? NaN)).toBe(SAMPLE_MARKET_TOTALS.hot);
    expect(evaluate(els, build.ids.heater, "count(serves)", "ea")).toBe(hotPoints.length);
    // The same walk: what the heater serves is what its cold inlet carries.
    expect(resolveField(els, build.ids.heaterInlet, "pipe.carries.wsfu_cold").value).toBe(SAMPLE_MARKET_TOTALS.hot);
  });

  it("removing a fixture updates it", () => {
    const { m, build } = sampleMarketModel();
    const k04 = build.points.find((p) => p.mark === "K04-1" && p.system === "hot");
    if (!k04) throw new Error("no K04 hot point");
    const id = loadPointId(k04.hostId, k04.port);
    const before = evaluate(m.head.elements, build.ids.heater, "sum(serves, {load.wsfu_total})", "WSFU") ?? NaN;
    const k04Total = read(m.head.elements, id, "mep.load_point", "load.wsfu_total");
    expect(typeof k04Total).toBe("number");
    m.ok({ type: "delete_elements", ids: [id], policy: "cascade" });
    expect(rel(m.head.elements, build.ids.heater, "serves")).not.toContain(id);
    expect(r2(evaluate(m.head.elements, build.ids.heater, "sum(serves, {load.wsfu_total})", "WSFU") ?? NaN)).toBe(r2(before - (k04Total as number)));
  });

  it("reads back: each hot connection's source is the heater, and the heater is the source of each", () => {
    const { m, build } = sampleMarketModel();
    const els = m.head.elements;
    const hot = build.points.find((p) => p.system === "hot");
    if (!hot) throw new Error("no hot point");
    const id = loadPointId(hot.hostId, hot.port);
    expect(rel(els, id, "source")).toEqual([build.ids.heater]);
    expect(rel(els, id, "served_by")).toEqual([build.ids.heater]);
    expect(rel(els, build.ids.heater, "source_of")).toContain(id);
    // A cold-only fixture is not on the heater.
    const cold = build.points.find((p) => p.mark === "P01-1" && p.system === "cold");
    if (!cold) throw new Error("no cold point");
    expect(rel(els, build.ids.heater, "serves")).not.toContain(loadPointId(cold.hostId, cold.port));
  });
});

describe("own counts on its own system; serves never adds into a system total", () => {
  it("the heater's own MBH is on the gas system while its served WSFU stays on the fixtures", () => {
    const gas = buildSampleMarketGas();
    const net = gasNetwork(gas, SAMPLE_MARKET_GAS_SYSTEM);
    if (!net) throw new Error("no gas network");
    // own.mbh: the heater burns 250 MBH, counted once on the gas system with every other appliance.
    expect(read(gas.elements, "gwh", "mep.plumbing_fixture", "own.mbh")).toBe(250);
    expect(r2(evaluate(gas.elements, "svc", "sum(serves, {own.mbh})", "MBH") ?? NaN)).toBe(r2(SAMPLE_MARKET_GAS_TOTAL_MBH));
    expect(r2(net.totalMbh)).toBe(r2(SAMPLE_MARKET_GAS_TOTAL_MBH));

    // Water: the hot system's total is its fixtures' hot units, and the cold service carries the fixtures' totals
    // once, not the fixtures plus the heater's served units again. The heater has no water load of its own.
    const { m, build } = sampleMarketModel();
    const els = m.head.elements;
    const served = evaluate(els, build.ids.heater, "sum(serves, {load.wsfu_hot})", "WSFU");
    expect(r2(served ?? NaN)).toBe(SAMPLE_MARKET_TOTALS.hot);
    expect(resolveField(els, build.ids.hwTrunk, "system.total.wsfu_hot").value).toBe(SAMPLE_MARKET_TOTALS.hot);
    expect(resolveField(els, build.ids.cwService, "pipe.carries.wsfu_cold").value).toBe(SAMPLE_MARKET_TOTALS.total);
    expect(read(els, build.ids.heater, "mep.plumbing_fixture", "load.wsfu_hot")).toBeNull();
    expect(read(els, build.ids.heater, "mep.plumbing_fixture", "load.wsfu_total")).toBeNull();
  });
});

describe("gas: source and serves from the Gas agent's walk", () => {
  const m = buildSampleMarketGas();
  const els = m.elements;
  const rows = gasConnectionRows(m);

  it("a gas appliance's source.developed_length equals the walk's length, and its source is the service", () => {
    expect(rows.length).toBe(6);
    for (const row of rows) {
      expect(read(els, row.elementId, "mep.plumbing_fixture", "source.developed_length") ?? read(els, row.elementId, "mep.equipment", "source.developed_length")).toBe(row.developedLengthFt);
      expect(rel(els, row.elementId, "source")).toEqual(["svc"]);
    }
    const k09a = rows.find((r) => r.elementId === "k09a");
    expect(k09a?.developedLengthFt).toBeGreaterThan(97);
    expect(read(els, "k09a", "mep.plumbing_fixture", "source.zone_length")).toBe(k09a?.zoneLengthFt);
    expect(read(els, "k09a", "mep.plumbing_fixture", "source.pressure")).toBe(11);
  });

  it("the service serves every appliance; the cook line regulator serves only the cook line", () => {
    expect([...rel(els, "svc", "serves")].sort()).toEqual(["doas", "gwh", "k07", "k08", "k09a", "k09b"]);
    expect([...rel(els, "LR-1", "serves")].sort()).toEqual(["k07", "k08", "k09a", "k09b"]);
    expect(rel(els, "AR-GWH", "serves")).toEqual(["gwh"]);
    expect([...rel(els, "k08", "served_by")].sort()).toEqual(["LR-1", "svc"]);
    expect(r2(evaluate(els, "LR-1", "sum(serves, {own.mbh})", "MBH") ?? NaN)).toBe(550);
    expect(evaluate(els, "svc", "max(serves, {source.developed_length})", "ft")).toBe(Math.max(...rows.map((r) => r.developedLengthFt)));
  });
});

describe("electrical: panels and feeders", () => {
  it("a board feeds what its feeders serve; a panel is fed from the board above it", () => {
    const b = referenceDistribution();
    const els = b.head.elements;
    expect(rel(els, "mdp", "serves")).toEqual(["h1", "t1"]);
    expect(rel(els, "mdp", "feeds")).toEqual(["h1", "t1"]);
    expect(rel(els, "l1", "fed_from")).toEqual(["t1"]);
    expect(rel(els, "f-h1", "serves")).toEqual(["h1"]);
    expect(rel(els, "h1", "served_by")).toEqual(["mdp"]);
  });

  it("sum(serves, {load}) on a panel is the loads on its circuits, read from the circuit engine", () => {
    const b = referenceBuilding();
    const els = b.head.elements;
    // RTU-1 24,000 + RTU-2 15,000 + MUA-1 10,000 + 40 lights x 40 W + 6 site lights x 150 W + K-3 9,000.
    expect(evaluate(els, "h1", "sum(serves, {load})", "VA")).toBe(60_500);
    expect(read(els, "rtu1", "mep.mechanical_equipment", "own.mca")).toBe(32);
    expect(read(els, "rtu1", "mep.mechanical_equipment", "own.va")).toBe(24_000);
  });
});
