/**
 * @jest-environment node
 *
 * The gravity regime (5c item d) on synthetic networks only: fixed-elevation
 * nodes, derived inverts, the segment that breaks the minimum slope, a pump
 * that resets the grade, the walk from touched nodes, and a load path that
 * aggregates downward with the same monoid electrical demand uses. Fails on
 * the code before 5c: `connections/regimes/` did not exist.
 */
import { accumulateBelow, sumMonoid } from "../src";
import { walkGravity, type GravityEdge, type GravityNetwork, type GravitySlopeRules } from "../src/connections/regimes";

/** 1 % everywhere, the adapter's rule (the regime knows no code). */
const ONE_PERCENT: GravitySlopeRules = { minSlope: () => 0.01 };

describe("a three-structure run to a fixed outfall", () => {
  // S1 → S2 → S3 → OUT, 30 m each. Outfall invert fixed at 0; S2 measured at 280 mm (needs 300).
  const run: GravityNetwork = {
    nodes: [{ id: "S1", topMm: 3000 }, { id: "S2", invertMm: 280, topMm: 2500 }, { id: "S3" }, { id: "OUT", invertMm: 0 }],
    edges: [
      { id: "e1", from: "S1", to: "S2", lengthMm: 30_000 },
      { id: "e2", from: "S2", to: "S3", lengthMm: 30_000 },
      { id: "e3", from: "S3", to: "OUT", lengthMm: 30_000 },
    ],
  };

  it("derives the free inverts at minimum slope and names the segment that is too flat", () => {
    const w = walkGravity(run, ONE_PERCENT);
    const byEdge = new Map(w.edges.map((e) => [e.edgeId, e]));
    expect(byEdge.get("e3")).toMatchObject({ status: "ok", upstreamInvertMm: 300, downstreamInvertMm: 0, fallMm: 300 });
    const e2 = byEdge.get("e2");
    expect(e2).toMatchObject({ status: "too_flat", upstreamInvertMm: 280, downstreamInvertMm: 300 });
    expect(e2?.shortfallMm).toBeCloseTo(320, 9); // it rises 20 mm and needs to fall 300
    expect(e2?.message).toMatch(/Segment e2 falls -20 mm over 30000 mm; it needs 300 mm \(320 mm more\)/);
    // S1 is free: it sits 1 % above S2's fixed invert.
    expect(byEdge.get("e1")).toMatchObject({ status: "ok", upstreamInvertMm: 580 });
    expect(w.nodes.find((n) => n.nodeId === "S1")?.depthMm).toBe(3000 - 580);
    expect(w.problems).toEqual([]);
  });

  it("a drop across a structure is taken before the next segment's fall", () => {
    const w = walkGravity(run, { minSlope: () => 0.01, dropAcrossMm: (n) => (n.id === "S3" ? 50 : 0) });
    expect(w.edges.find((e) => e.edgeId === "e3")).toMatchObject({ status: "ok", upstreamInvertMm: 300 });
    expect(w.edges.find((e) => e.edgeId === "e2")).toMatchObject({ status: "too_flat", downstreamInvertMm: 300 });
  });

  it("with no boundary below, every segment says so instead of guessing", () => {
    const open: GravityNetwork = { nodes: run.nodes.map((n) => (n.id === "OUT" ? { id: "OUT" } : n.id === "S2" ? { id: "S2" } : n)), edges: run.edges };
    const w = walkGravity(open, ONE_PERCENT);
    expect(w.edges.map((e) => e.status)).toEqual(["no_boundary", "no_boundary", "no_boundary"]);
    expect(w.edges[0]?.message).toMatch(/no fixed elevation below it/);
  });

  it("reports a node that drains two ways, and a loop", () => {
    const split: GravityNetwork = { nodes: run.nodes, edges: [...run.edges, { id: "e4", from: "S1", to: "S3", lengthMm: 10 }] };
    expect(walkGravity(split, ONE_PERCENT).problems[0]).toMatch(/S1 drains two ways \(e1 and e4\)/);
    const loop: GravityNetwork = { nodes: [{ id: "A" }, { id: "B" }], edges: [{ id: "ab", from: "A", to: "B", lengthMm: 10 }, { id: "ba", from: "B", to: "A", lengthMm: 10 }] };
    expect(walkGravity(loop, ONE_PERCENT).problems.join(" ")).toMatch(/loops back on itself/);
  });
});

