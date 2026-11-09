/**
 * @jest-environment node
 * @mutinybim-bare-kernel
 *
 * Round 14 lane K14 step 1: piping diagrams come from the Plumbing add-on.
 * `evaluateDiagram` asks the kind's `kernel.diagram_layout` row before its
 * own layouts; the riser and isometric layouts live in Plumbing and arrive
 * as its rows. A bare kernel refuses in words naming the add-on, and an
 * outside add-on draws its own diagram through the same row with no kernel
 * edit.
 *
 * Fails on round 13's code: `layoutRowFor` refused "isn't built yet", the
 * kernel held `diagrams/piping-layout.ts` and `isometric-layout.ts` and
 * chose them by kind, and Plumbing contributed no layout row.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_SETTINGS, DIAGRAM_GRAPH_POINT, DIAGRAM_LAYOUT_POINT, evaluateDiagram, layoutRowFor, type BimElement, type DiagramGraphDef, type DiagramLayoutRow, type DiagramNode, type ElementId, type ModelState, type ViewElement } from "../src";
import { contribute, definePack, installedFirstPartyPacks, isPackRefusal, PACK_CONTRACT_VERSION, PackSet, packNotLoadedMessage, withPackSet, type Pack } from "../src/packs";
import { PLUMBING_DIAGRAM_LAYOUT_ROWS, PLUMBING_GAS_PACK } from "@permitzip/bim-pack-plumbing";

const KERNEL_DIAGRAMS = path.resolve(__dirname, "../src/diagrams");
const EMPTY: ModelState = { modelId: "k14", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };

function node(id: string, service: string, children: readonly DiagramNode[] = []): DiagramNode {
  return { id, elementId: id as ElementId, kind: "zz.box", labelKind: "equipment", name: id, lines: [{ text: id.toUpperCase() }], levelId: null, service, children };
}

const FLOW_GRAPH: DiagramGraphDef = {
  kind: "zz.flow",
  build: () => ({ roots: [node("zz-src", "zz.loop", [node("zz-end", "zz.other")])], warnings: [], reads: ["zz-src" as ElementId, "zz-end" as ElementId] }),
};

const FLOW_ROW: DiagramLayoutRow = {
  kind: "zz.flow",
  label: "Test flow diagram",
  serviceSections: false,
  check: () => null,
  layout: () => ({ refused: "drawn from the model, not a stored spec" }),
  layoutGraph: ({ roots }) => {
    const src = roots[0];
    const end = src?.children[0];
    if (!src || !end) return { refused: "nothing to draw" };
    return {
      items: [
        { shape: "text", at: { x: 0, y: 10 }, widthMm: 20, lines: [{ text: "SRC" }], nodeId: src.id, role: "equipment" },
        { shape: "line", points: [{ x: 0, y: 0 }, { x: 40, y: 0 }], weight: "medium", nodeId: "piece:zz-end" },
        { shape: "text", at: { x: 40, y: 10 }, widthMm: 20, lines: [{ text: "END" }], nodeId: end.id, role: "equipment" },
      ],
      extent: { min: { x: 0, y: 0 }, max: { x: 60, y: 10 } },
      nodes: [],
      pieces: { "piece:zz-end": { elementId: "zz-run" as ElementId, elementIds: ["zz-run" as ElementId, "zz-elbow" as ElementId], name: "loop to END" } },
    };
  },
};

function outside(contributions: Pack["contributions"]): Pack {
  return definePack({ id: "zz", name: "ZZ", version: "1.0.0", kernel: `^${PACK_CONTRACT_VERSION}` }, contributions);
}

describe("k14 piping diagrams come from the Plumbing add-on", () => {
  it("the bare kernel has no add-on installed and refuses piping layouts in words, naming Plumbing", () => {
    expect(installedFirstPartyPacks()).toEqual([]);
    for (const kind of ["plumbing_riser", "plumbing_isometric"]) {
      const row = layoutRowFor(kind);
      expect(isPackRefusal(row) ? row.refused : "a row").toBe(packNotLoadedMessage("plumbing_gas"));
    }
    expect(packNotLoadedMessage("plumbing_gas")).toBe("This model uses Plumbing and gas, which isn't loaded here");
  });

  it("the kernel holds no piping layout and evaluate names no piping kind", () => {
    expect(existsSync(path.join(KERNEL_DIAGRAMS, "piping-layout.ts"))).toBe(false);
    expect(existsSync(path.join(KERNEL_DIAGRAMS, "isometric-layout.ts"))).toBe(false);
    const evaluate = readFileSync(path.join(KERNEL_DIAGRAMS, "evaluate.ts"), "utf8");
    expect(evaluate).not.toMatch(/plumbing|piping|layoutPiping|PIPING_DIAGRAM_KINDS/i);
  });

  it("with Plumbing in the set, its rows lay out the riser and the isometric from the graph", () => {
    expect(PLUMBING_DIAGRAM_LAYOUT_ROWS.map((r) => [r.kind, r.label, r.serviceSections, typeof r.layoutGraph])).toEqual([
      ["plumbing_riser", "Plumbing riser diagram", false, "function"],
      ["plumbing_isometric", "Plumbing isometric", false, "function"],
    ]);
    expect(PLUMBING_GAS_PACK.contributions.some((c) => c.pointId === DIAGRAM_LAYOUT_POINT.id)).toBe(true);
    withPackSet(PackSet.create([PLUMBING_GAS_PACK]), () => {
      for (const kind of ["plumbing_riser", "plumbing_isometric"]) {
        const row = layoutRowFor(kind);
        expect(isPackRefusal(row) ? row.refused : row.kind).toBe(kind);
        // A view stores only its kind and hints: the stored-spec face says so in words.
        if (!isPackRefusal(row)) expect(row.layout({}, { model: EMPTY })).toEqual({ refused: expect.stringMatching(/drawn from the model's piping/) });
      }
    });
  });

  it("an outside add-on's graph and layout row draw a live diagram with no kernel edit", () => {
    const set = PackSet.create([outside([contribute(DIAGRAM_GRAPH_POINT, [FLOW_GRAPH]), contribute(DIAGRAM_LAYOUT_POINT, [FLOW_ROW])])]);
    // A stored view from a peer with this add-on: its kind is the add-on's own, not one the kernel lists.
    const view = { id: "v-flow", props: { diagram: { kind: "zz.flow" } } } as unknown as Pick<ViewElement, "id" | "props">;
    const elements: Readonly<Record<string, BimElement>> = {};
    withPackSet(set, () => {
      const row = layoutRowFor("zz.flow");
      expect(isPackRefusal(row) ? row.refused : row.label).toBe("Test flow diagram");
      const ev = evaluateDiagram(elements, view);
      expect(ev?.items.length).toBe(3);
      expect(ev?.equipment).toEqual(["zz-src", "zz-end"]);
      // The drawn piece is its own click target and answers for every element it stands for.
      const piece = ev?.boxes.find((b) => b.pipe);
      expect(piece?.elementId).toBe("zz-run");
      expect(piece?.pipe?.elementIds).toEqual(["zz-run", "zz-elbow"]);
      // serviceSections: false: no automatic box round the end, though its service differs from what feeds it.
      expect(ev?.items.filter((i) => i.shape === "polyline")).toEqual([]);
    });
    expect(layoutRowFor("zz.flow")).toEqual({ refused: "No add-on in this model lays out zz.flow diagrams" });
  });
});
