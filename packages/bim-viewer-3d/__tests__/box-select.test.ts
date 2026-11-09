/**
 * @jest-environment node
 *
 * Window (left to right: fully inside) and crossing (right to left: touching)
 * box selection over projected solids.
 */
import { boxModeOf, boxSelect, dragRect, screenBoxes, type Project } from "../src/box-select";
import type { Solid } from "../src/native-geometry";
import { asElementId } from "@permitzip/bim-kernel";

/** A plan camera: scene x to the right, scene -z (north) up the screen, 100 px per metre. */
const plan: Project = (x, _y, z) => ({ x: x * 100, y: z * 100 });

function box(id: string, cx: number, cz: number, length: number, yaw = 0): Solid {
  return { elementId: asElementId(id), version: 0, group: "duct", shape: "box", center: [cx, 3, cz], size: [length, 0.3, 0.3], yaw };
}

describe("box select", () => {
  const solids: Solid[] = [box("inside", 2, 2, 1), box("straddles", 4, 2, 2), box("outside", 9, 9, 1), box("turned", 2, 4, 2, Math.PI / 2)];
  const boxes = screenBoxes(solids, plan);

  it("reads the drag direction the CAD way", () => {
    expect(boxModeOf({ x: 10 }, { x: 50 })).toBe("window");
    expect(boxModeOf({ x: 50 }, { x: 10 })).toBe("crossing");
  });

  it("window picks only what is fully inside", () => {
    const rect = dragRect({ x: 100, y: 100 }, { x: 420, y: 290 });
    expect(boxSelect(boxes, rect, "window")).toEqual(["inside"]);
  });

  it("crossing picks anything the box touches", () => {
    const rect = dragRect({ x: 420, y: 290 }, { x: 100, y: 100 });
    expect(boxSelect(boxes, rect, "crossing").sort()).toEqual(["inside", "straddles"]);
  });

  it("projects a rotated piece by its turned extent", () => {
    const turned = boxes.get("turned");
    expect(turned && turned.maxY - turned.minY).toBeCloseTo(200, 3);
    expect(turned && turned.maxX - turned.minX).toBeCloseTo(30, 3);
  });

  it("filters by category", () => {
    const rect = dragRect({ x: 0, y: 0 }, { x: 1000, y: 1000 });
    expect(boxSelect(boxes, rect, "window", (id) => id !== "straddles").sort()).toEqual(["inside", "outside", "turned"]);
  });

  it("leaves out pieces wholly behind the camera", () => {
    const behind: Project = (x, _y, z) => (z > 5 ? null : { x: x * 100, y: z * 100 });
    expect(screenBoxes(solids, behind).has("outside")).toBe(false);
  });
});
