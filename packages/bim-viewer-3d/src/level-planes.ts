import * as THREE from "three";

/**
 * Levels in the 3D view: a faint outline at each level's height around the
 * building, with its name and height on a label that keeps its screen size.
 * Subtle on purpose: they say where the floors are without hiding the model.
 * A layer of its own (added to the viewer's scene by the caller), so it needs
 * nothing from the viewer but its scene and colours.
 */

export interface LevelPlaneSpec {
  readonly id: string;
  readonly name: string;
  readonly elevationMm: number;
}

/** Kernel millimetres, plan only (x east, y plan north). */
export interface PlanExtentMm {
  readonly min: { readonly x: number; readonly y: number };
  readonly max: { readonly x: number; readonly y: number };
}

export interface LevelPlaneLayout {
  readonly id: string;
  /** Outline corners, scene metres (x east, y up, z south), closed loop. */
  readonly corners: readonly [number, number, number][];
  /** Where the label sits: the outline's west-south corner, scene metres. */
  readonly label: readonly [number, number, number];
  readonly text: string;
}

const MM = 0.001;
/** How far the outline reaches past the building, mm. */
export const LEVEL_PLANE_MARGIN_MM = 1500;
const LABEL_SCREEN_HEIGHT = 0.028;
/** The lens angle the label size was tuned at, degrees. A sprite without size attenuation still scales with the projection (spanning scale/tan(fov/2) of the view), so any other angle rescales it to keep the same screen size. */
const LABEL_FOV_CALIBRATION_DEG = 45;
const LABEL_FOV_CALIBRATION_TAN = Math.tan(THREE.MathUtils.degToRad(LABEL_FOV_CALIBRATION_DEG) / 2);

/** Feet and inches for the label: 26'-6". */
function heightText(mm: number): string {
  const inches = Math.round((Math.abs(mm) / 25.4) * 4) / 4;
  const ft = Math.floor(inches / 12);
  const rest = Math.round((inches - ft * 12) * 4) / 4;
  return `${mm < 0 ? "-" : ""}${ft}'-${rest}"`;
}

/** Where each level's outline and label go, around `extent` grown by the margin. */
export function levelPlaneLayout(levels: readonly LevelPlaneSpec[], extent: PlanExtentMm): LevelPlaneLayout[] {
  const x0 = (extent.min.x - LEVEL_PLANE_MARGIN_MM) * MM;
  const x1 = (extent.max.x + LEVEL_PLANE_MARGIN_MM) * MM;
  // Plan north is scene −z.
  const zSouth = -(extent.min.y - LEVEL_PLANE_MARGIN_MM) * MM;
  const zNorth = -(extent.max.y + LEVEL_PLANE_MARGIN_MM) * MM;
  return levels.map((l) => {
    const y = l.elevationMm * MM;
    return {
      id: l.id,
      corners: [
        [x0, y, zSouth],
        [x1, y, zSouth],
        [x1, y, zNorth],
        [x0, y, zNorth],
      ],
      label: [x0, y, zSouth],
      text: `${l.name}  ${heightText(l.elevationMm)}`,
    };
  });
}

function labelTexture(text: string, color: string, background: string): { texture: THREE.CanvasTexture; aspect: number } {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser can't draw level labels (no 2D canvas).");
  const font = "600 28px system-ui, sans-serif";
  ctx.font = font;
  const width = Math.ceil(ctx.measureText(text).width) + 20;
  canvas.width = width;
  canvas.height = 40;
  ctx.font = font;
  ctx.fillStyle = background;
  ctx.globalAlpha = 0.8;
  ctx.fillRect(0, 0, width, 40);
  ctx.globalAlpha = 1;
  ctx.fillStyle = color;
  ctx.textBaseline = "middle";
  ctx.fillText(text, 10, 21);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return { texture, aspect: width / 40 };
}

export interface LevelPlaneColors {
  /** Outline and label text. */
  readonly line: string;
  /** The hovered or selected level. */
  readonly highlight: string;
  /** Label background (the canvas background, so text reads on any model). */
  readonly background: string;
}

/** How the active 3D camera projects sprites: perspective by lens angle, orthographic by visible height. */
export type LevelLabelCamera =
  | { readonly projection: "perspective"; readonly fovDeg: number }
  | { readonly projection: "orthographic"; readonly orthoHeightMm: number };

