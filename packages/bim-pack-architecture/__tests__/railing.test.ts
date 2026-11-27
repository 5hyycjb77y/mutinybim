/**
 * @jest-environment node
 *
 * Verifies first-class `architecture.railing` (`IfcRailing`):
 * - Straight & continuous multi-segment polyline guardrails
 * - Class recognition (`arch.railing` → `IfcRailing`)
 * - Multi-material 3D output (`railingClassParts`: metal frame/posts/shoe + translucent `glazing`)
 * - 2D floor plan graphics (omitted in RCP `lookingUp: true`)
 * - All 5 architectural infill styles (`glass`, `picket`, `cable`, `horizontal_bar`, `solid`) + ADA handrail
 * - IBC 1015.3 (42" commercial guard height) & IBC 1015.4 (4" sphere rule) compliance checks
 */
import {
  DEFAULT_SETTINGS,
  activeClassRegistry,
  classSolidsOf,
  executeCommand,
  withUpgradePolicy,
  type Command,
  type ModelState,
  type Revision,
} from "@permitzip/bim-kernel";
import { PackSet, withPackSet } from "@permitzip/bim-kernel/packs";
import {
  ARCHITECTURE_PACK,
  IBC_COMMERCIAL_GUARD_MM,
  RAILING_KIND,
  RAILING_KIND_ROW,
  asRailing,
  encodeRailingPath,
  railingClassParts,
  railingCompliance,
  railingSpec,
} from "../src";

const FT = 304.8;
const IN = 25.4;

