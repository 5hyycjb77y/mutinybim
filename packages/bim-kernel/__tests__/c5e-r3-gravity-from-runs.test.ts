/**
 * @jest-environment node
 *
 * Round 3, lane B: the gravity regime's input built from drawn runs, with a
 * kernel-read pumped key (civil gap F). Fails on the code before: there was no
 * `gravityNetworkOf` and no `flow.pumped` reading, so a pack rebuilt the graph
 * from segment ends itself and couldn't mark a pumped segment.
 */
import { asElementId, type BimElement, type MepSystem, type PartInstance, type RunFitting, type RunSegment } from "../src";
import { gravityNetworkOf, PUMPED_SEGMENT_KEY, walkGravity } from "../src/connections/regimes";

const id = asElementId;
const base = { version: 1, authoredRev: {} };

function structure(pid: string, x: number, invertMm?: number): PartInstance {
  return { ...base, id: id(pid), kind: "part", typeId: id("pt"), levelId: id("lvl"), position: { x, y: 0 }, offsetMm: 0, rotationDeg: 0, mark: pid.toUpperCase(), values: invertMm === undefined ? {} : { "civtest.invert_elevation": invertMm } };
}

function pipe(sid: string, a: { x: number; z: number; to?: { elementId: string; port: string } }, b: { x: number; z: number; to?: { elementId: string; port: string } }, extra: Partial<RunSegment> = {}): RunSegment {
  return {
    ...base,
    id: id(sid),
    kind: "run_segment",
    domain: "pipe",
    systemId: id("sys"),
    levelId: id("lvl"),
    start: { x: a.x, y: 0, z: a.z },
    end: { x: b.x, y: 0, z: b.z },
    size: { shape: "pipe", nominalMm: 304.8, material: "pe" },
    links: { ...(a.to ? { start: { elementId: id(a.to.elementId), port: a.to.port } } : {}), ...(b.to ? { end: { elementId: id(b.to.elementId), port: b.to.port } } : {}) },
    branches: [],
    flow: 0,
    ...extra,
  };
}

/**
 * MH1 (invert 1000) → MH2 (free) → pumped → MH3 (free) → OF1 (outfall, invert 900).
 * The first pipe is drawn uphill (from MH2 to MH1); a branch from MH4 joins the last pipe through a hosted tap.
 */
function storm(): Record<string, BimElement> {
  const system: MepSystem = { ...base, id: id("sys"), kind: "mep_system", name: "Storm 1", systemKind: "civtest.storm", domain: "pipe" };
  const other: MepSystem = { ...base, id: id("sys-cw"), kind: "mep_system", name: "CW", systemKind: "domestic_cold_water", domain: "pipe" };
  const tap: RunFitting = { ...base, id: id("tap"), kind: "run_fitting", fittingType: "tap", label: "Wye", domain: "pipe", systemId: id("sys"), levelId: id("lvl"), position: { x: 70_000, y: 0, z: 0 }, ports: [], host: { segmentId: id("s3"), s: 10_000, side: 1 } };
  const els: BimElement[] = [
    system,
    other,
    structure("mh1", 0, 1000),
    structure("mh2", 30_000),
    structure("mh3", 60_000),
    structure("of1", 90_000, 900),
    structure("mh4", 70_000, 5000),
    pipe("s1", { x: 30_000, z: 0, to: { elementId: "mh2", port: "in" } }, { x: 0, z: 0, to: { elementId: "mh1", port: "out" } }),
    pipe("s2", { x: 30_000, z: 0, to: { elementId: "mh2", port: "out" } }, { x: 60_000, z: 0, to: { elementId: "mh3", port: "in" } }, { values: { [PUMPED_SEGMENT_KEY]: true } }),
    pipe("s3", { x: 60_000, z: 0, to: { elementId: "mh3", port: "out" } }, { x: 90_000, z: 0, to: { elementId: "of1", port: "in" } }),
    pipe("b1", { x: 70_000, z: 0, to: { elementId: "mh4", port: "out" } }, { x: 70_000, z: 0, to: { elementId: "tap", port: "branch" } }, { start: { x: 70_000, y: 10_000, z: 0 } }),
    pipe("cw1", { x: 0, z: 0 }, { x: 5000, z: 0 }, { systemId: id("sys-cw") }),
    tap,
  ];
  return Object.fromEntries(els.map((e) => [e.id, e]));
}

const invertOf = (p: PartInstance): number | undefined => {
  const v = p.values["civtest.invert_elevation"];
  return typeof v === "number" ? v : undefined;
};

describe("the gravity network of a service's drawn runs", () => {
  const elements = storm();
  const g = gravityNetworkOf(elements, { systemKinds: ["civtest.storm"], fixedInvertMm: invertOf, outfalls: ["of1"] });

  it("joins segments through the parts and fittings they link to, orients them to the outfall, and reads the pumped key", () => {
    const edges = new Map(g.network.edges.map((e) => [e.id, e]));
    expect(edges.get("s1")).toMatchObject({ from: "mh1", to: "mh2", lengthMm: 30_000 }); // drawn uphill, read downstream
    expect(edges.get("s2")).toMatchObject({ from: "mh2", to: "mh3", pumped: true });
    expect(edges.get("s3")).toMatchObject({ from: "mh3", to: "of1" });
    expect(edges.get("b1")).toMatchObject({ from: "mh4", to: "tap", lengthMm: 10_000 });
    expect(edges.get("s3~tap")).toMatchObject({ from: "tap", to: "of1", lengthMm: 20_000 });
    expect(g.segmentOf.get("s3~tap")).toBe("s3");
    expect(edges.has("cw1")).toBe(false); // another service
    expect(g.nodeOf("mh2")).toBe("mh2");
    expect(g.network.nodes.find((n) => n.id === "mh1")).toEqual({ id: "mh1", invertMm: 1000 });
  });

  it("walks: the pump resets the grade, so the run upstream of it is checked to its wet well", () => {
    const w = walkGravity(g.network, { minSlope: () => 0.005 });
    const by = new Map(w.edges.map((e) => [e.edgeId, e]));
    expect(by.get("s1")).toMatchObject({ status: "ok", upstreamInvertMm: 1000, downstreamInvertMm: 850 });
    expect(by.get("s2")?.status).toBe("pumped");
    // MH3 derives from the outfall: 900 + 0.5 % of 30 m.
    expect(by.get("s3")).toMatchObject({ status: "ok", upstreamInvertMm: 1050, downstreamInvertMm: 900 });
    // The branch's tap sits 20 m up the trunk from the outfall: 1000; MH4 is at 5000, plenty of fall.
    expect(by.get("b1")).toMatchObject({ status: "ok", downstreamInvertMm: 1000 });
    expect(w.problems).toEqual([]);
  });

  it("without outfalls, each segment runs from its higher end to its lower", () => {
    const els = storm();
    const s1 = els["s1"];
    if (s1?.kind !== "run_segment") throw new Error("s1");
    els["s1"] = { ...s1, start: { ...s1.start, z: -200 }, end: { ...s1.end, z: 100 } };
    const edge = gravityNetworkOf(els, { systemKinds: ["civtest.storm"] }).network.edges.find((e) => e.id === "s1");
    expect(edge).toMatchObject({ from: "mh1", to: "mh2" });
  });
});
