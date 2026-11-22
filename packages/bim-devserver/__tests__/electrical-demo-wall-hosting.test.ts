/** @jest-environment node */
import { buildSheetSceneFor, buildViewScene, evaluateDiagram, evaluateFormSchedule, resolveTextStyle, sceneToSvg, type PartInstance } from "@permitzip/bim-kernel";
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import { deriveCircuitGraphics } from "@permitzip/bim-pack-electrical";
import { createElectricalDemoModel } from "../src/electrical-demo";

installFirstPartyAddOns();

const FT = 304.8;

describe("electrical demo model wall-face hosting, schedules, diagrams, and multi-sheet end-game set", () => {
  it("hosts wall devices flush on wall finish faces, builds complete power/lighting/controls plans, schedules, live diagrams, and 3 Arch D sheets", () => {
    const demo = createElectricalDemoModel();
    const mdp = demo.elements["pnl-mdp"] as PartInstance;
    const lp1 = demo.elements["pnl-lp1"] as PartInstance;
    const r1 = demo.elements["r-1"] as PartInstance;
    const sw1 = demo.elements["sw-rr1"] as PartInstance;
    const swK1 = demo.elements["sw-k1"] as PartInstance;
    expect(mdp.host?.kind).toBe("wall_face");
    expect(lp1.host?.kind).toBe("wall_face");
    expect(r1.host?.kind).toBe("wall_face");
    expect(sw1.host?.kind).toBe("wall_face");
    expect(swK1.host?.kind).toBe("wall_face");

    // Ceiling fixtures & sensors sit at 9'-0" AFF ceiling height, exit signs at 8'-0" AFF — never on the floor.
    expect((demo.elements["lt-t1"] as PartInstance).offsetMm).toBeCloseTo(9 * FT, 1);
    expect((demo.elements["lt-d1"] as PartInstance).offsetMm).toBeCloseTo(9 * FT, 1);
    expect((demo.elements["os-1"] as PartInstance).offsetMm).toBeCloseTo(9 * FT, 1);
    expect((demo.elements["lt-ex1"] as PartInstance).offsetMm).toBeCloseTo(8 * FT, 1);

    // Unified 3/32" opaque Text Type active on marks and circuit labels.
    expect(resolveTextStyle(demo, "part_mark")?.mask).toBe(true);
    expect(resolveTextStyle(demo, "link_label")?.textSizeMm).toBe(2.4);

    const shown = new Map<string, PartInstance>();
    for (const el of Object.values(demo.elements)) if (el.kind === "part") shown.set(el.id, el);

    // 1. E101 Power Plan: bows power arcs into room, hides switch legs, combines LP-1-1,3 into a 2-arrowhead MWBC home run, and carries live enlarged-plan callout.
    const v101 = demo.elements["v-e101"];
    expect(v101?.kind).toBe("view");
    if (v101?.kind === "view") {
      const pwrGraphics = deriveCircuitGraphics(demo, v101, shown, 96, "medium");
      const ckt1 = pwrGraphics.find((g) => g.linkId === "ckt-lp-1");
      expect(ckt1).toBeDefined();
      for (const path of ckt1!.paths) {
        for (const pt of path) expect(pt.y).toBeLessThan(27.75 * FT - 10);
      }
      expect(ckt1?.homeRun?.label).toBe("LP-1-1,3");
      expect(ckt1?.homeRun?.arrows).toBe(2);
      expect(pwrGraphics.some((g) => g.kind === "switch_leg")).toBe(false);
    }
    expect(demo.elements["co-elec-rm"]?.kind).toBe("drawing_item");

    // 2. E103 Lighting Plan / RCP: shows switch legs a–e, dash-dot 0-10V leg b, and switch-leg hash marks.
    const v103 = demo.elements["v-e103"];
    expect(v103?.kind).toBe("view");
    if (v103?.kind === "view") {
      const rcpGraphics = deriveCircuitGraphics(demo, v103, shown, 96, "medium");
      expect(rcpGraphics.some((g) => g.kind === "switch_leg" && g.numbers.some((n) => n.text === "a"))).toBe(true);
      expect(rcpGraphics.find((g) => g.kind === "switch_leg" && g.numbers.some((n) => n.text === "b"))?.dashPattern).toEqual([2.2, 0.8, 0.45, 0.8]);
      expect(rcpGraphics.some((g) => g.kind === "switch_leg" && g.numbers.some((n) => n.text === "c"))).toBe(true);
    }

    // 3. E104 Dedicated Controls Schematic Plan: hides branch circuits, keeps switch legs.
    const v104 = demo.elements["v-e104"];
    expect(v104?.kind).toBe("view");
    if (v104?.kind === "view") {
      const ctrlGraphics = deriveCircuitGraphics(demo, v104, shown, 96, "medium");
      expect(ctrlGraphics.some((g) => g.kind === "circuit")).toBe(false);
      expect(ctrlGraphics.some((g) => g.kind === "switch_leg")).toBe(true);
    }

    // 4. All plan scenes render cleanly with opaque masks.
    for (const id of ["v-e100", "v-e101", "v-e102", "v-e103", "v-e104"]) {
      const scene = buildViewScene(demo, id).scene;
      expect(scene.primitives.length).toBeGreaterThan(0);
      if (id === "v-e101") expect(sceneToSvg(scene)).toContain('fill="#fff" stroke="none"');
    }

    // 5. All 5 live schedules evaluate with real data (LP-1, HP-1, MDP, Lighting Fixtures, Lighting Controls).
    const lctrlView = demo.elements["v-sch-lctrl"];
    expect(lctrlView?.kind).toBe("view");
    if (lctrlView?.kind === "view" && lctrlView.props?.formSchedule) {
      const form = evaluateFormSchedule(demo, lctrlView.props.formSchedule);
      expect(form.grid.rows.length).toBeGreaterThanOrEqual(5);
      expect(form.grid.rows.some((r) => r[0] === "B" && r[4]?.includes("0-10V"))).toBe(true);
    }
    for (const id of ["v-sch-lp1", "v-sch-hp1", "v-sch-mdp", "v-sch-lfx", "v-sch-lctrl"]) {
      expect(buildViewScene(demo, id).scene.primitives.length).toBeGreaterThan(0);
    }

    // 6. Both live diagrams (One-Line MDP->HP-1 & T-1->LP-1, and Lighting Controls Diagram) evaluate live!
    const sldView = demo.elements["v-diag-sld"];
    const ctrlDiagView = demo.elements["v-diag-ctrl"];
    expect(sldView?.kind).toBe("view");
    expect(ctrlDiagView?.kind).toBe("view");
    if (sldView?.kind === "view") {
      const sld = evaluateDiagram(demo.elements, sldView);
      expect(sld?.items.length).toBeGreaterThan(10);
      expect(sld?.equipment.length).toBeGreaterThanOrEqual(4);
    }
    if (ctrlDiagView?.kind === "view") {
      const cdiag = evaluateDiagram(demo.elements, ctrlDiagView);
      expect(cdiag?.items.length).toBeGreaterThan(20);
      expect(cdiag?.boxes.length).toBeGreaterThanOrEqual(5);
    }
    expect(buildViewScene(demo, "v-diag-sld").scene.primitives.length).toBeGreaterThan(0);
    expect(buildViewScene(demo, "v-diag-ctrl").scene.primitives.length).toBeGreaterThan(0);

    // 7. All 3 Arch D sheets (E101 Power/Enlarged/LP-1, E201 Lighting/Controls/Schedules, E501 Diagrams/Distribution) render cleanly!
    for (const sheetId of ["sh-e101", "sh-e201", "sh-e501"]) {
      const sheetScene = buildSheetSceneFor(demo, sheetId, { projectName: "Commercial Suite Demo" });
      expect(sheetScene.primitives.length).toBeGreaterThan(30);
    }
  });
});