export class LevelPlanes {
  readonly object = new THREE.Group();
  private specs: readonly LevelPlaneSpec[] = [];
  private extent: PlanExtentMm | null = null;
  private highlighted: string | null = null;
  private labelCamera: LevelLabelCamera = { projection: "perspective", fovDeg: LABEL_FOV_CALIBRATION_DEG };
  /** Label sprites and their canvas aspect ratios, to rescale when the camera projection or lens changes. */
  private labels: { readonly sprite: THREE.Sprite; readonly aspect: number }[] = [];

  constructor(private colors: LevelPlaneColors) {
    this.object.name = "level-planes";
    // Drawn after the model so the faint lines read over floors they sit on.
    this.object.renderOrder = 5;
  }

  set(levels: readonly LevelPlaneSpec[], extent: PlanExtentMm | null) {
    this.specs = levels;
    this.extent = extent;
    this.rebuild();
  }

  setHighlighted(id: string | null) {
    if (id === this.highlighted) return;
    this.highlighted = id;
    this.rebuild();
  }

  setColors(colors: LevelPlaneColors) {
    this.colors = colors;
    this.rebuild();
  }

  setVisible(visible: boolean) {
    this.object.visible = visible;
  }

  /** Keep the labels the same fraction of the view whatever lens angle or orthographic zoom the camera carries. */
  setCamera(camera: LevelLabelCamera) {
    if (
      camera.projection === this.labelCamera.projection &&
      (camera.projection === "perspective"
        ? Math.abs(camera.fovDeg - (this.labelCamera as Extract<LevelLabelCamera, { projection: "perspective" }>).fovDeg) < 1e-6
        : Math.abs(camera.orthoHeightMm - (this.labelCamera as Extract<LevelLabelCamera, { projection: "orthographic" }>).orthoHeightMm) < 1e-6)
    ) {
      return;
    }
    this.labelCamera = camera;
    this.applyLabelScales();
  }

  /** Keep the labels the same fraction of the view whatever lens angle a perspective camera carries (the FOV slider, or a saved 3D camera). */
  setFovDeg(fovDeg: number) {
    this.setCamera({ projection: "perspective", fovDeg });
  }

  /** Undo the projection's scaling so labels span the same NDC height in both perspective (scale/tan(fov/2)) and orthographic (scale*2/orthoHeightM). */
  private applyLabelScales() {
    const height =
      this.labelCamera.projection === "orthographic"
        ? (LABEL_SCREEN_HEIGHT / (2 * LABEL_FOV_CALIBRATION_TAN)) * Math.max(1e-3, this.labelCamera.orthoHeightMm) * MM
        : LABEL_SCREEN_HEIGHT * (Math.tan(THREE.MathUtils.degToRad(this.labelCamera.fovDeg) / 2) / LABEL_FOV_CALIBRATION_TAN);
    for (const { sprite, aspect } of this.labels) sprite.scale.set(height * aspect, height, 1);
  }

  dispose() {
    this.clear();
    this.object.removeFromParent();
  }

  private clear() {
    this.labels = [];
    for (const child of [...this.object.children]) {
      child.traverse((o) => {
        if (o instanceof THREE.LineLoop) {
          o.geometry.dispose();
          if (o.material instanceof THREE.Material) o.material.dispose();
        }
        if (o instanceof THREE.Sprite) {
          o.material.map?.dispose();
          o.material.dispose();
        }
      });
      this.object.remove(child);
    }
  }

  private rebuild() {
    this.clear();
    if (!this.extent) return;
    for (const layout of levelPlaneLayout(this.specs, this.extent)) {
      const hot = layout.id === this.highlighted;
      const color = hot ? this.colors.highlight : this.colors.line;
      const group = new THREE.Group();
      group.userData.levelId = layout.id;
      const geometry = new THREE.BufferGeometry().setFromPoints(layout.corners.map(([x, y, z]) => new THREE.Vector3(x, y, z)));
      const line = new THREE.LineLoop(geometry, new THREE.LineDashedMaterial({ color, dashSize: 0.6, gapSize: 0.35, transparent: true, opacity: hot ? 0.95 : 0.55, depthWrite: false }));
      line.computeLineDistances();
      line.renderOrder = 5;
      group.add(line);
      const { texture, aspect } = labelTexture(layout.text, color, this.colors.background);
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, sizeAttenuation: false, depthTest: false, transparent: true }));
      sprite.center.set(0, 0);
      this.labels.push({ sprite, aspect });
      sprite.position.set(...layout.label);
      sprite.renderOrder = 6;
      group.add(sprite);
      this.object.add(group);
    }
    this.applyLabelScales();
  }
}
