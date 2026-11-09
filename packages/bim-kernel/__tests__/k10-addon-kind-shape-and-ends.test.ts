/**
 * @jest-environment node
 *
 * Round 10 lane K10: a firm's add-on adds a kind of part with its own stored
 * shape and connector ends, and the network joins it with zero kernel edits.
 * A test hydronic add-on registers a coil (in / out ends, one naming an end
 * type Mechanical registers) and a damper that hangs on a duct; a test add-on
 * with thirty kinds proves kinds past the index's per-kind codes still walk.
 *
 * Fails on round 9's code: the kind row has no `connectorEnds`, `shape` or
 * `anchor` faces, the index reads `DOWNSTREAM_ENDS` (five built-in kinds), so
 * the coil breaks the tree and its terminal reads as disconnected, and
 * `connectorPointOf` / `anchorOf` refuse or ignore the add-on's kind.
 */
import {
  ELEMENT_KIND_POINT,
  anchorOf,
  asConnectionId,
  asElementId,
  connectorEndsTable,
  connectorPointOf,
  elementKindRowProblems,
  elementsOfKind,
  findDisconnected,
  freezeElements,
  KERNEL_ELEMENT_KINDS,
  recomputeDerived,
  validateModel,
  type BimElement,
  type Connection,
  type ElementKindItem,
  type ModelState,
  type Vec2,
} from "@permitzip/bim-kernel";
import { CONNECTOR_END_TYPE_POINT } from "@permitzip/bim-kernel";
import { PackSet, contribute, definePack, PACK_CONTRACT_VERSION, withPackSet } from "../src/packs";
import { networkOf } from "../src/network";
import { computeAirflow } from "@permitzip/bim-pack-mechanical";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";

function isPoint(value: unknown): value is Vec2 {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "x") === "number" && typeof Reflect.get(value, "y") === "number";
}

/** The stored `position` of a record of a kind the union doesn't name. */
function positionOf(el: BimElement): Vec2 | null {
  const p: unknown = Reflect.get(el, "position");
  return isPoint(p) ? p : null;
}

const COIL: ElementKindItem = {
  kind: "k10hy.coil",
  label: "Coil",
  nature: "physical",
  shape: { fields: [{ name: "position", form: "point" }], points: (el) => [positionOf(el) ?? { x: 0, y: 0 }] },
  connectorEnds: {
    ends: [
      { end: "coil_in", role: "upstream", endTypes: ["mechanical.slip"] },
      { end: "coil_out", role: "downstream" },
    ],
    point: (el) => positionOf(el),
  },
};

const DAMPER: ElementKindItem = {
  kind: "k10hy.damper",
  label: "Damper",
  shape: { fields: [{ name: "hostRef", form: "id" }, { name: "position", form: "point" }] },
  connectorEnds: { hostedBy: { field: "hostRef" }, ends: [{ end: "on", role: "upstream" }, { end: "onward", role: "downstream" }], point: (el) => positionOf(el) },
  anchor: (el) => positionOf(el),
};

const HYDRONIC = definePack({ id: "k10hy", name: "Hydronic coils (test)", version: "1.0.0", kernel: `^${PACK_CONTRACT_VERSION}` }, [contribute(ELEMENT_KIND_POINT, [COIL, DAMPER])]);
const WITH_HYDRONIC = PackSet.create([HYDRONIC]);
const BASE_ONLY = PackSet.create([]);

/** A stored record of an add-on kind: a kind string and fields the kernel's types don't name. */
function record(fields: Record<string, unknown>): BimElement {
  const raw: Record<string, unknown> = { version: 1, authoredRev: {}, ...fields };
  return raw as unknown as BimElement;
}

interface Spliced {
  readonly model: ModelState;
  readonly terminalId: string;
  readonly upstreamId: string;
  readonly coilId: string;
}

/** The demo model with a coil spliced in front of one terminal (upstream end → coil_in, coil_out → terminal in). */
function withCoil(): Spliced {
  const demo = recomputeDerived(createDemoModel("k10-coil")).model;
  const terminal = elementsOfKind(demo.elements, "terminal")[0];
  if (!terminal) throw new Error("demo has no terminal");
  const feed = demo.connections.find((c) => (c.a.elementId === terminal.id && c.a.end === "in") || (c.b.elementId === terminal.id && c.b.end === "in"));
  if (!feed) throw new Error("terminal has no feed");
  const upstream = feed.a.elementId === terminal.id ? feed.b : feed.a;
  const coilId = asElementId("coil-1");
  const connections: Connection[] = demo.connections.filter((c) => c !== feed);
  connections.push({ id: asConnectionId("k10-c1"), a: upstream, b: { elementId: coilId, end: "coil_in" } });
  connections.push({ id: asConnectionId("k10-c2"), a: { elementId: coilId, end: "coil_out" }, b: { elementId: terminal.id, end: "in" } });
  const coil = record({ id: coilId, kind: "k10hy.coil", position: terminal.position });
  return { model: { ...demo, elements: freezeElements({ ...demo.elements, [coilId]: coil }), connections }, terminalId: terminal.id, upstreamId: upstream.elementId, coilId };
}