describe("a pumped segment resets the grade", () => {
  // A (fixed 1000) → PIT (wet well, free) =pump=> HIGH → OUT (fixed 2000). The pump lifts the flow 1.3 m.
  const lifted: GravityNetwork = {
    nodes: [{ id: "A", invertMm: 1000 }, { id: "PIT" }, { id: "HIGH" }, { id: "OUT", invertMm: 2000 }],
    edges: [
      { id: "in", from: "A", to: "PIT", lengthMm: 20_000 },
      { id: "lift", from: "PIT", to: "HIGH", lengthMm: 5_000, pumped: true },
      { id: "out", from: "HIGH", to: "OUT", lengthMm: 10_000 },
    ],
  };

  it("the wet well sits below its inflow; the pumped segment is not slope-checked; downstream falls to the outfall", () => {
    const w = walkGravity(lifted, ONE_PERCENT);
    const byEdge = new Map(w.edges.map((e) => [e.edgeId, e]));
    expect(byEdge.get("in")).toMatchObject({ status: "ok", upstreamInvertMm: 1000, downstreamInvertMm: 800 });
    const lift = byEdge.get("lift");
    expect(lift).toMatchObject({ status: "pumped", upstreamInvertMm: 800, downstreamInvertMm: 2100, minSlope: null, message: null });
    expect(lift?.fallMm).toBe(-1300); // a rise: the pump makes it
    expect(byEdge.get("out")).toMatchObject({ status: "ok", upstreamInvertMm: 2100 });
  });

  it("without the pump the same run can't drain uphill", () => {
    const unpumped: GravityNetwork = { ...lifted, edges: lifted.edges.map((e): GravityEdge => (e.id === "lift" ? { id: e.id, from: e.from, to: e.to, lengthMm: e.lengthMm } : e)) };
    expect(walkGravity(unpumped, ONE_PERCENT).edges.find((e) => e.edgeId === "in")?.status).toBe("too_flat");
  });
});

describe("the walk from touched nodes (network.gravity.one_edit.tower)", () => {
  /** 40 storeys × 30 branches of 8 segments, each branch draining to its own stack node, stacks down to one fixed outfall. */
  function tower(): GravityNetwork {
    const nodes: { id: string; invertMm?: number }[] = [{ id: "OUT", invertMm: 0 }];
    const edges: GravityEdge[] = [];
    for (let f = 0; f < 40; f++) {
      nodes.push({ id: `stack-${f}` });
      edges.push({ id: `stack-${f}`, from: `stack-${f}`, to: f === 0 ? "OUT" : `stack-${f - 1}`, lengthMm: 1 });
      for (let b = 0; b < 30; b++) {
        for (let s = 0; s < 8; s++) {
          nodes.push({ id: `n-${f}-${b}-${s}` });
          edges.push({ id: `e-${f}-${b}-${s}`, from: `n-${f}-${b}-${s}`, to: s === 0 ? `stack-${f}` : `n-${f}-${b}-${s - 1}`, lengthMm: 1500 });
        }
      }
    }
    return { nodes, edges };
  }

  it("one edited branch end resolves its own run to the boundary, not the tower", () => {
    const net = tower();
    expect(net.edges.length).toBe(40 * 241);
    walkGravity(net, ONE_PERCENT, ["n-20-7-7"]); // the index is built once per network value
    // The median of 21 walks: one garbage-collection pause on a busy runner can't move it, a walk that rebuilds the tower does.
    const times: number[] = [];
    let w = walkGravity(net, ONE_PERCENT, ["n-20-7-7"]);
    for (let i = 0; i < 21; i++) {
      const t0 = performance.now();
      w = walkGravity(net, ONE_PERCENT, ["n-20-7-7"]);
      times.push(performance.now() - t0);
    }
    const ms = [...times].sort((a, b) => a - b)[10] ?? Number.POSITIVE_INFINITY;
    expect(w.edges.map((e) => e.edgeId)).toEqual([...Array.from({ length: 8 }, (_, s) => `e-20-7-${s}`), ...Array.from({ length: 21 }, (_, f) => `stack-${f}`)].sort((a, b) => net.edges.findIndex((e) => e.id === a) - net.edges.findIndex((e) => e.id === b)));
    expect(w.visitedNodes).toBeLessThanOrEqual(8 + 21 + 1);
    expect(w.edges.every((e) => e.status === "ok")).toBe(true);
    const full = walkGravity(net, ONE_PERCENT);
    expect(full.edges.length).toBe(net.edges.length);
    // Measured for the perf row; the structural bound above is the assertion.
    expect(ms).toBeLessThan(50);
  });
});

describe("a gravity-load network aggregates downward with the shared monoid", () => {
  it("a slab's load shares onto two beams, the beams onto columns, the columns onto one footing", () => {
    // Parents before children, from the support up. Each member's own load in kN.
    const order = ["footing", "col-a", "col-b", "beam-1", "beam-2", "slab"];
    const supports: Readonly<Record<string, readonly string[]>> = { footing: ["col-a", "col-b"], "col-a": ["beam-1", "beam-2"], "col-b": ["beam-2"], "beam-1": ["slab"], "beam-2": ["slab"], slab: [] };
    const own: Readonly<Record<string, number>> = { slab: 120, "beam-1": 6, "beam-2": 6, "col-a": 4, "col-b": 4, footing: 0 };
    /** The share of a member's total each support takes (tributary split, supplied by the structural adapter). */
    const share: Readonly<Record<string, number>> = { "slab>beam-1": 0.5, "slab>beam-2": 0.5, "beam-1>col-a": 1, "beam-2>col-a": 0.5, "beam-2>col-b": 0.5, "col-a>footing": 1, "col-b>footing": 1 };
    const totals = accumulateBelow(order, (n) => supports[n] ?? [], (n) => own[n], sumMonoid, (child, parent, total) => total * (share[`${child}>${parent}`] ?? 0));
    expect(totals.get("beam-2")).toBe(66);
    expect(totals.get("col-a")).toBe(4 + 66 + 33);
    expect(totals.get("footing")).toBe(140); // every kN lands once
  });
});
