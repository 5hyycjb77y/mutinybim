/**
 * @jest-environment node
 *
 * The looped-network solve hook (5c item d) on synthetic networks: a 2-loop
 * grid balanced by successive loop corrections through `solveNetwork`, one
 * that can't settle within its pass limit and says so, and the refusals.
 * Fails on the code before 5c: `TradeAdapter.solve` was declared and never
 * called, and there was no driver.
 */
import { BUILTIN_SERVICE_REGISTRY, DEFAULT_SETTINGS, NETWORK_ADAPTER_POINT, serviceById, withServiceRows, type ModelState, type TradeAdapter } from "../src";
import { PackSet, contribute, definePack, withPackSet } from "../src/packs";
import { iterateToConvergence, solveLoopNetwork, solveNetwork, type LoopEdge, type NetworkSolveProblem } from "../src/connections/solve";

const EMPTY: ModelState = { modelId: "solve-test", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };

/**
 * Two loops sharing the edge B–E:
 *
 *   A ── B ── C
 *   │    │    │
 *   D ── E ── F
 *
 * Supply 100 at A; draws 30 at C, 40 at F, 30 at D. Drop = r·Q|Q| (a square law).
 */
const R: Readonly<Record<string, number>> = { AB: 2, BC: 1, AD: 4, BE: 3, CF: 2, DE: 1, EF: 5 };
const GRID_EDGES: readonly LoopEdge[] = [
  { id: "AB", from: "A", to: "B" },
  { id: "BC", from: "B", to: "C" },
  { id: "AD", from: "A", to: "D" },
  { id: "BE", from: "B", to: "E" },
  { id: "CF", from: "C", to: "F" },
  { id: "DE", from: "D", to: "E" },
  { id: "EF", from: "E", to: "F" },
];
const squareLaw = (edge: LoopEdge, q: number) => {
  const r = R[edge.id] ?? 1;
  return { drop: r * q * Math.abs(q), slope: 2 * r * Math.abs(q) + 1e-12 };
};
const grid: NetworkSolveProblem = {
  nodes: [{ id: "A", demand: -100 }, { id: "B" }, { id: "C", demand: 30 }, { id: "D", demand: 30 }, { id: "E" }, { id: "F", demand: 40 }],
  edges: GRID_EDGES,
  drop: squareLaw,
  reference: { nodeId: "A", potential: 50_000 },
};

function netAt(flows: Readonly<Record<string, number>>, node: string): number {
  let out = 0;
  for (const e of GRID_EDGES) {
    if (e.from === node) out += flows[e.id] ?? 0;
    if (e.to === node) out -= flows[e.id] ?? 0;
  }
  return out;
}

