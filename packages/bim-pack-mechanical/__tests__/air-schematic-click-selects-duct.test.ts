/**
 * A click on a drawn duct labelled "Duct 14"x10" 300 CFM" selected the
 * transition the run starts with, so Properties showed the transition and the
 * duct's own "+" on its top never appeared. A drawn piece now selects the duct
 * its label names: its first level straight piece.
 */
import { asElementId, type DiagramEdge, type DiagramNode } from "@permitzip/bim-kernel";
import { drawnRunSelects, layoutAirSchematic } from "../src/diagrams/air-schematic";

const at = (z: number) => ({ x: 0, y: 0, z });
const DROP = asElementId("drop");
const MAIN = asElementId("main");
const FITTING = asElementId("fitting-1");
const PIECE = asElementId("piece-1");
const NEXT = asElementId("piece-2");

describe("a click on a drawn duct on the air schematic", () => {
  it("selects the run's first level straight piece, past a drop off the unit", () => {
    const drop = { id: DROP, start: at(4300), end: at(3500) };
    const main = { id: MAIN, start: at(3500), end: at(3500) };
    expect(drawnRunSelects([drop, main])).toBe(MAIN);
    expect(drawnRunSelects([drop])).toBe(DROP);
    expect(drawnRunSelects([])).toBeUndefined();
  });

  it("the drawn piece is clicked as that piece, not the fitting the run starts with", () => {
    const node = (id: string, children: DiagramNode[], feed?: DiagramEdge): DiagramNode => ({ id, elementId: asElementId(id), kind: "terminal", labelKind: "equipment", name: id, lines: [], levelId: null, service: "normal", children, ...(feed ? { feed } : {}) });
    const roots = [node("unit", [node("sd", [], { linkId: null, device: "duct", label: "14x10", elementIds: [FITTING, PIECE, NEXT], selects: PIECE })])];
    const [piece] = Object.values(layoutAirSchematic(roots).pieces ?? {});
    expect(piece?.elementId).toBe(PIECE);
    expect(piece?.elementIds).toEqual([FITTING, PIECE, NEXT]);
  });

  it("omits service section boxes, emits entry anchors for branch/terminal pinning, and preserves text movement", () => {
    const { AIR_SCHEMATIC_LAYOUT_ROW } = require("../src/diagrams/air-schematic");
    expect(AIR_SCHEMATIC_LAYOUT_ROW.serviceSections).toBe(false);

    const sd1: DiagramNode = {
      id: "sd-1#neck",
      elementId: asElementId("sd-1"),
      kind: "terminal",
      role: "terminal",
      labelKind: "equipment",
      name: "SD-1",
      lines: [{ text: "SD-1", bold: true }, { text: "450 CFM" }],
      levelId: null,
      service: "supply_air",
      feed: { linkId: null, device: "duct", label: '8"Ø', load: "450 CFM", elementIds: [PIECE], selects: PIECE },
      children: [],
    };
    const sd2: DiagramNode = {
      ...sd1,
      id: "sd-2#neck",
      elementId: asElementId("sd-2"),
      name: "SD-2",
      lines: [{ text: "SD-2", bold: true }, { text: "450 CFM" }],
    };
    const branch: DiagramNode = {
      id: "sa-tee",
      elementId: asElementId("sa-tee"),
      kind: "branch",
      role: "branch",
      labelKind: "equipment",
      name: "Supply Header",
      lines: [],
      levelId: null,
      service: "supply_air",
      feed: { linkId: null, device: "duct", label: 'SA 16"x10"', load: "900 CFM", elementIds: [MAIN], selects: MAIN },
      children: [sd1, sd2],
    };
    const unit: DiagramNode = {
      id: "rtu-1#supply",
      elementId: asElementId("rtu-1"),
      kind: "unit",
      role: "source",
      labelKind: "equipment",
      name: "RTU-1",
      lines: [{ text: "RTU-1", bold: true }, { text: "SA 900 CFM" }],
      levelId: null,
      service: "supply_air",
      children: [branch],
    };

    const res = layoutAirSchematic([unit]);
    // Branch header & terminals record entry anchors so dragging them on the diagram reconnects orthogonally.
    expect(res.entries?.["sa-tee"]).toBeDefined();
    expect(res.entries?.["sd-1#neck"]).toBeDefined();
    expect(res.entries?.["sd-2#neck"]).toBeDefined();
    // Duct labels never carry destructive wide masks that erase horizontal duct lines.
    const ductLabels = res.items.filter((it): it is Extract<typeof it, { shape: "text" }> => it.shape === "text" && it.role === "conductor");
    expect(ductLabels.length).toBeGreaterThan(0);
    expect(ductLabels.every((it) => !it.mask)).toBe(true);
  });
});
