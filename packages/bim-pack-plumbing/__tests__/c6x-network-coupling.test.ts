/**
 * @jest-environment node
 *
 * c6x-network-coupling: the water heater's coupling (its hot side carried on
 * its cold inlet, the combined fixture-unit adjustment where a fixture's two
 * sides meet) is this add-on's `kernel.network_coupling` row, read by the
 * kernel's run walks. On the Sample Market DCW and DHW systems every walked node's
 * own load equals what the batch 5c kernel code computed (copied below
 * verbatim), the derived flows are the Sample Market goldens (43.25 WSFU cold
 * service, 15.75 hot). c6x-network-coupling-bare proves the row is what
 * carries it.
 */
import { applyChangeset, canonicalJson, DEFAULT_SETTINGS, fixtureKeyOf, loadPointLoad, loadPointLoads, loadPointTotals, loadTypicalOf, planCommit, runNeighbours, typicalFactor, componentBeyond, type BimElement, type Changeset, type Command, type ElementId, type LoadPointElement, type MepSystem, type ModelState } from "@permitzip/bim-kernel";
import { SAMPLE_MARKET_CW, SAMPLE_MARKET_HW, SAMPLE_MARKET_TOTALS, sampleMarketLoadPointCommand, sampleMarket } from "../../bim-kernel/__tests__/fixtures/sample-market";
import { isHeaterInlet, isHeaterOutlet, pipeLoadWalk } from "../src";

type Elements = Readonly<Record<string, BimElement>>;
type Node = string;
interface LoadTree {
  readonly order: readonly Node[];
  readonly parent: ReadonlyMap<Node, Node | null>;
}
interface BatchLoads {
  readonly own: ReadonlyMap<Node, number>;
  readonly attachedParts: ReadonlySet<string>;
  readonly loadPointIds: readonly string[];
  readonly alsoRead: readonly string[];
}
const isPartNode = (n: Node) => n.includes("#");

// ---- batch 5c `packages/bim-kernel/src/load-points/plumbing.ts` loadPointLoads, verbatim (git show 7bfda9c7c).
/**
 * Own loads from load points for one walked tree. Water: a heater's cold
 * inlet carries its hot side's load point units; a fixture whose cold and hot
 * sides are both below a pipe counts its total units there, not cold + hot
 * (the difference is added once, at the node where its two sides meet).
 */
function batch5cLoadPointLoads(elements: Elements, tree: LoadTree, systemKind: string | null, neighbours: (n: Node) => readonly Node[]): BatchLoads {
  const own = new Map<Node, number>();
  const attached = new Set<string>();
  const ids: string[] = [];
  const alsoRead: string[] = [];
  const coldPoints: LoadPointElement[] = [];
  for (const n of tree.order) {
    const el = elements[n];
    if (el?.kind !== "load_point") continue;
    ids.push(el.id);
    own.set(n, loadPointLoad(elements, el));
    if (el.attachedPartId) attached.add(el.attachedPartId);
    if (systemKind === "domestic_cold_water") coldPoints.push(el);
  }
  if (systemKind !== "domestic_cold_water") return { own, attachedParts: attached, loadPointIds: ids, alsoRead };
  for (const n of tree.order) {
    if (!isPartNode(n)) continue;
    const partId = n.slice(0, n.indexOf("#"));
    const part = elements[partId];
    if (part?.kind !== "part" || !isHeaterInlet(elements, part, n.slice(n.indexOf("#") + 1))) continue;
    // The heater's hot side: every hot load point its outlets reach.
    const hot = new Map<string, number>();
    let hotTotal = 0;
    for (const [connector, link] of Object.entries(part.links ?? {})) {
      if (!isHeaterOutlet(elements, part, connector)) continue;
      for (const m of componentBeyond(elements, partId, link.elementId, neighbours)) {
        const el = elements[m];
        if (!isPartNode(m)) alsoRead.push(m);
        if (el?.kind !== "load_point") continue;
        const h = loadPointLoad(elements, el);
        // A typical unit's hot points count once per instance at a heater outside the unit (F6).
        hotTotal += h * typicalFactor(loadTypicalOf(elements, el, [el.host?.elementId, el.attachedPartId]).typical, part.groupId);
        const key = fixtureKeyOf(el);
        if (key) hot.set(key, (hot.get(key) ?? 0) + h);
      }
    }
    own.set(n, (own.get(n) ?? 0) + hotTotal);
    if (hot.size === 0) continue;
    const ancestors = new Set<Node>();
    for (let a: Node | null | undefined = n; a !== null && a !== undefined; a = tree.parent.get(a)) ancestors.add(a);
    for (const cold of coldPoints) {
      const key = fixtureKeyOf(cold);
      const h = key ? hot.get(key) : undefined;
      if (h === undefined) continue;
      const t = loadPointTotals(elements, cold);
      if (t.wsfu_total <= 0) continue;
      const adj = t.wsfu_total - t.wsfu_cold - h;
      if (adj === 0) continue;
      let meet: Node | null | undefined = cold.id;
      while (meet !== null && meet !== undefined && !ancestors.has(meet)) meet = tree.parent.get(meet);
      if (meet === null || meet === undefined) continue;
      const meetGroup = elements[meet.includes("#") ? meet.slice(0, meet.indexOf("#")) : meet]?.groupId;
      own.set(meet, (own.get(meet) ?? 0) + adj * typicalFactor(loadTypicalOf(elements, cold, [cold.host?.elementId, cold.attachedPartId]).typical, meetGroup));
    }
  }
  return { own, attachedParts: attached, loadPointIds: ids, alsoRead };
}