describe("a 2-loop grid through the solve hook", () => {
  const ADAPTER = "c5e.loop_test";
  const SERVICE = "test.loop_grid";
  const base = serviceById("domestic_cold_water");
  if (!base) throw new Error("the built-in cold water row");
  const registry = withServiceRows(BUILTIN_SERVICE_REGISTRY, [{ ...base, id: SERVICE, label: "Test loop grid", adapter: ADAPTER }], { source: "pack" });
  const adapter: TradeAdapter = {
    trade: "plumbing",
    source: () => null,
    connectors: () => [],
    positionsNeeded: () => null,
    refusal: () => null,
    positionsRefusal: () => null,
    solve: (model) => (model === EMPTY ? grid : null),
  };
  // A pack's adapter (round 6: no global registration), in force inside its set.
  const SET = PackSet.create([definePack({ id: "c5e", name: "Loop test", version: "1.0.0", kernel: "^1.3.0" }, [contribute(NETWORK_ADAPTER_POINT, [{ id: ADAPTER, adapter }])])]);

  it("converges: every node balances, every loop's drops sum to zero, potentials fall from the source", () => {
    const r = withPackSet(SET, () => solveNetwork(EMPTY, SERVICE, { registry, options: { tolerance: 1e-9 } }));
    if (r.status !== "converged") throw new Error(`expected converged, got ${r.status}: ${"message" in r ? r.message : ""}`);
    expect(r.loops).toBe(2);
    expect(r.iterations).toBeGreaterThan(1);
    const f = r.flows;
    expect(netAt(f, "A")).toBeCloseTo(100, 9);
    for (const [n, d] of [["B", 0], ["C", -30], ["D", -30], ["E", 0], ["F", -40]] as const) expect(netAt(f, n)).toBeCloseTo(d, 9);
    const d = (id: string) => squareLaw({ id, from: "", to: "" }, f[id] ?? 0).drop;
    expect(d("AB") + d("BE") - d("DE") - d("AD")).toBeCloseTo(0, 6);
    expect(d("BC") + d("CF") - d("EF") - d("BE")).toBeCloseTo(0, 6);
    expect(r.potentials?.A).toBe(50_000);
    expect(r.potentials?.F).toBeCloseTo(50_000 - d("AB") - d("BC") - d("CF"), 6);
    expect(r.message).toBeNull();
  });

  it("can't settle within two passes at a tight tolerance, and says so rather than returning flows as a result", () => {
    const r = withPackSet(SET, () => solveNetwork(EMPTY, SERVICE, { registry, options: { maxIterations: 2, tolerance: 1e-12 } }));
    expect(r.status).toBe("not_converged");
    expect("message" in r ? r.message : "").toMatch(/^Test loop grid network didn't settle within 2 passes \(the largest loop correction is still .*\); its flows are not a result$/);
  });

  it("a service whose adapter has no solve, and an unknown service, say so", () => {
    expect(solveNetwork(EMPTY, "domestic_cold_water")).toEqual({ status: "no_solver", message: "Domestic cold water has no looped-network solve; it is totalled as a tree" });
    expect(solveNetwork(EMPTY, "nope.nothing").status).toBe("unknown_service");
  });
});

describe("the driver and the problem checks", () => {
  it("iterateToConvergence reports divergence the moment a residual stops being a number", () => {
    const r = iterateToConvergence(1, (s) => ({ next: s * 2, residual: s > 4 ? Number.POSITIVE_INFINITY : 1 }), { maxIterations: 50, tolerance: 1e-6 });
    expect(r).toMatchObject({ status: "diverged", iterations: 4, state: 8 });
  });

  it("refuses an unbalanced network, a disconnected one, and a method it can't run, by name", () => {
    expect(solveLoopNetwork({ ...grid, nodes: grid.nodes.map((n) => (n.id === "A" ? { id: "A", demand: -90 } : n)) })).toMatchObject({ status: "invalid", message: expect.stringMatching(/draws more than it is supplied/) });
    expect(solveLoopNetwork({ ...grid, nodes: [...grid.nodes, { id: "Z" }] })).toMatchObject({ status: "invalid", message: expect.stringMatching(/Z isn't connected to A/) });
    expect(solveLoopNetwork({ ...grid, method: "newton_nodal" })).toMatchObject({ status: "invalid", message: expect.stringMatching(/"newton_nodal" solve, which this version can't run/) });
  });

  it("a loop that loses nothing for any flow breaks down loudly", () => {
    const r = solveLoopNetwork({ ...grid, drop: () => ({ drop: 0, slope: 0 }) });
    expect(r).toMatchObject({ status: "diverged", message: expect.stringMatching(/loses nothing for any flow/) });
  });

  it("a tree (no loops) is already balanced in one pass", () => {
    const tree: NetworkSolveProblem = { nodes: [{ id: "S", demand: -5 }, { id: "T", demand: 5 }], edges: [{ id: "ST", from: "S", to: "T" }], drop: squareLaw };
    expect(solveLoopNetwork(tree)).toMatchObject({ status: "converged", iterations: 1, loops: 0, flows: { ST: 5 } });
  });
});
