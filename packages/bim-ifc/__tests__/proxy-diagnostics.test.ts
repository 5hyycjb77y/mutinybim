/** @jest-environment node */
// @mutinybim-bare-kernel
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import { asElementId } from "@permitzip/bim-kernel";
import { exportIfc } from "../src";
import { PROJECT_ID, TIME_STAMP, syntheticModel } from "./c5i-model";

test("reports a stored building class lost to IFC proxy fallback", () => {
  const model = syntheticModel();
  const wall = model.elements["wall-1"];
  if (wall?.kind !== "wall") throw new Error("Expected a fixture wall");
  const options = { project: { id: PROJECT_ID, name: "Synthetic kitchen" }, timeStamp: TIME_STAMP };
  const secondWallId = asElementId("wall-2");
  const classified = {
    ...model,
    elements: {
      ...model.elements,
      [wall.id]: { ...wall, classId: "arch.wall" },
      [secondWallId]: {
        ...wall, id: secondWallId, classId: "arch.wall",
        start: { x: 0, y: 4000 }, end: { x: 8000, y: 4000 },
      },
    },
  };
  const fallback = exportIfc({ ...options, model: classified });
  const missingWallClass = (warning: string) => warning.includes('class "arch.wall" is unavailable');
  expect(fallback.report.warnings.filter(missingWallClass)).toEqual([
    'IFC export used IfcBuildingElementProxy for 2 building elements because class "arch.wall" is unavailable. Check that the export host has the add-on or library that provides this class.',
  ]);

  const unclassified = exportIfc({ ...options, model });
  expect(unclassified.report.byEntity.IfcBuildingElementProxy).toBeGreaterThan(0);
  expect(unclassified.report.warnings.some(missingWallClass)).toBe(false);

  installFirstPartyAddOns();
  const typed = exportIfc({ ...options, model: classified });
  expect(typed.report.byEntity.IfcWall).toBe(2);
  expect(typed.report.warnings.some(missingWallClass)).toBe(false);
});