describe("k10-addon-kind-shape-and-ends", () => {
  it("the add-on's rows pass conformance, naming an end type Mechanical registers; an unregistered one is refused", () => {
    const endTypes = new Set(BASE_ONLY.items(CONNECTOR_END_TYPE_POINT).map((r) => r.id));
    expect(elementKindRowProblems([COIL, DAMPER], new Set<string>(KERNEL_ELEMENT_KINDS), endTypes)).toEqual([]);
    const bad: ElementKindItem = { ...COIL, kind: "k10hy.bad", connectorEnds: { ends: [{ end: "x", role: "upstream", endTypes: ["k10hy.nope"] }] } };
    expect(elementKindRowProblems([bad], new Set<string>(KERNEL_ELEMENT_KINDS), endTypes)).toEqual(["element kind k10hy.bad: connector end x names the end type k10hy.nope, which no add-on in the set registers"]);
  });

  it("the coil's ends join the tree: the terminal hangs under it, nothing is disconnected, the unit's air total is unchanged", () => {
    const { model, terminalId, upstreamId, coilId } = withCoil();
    const before = withPackSet(WITH_HYDRONIC, () => computeAirflow(recomputeDerived(createDemoModel("k10-coil")).model));
    withPackSet(WITH_HYDRONIC, () => {
      const net = networkOf(model);
      expect(net.isTree).toBe(true);
      expect(net.children(upstreamId)).toContain(coilId);
      expect(net.children(upstreamId)).not.toContain(terminalId);
      expect(net.children(coilId)).toEqual([terminalId]);
      expect(net.parent(terminalId)).toBe(coilId);
      expect(findDisconnected(model)).toEqual([]);
      const after = computeAirflow(model);
      for (const unit of elementsOfKind(model.elements, "equipment")) expect([unit.id, after.get(unit.id)]).toEqual([unit.id, before.get(unit.id)]);
      expect(connectorEndsTable().upstream("k10hy.coil")).toBe("coil_in");
      expect(connectorEndsTable().downstream("k10hy.coil")).toEqual(["coil_out"]);
    });
  });

  it("where the coil's ends and the coil sit come from its row", () => {
    const { model, terminalId, coilId } = withCoil();
    const coil = model.elements[coilId];
    const terminal = model.elements[terminalId];
    if (!coil || terminal?.kind !== "terminal") throw new Error("splice failed");
    withPackSet(WITH_HYDRONIC, () => {
      expect(connectorPointOf(model, coil, "coil_in")).toEqual(terminal.position);
      expect(connectorPointOf(model, coil, "coil_out")).toEqual(terminal.position);
      expect(anchorOf(coil)).toEqual(terminal.position);
    });
  });

  it("without the add-on the coil is kept exactly as stored and joins nothing (its terminal reads as cut off)", () => {
    const { model, terminalId, coilId } = withCoil();
    withPackSet(BASE_ONLY, () => {
      expect(connectorEndsTable().isNetworkKind("k10hy.coil")).toBe(false);
      expect(findDisconnected(model)).toContain(terminalId);
      expect(findDisconnected(model)).not.toContain(coilId);
      expect(anchorOf(model.elements[coilId] as BimElement)).toBeNull();
      const terminal = model.elements[terminalId];
      expect(JSON.stringify(model.elements[coilId])).toBe(JSON.stringify(record({ id: coilId, kind: "k10hy.coil", position: terminal ? positionOf(terminal) : null })));
      validateModel(model);
    });
  });

  it("a damper hangs on a duct through its stored host field, listed after the duct's own connections", () => {
    const demo = recomputeDerived(createDemoModel("k10-damper")).model;
    const duct = elementsOfKind(demo.elements, "duct_segment")[0];
    if (!duct) throw new Error("demo has no duct");
    const damperId = asElementId("damper-1");
    const model: ModelState = { ...demo, elements: freezeElements({ ...demo.elements, [damperId]: record({ id: damperId, kind: "k10hy.damper", hostRef: duct.id, position: duct.start }) }) };
    withPackSet(WITH_HYDRONIC, () => {
      const net = networkOf(model);
      expect(net.hostedTaps(duct.id)).toContain(damperId);
      expect(net.children(duct.id).at(-1)).toBe(damperId);
      expect(net.parent(damperId)).toBe(duct.id);
      expect(anchorOf(model.elements[damperId] as BimElement)).toEqual(duct.start);
    });
  });

  describe("thirty kinds with ends (past the index's per-kind codes)", () => {
    const N = 30;
    const rows: ElementKindItem[] = Array.from({ length: N }, (_, i) => ({
      kind: `k10ov.n${i}`,
      label: `Piece ${i}`,
      connectorEnds: i === 0 ? { root: true, ends: [{ end: "o", role: "downstream" }] } : { ends: [{ end: "i", role: "upstream" }, { end: "o", role: "downstream" }] },
    }));
    const pack = definePack({ id: "k10ov", name: "Thirty kinds (test)", version: "1.0.0", kernel: `^${PACK_CONTRACT_VERSION}` }, [contribute(ELEMENT_KIND_POINT, rows)]);
    const set = PackSet.create([pack]);

    it("a chain of one piece of each kind walks end to end, every piece reached, ranked root first", () => {
      const demo = createDemoModel("k10-thirty");
      const elements: Record<string, BimElement> = {};
      const connections: Connection[] = [];
      for (let i = 0; i < N; i++) {
        elements[`p${i}`] = record({ id: `p${i}`, kind: `k10ov.n${i}` });
        if (i > 0) connections.push({ id: asConnectionId(`k10ov-c${i}`), a: { elementId: asElementId(`p${i - 1}`), end: "o" }, b: { elementId: asElementId(`p${i}`), end: "i" } });
      }
      const model: ModelState = { ...demo, elements: freezeElements(elements), connections };
      withPackSet(set, () => {
        const net = networkOf(model);
        expect(net.isTree).toBe(true);
        for (let i = 0; i < N - 1; i++) expect([i, net.children(`p${i}`)]).toEqual([i, [`p${i + 1}`]]);
        expect(net.parent("p0")).toBeUndefined();
        expect(net.disconnected()).toEqual([]);
        expect(net.airflowRank(asElementId("p0"))).toBe(N - 1);
        expect(net.airflowRank(asElementId(`p${N - 1}`))).toBe(0);
      });
    });
  });
});
