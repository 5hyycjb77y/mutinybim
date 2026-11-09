import { fromCanonical, qty, type Quantity } from "@permitzip/bim-units";
import { IncrementalTotals, networkTotals, sumMonoid, type BimElement, type ModelState, type NetworkAdapter, type NetworkAdapterItem, type NetworkQuantities } from "@permitzip/bim-pack/runtime";
import { gravityNetworkOf, walkGravity, type GravityEdgeResult, type GravityModelNetwork, type GravityNetwork } from "@permitzip/bim-kernel/connections";
import { CIVIL_CLASS, CIVIL_PARAM, CIVIL_RUNOFF, CIVIL_STORM_ADAPTER, CIVIL_STORM_SERVICE } from "./ids";
import { manningFullFlow, manningNFor } from "./manning";
import { readCivilSite, type CivilSite } from "./model";
import { rationalRunoff } from "./runoff";

/**
 * The storm network: catchment runoff carried inlet → pipe → manhole →
 * outfall. The pack declares it to the kernel as a network to total
 * (`CIVIL_STORM_NETWORK`, the network adapter point's `aggregation` face), so
 * `serviceNetworkTotals(model, "civil.storm")` totals it with the kernel's
 * own monoid walk; `solveStormNetwork` reads the same graph and adds what a
 * total can't say (per-pipe flow, capacity, fall).
 *
 * The graph is the kernel's (`gravityNetworkOf`): the storm system's run
 * segments joined through the parts and fittings they link to, oriented toward
 * the outfalls, so a pipe drawn uphill still reads downstream and its rise
 * shows up as a slope finding; a segment marked `flow.pumped` is a pumped
 * edge. The fall check is the kernel's gravity regime (`walkGravity`) on that
 * graph: structures carry their inverts, a fitting or a structure with no
 * invert takes the lowest that still falls to the one below.
 */

type Elements = Readonly<Record<string, BimElement>>;

/** The pack's minimum slope when neither the call nor the storm system gives one (`MIN_SLOPE_CRITERION`). */
export const DEFAULT_MIN_SLOPE: Quantity<"slope"> = qty("slope", 0.5, "%");

export interface StormOptions {
  /** The design intensity. Absent: the storm system's `civil.design_intensity`. */
  readonly intensity?: Quantity<"rainfall_intensity">;
  readonly minSlope?: Quantity<"slope">;
}

/** The storm network as a graph: who drains where, and what each structure takes in from the surface. */
export interface StormGraph {
  readonly site: CivilSite;
  readonly intensity: Quantity<"rainfall_intensity"> | null;
  readonly minSlope: Quantity<"slope">;
  readonly outfalls: readonly string[];
  /** The kernel's gravity input for the storm runs, with its maps back to the model. */
  readonly runs: GravityModelNetwork;
  /** Each node's downstream node; null at an outfall. Nodes (structures, fittings) that reach no outfall are absent. */
  readonly downstream: ReadonlyMap<string, string | null>;
  readonly upstream: ReadonlyMap<string, readonly string[]>;
  readonly catchmentRunoff: ReadonlyMap<string, Quantity<"flow_liquid">>;
  /** Runoff from the catchments that drain straight to a structure, m³/s. */
  readonly surface: ReadonlyMap<string, number>;
  readonly drainsTo: ReadonlyMap<string, string>;
  readonly problems: readonly string[];
}

const graphs = new WeakMap<Elements, WeakMap<StormOptions, StormGraph>>();
const NO_OPTIONS: StormOptions = {};

/** The storm graph of a model state, built once per elements record (and options object). */
export function stormGraph(elements: Elements, opts: StormOptions = NO_OPTIONS): StormGraph {
  let byOpts = graphs.get(elements);
  const hit = byOpts?.get(opts);
  if (hit) return hit;
  const graph = buildGraph(elements, opts);
  if (!byOpts) {
    byOpts = new WeakMap();
    graphs.set(elements, byOpts);
  }
  byOpts.set(opts, graph);
  return graph;
}

