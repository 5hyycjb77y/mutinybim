/**
 * @jest-environment node
 *
 * Script API coverage for saved 3D views and camera/lens angle (`documents.view3d`,
 * `documents.setCamera3d` with `fovDeg`, `projection`, `lookFrom`, typed `eye`/`target`,
 * `orthoHeight`, and `cropBox`/`fitElements`), plus `bim_script_reference` discovery.
 */
import { DEFAULT_SETTINGS, ELEMENTS_CORE_FEATURE, ELEMENTS_CREATE_FEATURE, executeCommand, withUpgradePolicy, type Command, type ModelState, type Revision, type ViewElement } from "@permitzip/bim-kernel";
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import { KIT_ENTRIES, building, checkScriptSource, defineScript, documents, kitDeclarations, runScript, searchReference, sliceModel, units } from "../src";

installFirstPartyAddOns();

const FEATURES = [ELEMENTS_CORE_FEATURE, ELEMENTS_CREATE_FEATURE] as const;

function baseModel(): ModelState {
  const empty: ModelState = { modelId: "script-view3d", revision: 0 as Revision, elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  const r = executeCommand(empty, { type: "create_level", levelId: "L1", name: "Level 1", elevationMm: 0 });
  if (!r.ok) throw new Error(r.error.message);
  return r.model;
}

describe("documents.view3d and documents.setCamera3d", () => {
  it("creates saved 3D views with fovDeg/projection, updates fovDeg without disturbing eye/target, and updates lookFrom without resetting fovDeg", async () => {
    const model = baseModel();
    const script = defineScript({
      kind: "layout",
      reads: { levels: true },
      parameters: {},
      run(ctx) {
        const walls = building.walls(ctx, {
          level: "L1",
          points: [
            { x: units.ft(0), y: units.ft(0) },
            { x: units.ft(30), y: units.ft(0) },
            { x: units.ft(30), y: units.ft(20) },
            { x: units.ft(0), y: units.ft(20) },
          ],
          closed: true,
          thickness: units.in(8),
          height: units.ft(10),
        });
        const v1 = documents.view3d(ctx, {
          name: "South-East Perspective",
          lookFrom: "south_east",
          fovDeg: 55,
          projection: "perspective",
          fitElements: [walls.element(1), walls.element(2)],
          id: "v-se",
        });
        // Lens-only update keeps the existing eye, target and framing intact.
        documents.setCamera3d(ctx, v1, { fovDeg: 68 });
        // Re-aiming by lookFrom keeps the 68° lens angle unless overridden.
        documents.setCamera3d(ctx, v1, { lookFrom: "north_west" });

        // Second 3D view with explicit eye/target, lens angle, and orthographic switch.
        const v2 = documents.view3d(ctx, {
          name: "Hero Eye-Level",
          eye: { x: units.ft(-20), y: units.ft(-15), z: units.ft(6) },
          target: { x: units.ft(15), y: units.ft(10), z: units.ft(5) },
          fovDeg: 35,
          projection: "perspective",
          cropBox: {
            center: { x: units.ft(15), y: units.ft(10), z: units.ft(5) },
            halfSize: { x: units.ft(20), y: units.ft(15), z: units.ft(8) },
          },
          id: "v-hero",
        });
        documents.setCamera3d(ctx, v2, { projection: "orthographic", orthoHeight: units.ft(30) });

        const sheet = documents.sheet(ctx, { number: "A-501", name: "3D Views", id: "s-a501" });
        documents.place(ctx, sheet, v1, { x: units.mm(300), y: units.mm(300) });
      },
    });

    const out = await runScript(script, { slice: sliceModel(model, script.manifest.reads, [], FEATURES), values: {}, scriptHash: "sha256:view3d-camera" });
    const commands = out.kind === "edits" ? out.batches.flatMap((b) => b.commands) : [];
    let m = model;
    withUpgradePolicy(
      (f) => (FEATURES as readonly string[]).includes(f),
      () => {
        for (const cmd of commands) {
          const r = executeCommand(m, cmd as Command);
          if (!r.ok) throw new Error(`Command ${(cmd as Command).type} failed: ${r.error.message}`);
          m = r.model;
        }
      },
    );

    const v1 = m.elements["v-se"] as ViewElement;
    expect(v1.viewType).toBe("three_d");
    expect(v1.props?.projection).toBe("perspective");
    expect(v1.props?.camera3d?.fovDeg).toBe(68);
    // North-west vantage puts eye west (-x) and north (+y) of target.
    expect(v1.props!.camera3d!.eye.x).toBeLessThan(v1.props!.camera3d!.target.x);
    expect(v1.props!.camera3d!.eye.y).toBeGreaterThan(v1.props!.camera3d!.target.y);

    const v2 = m.elements["v-hero"] as ViewElement;
    expect(v2.viewType).toBe("three_d");
    expect(v2.props?.projection).toBe("orthographic");
    expect(v2.props?.camera3d?.fovDeg).toBe(35);
    expect(v2.props?.camera3d?.orthoHeightMm).toBeCloseTo(30 * 304.8, 0);
  });

  it("refuses out-of-range fovDeg and non-3D views with plain-English errors", async () => {
    const model = baseModel();
    const badFov = defineScript({
      kind: "layout",
      reads: { levels: true },
      parameters: {},
      run(ctx) {
        documents.view3d(ctx, { name: "Bad FOV", fovDeg: 150 });
      },
    });
    await expect(runScript(badFov, { slice: sliceModel(model, badFov.manifest.reads), values: {}, scriptHash: "sha256:bad-fov" })).rejects.toThrow(/5° and 120°/);

    const wrongView = defineScript({
      kind: "layout",
      reads: { levels: true },
      parameters: {},
      run(ctx) {
        const plan = documents.planView(ctx, { level: "L1", name: "L1 Plan" });
        documents.setCamera3d(ctx, plan, { fovDeg: 60 });
      },
    });
    await expect(runScript(wrongView, { slice: sliceModel(model, wrongView.manifest.reads), values: {}, scriptHash: "sha256:wrong-view" })).rejects.toThrow(/not a 3D view/);
  });

  it("surfaces documents.view3d and documents.setCamera3d in bim_script_reference and kitDeclarations", () => {
    const names = searchReference("field of view 3d camera", 10).map((e) => e.name);
    expect(names).toContain("documents.view3d");
    expect(names).toContain("documents.setCamera3d");

    const dts = kitDeclarations();
    expect(dts).toContain("export interface View3dSpec");
    expect(dts).toContain("export interface Camera3dSpec");
    expect(dts).toContain("view3d(ctx: ScriptContext, spec: View3dSpec): string;");
    expect(dts).toContain("setCamera3d(ctx: ScriptContext, view: string, camera: Camera3dSpec): void;");

    for (const name of ["documents.view3d", "documents.setCamera3d"]) {
      const entry = KIT_ENTRIES.find((e) => e.name === name);
      expect(entry).toBeDefined();
      expect(checkScriptSource(entry!.example)).toEqual([]);
    }
  });
});
