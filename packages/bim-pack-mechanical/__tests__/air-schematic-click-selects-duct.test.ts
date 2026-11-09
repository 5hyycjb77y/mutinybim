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
});