function buildGraph(elements: Elements, opts: StormOptions): StormGraph {
  const site = readCivilSite(elements);
  const problems = [...site.problems];
  const outfalls = site.structures.filter((s) => s.classId === CIVIL_CLASS.outfall).map((s) => s.id);
  if (outfalls.length === 0) problems.push("The storm network has no outfall, so nothing can be totalled");
  if (site.systems.length > 1) problems.push(`The model has ${site.systems.length} storm systems; the first one's design storm is used for all`);
  const system = site.systems[0];
  const intensity = opts.intensity ?? system?.intensity ?? null;
  if (intensity === null) problems.push("No design rainfall intensity is set on the storm system, so runoff can't be found");
  const minSlope = opts.minSlope ?? system?.minSlope ?? DEFAULT_MIN_SLOPE;

  const invertOf = (part: { readonly values: Readonly<Record<string, unknown>> }): number | undefined => {
    const v = part.values[CIVIL_PARAM.invertElevation];
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  };
  const rimOf = (part: { readonly values: Readonly<Record<string, unknown>> }): number | undefined => {
    const v = part.values[CIVIL_PARAM.rimElevation];
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  };
  const runs = gravityNetworkOf(elements, { systemKinds: [CIVIL_STORM_SERVICE], fixedInvertMm: invertOf, topMm: rimOf, outfalls });

  // Who drains where, from the kernel's oriented edges; then what reaches an outfall.
  const down = new Map<string, string>();
  for (const e of runs.network.edges) {
    const other = down.get(e.from);
    if (other !== undefined && other !== e.to) {
      problems.push(`${e.from} drains two ways; a gravity network needs one way down from each structure`);
      continue;
    }
    down.set(e.from, e.to);
  }
  const up = new Map<string, string[]>();
  for (const [from, to] of down) {
    const list = up.get(to) ?? [];
    list.push(from);
    up.set(to, list);
  }
  const downstream = new Map<string, string | null>();
  const upstream = new Map<string, string[]>();
  const queue: string[] = [];
  for (const o of outfalls) {
    if (downstream.has(o)) continue;
    downstream.set(o, null);
    queue.push(o);
  }
  for (let i = 0; i < queue.length; i++) {
    const at = queue[i];
    if (at === undefined) continue;
    for (const n of up.get(at) ?? []) {
      if (downstream.has(n)) continue;
      downstream.set(n, at);
      const list = upstream.get(at) ?? [];
      list.push(n);
      upstream.set(at, list);
      queue.push(n);
    }
  }
  for (const s of site.structures) if (!downstream.has(s.id)) problems.push(`${s.name} doesn't drain to an outfall`);

  const catchmentRunoff = new Map<string, Quantity<"flow_liquid">>();
  const surface = new Map<string, number>();
  const drainsTo = new Map<string, string>();
  for (const c of site.catchments) {
    if (c.c === null || intensity === null || !c.drainsTo) continue;
    const q = rationalRunoff(c.c, intensity, c.area);
    catchmentRunoff.set(c.id, q);
    drainsTo.set(c.id, c.drainsTo);
    surface.set(c.drainsTo, (surface.get(c.drainsTo) ?? 0) + q);
  }
  return { site, intensity, minSlope, outfalls, runs, downstream, upstream, catchmentRunoff, surface, drainsTo, problems: [...new Set(problems)] };
}

/** The graph as the kernel's network face: roots are outfalls, children what drains into a node, own its surface runoff (m³/s under `civil.runoff`). */
export function stormNetworkAdapter(graph: StormGraph): NetworkAdapter<string, NetworkQuantities> {
  return {
    roots: () => graph.outfalls,
    children: (n) => graph.upstream.get(n) ?? [],
    ownQuantities: (n) => ({ [CIVIL_RUNOFF]: graph.surface.get(n) ?? 0 }),
  };
}

/** The civil network adapter: a physical storm network the kernel totals (no served-from links). */
export const CIVIL_STORM_NETWORK: NetworkAdapterItem = {
  id: CIVIL_STORM_ADAPTER,
  aggregation: {
    quantities: [CIVIL_RUNOFF],
    direction: "downstream",
    over: ["physical"],
    network(model: ModelState) {
      const graph = stormGraph(model.elements);
      if (graph.site.structures.length === 0) return null;
      if (graph.intensity === null) {
        console.error("[civil/network] storm network totalled with no design intensity: runoff reads 0", { modelId: model.modelId });
      }
      return stormNetworkAdapter(graph);
    },
  },
};

export interface StormPipeResult {
  readonly id: string;
  /** Upstream structure. */
  readonly from: string;
  /** Downstream structure. */
  readonly to: string;
  readonly length: Quantity<"length">;
  /** What the pipe carries: the total at its upstream structure. Null when runoff couldn't be found. */
  readonly flow: Quantity<"flow_liquid"> | null;
  /** Manning full-flow capacity at its actual slope; null without a size or with no fall. */
  readonly capacity: Quantity<"flow_liquid"> | null;
  readonly gravity: GravityEdgeResult | null;
}

