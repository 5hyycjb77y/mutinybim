/**
 * @jest-environment node
 */
import * as THREE from "three";
import { DEFAULT_VIEWER_COLORS, ViewerPalette } from "../src/viewer-colors";

const hex = (c: THREE.Color) => `#${c.getHexString()}`;

describe("3D view colors come from the theme", () => {
  it("draws selection, group selection, hover, edges, backgrounds and axes in the colors it is given", () => {
    const palette = new ViewerPalette({ background: "#f2f3f4", planBackground: "#ffffff", selection: "#d7e620", selectionOutline: "#5c6b00", hover: "#2f5fbf", edges: "#182126", provisional: "#e3a33a", axisX: "#c8402f", axisY: "#3e8a3a", axisZ: "#2f5fbf" });
    expect(hex(palette.background)).toBe("#f2f3f4");
    expect(hex(palette.planBackground)).toBe("#ffffff");
    expect(hex(palette.selected.color)).toBe("#d7e620");
    expect(hex(palette.groupSelected.color)).toBe("#d7e620");
    expect(hex(palette.pickHighlight)).toBe("#d7e620");
    expect(hex(palette.hover.color)).toBe("#2f5fbf");
    expect(hex(palette.edge.color)).toBe("#182126");
    expect(hex(palette.selectedEdge.color)).toBe("#5c6b00");
    expect(palette.selectedEdge.transparent).toBe(false);
    expect(palette.css("selectionOutline")).toBe("#5c6b00");
    expect(hex(palette.provisional.color)).toBe("#e3a33a");
    expect(palette.axes.map(hex)).toEqual(["#c8402f", "#3e8a3a", "#2f5fbf"]);
    expect(palette.css("selection")).toBe("#d7e620");
  });

  it("changes colors in place, so objects already drawn follow a theme switch without a rebuild", () => {
    const palette = new ViewerPalette();
    const background = palette.background;
    const selected = palette.selected;
    expect(hex(selected.color)).toBe(DEFAULT_VIEWER_COLORS.selection);
    palette.apply({ selection: "#a8471b", background: "#ebe7df" });
    expect(palette.selected).toBe(selected);
    expect(palette.background).toBe(background);
    expect(hex(selected.color)).toBe("#a8471b");
    expect(hex(background)).toBe("#ebe7df");
    expect(hex(palette.edge.color)).toBe(DEFAULT_VIEWER_COLORS.edges);
  });

  it("logs and keeps the default for a color it can't read", () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const palette = new ViewerPalette({ edges: "not-a-color" });
    expect(hex(palette.edge.color)).toBe(DEFAULT_VIEWER_COLORS.edges);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("viewer color"), expect.objectContaining({ slot: "edges" }));
    spy.mockRestore();
    warn.mockRestore();
  });
});