function run(commands: readonly Command[]): ModelState {
  let cur: ModelState = { modelId: "railing-test", revision: 0 as Revision, elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  for (const command of commands) {
    const res = executeCommand(cur, command);
    if (!res.ok) throw new Error(`${command.type} failed: ${res.error.code} — ${res.error.message}`);
    cur = { ...res.model, revision: (cur.revision + 1) as Revision };
  }
  return cur;
}

describe("architecture.railing (IfcRailing)", () => {
  const packs = PackSet.create([ARCHITECTURE_PACK]);

  test("creates straight & polyline guardrails, classifies as arch.railing / IfcRailing, and verifies IBC 1015.3 / 1015.4 compliance", () => {
    withPackSet(packs, () =>
      withUpgradePolicy(
        () => true,
        () => {
          const m = run([
            { type: "create_level", levelId: "L1", name: "Level 1", elevationMm: 0 },
            { type: "create_level", levelId: "L2", name: "Level 2", elevationMm: Math.round(12 * FT) },
            {
              type: "create_element",
              elementId: "rail-balc",
              levelId: "L2",
              kind: RAILING_KIND,
              placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 10 * FT, y: 0 } },
              size: { heightMm: Math.round(42 * IN) },
              values: {
                "architecture.railing_style": "glass",
                "architecture.railing_height_mm": Math.round(42 * IN),
                "architecture.post_spacing_mm": Math.round(5 * FT),
                "architecture.railing_path": encodeRailingPath([
                  { x: 0, y: 0 },
                  { x: 0, y: -4 * FT },
                  { x: 10 * FT, y: -4 * FT },
                  { x: 10 * FT, y: 0 },
                ]),
              },
            },
          ]);

          const el = m.elements["rail-balc"];
          expect(el).toBeDefined();
          const rec = asRailing(el!);
          expect(rec).not.toBeNull();

          // IFC4.3 classification via arch.railing & live CLASS_SOLIDS_POINT lookup (bim-viewer-3d path)
          const reg = activeClassRegistry();
          const cls = reg.getClass("arch.railing");
          expect(cls?.id).toBe("arch.railing");
          expect(cls?.ifc?.entity).toBe("IfcRailing");
          const viaRegistry = classSolidsOf(el!, { elements: m.elements, floorMm: Math.round(12 * FT) }, reg);
          expect(viaRegistry).not.toBeNull();
          expect(viaRegistry!.some((p) => p.look === "glazing")).toBe(true);

          // Continuous 3-segment U-perimeter length = 4' + 10' + 4' = 18'
          const spec = railingSpec(rec!, m.elements);
          expect(spec.path).toHaveLength(4);
          expect(spec.lengthMm).toBeCloseTo(18 * FT, 0);
          expect(spec.style).toBe("glass");
          expect(spec.heightMm).toBeGreaterThanOrEqual(IBC_COMMERCIAL_GUARD_MM);
          expect(spec.postCount).toBeGreaterThanOrEqual(5);

          const comp = railingCompliance(rec!, m.elements);
          expect(comp.compliant).toBe(true);
          expect(comp.issues).toEqual([]);

          // Multi-material 3D output: metal frame/posts/shoe + translucent glazing panels
          const parts = railingClassParts(el!, { elements: m.elements, floorMm: Math.round(12 * FT) });
          expect(parts).not.toBeNull();
          const glazing = parts!.filter((p) => p.look === "glazing");
          const frame = parts!.filter((p) => !p.look);
          expect(glazing.length).toBeGreaterThanOrEqual(4);
          expect(frame.length).toBeGreaterThanOrEqual(8);

          // 2D plan graphics appear in floor plan, omitted in RCP (lookingUp: true)
          const planG = RAILING_KIND_ROW.planGraphics!(el!, { elements: m.elements, scale: 100, levelId: "L2", detail: "medium", drawing: "view", lookingUp: false, connectedTo: () => null }) ?? [];
          expect(planG.length).toBeGreaterThanOrEqual(7);
          const rcpG = RAILING_KIND_ROW.planGraphics!(el!, { elements: m.elements, scale: 100, levelId: "L2", detail: "medium", drawing: "view", lookingUp: true, connectedTo: () => null }) ?? [];
          expect(rcpG).toEqual([]);
        },
      ),
    );
  });

  test("flags non-compliant height (<42\") and baluster spacing (>4\" clear) and supports picket, cable, horizontal_bar, solid + ADA handrail", () => {
    withPackSet(packs, () =>
      withUpgradePolicy(
        () => true,
        () => {
          const cmds: Command[] = [
            { type: "create_level", levelId: "L1", name: "Level 1", elevationMm: 0 },
            { type: "create_level", levelId: "L2", name: "Level 2", elevationMm: Math.round(12 * FT) },
          ];
          for (const style of ["picket", "cable", "horizontal_bar", "solid"] as const) {
            cmds.push({
              type: "create_element",
              elementId: `rail-${style}`,
              levelId: "L2",
              kind: RAILING_KIND,
              placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 8 * FT, y: 0 } },
              values: {
                "architecture.railing_style": style,
                "architecture.railing_height_mm": Math.round(42 * IN),
                "architecture.rail_handrail": true,
              },
            });
          }
          // Non-compliant guard: 34" height + 6" picket spacing
          cmds.push({
            type: "create_element",
            elementId: "rail-bad",
            levelId: "L2",
            kind: RAILING_KIND,
            placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 6 * FT, y: 0 } },
            values: {
              "architecture.railing_style": "picket",
              "architecture.railing_height_mm": Math.round(34 * IN),
              "architecture.baluster_spacing_mm": Math.round(6 * IN),
            },
          });

          const m = run(cmds);
          for (const style of ["picket", "cable", "horizontal_bar", "solid"] as const) {
            const el = m.elements[`rail-${style}`]!;
            const rec = asRailing(el)!;
            expect(railingCompliance(rec, m.elements).compliant).toBe(true);
            const parts = railingClassParts(el, { elements: m.elements, floorMm: 3658 });
            expect(parts && parts.length).toBeGreaterThanOrEqual(6);
          }

          const badComp = railingCompliance(asRailing(m.elements["rail-bad"]!)!, m.elements);
          expect(badComp.commercialGuardOk).toBe(false);
          expect(badComp.sphereRuleOk).toBe(false);
          expect(badComp.compliant).toBe(false);
          expect(badComp.issues).toHaveLength(2);
        },
      ),
    );
  });
});