export interface StormNetworkResult extends StormGraph {
  /** Runoff from the catchments that drain straight to a structure. */
  readonly surfaceRunoff: ReadonlyMap<string, Quantity<"flow_liquid">>;
  /** A structure's surface runoff plus everything upstream of it (kernel `networkTotals`). */
  readonly totalRunoff: ReadonlyMap<string, Quantity<"flow_liquid">>;
  readonly pipes: readonly StormPipeResult[];
  readonly gravity: GravityNetwork;
  /** Totals kept current one catchment edit at a time: O(depth to the outfall), never a re-walk. */
  incremental(): StormIncrementalTotals;
}

export class StormIncrementalTotals {
  constructor(
    private readonly totals: IncrementalTotals<string>,
    private readonly drainsTo: ReadonlyMap<string, string>,
    private readonly catchment: Map<string, number>,
  ) {}

  totalAt(structureId: string): Quantity<"flow_liquid"> {
    return fromCanonical("flow_liquid", this.totals.totalOf(structureId));
  }

  /** A catchment's runoff changed; returns the structures whose totals changed, nearest first. */
  setCatchmentRunoff(catchmentId: string, runoff: Quantity<"flow_liquid">): readonly string[] {
    const at = this.drainsTo.get(catchmentId);
    if (at === undefined || !this.totals.has(at)) {
      console.error("[civil/network] catchment edit outside the network", { catchmentId });
      throw new Error(`Catchment ${catchmentId} doesn't drain into this storm network`);
    }
    const before = this.catchment.get(catchmentId) ?? 0;
    this.catchment.set(catchmentId, runoff);
    return this.totals.setOwn(at, this.totals.ownOf(at) - before + runoff);
  }
}

/** Read the model's storm elements, carry runoff down to the outfalls, and check every pipe's fall and capacity. */
export function solveStormNetwork(elements: Elements, opts: StormOptions = NO_OPTIONS): StormNetworkResult {
  const graph = stormGraph(elements, opts);
  const { site, upstream, surface } = graph;
  const problems = [...graph.problems];
  const numeric: NetworkAdapter<string> = { roots: () => graph.outfalls, children: (n) => upstream.get(n) ?? [], ownQuantities: (n) => surface.get(n) ?? 0 };
  const totals = graph.intensity === null ? new Map<string, number>() : networkTotals(numeric, sumMonoid);
  const totalRunoff = new Map([...totals].map(([id, v]) => [id, fromCanonical("flow_liquid", v)]));
  const surfaceRunoff = new Map([...surface].map(([id, v]) => [id, fromCanonical("flow_liquid", v)]));

  const pipeById = new Map(site.pipes.map((p) => [p.id, p]));
  const gravity = graph.runs.network;
  const walked = walkGravity(gravity, { minSlope: () => graph.minSlope });
  problems.push(...walked.problems);
  const findingOf = new Map(walked.edges.map((e) => [e.edgeId, e]));

  const pipes = gravity.edges.map((e): StormPipeResult => {
    const pipe = pipeById.get(graph.runs.segmentOf.get(e.id) ?? e.id);
    const finding = findingOf.get(e.id) ?? null;
    const flow = totalRunoff.get(e.from) ?? null;
    let capacity: Quantity<"flow_liquid"> | null = null;
    if (pipe?.diameter && finding?.slope !== null && finding?.slope !== undefined && finding.slope > 0) {
      capacity = manningFullFlow(pipe.diameter, fromCanonical("slope", finding.slope), pipe.manningN ?? manningNFor(pipe.material)).capacity;
    }
    return { id: e.id, from: e.from, to: e.to, length: qty("length", e.lengthMm, "mm"), flow, capacity, gravity: finding };
  });

  const parentOf = new Map<string, string | null>(graph.downstream);
  return {
    ...graph,
    problems: [...new Set(problems)],
    surfaceRunoff,
    totalRunoff,
    pipes,
    gravity,
    incremental: () => {
      if (site.structures.length === 0) throw new Error("This model has no storm structures to total");
      return new StormIncrementalTotals(IncrementalTotals.build(numeric, parentOf), graph.drainsTo, new Map([...graph.catchmentRunoff]));
    },
  };
}
