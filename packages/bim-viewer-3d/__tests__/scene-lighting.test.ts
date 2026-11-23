/**
 * @jest-environment node
 *
 * Trade-agnostic 3D lighting controller, frustum-culled SpotLight pool,
 * scalar heatmap overlay, and depth-aware 3D origin axis tests.
 */
import * as THREE from "three";
import {
  SCENE_LIGHTING_PRESETS,
  SceneLightingController,
  buildScalarHeatmapGroup,
  buildSceneLightEmitterGroup,
  sampleHeatmapColor,
  type SceneLightEmitter,
} from "../src/index";
import { buildDepthAwareAxisLines, updateDepthAwareAxisLines } from "../src/origin-gizmo";

describe("3D scalar heatmap overlay", () => {
  it("builds vertex-colored cells with rotation and pass/fail crimson borders", () => {
    const group = buildScalarHeatmapGroup({
      cells: [
        { xMm: 1000, yMm: 1000, zMm: 762, widthMm: 600, depthMm: 600, value: 35, fail: false },
        { xMm: 2000, yMm: 1000, zMm: 1200, widthMm: 600, depthMm: 450, value: 0.04, fail: true, rotationDeg: 90 },
      ],
      minValue: 0,
      maxValue: 50,
      threshold: 0.1,
      palette: "pass_fail",
    });

    expect(group.children.length).toBe(2); // surface mesh + fail LineSegments
    const failRgb = sampleHeatmapColor(0.02, 0, 5, "pass_fail", 0.1, true);
    expect(failRgb[0]).toBeGreaterThan(0.8);
  });
});

