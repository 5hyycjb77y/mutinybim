import * as THREE from "three";

/**
 * The on-screen colors of the 3D / plan view. The host passes them from its
 * theme (MutinyBIM: `MutinyTheme.viewer`); nothing in the viewer hardcodes a
 * UI color. Category colors (duct blue, pipe green…) are drawing conventions,
 * not theme, and stay in the viewer.
 */
export interface ViewerColors {
  readonly background: string;
  readonly planBackground: string;
  readonly selection: string;
  /** Edges of the selected object, the crop box and the orbit point: must read on `background` when `selection` can't. */
  readonly selectionOutline: string;
  /** Hover pre-highlight ("Tab to select more"). */
  readonly hover: string;
  readonly provisional: string;
  readonly edges: string;
  readonly axisX: string;
  readonly axisY: string;
  readonly axisZ: string;
}

/** Neutral defaults for a host that passes no theme. */
export const DEFAULT_VIEWER_COLORS: ViewerColors = {
  background: "#eef1f5",
  planBackground: "#ffffff",
  selection: "#ff7a1a",
  selectionOutline: "#9a3f00",
  hover: "#1fb6ff",
  provisional: "#f2a33a",
  edges: "#0f2a4a",
  axisX: "#db3333",
  axisY: "#2e9e4c",
  axisZ: "#3366e6",
};

const CSS_COLOR = /^(#[0-9a-f]{3}|#[0-9a-f]{6}|(rgb|hsl)a?\([^)]*\))$/i;

/** three.js only warns on a color it can't read and leaves white, so check first and fall back loudly. */
function color(value: string, fallback: string, slot: string): THREE.Color {
  const trimmed = value.trim();
  const readable = CSS_COLOR.test(trimmed) || trimmed.toLowerCase() in THREE.Color.NAMES;
  if (!readable) console.error("[bim-viewer-3d] viewer color is not a CSS color; using the default", { slot, value });
  return new THREE.Color().setStyle(readable ? trimmed : fallback);
}

/** The materials and colors the viewer draws selection, edges, backgrounds and axes with. */
export class ViewerPalette {
  readonly background = new THREE.Color();
  readonly planBackground = new THREE.Color();
  readonly pickHighlight = new THREE.Color();
  readonly axes: readonly [THREE.Color, THREE.Color, THREE.Color] = [new THREE.Color(), new THREE.Color(), new THREE.Color()];
  readonly selected = new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.1 });
  /** A selected group (run, branch, system, box selection), drawn over the model. */
  readonly groupSelected = new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.1, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  readonly hover = new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.1, transparent: true, opacity: 0.85, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  readonly provisional = new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.1, transparent: true, opacity: 0.85 });
  readonly edge = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.55 });
  /** The selected object's edges: opaque, and drawn in every visual style. */
  readonly selectedEdge = new THREE.LineBasicMaterial();
  private current: ViewerColors = DEFAULT_VIEWER_COLORS;

  constructor(colors?: Partial<ViewerColors>) {
    this.apply(colors ?? {});
  }

  get colors(): ViewerColors {
    return this.current;
  }

  /** Updates every material and color in place, so drawn objects change without a rebuild. */
  apply(colors: Partial<ViewerColors>): void {
    const next: ViewerColors = { ...this.current, ...colors };
    const d = DEFAULT_VIEWER_COLORS;
    this.current = next;
    this.background.copy(color(next.background, d.background, "background"));
    this.planBackground.copy(color(next.planBackground, d.planBackground, "planBackground"));
    const selection = color(next.selection, d.selection, "selection");
    this.pickHighlight.copy(selection);
    this.selected.color.copy(selection);
    this.selected.emissive.copy(selection).multiplyScalar(0.3);
    this.groupSelected.color.copy(selection);
    this.groupSelected.emissive.copy(selection).multiplyScalar(0.3);
    this.selectedEdge.color.copy(color(next.selectionOutline, d.selectionOutline, "selectionOutline"));
    const hover = color(next.hover, d.hover, "hover");
    this.hover.color.copy(hover);
    this.hover.emissive.copy(hover).multiplyScalar(0.35);
    this.provisional.color.copy(color(next.provisional, d.provisional, "provisional"));
    this.edge.color.copy(color(next.edges, d.edges, "edges"));
    this.axes[0].copy(color(next.axisX, d.axisX, "axisX"));
    this.axes[1].copy(color(next.axisY, d.axisY, "axisY"));
    this.axes[2].copy(color(next.axisZ, d.axisZ, "axisZ"));
  }

  /** `#rrggbb` for canvas-drawn symbols. */
  css(slot: "selection" | "selectionOutline" | "edges"): string {
    const c = slot === "selection" ? this.pickHighlight : slot === "selectionOutline" ? this.selectedEdge.color : this.edge.color;
    return `#${c.getHexString()}`;
  }

  dispose(): void {
    this.selected.dispose();
    this.groupSelected.dispose();
    this.hover.dispose();
    this.provisional.dispose();
    this.edge.dispose();
    this.selectedEdge.dispose();
  }
}
