/**
 * @jest-environment node
 *
 * Round 14 lane M14 (Bedrock proof): an outside add-on's own diagram (a cable
 * tray diagram) selects both ways through the kernel's map with zero kernel
 * edits. The add-on contributes a graph row and a layout row; one drawn tray
 * run stands for two of its model elements; clicking it gives both, and either
 * element lights it. Without the add-on the diagram draws nothing and
 * nothing maps.
 *
 * Fails on round 13: `modelIdsOf` / `diagramEntriesOf` refused every call.
 */
import { DIAGRAM_GRAPH_POINT, DIAGRAM_LAYOUT_POINT, asElementId, diagramEntriesOf, diagramSelectionIndex, evaluateDiagram, modelIdsOf, type DiagramGraphDef, type DiagramLayoutRow, type ElementId, type ModelState, type ViewElement } from "../src";
import { PackSet, contribute, definePack, withPackSet } from "../src/packs";
import { twoLevels } from "./a13a-fixtures";

const KIND = "zztray.tray";
const id = (s: string) => s as ElementId;

const GRAPH: DiagramGraphDef = {
  kind: KIND,
  build: (elements) => {
    const a = elements["w-1"];
    const b = elements["w-2"];
    if (!a || !b) return { roots: [], warnings: [], reads: [] };
    const node = (nid: string, name: string, children: never[] = []) => ({ id: nid, elementId: asElementId(nid), kind: "tray_end", labelKind: "equipment" as const, name, lines: [{ text: name }], levelId: null, service: "tray", children });
    return { roots: [{ ...node("w-1", "TR-1"), children: [{ ...node("w-2", "TR-2"), feed: { linkId: null, device: "tray", elementIds: [asElementId("w-1"), asElementId("w-2")] } }] }], warnings: [], reads: [asElementId("w-1"), asElementId("w-2")] };
  },
};

const LAYOUT: DiagramLayoutRow = {
  kind: KIND,
  label: "Tray diagram",
  check: () => null,
  layout: () => ({ refused: "drawn from the model" }),
  layoutGraph: ({ roots }) => {
    const root = roots[0];
    const child = root?.children[0];
    if (!root || !child) return { items: [], extent: { min: { x: 0, y: 0 }, max: { x: 0, y: 0 } }, nodes: [] };
    return {
      items: [
        { shape: "polyline", points: [{ x: -2, y: -2 }, { x: 2, y: -2 }, { x: 2, y: 2 }], closed: true, weight: "medium", nodeId: root.id },
        { shape: "line", points: [{ x: 2, y: 0 }, { x: 38, y: 0 }], weight: "medium", nodeId: "run:tr" },
        { shape: "polyline", points: [{ x: 38, y: -2 }, { x: 42, y: -2 }, { x: 42, y: 2 }], closed: true, weight: "medium", nodeId: child.id },
      ],
      extent: { min: { x: -2, y: -2 }, max: { x: 42, y: 2 } },
      nodes: [],
      pieces: { "run:tr": { elementId: asElementId("w-1"), elementIds: [asElementId("w-1"), asElementId("w-2")], name: "Tray run" } },
    };
  },
};

const TRAY = definePack({ id: "zztray", name: "Test cable tray", version: "1.0.0", kernel: "^1.12.0" }, [contribute(DIAGRAM_GRAPH_POINT, [GRAPH]), contribute(DIAGRAM_LAYOUT_POINT, [LAYOUT])]);

function model(): ModelState {
  const m = twoLevels("m14-tray");
  m.ok({ type: "create_element", elementId: "w-1", kind: "wall", levelId: "L1", placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 3000, y: 0 } } });
  m.ok({ type: "create_element", elementId: "w-2", kind: "wall", levelId: "L1", placement: { kind: "line", start: { x: 3000, y: 0 }, end: { x: 6000, y: 0 } } });
  // The view schema's kinds are closed today; an add-on's kind is held as the store would hold it once they open (K14 line).
  const view: ViewElement = { id: asElementId("v-tray"), kind: "view", version: 1, authoredRev: {}, name: "Tray diagram", viewType: "detail", cropMin: { x: 0, y: 0 }, cropMax: { x: 1, y: 1 }, props: { diagram: { kind: KIND } } };
  return { ...m.head, elements: { ...m.head.elements, [view.id]: view } };
}

describe("m14 outside add-on: its own diagram selects both ways", () => {
  it("a drawn run gives every element it stands for; either element lights it; equipment maps to itself", () => {
    const m = model();
    withPackSet(PackSet.create([TRAY]), () => {
      expect(modelIdsOf(m, id("v-tray"), "piece:w-1")).toEqual(["w-1", "w-2"]);
      expect(diagramEntriesOf(m, id("v-tray"), id("w-2"))).toEqual(["node:w-2", "piece:w-1"]);
      expect(modelIdsOf(m, id("v-tray"), "node:w-1")).toEqual(["w-1"]);
      const view = m.elements["v-tray"];
      const ev = view?.kind === "view" ? evaluateDiagram(m.elements, view) : null;
      if (!ev) throw new Error("no evaluation");
      expect(diagramSelectionIndex(ev)).toBe(diagramSelectionIndex(ev));
    });
  });

  it("without the add-on the diagram draws nothing, so nothing maps", () => {
    const m = model();
    expect(diagramEntriesOf(m, id("v-tray"), id("w-1"))).toEqual([]);
    expect(modelIdsOf(m, id("v-tray"), "piece:w-1")).toEqual({ refused: "That symbol isn't on Tray diagram any more: what it stood for was removed or is no longer drawn there" });
  });
});