describe("3D scene lighting presets & frustum-culled SpotLight pool", () => {
  const sampleEmitters: readonly SceneLightEmitter[] = [
    {
      id: "normal-1",
      positionMm: [3000, 3000, 2743],
      direction: [0, 0, -1],
      intensityCandela: 1100,
      lumens: 3500,
      colorHex: 0xfff8ee,
      beamAngleDeg: 110,
      penumbra: 0.7,
      rangeMm: 3000,
      apertureMm: [1200, 600],
      apertureShape: "rect",
      mountKind: "ceiling",
      emitterRole: "standard",
      activeInNormal: true,
      activeInBlackout: false,
      blackoutScale: 0,
    },
    {
      id: "egress-1",
      positionMm: [6000, 3000, 2743],
      direction: [0, 0, -1],
      intensityCandela: 600,
      lumens: 1500,
      colorHex: 0xfff0d9,
      beamAngleDeg: 95,
      penumbra: 0.65,
      rangeMm: 3000,
      apertureMm: [180, 180],
      apertureShape: "round",
      mountKind: "ceiling",
      emitterRole: "standard",
      activeInNormal: true,
      activeInBlackout: true,
      blackoutScale: 0.5,
      blackout90MinScale: 0.3,
    },
    {
      id: "exit-combo-heads",
      positionMm: [4000, 5000, 2590],
      direction: [0, 0, -1],
      intensityCandela: 220,
      lumens: 450,
      colorHex: 0xfff3d4,
      beamAngleDeg: 110,
      penumbra: 0.7,
      rangeMm: 3000,
      apertureMm: [240, 64],
      apertureShape: "rect",
      mountKind: "ceiling",
      emitterRole: "emergency_only",
      activeInNormal: false,
      activeInBlackout: true,
      blackoutScale: 1.0,
      blackout90MinScale: 0.6,
    },
    {
      id: "exterior-sconce-1",
      positionMm: [2000, 0, 2400],
      direction: [0, -0.56, -0.828],
      intensityCandela: 650,
      lumens: 1200,
      colorHex: 0xffe4b8,
      beamAngleDeg: 95,
      penumbra: 0.65,
      rangeMm: 4500,
      apertureMm: [214, 112],
      apertureShape: "rect",
      mountKind: "wall",
      emitterRole: "standard",
      activeInNormal: true,
      activeInBlackout: false,
      blackoutScale: 0,
    },
    {
      id: "exit-sign-face",
      positionMm: [4000, 5000, 2650],
      direction: [0, 0, -1],
      intensityCandela: 0,
      lumens: 0,
      colorHex: 0xff2b2b,
      beamAngleDeg: 120,
      penumbra: 0.8,
      rangeMm: 500,
      apertureMm: [280, 96],
      diffuserPlane: "vertical_double_face",
      signDepthMm: 52,
      mountKind: "wall",
      emitterRole: "sign",
      activeInNormal: true,
      activeInBlackout: true,
      blackoutScale: 1,
      blackout90MinScale: 1,
    },
  ];

  const lightStats = (g: THREE.Group) => {
    let spots = 0;
    let bounces = 0;
    let points = 0;
    let sumIntensity = 0;
    let sumBounceIntensity = 0;
    const bounceHeights: number[] = [];
    const bounceAimUp: boolean[] = [];
    const spotDistances: number[] = [];
    const ceilingAnglesDeg: number[] = [];
    g.traverse((o) => {
      if (o instanceof THREE.SpotLight) {
        if (o.name === "interior-bounce") {
          bounces++;
          sumBounceIntensity += o.intensity;
          bounceHeights.push(o.position.y);
          bounceAimUp.push(o.target.position.y > o.position.y);
        } else {
          spots++;
          sumIntensity += o.intensity;
          spotDistances.push(o.distance);
          if (o.target.position.y < o.position.y - 2) {
            ceilingAnglesDeg.push((o.angle * 180) / Math.PI);
          }
        }
      }
      if (o instanceof THREE.PointLight) points++;
    });
    return { spots, bounces, points, sumIntensity, sumBounceIntensity, bounceHeights, bounceAimUp, spotDistances, ceilingAnglesDeg };
  };

  it("switches emitters cleanly across no_shadows, daytime, evening, night, blackout initial, and blackout 90-min", () => {
    const noShadows = buildSceneLightEmitterGroup(sampleEmitters, SCENE_LIGHTING_PRESETS.no_shadows);
    expect(noShadows.children.length).toBe(0);

    const noon = lightStats(buildSceneLightEmitterGroup(sampleEmitters, SCENE_LIGHTING_PRESETS.noon));
    const evening = lightStats(buildSceneLightEmitterGroup(sampleEmitters, SCENE_LIGHTING_PRESETS.evening));
    const night = lightStats(buildSceneLightEmitterGroup(sampleEmitters, SCENE_LIGHTING_PRESETS.night));
    const nightDraft = lightStats(buildSceneLightEmitterGroup(sampleEmitters, SCENE_LIGHTING_PRESETS.night, { renderQuality: "draft" }));
    const emInit = lightStats(buildSceneLightEmitterGroup(sampleEmitters, SCENE_LIGHTING_PRESETS.night_blackout));
    const em90 = lightStats(buildSceneLightEmitterGroup(sampleEmitters, SCENE_LIGHTING_PRESETS.night_blackout_90min));

    // Daytime & Draft: interior fixtures ON, photocell exterior sconce & emergency-only heads OFF, zero bounce lights & zero PointLights
    expect(noon.spots).toBe(2);
    expect(noon.bounces).toBe(0);
    expect(noon.points).toBe(0);
    expect(nightDraft.bounces).toBe(0);
    // Evening & Night: interior + exterior photocell sconce ON (3), plus upward floor-to-ceiling interior bounce
    expect(evening.spots).toBe(3);
    expect(night.spots).toBe(3);
    expect(night.points).toBe(0);
    expect(night.bounces).toBeGreaterThan(0);
    expect(night.bounces).toBeLessThanOrEqual(2); // only interior ceiling emitters (never exterior wall sconce)
    for (const y of night.bounceHeights) expect(y).toBeLessThan(0.6); // floor-bounce origin just above finished floor
    for (const up of night.bounceAimUp) expect(up).toBe(true); // aims strictly upward onto walls, equipment, and ceiling
    // Ceiling spotlights reach cleanly past floor height and widen IES 50% FWHM -> soft Lambertian field cone
    for (const d of night.spotDistances) expect(d).toBeGreaterThanOrEqual(3.8);
    expect(night.ceilingAnglesDeg.some((deg) => deg >= 75)).toBe(true);
    // Emergency Initial: normal-only OFF, dual-mode dimmed + emergency-only combo heads snap ON
    expect(emInit.spots).toBe(2);
    expect(emInit.sumIntensity).toBeLessThan(night.sumIntensity);
    expect(emInit.sumBounceIntensity).toBeLessThan(night.sumBounceIntensity);
    // Emergency 90-Min: further 60% battery end-of-discharge derate
    expect(em90.spots).toBe(2);
    expect(em90.sumIntensity).toBeLessThan(emInit.sumIntensity);
    expect(em90.sumBounceIntensity).toBeLessThan(emInit.sumBounceIntensity);
  });

  it("reassigns its fixed SpotLight pool in-place to include every closely-spaced fixture inside the camera frustum", () => {
    // 30 emitters across a building, including twin pendants 1.2 m apart at (6 m, 4 m) and (6 m, 5.2 m)
    const many: SceneLightEmitter[] = [];
    for (let i = 0; i < 28; i++) {
      many.push({
        id: `far-${i}`,
        positionMm: [14000 + (i % 7) * 2000, 1000 + Math.floor(i / 7) * 2500, 2900],
        direction: [0, 0, -1],
        intensityCandela: 1000,
        lumens: 3600,
        colorHex: 0xfff8ee,
        beamAngleDeg: 110,
        penumbra: 0.7,
        rangeMm: 3100,
        apertureMm: [1200, 600],
        mountKind: "ceiling",
        emitterRole: "standard",
        activeInNormal: true,
      });
    }
    many.push(
      {
        id: "twin-a",
        positionMm: [6000, 4000, 2300],
        direction: [0, 0, -1],
        intensityCandela: 900,
        lumens: 3400,
        colorHex: 0xfff0d9,
        beamAngleDeg: 105,
        penumbra: 0.7,
        rangeMm: 2800,
        apertureMm: [1200, 90],
        rotationDeg: 90,
        mountKind: "pendant",
        emitterRole: "standard",
        activeInNormal: true,
      },
      {
        id: "twin-b",
        positionMm: [6000, 5200, 2300],
        direction: [0, 0, -1],
        intensityCandela: 900,
        lumens: 3400,
        colorHex: 0xfff0d9,
        beamAngleDeg: 105,
        penumbra: 0.7,
        rangeMm: 2800,
        apertureMm: [1200, 90],
        rotationDeg: 90,
        mountKind: "pendant",
        emitterRole: "standard",
        activeInNormal: true,
      },
    );

    const fakeRenderer = { toneMappingExposure: 1 } as unknown as THREE.WebGLRenderer;
    const scene = new THREE.Scene();
    const root = new THREE.Group();
    const ctrl = new SceneLightingController(
      fakeRenderer,
      scene,
      new THREE.HemisphereLight(),
      new THREE.DirectionalLight(),
      new THREE.DirectionalLight(),
      root,
      null,
      new THREE.Color(0xffffff),
    );
    ctrl.setEmitters(many, true, "standard");
    ctrl.apply("night", { is3d: true, shadowsEnabled: true, renderQuality: "standard" });

    // Zoom camera straight in on twin-a & twin-b (scene coords: x=6, y=2.3, z=-4.0 and -5.2)
    const cam = new THREE.PerspectiveCamera(45, 16 / 9, 0.1, 200);
    cam.position.set(8.5, 1.8, -4.6);
    const target = new THREE.Vector3(6.0, 1.8, -4.6);
    cam.lookAt(target);
    cam.updateMatrixWorld();
    cam.updateProjectionMatrix();

    ctrl.updateCameraFocus(cam, target);

    const spots: THREE.SpotLight[] = [];
    const bounces: THREE.SpotLight[] = [];
    root.traverse((o) => {
      if (o instanceof THREE.SpotLight) {
        if (o.name === "interior-bounce") bounces.push(o);
        else spots.push(o);
      }
    });
    // Bounded pools keep GPU fragment cost small while BOTH zoomed-in twins stay illuminated + bounced
    expect(spots.length).toBe(12);
    expect(bounces.length).toBe(6);
    expect(spots.some((s) => Math.hypot(s.position.x - 6.0, s.position.z - -4.0) < 0.25)).toBe(true);
    expect(spots.some((s) => Math.hypot(s.position.x - 6.0, s.position.z - -5.2) < 0.25)).toBe(true);
  });
});

describe("Depth-aware 3D origin axis lines", () => {
  it("renders paired foreground (LessEqualDepth) and dimmed behind-building (GreaterDepth) passes", () => {
    const group = buildDepthAwareAxisLines();
    const lines = group.children.filter((c): c is THREE.Line => c instanceof THREE.Line);
    expect(lines.length).toBe(6); // 3 axes × 2 depth passes
    const front = lines.filter((l) => (l.material as THREE.LineDashedMaterial).depthFunc === THREE.LessEqualDepth);
    const behind = lines.filter((l) => (l.material as THREE.LineDashedMaterial).depthFunc === THREE.GreaterDepth);
    expect(front.length).toBe(3);
    expect(behind.length).toBe(3);
    expect((behind[0]!.material as THREE.LineDashedMaterial).opacity).toBeLessThan(
      (front[0]!.material as THREE.LineDashedMaterial).opacity,
    );

    const cam = new THREE.PerspectiveCamera(45, 16 / 9, 0.1, 500);
    cam.position.set(10, 10, 10);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld();
    updateDepthAwareAxisLines(group, cam, new THREE.Vector3(), 900);
    expect(lines.every((l) => l.visible)).toBe(true);
  });
});
