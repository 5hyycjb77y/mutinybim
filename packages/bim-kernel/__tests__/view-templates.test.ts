import { z } from "zod";
import {
  DEFAULT_SETTINGS,
  VIEW_GRAPHICS_POINT,
  asRevision,
  documentIndex,
  executeCommand,
  planReachRange,
  resolveViewElement,
  resolveViewProps,
  withUpgradePolicy,
  type Command,
  type ModelState,
  type ViewElement,
} from "../src/index";
import { PackSet, contribute, definePack, withPackSet } from "../src/packs/index";

const TEST_PACK = definePack(
  { id: "test_graphics", name: "Test Graphics", version: "1.0.0", kernel: ">=0.1.0" },
  [
    contribute(VIEW_GRAPHICS_POINT, [
      {
        id: "test_graphics.overlay",
        label: "Test overlay",
        hintsKey: "customPackDisplay",
        hintsSchema: z.object({ mode: z.enum(["schematic", "detailed"]), density: z.number(), hints: z.record(z.string(), z.unknown()).optional() }),
        order: 100,
        draw: () => {},
      },
    ]),
  ],
);

function blankModel(): ModelState {
  return { modelId: "vt-test", revision: asRevision(0), elements: {}, connections: [], settings: DEFAULT_SETTINGS };
}

function run(model: ModelState, cmd: Command): ModelState {
  const res = executeCommand(model, cmd);
  if (!res.ok) throw new Error(`${cmd.type} refused: ${res.error.message}`);
  return res.model;
}

describe("view_template kernel bedrock", () => {
  it("creates, binds, resolves locked groups (including level_above view range and pack-registered ViewGraphicsHints), updates live, and detaches cleanly on delete", () => {
    withUpgradePolicy(
      () => true,
      () =>
        withPackSet(PackSet.create([TEST_PACK]), () => {
      let m = blankModel();
      m = run(m, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
      m = run(m, { type: "create_level", levelId: "lvl-2", name: "Level 2", elevationMm: 3658 });

      // Create a reusable template locking view_range, discipline, annotations, and pack-owned pack_props
      m = run(m, {
        type: "create_view_template",
        viewTemplateId: "vt-plan",
        name: "Standard Floor Plan",
        description: "Locks level-above view top and pack-registered display settings.",
        viewTypes: ["floor_plan"],
        locks: ["view_range", "discipline", "annotations", "pack_props"],
        props: {
          discipline: "mechanical",
          cutHeightMm: 1219,
          viewBottomMm: 0,
          viewTopRef: "level_above",
          hideDeviceMarks: true,
          customPackDisplay: { mode: "schematic", density: 2 },
        } as never,
      });

      expect(documentIndex(m).viewTemplates.map((t) => t.id)).toEqual(["vt-plan"]);

      // Create a plan view bound to the template with conflicting local props
      m = run(m, {
        type: "create_view",
        viewId: "v-1",
        name: "Level 1 Plan",
        viewType: "floor_plan",
        props: {
          level: "Level 1",
          scale: 48,
          viewTemplateId: "vt-plan",
          discipline: "architecture",
          viewTopMm: 2100,
          hideDeviceMarks: false,
        },
      });

      const view = m.elements["v-1"] as ViewElement;
      const resolved = resolveViewProps(m.elements, view);
      expect(resolved.template?.id).toBe("vt-plan");
      expect(resolved.lockedGroups.has("view_range")).toBe(true);
      expect(resolved.lockedGroups.has("pack_props")).toBe(true);
      // Locked groups come from template, unlocked group (scale) stays view-local
      expect(resolved.props.discipline).toBe("mechanical");
      expect(resolved.props.viewTopRef).toBe("level_above");
      expect(resolved.props.viewTopMm).toBeUndefined();
      expect(resolved.props.hideDeviceMarks).toBe(true);
      expect(resolved.props.scale).toBe(48);
      expect((resolved.props as Record<string, unknown>).customPackDisplay).toEqual({ mode: "schematic", density: 2 });

      // planReachRange resolves through the template automatically (reaches Level 2 at 3658 mm)
      const reach = planReachRange(m, view);
      expect(reach).toEqual({ lowMm: 0, highMm: 3658 });

      // Live template update propagates immediately to all bound views AND preserves view-local pack_props subkeys (like per-wire drafting hints)
      m = run(m, {
        type: "set_view_properties",
        viewId: "v-1",
        props: { customPackDisplay: { mode: "detailed", density: 9, hints: { wireA: [[100, 200]] } } } as never,
      });
      const withLocalDrafting = resolveViewProps(m.elements, m.elements["v-1"] as ViewElement);
      expect((withLocalDrafting.props as Record<string, unknown>).customPackDisplay).toEqual({
        mode: "schematic",
        density: 2,
        hints: { wireA: [[100, 200]] },
      });

      m = run(m, {
        type: "update_view_template",
        viewTemplateId: "vt-plan",
        props: { cutHeightMm: 1500, viewTopRef: "associated_level", viewTopMm: 2800 },
      });
      const updatedView = resolveViewElement(m.elements, m.elements["v-1"] as ViewElement);
      expect(updatedView.props?.cutHeightMm).toBe(1500);
      expect(updatedView.props?.viewTopMm).toBe(2800);
      expect(planReachRange(m, m.elements["v-1"] as ViewElement)).toEqual({ lowMm: 0, highMm: 2800 });

      // Incompatible view type binding is rejected cleanly
      const badBind = executeCommand(m, {
        type: "create_view",
        viewId: "v-rcp",
        name: "Level 1 RCP",
        viewType: "ceiling_plan",
        props: { level: "Level 1", viewTemplateId: "vt-plan" },
      });
      expect(badBind.ok).toBe(false);

      // Deleting a template detaches every bound view cleanly
      m = run(m, { type: "delete_view_template", viewTemplateId: "vt-plan" });
      expect(documentIndex(m).viewTemplates).toHaveLength(0);
      expect((m.elements["v-1"] as ViewElement).props?.viewTemplateId).toBeUndefined();
        }),
    );
  });

  it("refuses view_template creation on older peers that do not advertise views:templates", () => {
    const m = blankModel();
    const res = withUpgradePolicy(
      () => false,
      () =>
        executeCommand(m, {
          type: "create_view_template",
          viewTemplateId: "vt-old",
          name: "Old Peer Test",
          locks: ["discipline"],
          props: { discipline: "architecture" },
        }),
    );
    expect(res.ok).toBe(false);
  });
});