// ---- end of the batch 5c copy.

const NOW = () => "2026-10-30T12:00:00.000Z";

function sampleMarketModel(): ModelState {
  let head: ModelState = { modelId: "c6x", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  const log: Changeset[] = [];
  const build = sampleMarket();
  const commands: readonly Command[] = [...build.setup, sampleMarketLoadPointCommand(build.points)];
  commands.forEach((command, i) => {
    const d = planCommit(head, [], { idempotencyKey: `c6x-${i}`, baseRevision: head.revision, actor: { id: "avery", name: "Avery", kind: "human" }, command }, NOW, log);
    if (!d.ok) throw new Error(`${command.type}: ${d.error.message}`);
    expect(canonicalJson(applyChangeset(head, d.changeset))).toBe(canonicalJson(d.model));
    head = d.model;
    log.push(d.changeset);
  });
  return head;
}

function system(m: ModelState, id: string): MepSystem {
  const s = m.elements[id];
  if (s?.kind !== "mep_system") throw new Error(`no system ${id}`);
  return s;
}

const flowOf = (m: ModelState, id: string) => {
  const s = m.elements[id];
  return s?.kind === "run_segment" ? s.flow : undefined;
};

describe("c6x-network-coupling", () => {
  const m = sampleMarketModel();

  it.each([
    ["DCW", SAMPLE_MARKET_CW.id, "cw-s1"],
    ["DHW", SAMPLE_MARKET_HW.id, "hw-s2"],
  ])("Sample Market %s: every node's own load is the batch 5c kernel's", (_label, systemId, anchor) => {
    const sys = system(m, systemId);
    const walk = pipeLoadWalk(m.elements, sys, anchor as ElementId, {}, []);
    const neighbours = (n: Node) => runNeighbours(m.elements, n);
    const before = batch5cLoadPointLoads(m.elements, walk.walk, sys.systemKind, neighbours);
    const now = loadPointLoads(m.elements, walk.walk, sys.systemKind, neighbours);
    expect([...now.own.entries()]).toEqual([...before.own.entries()]);
    expect([...now.attachedParts]).toEqual([...before.attachedParts]);
    expect(now.loadPointIds).toEqual(before.loadPointIds);
    expect(now.alsoRead).toEqual(before.alsoRead);
    expect(before.own.size).toBeGreaterThan(0);
  });

  it("derives the Sample Market goldens: the cold service carries the total, the heater inlet the hot side", () => {
    expect(flowOf(m, "cw-s1")).toBe(SAMPLE_MARKET_TOTALS.total);
    expect(flowOf(m, "hw-s2")).toBe(SAMPLE_MARKET_TOTALS.hot);
    expect(flowOf(m, "cw-gwh-s1")).toBe(SAMPLE_MARKET_TOTALS.hot);
  });
});
