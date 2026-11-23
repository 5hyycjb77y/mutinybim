/**
 * @jest-environment node
 *
 * End-to-end verification of `@permitzip/bim-script`'s `electrical` photometric
 * & emergency egress helpers (`setLuminaireIes`, `runPhotometrics`,
 * `runEgressLightingCheck`, `enablePhotometricOverlay`).
 */
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import { SERVER_FEATURES } from "@permitzip/bim-sync";
import { DEFAULT_SETTINGS, executeCommand, withUpgradePolicy, type ModelState, type Revision, type ViewElement } from "@permitzip/bim-kernel";
import {
  building,
  defineScript,
  documents,
  electrical,
  equipment,
  runScript,
  sliceModel,
  units,
} from "@permitzip/bim-script";

installFirstPartyAddOns();

const CUSTOM_TROFFER_IES = `IESNA:LM-63-2002
[TEST] SCRIPT-CUSTOM-IES-001
[MANUFAC] PermitZIP Custom Optics
[LUMCAT] PZ-CUSTOM-4500
[LUMINAIRE] Custom 2x4 High-Output Volumetric Troffer
[LAMP] Integral LED 4500lm 32W
[MORE] High-efficacy custom photometric web payload exceeding 400 characters to exercise PARTS_LONG_TEXT_VALUES_FEATURE
TILT=NONE
1 4500 1.0 10 3 1 1 2.0 4.0 0.25
1.0 1.0 32.0
0 10 20 30 40 50 60 70 80 90
0 45 90
1550 1520 1420 1260 1050 810 550 280 70 0
1550 1525 1435 1285 1080 845 585 305 80 0
1550 1530 1450 1310 1110 880 620 330 90 0
`;

describe("@permitzip/bim-script electrical photometrics & egress kit", () => {
  it("sets custom IES profiles (inline >400 chars & catalog), runs normal + egress checks, and enables plan overlays", async () => {
    expect(CUSTOM_TROFFER_IES.length).toBeGreaterThan(400);

    let base: ModelState = {
      modelId: "script-photometrics",
      revision: 0 as Revision,
      elements: {},
      connections: [],
      settings: DEFAULT_SETTINGS,
    };
    base = withUpgradePolicy(
      () => true,
      () => {
        const res = executeCommand(base, { type: "create_level", levelId: "L1", name: "Level 1", elevationMm: 0 });
        if (!res.ok) throw new Error(res.error.message);
        return res.model;
      },
    );

    const script = defineScript({
      kind: "layout",
      reads: { levels: true },
      parameters: {},
      run(ctx) {
        building.walls(ctx, {
          level: "L1",
          points: [
            { x: units.ft(0), y: units.ft(0) },
            { x: units.ft(28), y: units.ft(0) },
            { x: units.ft(28), y: units.ft(8) },
            { x: units.ft(0), y: units.ft(8) },
          ],
          closed: true,
          thickness: units.in(6),
          height: units.ft(10),
        });
        building.room(ctx, {
          level: "L1",
          number: "100",
          name: "Egress Corridor",
          outline: [
            { x: units.ft(0), y: units.ft(0) },
            { x: units.ft(28), y: units.ft(0) },
            { x: units.ft(28), y: units.ft(8) },
            { x: units.ft(0), y: units.ft(8) },
          ],
        });
        const f1 = equipment.place(ctx, {
          level: "L1",
          type: "builtin:troffer-2x4-led-em@1",
          at: { x: units.ft(7), y: units.ft(4) },
          height: units.ft(9),
          mark: "EM-1",
        });
        const f2 = equipment.place(ctx, {
          level: "L1",
          type: "builtin:troffer-2x4-led-em@1",
          at: { x: units.ft(21), y: units.ft(4) },
          height: units.ft(9),
          mark: "EM-2",
        });

        // Attach inline IES (>400 chars) on f1, and catalog-backed IES on f2
        electrical.setLuminaireIes(ctx, f1, {
          iesText: CUSTOM_TROFFER_IES,
          emergencyMode: "battery_pack",
          emergencyLumens: 1400,
          egressFixture: true,
          lld: 0.9,
          ldd: 0.92,
        });
        electrical.setLuminaireIes(ctx, f2, {
          iesText: CUSTOM_TROFFER_IES,
          saveAsProfile: "Custom-4500-Troffer",
          emergencyMode: "battery_pack",
          emergencyLumens: 1400,
          egressFixture: true,
        });

        const normal = electrical.runPhotometrics<{ ok: boolean; run: { values: readonly { key: string; value: unknown }[] } }>(ctx, {
          gridSpacing: units.ft(2),
          workplaneHeight: units.in(0),
        });
        const egress = electrical.runEgressLightingCheck<{ ok: boolean; run: { values: readonly { key: string; value: unknown }[] } }>(ctx, {
          gridSpacing: units.ft(2),
        });

        const plan = documents.planView(ctx, { level: "L1", name: "Level 1 - Egress Lighting", scale: 48 });
        electrical.enablePhotometricOverlay(ctx, plan, {
          mode: "egress",
          showContours: true,
          showGridValues: true,
          gridSpacing: units.ft(2),
        });

        ctx.report("normal_ok", normal.ok);
        ctx.report("normal_status", normal.run.values.find((v) => v.key === "status")?.value);
        ctx.report("egress_ok", egress.ok);
        ctx.report("egress_status", egress.run.values.find((v) => v.key === "status")?.value);
      },
    });

    const out = await runScript(script, {
      slice: sliceModel(base, script.manifest.reads, [], SERVER_FEATURES),
      values: {},
      scriptHash: "sha256:phot-script-seed",
    });

    expect(out.kind).toBe("edits");
    expect(out.report?.find((r) => r.label === "normal_ok")?.value).toBe(true);
    expect(out.report?.find((r) => r.label === "normal_status")?.value).toBe("PASS");
    expect(out.report?.find((r) => r.label === "egress_ok")?.value).toBe(true);
    expect(out.report?.find((r) => r.label === "egress_status")?.value).toBe("PASS");

    // Apply produced commands onto the real model and inspect resulting view & catalog record
    let after = base;
    withUpgradePolicy(
      () => true,
      () => {
        if (out.kind !== "edits") return;
        for (const batch of out.batches) {
          for (const cmd of batch.commands) {
            const res = executeCommand(after, cmd);
            if (!res.ok) throw new Error(res.error.message);
            after = res.model;
          }
        }
      },
    );

    const view = Object.values(after.elements).find((e): e is ViewElement => e.kind === "view" && e.name === "Level 1 - Egress Lighting");
    expect(view?.props?.photometrics?.photometricsMode).toBe("egress");
    expect(view?.props?.photometrics?.showContours).toBe(true);
    expect(view?.props?.photometrics?.showGridValues).toBe(true);

    const cat = Object.values(after.elements).find((e) => e.kind === "service_catalog" && e.entry.type === "photometric_profile");
    expect(cat).toBeDefined();
  });

  it("exposes calculationMode options and viewport north-arrow helpers in generated script declarations", async () => {
    const { kitDeclarations } = await import("../src");
    const dts = kitDeclarations();
    expect(dts).toContain('export type PhotometricsCalculationMode = "simplified" | "detailed" | "surfaces";');
    expect(dts).toContain("calculationMode?: PhotometricsCalculationMode;");
    expect(dts).toContain("includeFurnitureOcclusion?: boolean;");
    expect(dts).toContain("setViewportNorthArrow(");
    expect(dts).toContain("northArrowOffset?: { x: Measure; y: Measure }");
  });
});
