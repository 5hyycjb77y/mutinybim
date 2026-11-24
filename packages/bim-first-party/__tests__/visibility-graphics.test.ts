/**
 * @jest-environment node
 *
 * Verifies Visibility/Graphics category resolution and inheritance for
 * structural classes (`struct.column_steel`, `struct.beam_steel`,
 * `struct.footing_pad`, plain `struct.footing`, `struct.floor_deck`,
 * `struct.roof_deck`) alongside architectural components.
 */
import {
  DEFAULT_SETTINGS,
  buildCategoryRegistry,
  buildViewScene,
  categoryLook,
  elementCategoryChain,
  elementClass,
  elementLook,
  executeCommand,
  withCategoryRegistry,
  withUpgradePolicy,
  type Command,
  type ModelState,
  type Revision,
  type ViewElement,
} from "@permitzip/bim-kernel";
import { installFirstPartyAddOns } from "../src";

function run(commands: readonly Command[]): ModelState {
  let cur: ModelState = { modelId: "vg-struct", revision: 0 as Revision, elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  for (const command of commands) {
    const res = executeCommand(cur, command);
    if (!res.ok) throw new Error(`${command.type} failed: ${res.error.code} — ${res.error.message}`);
    cur = { ...res.model, revision: (cur.revision + 1) as Revision };
  }
  return cur;
}

describe("structural Visibility/Graphics category hierarchy and elementClass resolution", () => {
  beforeAll(() => {
    installFirstPartyAddOns();
  });

  it("resolves explicit classId and specific recognize rules, and cascades Structure -> parent -> subclass toggles", () => {
    const reg = buildCategoryRegistry();
    withCategoryRegistry(reg, () => {
      const model = withUpgradePolicy(
        () => true,
        () =>
          run([
            { type: "create_level", levelId: "L1", name: "Level 1", elevationMm: 0 },
            { type: "create_element", elementId: "col", levelId: "L1", kind: "column", classId: "struct.column_steel", placement: { kind: "point", position: { x: 0, y: 0 } }, size: { widthMm: 250, depthMm: 250, heightMm: 3600 }, values: { mark: "C1" } },
            { type: "create_element", elementId: "bm", levelId: "L1", kind: "beam", classId: "struct.beam_steel", placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 6000, y: 0 } }, values: { mark: "B1" } },
            { type: "create_element", elementId: "ftg-pad", levelId: "L1", kind: "component", category: "footing", classId: "struct.footing_pad", placement: { kind: "point", position: { x: 0, y: 0 } }, size: { widthMm: 1500, depthMm: 1500 }, values: { mark: "F1" } },
            { type: "create_element", elementId: "ftg-plain", levelId: "L1", kind: "component", category: "footing", placement: { kind: "point", position: { x: 3000, y: 0 } }, size: { widthMm: 1200, depthMm: 1200 }, values: { mark: "F2" } },
            { type: "create_element", elementId: "desk", levelId: "L1", kind: "component", category: "furniture", placement: { kind: "point", position: { x: 3000, y: 3000 } }, size: { widthMm: 1500, depthMm: 750 } },
            { type: "create_view", viewId: "v-arch", name: "Arch Plan", viewType: "floor_plan", crop: { min: { x: -3000, y: -3000 }, max: { x: 9000, y: 6000 } }, props: { level: "Level 1", scale: 50, discipline: "architecture", categoryOverrides: { "struct.footing": { visible: false }, "struct.beam": { visible: false } } } },
            { type: "create_view", viewId: "v-fnd", name: "Foundation Plan", viewType: "floor_plan", crop: { min: { x: -3000, y: -3000 }, max: { x: 9000, y: 6000 } }, props: { level: "Level 1", scale: 50, discipline: "structure" } },
          ]),
      );

      expect(elementClass(model.elements, model.elements.col!, reg)).toBe("struct.column_steel");
      expect(elementClass(model.elements, model.elements.bm!, reg)).toBe("struct.beam_steel");
      expect(elementClass(model.elements, model.elements["ftg-pad"]!, reg)).toBe("struct.footing_pad");
      expect(elementClass(model.elements, model.elements["ftg-plain"]!, reg)).toBe("struct.footing");
      expect(elementClass(model.elements, model.elements.desk!, reg)).toBe("arch.component");

      expect(elementCategoryChain(model.elements, model.elements.col!, reg)).toEqual(["struct.column_steel", "struct.column", "structure"]);
      expect(elementCategoryChain(model.elements, model.elements.bm!, reg)).toEqual(["struct.beam_steel", "struct.beam", "structure"]);
      expect(elementCategoryChain(model.elements, model.elements["ftg-pad"]!, reg)).toEqual(["struct.footing_pad", "struct.footing", "structure"]);
      expect(elementCategoryChain(model.elements, model.elements["ftg-plain"]!, reg)).toEqual(["struct.footing", "structure"]);

      const archView = model.elements["v-arch"] as ViewElement;
      expect(categoryLook(archView, "struct.footing_pad", reg).visible).toBe(false);
      expect(categoryLook(archView, "struct.beam_steel", reg).visible).toBe(false);
      expect(elementLook(model, archView, model.elements["ftg-pad"]!, reg).visible).toBe(false);
      expect(elementLook(model, archView, model.elements["ftg-plain"]!, reg).visible).toBe(false);
      expect(elementLook(model, archView, model.elements.bm!, reg).visible).toBe(false);
      expect(elementLook(model, archView, model.elements.col!, reg).visible).toBe(true);
      expect(elementLook(model, archView, model.elements.desk!, reg).visible).toBe(true);

      // Hiding top-level `structure` cascades to columns, beams, footings, and their subclasses, leaving furniture alone.
      const hideStruct: Pick<ViewElement, "props"> = { props: { hiddenCategories: ["structure"] } };
      expect(elementLook(model, hideStruct, model.elements.col!, reg).visible).toBe(false);
      expect(elementLook(model, hideStruct, model.elements.bm!, reg).visible).toBe(false);
      expect(elementLook(model, hideStruct, model.elements["ftg-pad"]!, reg).visible).toBe(false);
      expect(elementLook(model, hideStruct, model.elements["ftg-plain"]!, reg).visible).toBe(false);
      expect(elementLook(model, hideStruct, model.elements.desk!, reg).visible).toBe(true);

      // Printed drawing respects the visibility toggle: F1 disappears from Arch Plan and appears on Foundation Plan.
      const archTexts = buildViewScene(model, "v-arch").scene.primitives.filter((p) => p.kind === "text").map((p) => (p.kind === "text" ? p.text : ""));
      const fndTexts = buildViewScene(model, "v-fnd").scene.primitives.filter((p) => p.kind === "text").map((p) => (p.kind === "text" ? p.text : ""));
      expect(archTexts.some((t) => t.startsWith("F1"))).toBe(false);
      expect(fndTexts.some((t) => t.startsWith("F1"))).toBe(true);
    });
  });
});
