/**
 * The 3D model view: linked IFC references drawn by That Open Fragments,
 * authored MEP drawn as kernel-generated three.js solids on top, one camera
 * rig for 3D orbit and a top-down plan cut, a section box, level isolation,
 * discipline visibility and picking.
 */
import * as THREE from "three";
import CameraControls from "camera-controls";
import { FragmentsModels, type FragmentsModel } from "@thatopen/fragments";
import { asElementId, elementEntries, type Aabb3, type CropBox3d, type CropFace, type DisplayContext, type ElementId, type ModelState, type RouteJoin, type View3dCamera, findLevelByName, normalizeLevelName } from "@permitzip/bim-kernel";
import { liveDisplayOf, liveViewRangeExcludes, type CategoryView } from "./live-display";
import { livePlanSymbols, symbolPositions, type LivePlanText } from "./live-plan-graphics";
import { PlanFootprintGrid } from "./plan-near-miss";
import { ifcPlacementToScene, kernelToScene, MM, sceneToKernel, toColumnMajor, type Mat4Rows, type Vec3Tuple } from "./coords";
import { robustCore } from "./framing";
import { DEFAULT_ELEVATIONS, modelSolids, routeJoinSolids, type ElevationRules, type RenderGroup, type Solid } from "./native-geometry";
import { batchMeshSolids, batchOwnerAt, type MeshBatch } from "./mesh-batches";
import { readReferenceItem, type ReferenceItemProperties } from "./item-properties";
import { nearestTurn, type Orientation, type PlanRectMm } from "./orientation";
import { screenBoxes, type ScreenRect } from "./box-select";
import { ARROW_PX, buildArrows, chooseOrbitPivot, gizmoHandleAt, gizmoScreen, metresPerPixel, planUpVector, pointOnScreen, type GizmoHandle, type GizmoScreen } from "./origin-gizmo";
import { ViewerPalette, type ViewerColors } from "./viewer-colors";
import { matchCamera, orthoZoomFor, type Projection, type ViewCamera } from "./projection";
import { makeCameraControls, pinOrbitPoint, zoomFloorFor, type PointZoomControls, type ZoomAnchorQuery } from "./navigation";
import { NORMAL_REFERENCE_TONE, PICK_HIGHLIGHT_ID, baseMaterials, overlayMaterial, referenceMayWinPick, sameReferenceTone, toneMaterial, type ReferenceTone } from "./reference-tone";
import { NO_INSETS, planFit, type FrameInsets } from "./plan-fit";
import { CropBoxOutline, cropBoxScenePlanes, faceDragOffsetMm, gripsOnScreen, keptByPlanes, type GripOnScreen } from "./crop-box";
import { facingRay, SurfacePicker, toSurfaceHit, type SceneSurfaceHit, type SurfaceHit, type SurfaceQuery } from "./surface-pick";
import { solidRotation } from "./solid-pose";
import { nativeHiddenByLinked } from "./hover-occlusion";

export type ViewMode = "3d" | "plan";

/** A material Fragments makes reaches a mesh within a few frames of being made. */
const REFERENCE_MATERIAL_WATCH_FRAMES = 30;

interface LoadedEntry {
  readonly model: FragmentsModel;
  readonly info: LoadedReference;
  readonly hiddenIds: number[];
  /** Items of the IFC categories the open view hides. */
  toneHiddenIds: number[];
  readonly categoryIds: Map<string, number[]>;
}
export type ReferenceDiscipline = "architecture" | "mep";

export interface ReferenceSpec {
  readonly id: string;
  readonly label: string;
  readonly discipline: ReferenceDiscipline;
  readonly bytes: ArrayBuffer;
  /** Link -> host placement as recorded by the exporter (IFC axes, metres, row-major). */
  readonly ifcPlacement?: Mat4Rows;
}

export interface LoadedReference {
  readonly id: string;
  readonly label: string;
  readonly discipline: ReferenceDiscipline;
  readonly loadMs: number;
  readonly levels: readonly { readonly name: string; readonly localIds: readonly number[] }[];
}

export type Pick =
  | { readonly source: "native"; readonly elementId: ElementId; readonly point: THREE.Vector3 }
  | { readonly source: "reference"; readonly referenceId: string; readonly localId: number; readonly point: THREE.Vector3 }
  | { readonly source: "marker"; readonly referenceId: string; readonly markerId: string; readonly point: THREE.Vector3 };

/**
 * A symbol for an element a reference's IFC left out (a receptacle has no 3D
 * body), drawn at the location Revit records. Same screen size at any zoom.
 */
export interface MarkerSpec {
  readonly id: string;
  /** Scene metres (already through the reference's placement). */
  readonly position: Vec3Tuple;
  /** Storey name, for level isolation; null shows on every level. */
  readonly level: string | null;
}

export interface ViewerStats {
  readonly fps: number;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly geometries: number;
  readonly textures: number;
}

export interface ViewerOptions {
  /** URL of the Fragments worker (bundled with the app; never fetched from a CDN). */
  readonly workerUrl: string;
  readonly elevations?: ElevationRules;
  /** Called after every rendered frame where stats changed meaningfully. */
  readonly onStats?: (stats: ViewerStats) => void;
  /** On-screen colors from the host's theme; missing slots use neutral defaults. */
  readonly colors?: Partial<ViewerColors>;
}

const GROUP_STYLE: Record<RenderGroup, { color: number; roughness: number; metalness: number; opacity?: number }> = {
  duct: { color: 0x2f7fd8, roughness: 0.45, metalness: 0.35 },
  duct_fitting: { color: 0x2569b8, roughness: 0.45, metalness: 0.35 },
  terminal: { color: 0xe9eef5, roughness: 0.6, metalness: 0.1 },
  equipment: { color: 0x5b6b7a, roughness: 0.55, metalness: 0.4 },
  pipe: { color: 0x2ea86b, roughness: 0.4, metalness: 0.3 },
  electrical: { color: 0xd9a21b, roughness: 0.5, metalness: 0.2 },
  sprinkler: { color: 0xd8463b, roughness: 0.45, metalness: 0.3 },
  wall: { color: 0xdedbd5, roughness: 0.9, metalness: 0 },
  slab: { color: 0xc9c6c0, roughness: 0.95, metalness: 0 },
  structure: { color: 0x9aa3ab, roughness: 0.8, metalness: 0.1 },
  riser: { color: 0x7a5bd8, roughness: 0.45, metalness: 0.3 },
  furnishing: { color: 0xb59a7a, roughness: 0.85, metalness: 0 },
  insulation: { color: 0xe8d9a8, roughness: 0.95, metalness: 0, opacity: 0.35 },
  mounting_plane: { color: 0x8fb3d9, roughness: 0.9, metalness: 0, opacity: 0.25 },
  filler: { color: 0x8a6f52, roughness: 0.7, metalness: 0.05 },
  glazing: { color: 0x9fc8e8, roughness: 0.1, metalness: 0.1, opacity: 0.3 },
};

/** Plan symbols sit this far under the cut, so the cut never clips them. */
const PLAN_SYMBOL_BELOW_CUT_MM = 50;
/** Drawn after the model, so a swing over a floor reads like the printed plan. */
const PLAN_SYMBOL_RENDER_ORDER = 10;
/** A plan with no saved view draws its symbols as a 1:100 plan would. */
const DEFAULT_PLAN_SYMBOL_SCALE = 100;

const PICK_TOLERANCE_PX: readonly (readonly [number, number])[] = [[0, 0], [-4, 0], [4, 0], [0, -4], [0, 4], [-8, 0], [8, 0], [0, -8], [0, 8]];
/** In plan, a footprint this close to the pointer still picks when every ray missed (the rays' own reach). */
const PICK_NEAR_MISS_PX = 8;
/** Above this many solids, authored elements are instanced (no outlines) to keep frame time flat. */
const INSTANCE_THRESHOLD = 4000;
/** Marker size as a fraction of the view's height (sizeAttenuation off). */
const MARKER_SCREEN_SIZE = 0.028;
const MARKER_PICK_SLACK_M = 0.5;

/** A device symbol: a filled circle with two short bars (the plan mark for a receptacle or box). */
function markerTexture(fill: string, outline: string): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser can't draw the fixture symbols (no 2D canvas).");
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 4, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = outline;
  ctx.stroke();
  ctx.lineWidth = 5;
  for (const x of [size * 0.4, size * 0.6]) {
    ctx.beginPath();
    ctx.moveTo(x, size * 0.3);
    ctx.lineTo(x, size * 0.7);
    ctx.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Canvas pixels per text cap height: enough for a crisp tag at plan zoom. */
const PLAN_TEXT_PX = 48;

/** One line of plan text (a home-run tag, a mark) as a sprite texture, in `color`. */
function planTextTexture(text: string, color: string): { texture: THREE.CanvasTexture; aspect: number } {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser can't draw the plan's tags (no 2D canvas).");
  const font = `${PLAN_TEXT_PX}px sans-serif`;
  ctx.font = font;
  const width = Math.max(1, Math.ceil(ctx.measureText(text).width));
  canvas.width = width;
  canvas.height = Math.ceil(PLAN_TEXT_PX * 1.3);
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textBaseline = "middle";
  ctx.fillText(text, 0, canvas.height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return { texture, aspect: canvas.width / canvas.height };
}

interface NativeEntry {
  readonly object: THREE.Object3D;
  readonly elementId: ElementId;
  /** One mesh for many elements (walls per level): `elementId` is only its first; picks read the triangle's owner. */
  readonly batch?: { readonly owners: MeshBatch["owners"]; readonly triangleOwner: MeshBatch["triangleOwner"] };
}

/** A drawing view's visual style, as the live model shows it. */
export type ViewerVisualStyle = "wireframe" | "hidden_line" | "shaded" | "shaded_edges";

/** A plan camera as the viewer holds it: the point it looks at (scene metres), the view's half-height and its zoom. */
export interface PlanCameraState {
  readonly targetX: number;
  readonly targetZ: number;
  readonly halfHeight: number;
  readonly zoom: number;
}

/** Render groups drawn see-through over the model: a solid element under the pointer wins the pick over them. */
export const SEE_THROUGH_PICK_GROUPS: ReadonlySet<string> = new Set(["mounting_plane"]);

/**
 * The pick under a pointer with a few pixels of tolerance: the first solid hit
 * over the tolerance offsets, else a solid near miss (plan), else the first
 * see-through hit (a mounting plane over the work is picked only when nothing
 * solid is under the pointer).
 */
export function pickPreferringSolid<P>(
  offsets: readonly (readonly [number, number])[],
  exact: (dx: number, dy: number) => { readonly solid: P | null; readonly seeThrough: P | null } | null,
  nearSolid: () => P | null,
): P | null {
  let seeThrough: P | null = null;
  for (const [dx, dy] of offsets) {
    const hit = exact(dx, dy);
    if (hit?.solid) return hit.solid;
    seeThrough ??= hit?.seeThrough ?? null;
  }
  return nearSolid() ?? seeThrough;
}

/** From one ray's hits, nearest first: the nearest solid one, and the nearest see-through one before it. */
export function choosePickHits<P>(hits: readonly { readonly pick: P; readonly seeThrough: boolean }[]): { readonly solid: P | null; readonly seeThrough: P | null } {
  return { solid: hits.find((h) => !h.seeThrough)?.pick ?? null, seeThrough: hits.find((h) => h.seeThrough)?.pick ?? null };
}

export class ModelViewer3D {
  readonly scene = new THREE.Scene();
  readonly renderer: THREE.WebGLRenderer;
  private readonly perspective: THREE.PerspectiveCamera;
  private readonly ortho: THREE.OrthographicCamera;
  /** The 3D view's parallel camera (plan keeps its own straight-down one). */
  private readonly orthoView: THREE.OrthographicCamera;
  private projection: Projection = "perspective";
  /** Where the 3D view was looking when plan took over (a projection switch in plan frames about it). */
  private readonly last3dTarget = new THREE.Vector3();
  private controls: PointZoomControls;
  /** A completed click or a wheel zoom chose the orbit point (the controls' target); false: it follows the middle of the model. */
  private orbitPointPinned = false;
  private zoomFloor = 1;
  /** The last linked-model hit along the wheel's pointer ray (Fragments casts rays asynchronously), and the ray of the last miss. */
  private linkedAnchor: THREE.Vector3 | null = null;
  private linkedMiss: THREE.Ray | null = null;
  private linkedCast: Promise<void> | null = null;
  private readonly anchorRaycaster = new THREE.Raycaster();
  private readonly fragments: FragmentsModels;
  private readonly elevations: ElevationRules;
  private readonly references = new Map<string, LoadedEntry>();
  /** Per linked model id, how the open view draws it (kept across reloads and versions). */
  private readonly referenceTones = new Map<string, ReferenceTone>();
  /** Linked models switched off in this tab only. */
  private readonly sessionHiddenReferences = new Set<string>();
  /** Frames left to look for meshes using materials Fragments just made (a tile streaming in), so toned models tone them too. */
  private referenceMaterialFrames = 0;
  private readonly nativeRoot = new THREE.Group();
  /** Placement / move preview: drawn over the model, never picked. */
  private readonly ghostRoot = new THREE.Group();
  /** Hover pre-highlight and group selection, over the model; never picked. */
  private readonly highlightRoot = new THREE.Group();
  /** While routing: the face the route would join (an open end, a tap location). Over the model; never picked. */
  private readonly joinRoot = new THREE.Group();
  private readonly groupRoot = new THREE.Group();
  /** A selected element drawn inside a batch, as its own body over the batch; never picked. */
  private readonly selectedRoot = new THREE.Group();
  /** Elements drawn inside a batch (joined walls per level). */
  private batchedIds = new Set<string>();
  private selectedOverlayShown = false;
  /** Plan only: the plan symbols the printed drawing draws (a door's swing, a window's lines), over the cut; never picked. */
  private readonly planSymbolRoot = new THREE.Group();
  private planSymbolMaterial: THREE.LineBasicMaterial | null = null;
  /** Plan text textures by colour and text, kept across redraws; freed on dispose. */
  private readonly planTextTextures = new Map<string, { texture: THREE.CanvasTexture; aspect: number }>();
  private solidsById = new Map<string, Solid[]>();
  /** Plan footprints by grid cell, for the near-miss pick. A draw marks them stale; they catch up when idle, or at the next near miss. */
  private readonly planFootprints = new PlanFootprintGrid();
  private planFootprintsStale = true;
  private planFootprintsIdle: { readonly id: number; readonly idle: boolean } | null = null;
  private lastSolids: Solid[] = [];
  private highlightIds: ReadonlySet<string> | null = null;
  private groupIds: ReadonlySet<string> | null = null;
  private readonly referenceRoot = new THREE.Group();
  private readonly markerRoot = new THREE.Group();
  private readonly palette: ViewerPalette;
  /** The origin marker's arrows, in the theme's axis colors (the axis lines and label are drawn over the canvas from `originGizmoScreen`). */
  private readonly origin: THREE.Group;
  /** The project origin (base point), scene metres: the orbit point when none is chosen and nothing is loaded or drawn. */
  private readonly projectOrigin = new THREE.Vector3();
  private referencesBoxCache: Promise<THREE.Box3> | null = null;
  /** Degrees clockwise from plan north that points up in plan (the true north angle for a true-north plan). */
  private planUpDeg = 0;
  /** Per reference: its marker group and each marker's true position (plan view lowers them under the cut). */
  private readonly markers = new Map<string, { group: THREE.Group; items: { sprite: THREE.Sprite; spec: MarkerSpec }[] }>();
  private markerMaterials: { normal: THREE.SpriteMaterial; selected: THREE.SpriteMaterial } | null = null;
  private isolatedLevel: string | null = null;
  private authoredLevels: ReadonlySet<string> | null = null;
  private lastAuthored: { readonly accepted: ModelState; readonly view: ModelState } | null = null;
  private nativeEntries: NativeEntry[] = [];
  private readonly instanceLookup = new Map<THREE.InstancedMesh, ElementId[]>();
  private readonly materials = new Map<string, { group: RenderGroup; tint?: number; material: THREE.MeshStandardMaterial }>();
  private readonly hiddenGroups = new Set<RenderGroup>();
  /** Phase, phase filter and group settings of what is open (null: everything shows). */
  private displayContext: DisplayContext | null = null;
  private categoryView: CategoryView | null = null;
  /** Elements the open view's groups or phase filter hide (not drawn, not picked, not box-selected). */
  private hiddenElements: ReadonlySet<string> = new Set();
  private readonly toneMaterials = new Map<string, { group: RenderGroup; tint?: number; tone: "halftone" | "dashed"; material: THREE.MeshStandardMaterial }>();
  private dashedEdge: THREE.LineDashedMaterial | null = null;
  private readonly raycaster = new THREE.Raycaster();
  private readonly clock = new THREE.Clock();
  private mode: ViewMode = "3d";
  private visualStyle: ViewerVisualStyle = "shaded_edges";
  private sectionPlanes: THREE.Plane[] = [];
  private cutPlane: THREE.Plane | null = null;
  /** The open 3D view's crop box (kernel mm), its planes while cropping, and its outline (drawn unclipped, over the model). */
  private cropBox: CropBox3d | null = null;
  private cropBoxPlanes: THREE.Plane[] = [];
  private readonly overlayScene = new THREE.Scene();
  private readonly cropOutline: CropBoxOutline;
  private readonly cameraListeners = new Set<() => void>();
  private readonly cameraSettledListeners = new Set<() => void>();
  private readonly pointerClaims = new Set<symbol>();
  private selected: Pick | null = null;
  private frameCount = 0;
  private fpsWindow: number[] = [];
  private disposed = false;
  private resizeObserver: ResizeObserver;
  /** Canvas edges covered by panels drawn over it; a plan fit keeps clear of them. */
  private frameInsets: FrameInsets = NO_INSETS;
  /** The plan rectangle last framed, while nobody has panned or zoomed since: it is re-fitted when the canvas or its insets change. */
  private planFitted: { readonly box: THREE.Box3; readonly center: THREE.Vector3; readonly followInsets: boolean } | null = null;

  constructor(
    private readonly container: HTMLElement,
    private readonly options: ViewerOptions,
  ) {
    this.elevations = options.elevations ?? DEFAULT_ELEVATIONS;
    this.palette = new ViewerPalette(options.colors);
    this.origin = buildArrows(this.palette.axes);
    this.cropOutline = new CropBoxOutline(this.palette.css("selectionOutline"));
    this.overlayScene.add(this.cropOutline.object);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance", logarithmicDepthBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.localClippingEnabled = false;
    // Counted per frame, across the model pass and the crop box outline pass.
    this.renderer.info.autoReset = false;
    this.renderer.domElement.style.display = "block";
    this.renderer.domElement.style.outline = "none";
    container.appendChild(this.renderer.domElement);

    this.scene.background = this.palette.background;
    // Low ambient + a strong key light so walls, floors and roof planes read as different surfaces.
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x7d8794, 0.95));
    const sun = new THREE.DirectionalLight(0xfff6ea, 2.3);
    sun.position.set(60, 100, 35);
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0xdfe8ff, 0.45);
    fill.position.set(-50, 30, -40);
    this.scene.add(fill);
    this.scene.add(this.referenceRoot, this.nativeRoot, this.markerRoot, this.ghostRoot, this.groupRoot, this.highlightRoot, this.joinRoot, this.planSymbolRoot, this.selectedRoot, this.origin);

    const { width, height } = this.size();
    this.perspective = new THREE.PerspectiveCamera(45, width / height, 0.1, 5000);
    this.perspective.position.set(40, 30, 40);
    this.ortho = new THREE.OrthographicCamera(-50, 50, 50, -50, -1000, 1000);
    // A parallel view has no "behind the eye": the near plane sits far back so orbiting close never clips the model.
    this.orthoView = new THREE.OrthographicCamera(-50, 50, 50, -50, -5000, 5000);
    this.controls = this.makeControls(this.perspective);

    this.fragments = new FragmentsModels(options.workerUrl);
    this.fragments.settings.autoCoordinate = false;
    this.fragments.models.materials.list.onItemSet.add(({ value: material }) => {
      this.referenceMaterialFrames = REFERENCE_MATERIAL_WATCH_FRAMES;
      if (!("isLodMaterial" in material && material.isLodMaterial)) {
        material.polygonOffset = true;
        material.polygonOffsetUnits = 1;
        material.polygonOffsetFactor = 1;
      }
    });

    this.resizeObserver = new ResizeObserver(() => this.onContainerResize());
    this.resizeObserver.observe(container);
    this.renderer.setAnimationLoop(() => this.tick());
  }

  private size(): { width: number; height: number } {
    return { width: Math.max(1, this.container.clientWidth), height: Math.max(1, this.container.clientHeight) };
  }

  private makeControls(camera: THREE.PerspectiveCamera | THREE.OrthographicCamera): PointZoomControls {
    const controls = makeCameraControls(camera, this.renderer.domElement);
    controls.zoomFloor = this.zoomFloor;
    controls.zoomAnchor = this.zoomAnchorAt;
    controls.onPassThrough = () => this.emitPassThrough(true);
    controls.onZoomExtents = () => void this.frame().catch((err: unknown) => console.error("[ModelViewer3D] zoom extents failed", err));
    // Fresh controls (plan / 3D / projection / plan-up) start with nothing to step back out of.
    this.emitPassThrough(false);
    controls.onZoomAnchor = () => {
      // The point zoomed into is the 3D orbit point from now on; the middle of the model no longer claims it.
      if (this.mode !== "plan") this.orbitPointPinned = true;
    };
    controls.addEventListener("update", () => {
      void this.fragments.update();
      for (const listener of this.cameraListeners) listener();
    });
    // "sleep": the first frame with no movement after moving (a zoom or orbit has eased out, or an instant move landed).
    controls.addEventListener("sleep", () => {
      for (const listener of this.cameraSettledListeners) listener();
    });
    return controls;
  }

  private camera(): ViewCamera {
    return this.mode === "plan" ? this.ortho : this.camera3d();
  }

  private camera3d(): ViewCamera {
    return this.projection === "orthographic" ? this.orthoView : this.perspective;
  }

  /** The canvas changed size: a plan nobody has moved since it was framed is framed again for the new size. */
  private onContainerResize() {
    const held = this.planFitHolds() ? this.planFitted : null;
    this.resize();
    if (held) void this.applyPlanFit(held.box, false, held.followInsets).catch((err: unknown) => console.error("[ModelViewer3D] re-framing the plan after a resize failed", err));
  }

  private resize() {
    const { width, height } = this.size();
    this.renderer.setSize(width, height, false);
    this.renderer.domElement.style.width = `${width}px`;
    this.renderer.domElement.style.height = `${height}px`;
    this.perspective.aspect = width / height;
    this.perspective.updateProjectionMatrix();
    const half = (this.ortho.top - this.ortho.bottom) / 2;
    this.ortho.left = -half * (width / height);
    this.ortho.right = half * (width / height);
    this.ortho.updateProjectionMatrix();
    const viewHalf = (this.orthoView.top - this.orthoView.bottom) / 2;
    this.orthoView.left = -viewHalf * (width / height);
    this.orthoView.right = viewHalf * (width / height);
    this.orthoView.updateProjectionMatrix();
    void this.fragments.update(true);
  }

  private tick() {
    if (this.disposed) return;
    const delta = this.clock.getDelta();
    this.controls.update(delta);
    this.renderer.info.reset();
    if (this.origin.visible) this.origin.scale.setScalar(ARROW_PX * metresPerPixel(this.camera(), this.origin.position, this.size().height));
    this.toneNewReferenceMaterials();
    this.renderer.render(this.scene, this.camera());
    if (this.cropOutline.object.visible) {
      // The outline sits exactly on the clipping planes; draw it in its own pass with clipping off.
      const planes = this.renderer.clippingPlanes;
      this.renderer.clippingPlanes = [];
      this.renderer.autoClear = false;
      this.renderer.render(this.overlayScene, this.camera());
      this.renderer.autoClear = true;
      this.renderer.clippingPlanes = planes;
    }
    this.fpsWindow.push(delta);
    if (this.fpsWindow.length > 60) this.fpsWindow.shift();
    if (++this.frameCount % 30 === 0 && this.options.onStats) this.options.onStats(this.stats());
  }

  stats(): ViewerStats {
    const avg = this.fpsWindow.reduce((a, b) => a + b, 0) / Math.max(1, this.fpsWindow.length);
    const info = this.renderer.info;
    return {
      fps: avg > 0 ? Math.round(1 / avg) : 0,
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
    };
  }

  // ---------------------------------------------------------------- references

  async addReference(spec: ReferenceSpec): Promise<LoadedReference> {
    const t0 = performance.now();
    const model = await this.fragments.load(spec.bytes, { modelId: spec.id, camera: this.camera() });
    // The importer recentres each file on its own base point; undo that so every
    // reference sits in its true IFC coordinates, then apply the link placement.
    const [cx = 0, cy = 0, cz = 0] = await model.getCoordinates();
    const toIfc = new THREE.Matrix4().makeTranslation(-cx, -cy, -cz);
    const placement = spec.ifcPlacement ? new THREE.Matrix4().fromArray(toColumnMajor(ifcPlacementToScene(spec.ifcPlacement))) : new THREE.Matrix4();
    model.object.applyMatrix4(placement.multiply(toIfc));
    model.object.updateMatrixWorld(true);
    this.referenceRoot.add(model.object);
    this.styleReferences(model.object);
    // Lets Fragments skip clipped geometry when streaming and when picking.
    model.getClippingPlanesEvent = () => this.renderer.clippingPlanes;
    // Rooms and annotation are bookkeeping, not geometry anyone wants to look at.
    const hidden = await model.getItemsOfCategories([/^IFCSPACE$/, /^IFCANNOTATION$/, /^IFCOPENINGELEMENT$/]);
    const hiddenIds = Object.values(hidden).flat();
    if (hiddenIds.length > 0) await model.setVisible(hiddenIds, false);
    await this.fragments.update(true);
    const levels = await storeyItems(model);
    const info: LoadedReference = { id: spec.id, label: spec.label, discipline: spec.discipline, loadMs: Math.round(performance.now() - t0), levels };
    const entry: LoadedEntry = { model, info, hiddenIds, toneHiddenIds: [], categoryIds: new Map() };
    this.references.set(spec.id, entry);
    this.referencesBoxCache = null;
    if (this.referenceTones.has(spec.id) || this.sessionHiddenReferences.has(spec.id)) await this.applyReferenceTone(spec.id, entry);
    void this.refreshOrbitFallback();
    return info;
  }

  /** Take a reference out of the view and free its memory (unlink, or before loading a different version). */
  async removeReference(id: string): Promise<void> {
    const ref = this.references.get(id);
    if (!ref) return;
    this.references.delete(id);
    this.setMarkers(id, []);
    this.referenceRoot.remove(ref.model.object);
    this.referencesBoxCache = null;
    await this.fragments.disposeModel(id);
    await this.fragments.update(true);
    await this.refreshOrbitFallback();
  }

  hasReference(id: string): boolean {
    return this.references.has(id);
  }

  setReferenceVisible(id: string, visible: boolean) {
    if (visible) this.sessionHiddenReferences.delete(id);
    else this.sessionHiddenReferences.add(id);
    this.showReference(id);
  }

  private referenceShown(id: string): boolean {
    return !this.sessionHiddenReferences.has(id) && (this.referenceTones.get(id) ?? NORMAL_REFERENCE_TONE).visible;
  }

  private showReference(id: string) {
    const visible = this.referenceShown(id);
    const ref = this.references.get(id);
    if (ref && ref.model.object.visible !== visible) {
      ref.model.object.visible = visible;
      this.referencesBoxCache = null;
      void this.refreshOrbitFallback();
    }
    const marks = this.markers.get(id);
    if (marks) marks.group.visible = visible;
  }

  /**
   * How a linked model draws in the open view: halftone grey, see-through,
   * an underlay, hidden, or with some IFC categories off or toned
   * (`reference-tone.ts`). Set before or after it loads; a new version keeps it.
   */
  async setReferenceTone(id: string, tone: ReferenceTone): Promise<void> {
    if (sameReferenceTone(this.referenceTones.get(id) ?? NORMAL_REFERENCE_TONE, tone)) return;
    this.referenceTones.set(id, tone);
    const entry = this.references.get(id);
    if (entry) await this.applyReferenceTone(id, entry);
  }

  referenceToneOf(id: string): ReferenceTone {
    return this.referenceTones.get(id) ?? NORMAL_REFERENCE_TONE;
  }

  private async categoryItems(entry: LoadedEntry, category: string): Promise<number[]> {
    const cached = entry.categoryIds.get(category);
    if (cached) return cached;
    const found = await entry.model.getItemsOfCategories([new RegExp(`^${category}$`)]);
    const ids = Object.values(found).flat();
    entry.categoryIds.set(category, ids);
    return ids;
  }

  private async applyReferenceTone(id: string, entry: LoadedEntry): Promise<void> {
    const tone = this.referenceToneOf(id);
    this.showReference(id);
    const hidden: number[] = [];
    for (const o of tone.overrides) if (!o.visible) hidden.push(...(await this.categoryItems(entry, o.category)));
    const hiddenChanged = hidden.length !== entry.toneHiddenIds.length || hidden.some((v, i) => v !== entry.toneHiddenIds[i]);
    entry.toneHiddenIds = hidden;
    await this.paintReference(id, entry);
    if (hiddenChanged) await this.applyReferenceVisibility(entry);
    await this.fragments.update(true);
  }

  /** The whole-model tone on its own materials, category exceptions as opaque overlays, then the selection on top. */
  private async paintReference(id: string, entry: LoadedEntry): Promise<void> {
    const { model } = entry;
    const tone = this.referenceToneOf(id);
    for (const m of baseMaterials(model.object)) toneMaterial(m, tone.base);
    await model.resetHighlight();
    for (const o of tone.overrides) {
      if (!o.visible || !o.overlay) continue;
      const ids = await this.categoryItems(entry, o.category);
      if (ids.length === 0) continue;
      const overlay = overlayMaterial(o.overlay);
      if (overlay) await model.highlight(ids, overlay);
      else await model.setOpacity(ids, 1);
    }
    const pick = this.selected;
    if (pick?.source === "reference" && pick.referenceId === id) {
      await model.highlight([pick.localId], { color: this.palette.pickHighlight, renderedFaces: 0, opacity: 1, transparent: false, customId: PICK_HIGHLIGHT_ID });
    }
  }

  /** Tiles stream in with materials Fragments makes as it goes; toned models tone them too. */
  private toneNewReferenceMaterials() {
    if (this.referenceMaterialFrames === 0) return;
    this.referenceMaterialFrames -= 1;
    for (const [id, { model }] of this.references) {
      const base = this.referenceToneOf(id).base;
      if (base) for (const m of baseMaterials(model.object)) toneMaterial(m, base);
    }
  }

  // ---------------------------------------------------------------- markers

  private markerMaterial(): { normal: THREE.SpriteMaterial; selected: THREE.SpriteMaterial } {
    if (!this.markerMaterials) {
      // sizeAttenuation off: the symbol keeps its screen size whether the view shows a room or the whole site.
      const outline = this.palette.css("edges");
      const make = (fill: string) => new THREE.SpriteMaterial({ map: markerTexture(fill, outline), sizeAttenuation: false, depthTest: true, transparent: true });
      // The fixture symbol fill is a drawing convention; selection and outline follow the theme.
      this.markerMaterials = { normal: make("#f5c542"), selected: make(this.palette.css("selection")) };
    }
    return this.markerMaterials;
  }

  /** Replace a reference's markers (an empty list removes them). They follow the reference's visibility. */
  setMarkers(referenceId: string, specs: readonly MarkerSpec[]) {
    const previous = this.markers.get(referenceId);
    if (previous) this.markerRoot.remove(previous.group);
    this.markers.delete(referenceId);
    if (specs.length === 0) return;
    const group = new THREE.Group();
    group.visible = this.references.get(referenceId)?.model.object.visible ?? true;
    const { normal } = this.markerMaterial();
    const items = specs.map((spec) => {
      const sprite = new THREE.Sprite(normal);
      sprite.scale.set(MARKER_SCREEN_SIZE, MARKER_SCREEN_SIZE, 1);
      sprite.userData.markerId = spec.id;
      sprite.userData.referenceId = referenceId;
      group.add(sprite);
      return { sprite, spec };
    });
    this.markers.set(referenceId, { group, items });
    this.markerRoot.add(group);
    this.placeMarkers();
  }

  /** True positions in 3D; in plan, just under the cut so a switch at 48" isn't cut away with the walls above it. */
  private placeMarkers() {
    const cut = this.cutPlane ? this.cutPlane.constant - 0.05 : null;
    for (const { items } of this.markers.values()) {
      for (const { sprite, spec } of items) {
        const [x, y, z] = spec.position;
        sprite.position.set(x, cut === null ? y : Math.min(y, cut), z);
        sprite.visible = this.isolatedLevel === null || spec.level === null || normalizeLevelName(spec.level) === normalizeLevelName(this.isolatedLevel);
      }
    }
  }

  /** Show only the given storey names on every reference (null shows all). */
  async isolateLevel(levelName: string | null) {
    this.isolatedLevel = levelName;
    this.placeMarkers();
    for (const entry of this.references.values()) await this.applyReferenceVisibility(entry, false);
    if (this.mode === "plan") await this.setPlanCategoriesVisible(false);
    await this.fragments.update(true);
  }

  /** The isolated level, bookkeeping categories, the view's hidden linked categories and (in plan) roofs and slabs. */
  private async applyReferenceVisibility(entry: LoadedEntry, withPlanCategories = true): Promise<void> {
    const { model, info, hiddenIds, toneHiddenIds } = entry;
    // A view on the model's "Level 1" shows the linked storey "LEVEL 1" (and the reverse).
    const keep = this.isolatedLevel === null ? undefined : findLevelByName(info.levels, this.isolatedLevel);
    // A file without a storey of that name stays whole rather than vanishing.
    if (!keep) {
      await model.resetVisible();
    } else {
      await model.setVisible(undefined, false);
      await model.setVisible([...keep.localIds], true);
    }
    if (hiddenIds.length > 0) await model.setVisible(hiddenIds, false);
    if (toneHiddenIds.length > 0) await model.setVisible(toneHiddenIds, false);
    if (withPlanCategories && this.mode === "plan") await this.planCategoriesOf(entry, false);
  }

  /** Everything the linked IFC knows about one element: instance and type property sets, quantities, systems, ports. */
  async referenceProperties(referenceId: string, localId: number): Promise<ReferenceItemProperties> {
    const ref = this.references.get(referenceId);
    if (!ref) throw new Error(`Linked model ${referenceId} is not loaded`);
    return readReferenceItem((ids, config) => ref.model.getItemsData(ids, config), localId);
  }

  // ---------------------------------------------------------------- authored

  /**
   * Draw the authored model. Elements that differ between the accepted model
   * and the local view (edits not yet accepted by the server) use the
   * provisional style.
   */
  setAuthored(accepted: ModelState, view: ModelState = accepted, levels: ReadonlySet<string> | null = this.authoredLevels) {
    this.lastAuthored = { accepted, view };
    for (const entry of this.nativeEntries) {
      this.nativeRoot.remove(entry.object);
      disposeObject(entry.object);
    }
    this.nativeEntries = [];
    this.instanceLookup.clear();
    this.batchedIds = new Set();
    // The selected element is drawn alone below (never batched), so its batch overlay goes.
    if (this.selectedOverlayShown) {
      this.drawOverlay(this.selectedRoot, null, this.palette.selected);
      this.selectedOverlayShown = false;
    }

    const solids = modelSolids(view, this.elevations, levels ?? undefined);
    this.lastSolids = solids;
    this.solidsById = new Map();
    for (const s of solids) {
      const list = this.solidsById.get(s.elementId);
      if (list) list.push(s);
      else this.solidsById.set(s.elementId, [s]);
    }
    this.markPlanFootprintsStale();
    this.drawHighlight();
    this.drawOverlay(this.groupRoot, this.groupIds, this.palette.groupSelected);
    const provisional = new Set<ElementId>();
    for (const [id, el] of elementEntries(view.elements)) if (accepted.elements[id] !== el) provisional.add(el.id);
    const tones = this.resolveDisplay(view);
    const skip = (s: Solid) => this.hiddenGroups.has(s.group) || this.hiddenElements.has(s.elementId);
    const materialFor = (s: Solid) => {
      const tone = tones.get(s.elementId);
      return tone ? this.toneMaterial(s.group, tone, s.tint) : this.material(s.group, s.tint);
    };

    // Joined walls draw as one mesh per level and category; a selected, provisional or toned wall draws alone.
    const selectedId = this.selected?.source === "native" ? this.selected.elementId : null;
    const { batches, rest } = batchMeshSolids(solids, (s) => (s.group === "wall" && s.tint === undefined && s.elementId !== selectedId && !provisional.has(s.elementId) && !tones.has(s.elementId) && !skip(s) ? `${view.elements[s.elementId]?.partition?.level ?? ""}:${s.group}` : null));
    for (const b of batches) this.drawBatch(b);

    if (rest.length > INSTANCE_THRESHOLD) {
      this.drawInstanced(rest.filter((s) => !provisional.has(s.elementId) && !skip(s) && s.shape !== "mesh"), (s) => tones.get(s.elementId) ?? "normal", materialFor);
      for (const s of rest) if (s.shape === "mesh" && !provisional.has(s.elementId) && !skip(s)) this.drawSolid(s, materialFor(s), true, tones.get(s.elementId) === "dashed");
      for (const s of rest) if (provisional.has(s.elementId) && !skip(s)) this.drawSolid(s, this.palette.provisional, false);
    } else {
      for (const s of rest) {
        if (skip(s)) continue;
        const selected = this.selected?.source === "native" && this.selected.elementId === s.elementId;
        this.drawSolid(s, selected ? this.palette.selected : provisional.has(s.elementId) ? this.palette.provisional : materialFor(s), true, tones.get(s.elementId) === "dashed");
      }
    }
    this.keepInPlanCut(this.authoredBox());
    this.drawPlanSymbols();
    // Previews (a drag, a route being drawn) leave the orbit point alone; it follows the model once the edit lands.
    if (view === accepted) void this.refreshOrbitFallback();
  }

  /**
   * Group and phase display for the open view: hidden elements are not drawn
   * or picked, halftone ones draw see-through, dashed (demolished) ones draw
   * faint with dashed edges. Takes effect on the next setAuthored.
   */
  setDisplayContext(ctx: DisplayContext | null) {
    this.displayContext = ctx;
  }

  /** The open view whose Visibility/Graphics switches the live model follows; null for the free model. Takes effect on the next setAuthored. */
  setCategoryView(view: CategoryView | null) {
    this.categoryView = view;
  }

  /** Ids the current display hides (for tests and the status line). */
  hiddenElementCount(): number {
    return this.hiddenElements.size;
  }

  private resolveDisplay(view: ModelState): Map<string, "halftone" | "dashed"> {
    const tones = new Map<string, "halftone" | "dashed">();
    const hidden = new Set<string>();
    const resolve = liveDisplayOf(view, this.displayContext, this.categoryView);
    // The plan shows what its sheet shows: the same view range test.
    const outsideRange = liveViewRangeExcludes(view, this.categoryView, this.mode === "plan");
    if (outsideRange) {
      for (const id of this.solidsById.keys()) {
        const el = view.elements[id];
        if (el && outsideRange(el)) hidden.add(id);
      }
    }
    if (resolve) {
      for (const id of this.solidsById.keys()) {
        const el = view.elements[id];
        if (!el || hidden.has(id)) continue;
        const d = resolve(el);
        if (!d.visible) hidden.add(id);
        else if (d.dashed) tones.set(id, "dashed");
        else if (d.halftone) tones.set(id, "halftone");
      }
    }
    this.hiddenElements = hidden;
    return tones;
  }

  private toneMaterial(group: RenderGroup, tone: "halftone" | "dashed", tint?: number): THREE.MeshStandardMaterial {
    const key = `${group}:${tone}:${tint ?? ""}`;
    let entry = this.toneMaterials.get(key);
    if (!entry) {
      const style = GROUP_STYLE[group];
      const material = new THREE.MeshStandardMaterial({ color: tint ?? style.color, roughness: style.roughness, metalness: style.metalness, transparent: true, opacity: tone === "halftone" ? 0.35 : 0.15, depthWrite: false });
      entry = { group, tone, material, ...(tint !== undefined ? { tint } : {}) };
      this.styleToneMaterial(entry);
      this.toneMaterials.set(key, entry);
    }
    return entry.material;
  }

  private styleToneMaterial(entry: { group: RenderGroup; tint?: number; material: THREE.MeshStandardMaterial }) {
    entry.material.wireframe = this.visualStyle === "wireframe";
    entry.material.color.set(this.visualStyle === "hidden_line" ? 0xffffff : (entry.tint ?? GROUP_STYLE[entry.group].color));
    entry.material.needsUpdate = true;
  }

  private dashedEdgeMaterial(): THREE.LineDashedMaterial {
    if (!this.dashedEdge) this.dashedEdge = new THREE.LineDashedMaterial({ color: this.palette.edge.color, dashSize: 0.12, gapSize: 0.08 });
    return this.dashedEdge;
  }

  /**
   * Draw only the authored work on these partition levels (a plan's levels,
   * resolved by the kernel's `viewLevelNames`); null draws every level.
   */
  setAuthoredLevels(levels: ReadonlySet<string> | null) {
    const same = levels === this.authoredLevels || (levels !== null && this.authoredLevels !== null && levels.size === this.authoredLevels.size && [...levels].every((l) => this.authoredLevels?.has(l)));
    if (same) return;
    this.authoredLevels = levels;
    if (this.lastAuthored) this.setAuthored(this.lastAuthored.accepted, this.lastAuthored.view);
  }

  /**
   * Show a live preview (a part being placed or moved) without redrawing the
   * model, so preview cost does not grow with model size. null clears it.
   */
  setGhost(solids: readonly Solid[] | null) {
    for (const child of [...this.ghostRoot.children]) {
      this.ghostRoot.remove(child);
      disposeObject(child);
    }
    if (!solids) return;
    for (const s of solids) {
      const geometry = solidGeometry(s);
      const mesh = new THREE.Mesh(geometry, this.palette.provisional);
      placeSolid(mesh, s);
      mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 30), this.palette.edge));
      this.ghostRoot.add(mesh);
    }
    this.keepInPlanCut(new THREE.Box3().setFromObject(this.ghostRoot));
  }

  /**
   * Pre-highlight what the pointer would select (the piece, or its run, branch
   * or system after Tab). Cost follows the highlighted pieces, not the model.
   */
  setHighlight(ids: ReadonlySet<string> | null) {
    this.highlightIds = ids && ids.size > 0 ? ids : null;
    this.drawHighlight();
  }

  /**
   * The hover overlay, minus what is already selected: a selected run, branch
   * or system (or piece) keeps the selection colour while the pointer is on it,
   * so it is plain what a click selected.
   */
  private drawHighlight() {
    const ids = this.highlightIds;
    const selected = this.selected?.source === "native" ? this.selected.elementId : null;
    const shown = ids ? new Set([...ids].filter((id) => id !== selected && !this.groupIds?.has(id))) : null;
    this.drawOverlay(this.highlightRoot, shown && shown.size > 0 ? shown : null, this.palette.hover);
  }

  /** While routing, mark the face the route would join: an open end to continue, or where a tap would be cut. null clears it. */
  setRouteJoin(model: ModelState | null, join: RouteJoin | null, levelElevationMm = 0) {
    for (const child of [...this.joinRoot.children]) {
      this.joinRoot.remove(child);
      disposeObject(child);
    }
    if (!model || !join) return;
    for (const s of routeJoinSolids(model, join, levelElevationMm)) {
      const geometry = solidGeometry(s);
      const mesh = new THREE.Mesh(geometry, this.palette.hover);
      placeSolid(mesh, s);
      mesh.renderOrder = 10;
      mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 30), this.palette.edge));
      this.joinRoot.add(mesh);
    }
  }

  /** Show a selected group (a run, branch, system or box selection). null clears it. */
  setGroupSelection(ids: ReadonlySet<string> | null) {
    this.groupIds = ids && ids.size > 0 ? ids : null;
    this.drawOverlay(this.groupRoot, this.groupIds, this.palette.groupSelected);
    this.drawHighlight();
  }

  private drawOverlay(root: THREE.Group, ids: ReadonlySet<string> | null, material: THREE.Material) {
    for (const child of [...root.children]) {
      root.remove(child);
      disposeObject(child);
    }
    if (!ids) return;
    for (const id of ids) {
      if (this.hiddenElements.has(id)) continue;
      for (const s of this.solidsById.get(id) ?? []) {
        if (this.hiddenGroups.has(s.group)) continue;
        const geometry = solidGeometry(s);
        const mesh = new THREE.Mesh(geometry, material);
        placeSolid(mesh, s);
        if (material === this.palette.groupSelected) mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 30), this.palette.selectedEdge));
        root.add(mesh);
      }
    }
  }

  /** Each authored element's box on screen, in client pixels (for window / crossing selection). */
  authoredScreenBoxes(): Map<string, ScreenRect> {
    const camera = this.camera();
    camera.updateMatrixWorld();
    const rect = this.renderer.domElement.getBoundingClientRect();
    const v = new THREE.Vector3();
    const planes = this.renderer.clippingPlanes;
    const solids = planes.length === 0 ? this.lastSolids : this.lastSolids.filter((s) => keptByPlanes(planes, v.set(s.center[0], s.center[1], s.center[2])));
    return screenBoxes(solids.filter((s) => !this.hiddenGroups.has(s.group) && !this.hiddenElements.has(s.elementId)), (x, y, z) => {
      v.set(x, y, z).project(camera);
      if (v.z > 1 || v.z < -1) return null;
      return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
    });
  }

  /** One authored element's box on screen, in client pixels, read from its own solids only; null when it isn't drawn. */
  elementScreenBox(elementId: string): ScreenRect | null {
    if (this.hiddenElements.has(elementId)) return null;
    const camera = this.camera();
    camera.updateMatrixWorld();
    const rect = this.renderer.domElement.getBoundingClientRect();
    const v = new THREE.Vector3();
    const planes = this.renderer.clippingPlanes;
    const solids = (this.solidsById.get(elementId) ?? []).filter((s) => !this.hiddenGroups.has(s.group) && (planes.length === 0 || keptByPlanes(planes, v.set(s.center[0], s.center[1], s.center[2]))));
    if (solids.length === 0) return null;
    const boxes = screenBoxes(solids, (x, y, z) => {
      v.set(x, y, z).project(camera);
      if (v.z > 1 || v.z < -1) return null;
      return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
    });
    return boxes.get(elementId) ?? null;
  }

  /** In plan, the cut never hides new work: raise it above what was just drawn. */
  private keepInPlanCut(box: THREE.Box3) {
    if (this.mode !== "plan" || !this.cutPlane || box.isEmpty()) return;
    const top = box.max.y + 0.3;
    if (top <= this.cutPlane.constant) return;
    this.cutPlane.constant = top;
    this.applyClipping();
  }

  setGroupVisible(group: RenderGroup, visible: boolean) {
    if (visible) this.hiddenGroups.delete(group);
    else this.hiddenGroups.add(group);
  }

  /** One material per group, and per system colour within it (so instancing still batches each colour). */
  private material(group: RenderGroup, tint?: number): THREE.MeshStandardMaterial {
    const key = `${group}:${tint ?? ""}`;
    let entry = this.materials.get(key);
    if (!entry) {
      const style = GROUP_STYLE[group];
      const seeThrough = style.opacity !== undefined ? { transparent: true, opacity: style.opacity, depthWrite: false } : {};
      entry = { group, material: new THREE.MeshStandardMaterial({ color: tint ?? style.color, roughness: style.roughness, metalness: style.metalness, ...seeThrough }), ...(tint !== undefined ? { tint } : {}) };
      this.styleMaterial(entry);
      this.materials.set(key, entry);
    }
    return entry.material;
  }

  /**
   * How the model draws, as a drawing view sets it: wireframe (triangle
   * edges only), hidden line (white surfaces with their edges, so nearer
   * surfaces hide what is behind), shaded (colour, no edges) or shaded with
   * edges (the default). Linked models follow wireframe; their colours stay.
   */
  /** Applies new theme colors in place (selection, edges, backgrounds, axes, fixture symbols). */
  setColors(colors: Partial<ViewerColors>) {
    this.palette.apply(colors);
    this.cropOutline.setColor(this.palette.css("selectionOutline"));
    // Swap the arrows' mesh, keeping the group's position, scale and visibility.
    for (const child of [...this.origin.children]) {
      this.origin.remove(child);
      disposeObject(child);
      if (child instanceof THREE.Mesh && child.material instanceof THREE.Material) child.material.dispose();
    }
    for (const child of [...buildArrows(this.palette.axes).children]) this.origin.add(child);
    if (this.markerMaterials) {
      // Sprites keep their material; only the drawn symbol changes.
      const outline = this.palette.css("edges");
      const fills: [THREE.SpriteMaterial, string][] = [[this.markerMaterials.normal, "#f5c542"], [this.markerMaterials.selected, this.palette.css("selection")]];
      for (const [material, fill] of fills) {
        material.map?.dispose();
        material.map = markerTexture(fill, outline);
        material.needsUpdate = true;
      }
    }
  }

  get colors(): ViewerColors {
    return this.palette.colors;
  }

  setVisualStyle(style: ViewerVisualStyle) {
    if (style === this.visualStyle) return;
    this.visualStyle = style;
    for (const entry of this.materials.values()) this.styleMaterial(entry);
    for (const entry of this.toneMaterials.values()) this.styleToneMaterial(entry);
    this.palette.edge.visible = style === "hidden_line" || style === "shaded_edges";
    this.styleReferences(this.referenceRoot);
  }

  private styleMaterial(entry: { group: RenderGroup; tint?: number; material: THREE.MeshStandardMaterial }) {
    const m = entry.material;
    m.wireframe = this.visualStyle === "wireframe";
    m.color.set(this.visualStyle === "hidden_line" ? 0xffffff : (entry.tint ?? GROUP_STYLE[entry.group].color));
    m.needsUpdate = true;
  }

  private styleReferences(root: THREE.Object3D) {
    const wire = this.visualStyle === "wireframe";
    root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      for (const mat of Array.isArray(o.material) ? o.material : [o.material]) {
        if ("wireframe" in mat && typeof mat.wireframe === "boolean" && mat.wireframe !== wire) {
          mat.wireframe = wire;
          mat.needsUpdate = true;
        }
      }
    });
  }

  private drawSolid(s: Solid, material: THREE.Material, outline: boolean, dashedEdges = false) {
    const geometry = solidGeometry(s);
    const mesh = new THREE.Mesh(geometry, material);
    placeSolid(mesh, s);
    mesh.userData.elementId = s.elementId;
    if (dashedEdges) {
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 30), this.dashedEdgeMaterial());
      edges.computeLineDistances();
      mesh.add(edges);
    } else if (outline) mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 30), material === this.palette.selected ? this.palette.selectedEdge : this.palette.edge));
    this.nativeRoot.add(mesh);
    this.nativeEntries.push({ object: mesh, elementId: s.elementId });
  }

  /** Many elements' meshes as one draw (walls on one level), with one outline. */
  private drawBatch(b: MeshBatch) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(b.positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(b.indices, 1));
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, this.material(b.group));
    mesh.userData.group = b.group;
    mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 30), this.palette.edge));
    this.nativeRoot.add(mesh);
    const first = b.owners[0];
    if (first !== undefined) this.nativeEntries.push({ object: mesh, elementId: first, batch: b });
    for (const id of b.owners) this.batchedIds.add(id);
  }

  /** The element a native hit belongs to: an instance's, a batch triangle's owner, or the mesh's own. */
  private hitElementId(h: THREE.Intersection): string | null {
    if (h.object instanceof THREE.InstancedMesh) return this.instanceLookup.get(h.object)?.[h.instanceId ?? -1] ?? null;
    const batch = this.batchOf(h.object);
    if (batch) return batchOwnerAt(batch, h.faceIndex);
    const id: unknown = h.object.userData.elementId;
    return typeof id === "string" ? id : null;
  }

  private batchOf(object: THREE.Object3D): NativeEntry["batch"] | null {
    for (const entry of this.nativeEntries) if (entry.object === object) return entry.batch ?? null;
    return null;
  }

  private drawInstanced(solids: Solid[], toneOf: (s: Solid) => string, materialFor: (s: Solid) => THREE.Material) {
    const byKey = new Map<string, Solid[]>();
    for (const s of solids) {
      const key = `${s.group}:${s.shape}:${toneOf(s)}:${s.tint ?? ""}`;
      const list = byKey.get(key) ?? [];
      list.push(s);
      byKey.set(key, list);
    }
    const dummy = new THREE.Object3D();
    for (const list of byKey.values()) {
      const first = list[0]!;
      const shape = first.shape;
      const unit = shape === "box" ? new THREE.BoxGeometry(1, 1, 1) : new THREE.CylinderGeometry(0.5, 0.5, 1, 12);
      const mesh = new THREE.InstancedMesh(unit, materialFor(first), list.length);
      list.forEach((s, i) => {
        placeSolid(dummy, s);
        dummy.scale.set(shape === "box" ? s.size[0] : s.size[1], shape === "box" ? s.size[1] : s.size[0], shape === "box" ? s.size[2] : s.size[1]);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      this.instanceLookup.set(mesh, list.map((s) => s.elementId));
      this.nativeRoot.add(mesh);
      this.nativeEntries.push({ object: mesh, elementId: list[0]!.elementId });
    }
  }

  // ---------------------------------------------------------------- views

  /**
   * Plan looks straight down with everything above `cutElevationMm` removed.
   * For MEP the default cut sits just above the new ductwork so it is in the drawing.
   */
  setMode(mode: ViewMode, cutElevationMm?: number) {
    if (mode === this.mode) return;
    const target = new THREE.Vector3();
    this.controls.getTarget(target);
    const enabled = this.controls.enabled;
    this.controls.dispose();
    this.mode = mode;
    if (mode === "plan") {
      this.last3dTarget.copy(target);
      const work = this.authoredBox();
      const cutM = cutElevationMm !== undefined ? cutElevationMm * MM : work.isEmpty() ? 1.2 : work.max.y + 0.3;
      this.cutPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), cutM);
      this.scene.background = this.palette.planBackground;
      void this.setPlanCategoriesVisible(false);
      this.ortho.position.set(target.x, 200, target.z);
      this.ortho.up.copy(planUpVector(this.planUpDeg));
      this.ortho.lookAt(target.x, 0, target.z);
      this.controls = this.makeControls(this.ortho);
      const eye = this.planEye(target);
      this.controls.setLookAt(eye.x, 200, eye.z, target.x, 0, target.z, false);
      this.controls.mouseButtons.left = CameraControls.ACTION.TRUCK;
      this.controls.touches.one = CameraControls.ACTION.TOUCH_TRUCK;
      this.controls.minPolarAngle = 0;
      this.controls.maxPolarAngle = 0;
      this.carryControlState(enabled);
    } else {
      this.cutPlane = null;
      this.scene.background = this.palette.background;
      void this.setPlanCategoriesVisible(true);
      const camera = this.camera3d();
      // An orbit point a click or a zoom chose survives a trip to plan: the 3D camera comes back as it was, orbiting that point.
      const eye = camera.position.clone();
      const ahead = eye.clone().addScaledVector(camera.getWorldDirection(new THREE.Vector3()), Math.max(eye.distanceTo(this.last3dTarget), 0.01));
      this.controls = this.makeControls(camera);
      if (this.orbitPointPinned) {
        void this.controls.setLookAt(eye.x, eye.y, eye.z, ahead.x, ahead.y, ahead.z, false);
        this.controls.update(0);
        camera.updateMatrixWorld();
        pinOrbitPoint(this.controls, this.last3dTarget);
      } else {
        this.controls.setTarget(target.x, target.y, target.z, false);
      }
      this.carryControlState(enabled);
      void this.refreshOrbitFallback();
    }
    this.applyClipping();
    this.placeMarkers();
    this.drawPlanSymbols();
    for (const { model } of this.references.values()) model.useCamera(this.camera());
    void this.fragments.update(true);
  }

  /**
   * The live plan's symbol layer (`livePlanSymbols`): the plan graphics the
   * printed drawing draws for the records on the plan's levels, as lines just
   * under the cut, drawn over the model. Cleared outside plan.
   */
  private drawPlanSymbols() {
    for (const child of [...this.planSymbolRoot.children]) {
      this.planSymbolRoot.remove(child);
      if (child instanceof THREE.LineSegments) child.geometry.dispose();
      // The text textures stay in `planTextTextures` (the same tags come back on the next redraw).
      if (child instanceof THREE.Sprite) child.material.dispose();
    }
    // The counts ride on the canvas so a browser check can see the plan's symbols (a door's swing, a circuit's home-run tag) without reading pixels.
    this.renderer.domElement.dataset.planSymbols = "0";
    this.renderer.domElement.dataset.planTexts = "";
    if (this.mode !== "plan" || !this.cutPlane || !this.lastAuthored) return;
    const props = this.categoryView?.props;
    const symbols = livePlanSymbols(this.lastAuthored.view, {
      levelId: props?.level ?? "",
      scale: props?.scale ?? DEFAULT_PLAN_SYMBOL_SCALE,
      detail: props?.detailLevel ?? "medium",
      levels: this.authoredLevels,
      hasBody: (id) => this.solidsById.has(id),
      hidden: (id) => this.hiddenElements.has(id),
      ...(this.categoryView ? { view: this.categoryView } : {}),
    });
    const elevationMm = this.cutPlane.constant / MM - PLAN_SYMBOL_BELOW_CUT_MM;
    this.drawPlanTexts(symbols.texts, props?.scale ?? DEFAULT_PLAN_SYMBOL_SCALE, elevationMm);
    if (symbols.segments.length === 0) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(symbolPositions(symbols.segments, elevationMm), 3));
    const lines = new THREE.LineSegments(geometry, this.planSymbolLines());
    lines.renderOrder = PLAN_SYMBOL_RENDER_ORDER;
    lines.userData.planSymbols = symbols.segments.length;
    this.planSymbolRoot.add(lines);
    this.renderer.domElement.dataset.planSymbols = String(symbols.segments.length);
  }

  /** The live plan's texts (home-run tags, marks) as sprites at their printed size for the plan's scale, level, in the theme's edge colour. */
  private drawPlanTexts(texts: readonly LivePlanText[], scale: number, elevationMm: number) {
    if (texts.length === 0) return;
    const color = `#${this.palette.edge.color.getHexString()}`;
    for (const t of texts) {
      const key = `${color}|${t.text}`;
      let made = this.planTextTextures.get(key);
      if (!made) {
        made = planTextTexture(t.text, color);
        this.planTextTextures.set(key, made);
      }
      const { texture, aspect } = made;
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }));
      const heightM = t.heightMm * scale * MM * 1.3;
      sprite.scale.set(heightM * aspect, heightM, 1);
      sprite.center.set(0, 0.5);
      const [x, y, z] = kernelToScene(t.at.x, t.at.y, elevationMm);
      sprite.position.set(x, y, z);
      sprite.renderOrder = PLAN_SYMBOL_RENDER_ORDER;
      sprite.userData.planText = t.text;
      this.planSymbolRoot.add(sprite);
    }
    this.renderer.domElement.dataset.planTexts = texts.map((t) => t.text).join("|");
  }

  private planSymbolLines(): THREE.LineBasicMaterial {
    if (!this.planSymbolMaterial) this.planSymbolMaterial = new THREE.LineBasicMaterial({ depthTest: false, transparent: true });
    // The theme's edge colour, as it is now (the theme can change while a plan is open).
    this.planSymbolMaterial.color.copy(this.palette.edge.color);
    return this.planSymbolMaterial;
  }

  /** How many plan symbol segments the live plan draws now (for tests and the status line). */
  planSymbolCount(): number {
    let n = 0;
    for (const child of this.planSymbolRoot.children) if (typeof child.userData.planSymbols === "number") n += child.userData.planSymbols;
    return n;
  }

  /** Floors, roofs and ceilings would paint over the plan; hide them while looking down. */
  private async setPlanCategoriesVisible(visible: boolean) {
    for (const entry of this.references.values()) await this.planCategoriesOf(entry, visible);
    await this.fragments.update(true);
  }

  private async planCategoriesOf(entry: LoadedEntry, visible: boolean) {
    const items = await entry.model.getItemsOfCategories([/^IFCSLAB$/, /^IFCROOF$/, /^IFCCOVERING$/, /^IFCSITE$/]);
    const ids = Object.values(items).flat();
    if (ids.length > 0) await entry.model.setVisible(ids, visible);
    // Back in 3D, slabs return, but not the ones the view hides by category.
    if (visible && entry.toneHiddenIds.length > 0) await entry.model.setVisible(entry.toneHiddenIds, false);
  }

  getMode(): ViewMode {
    return this.mode;
  }

  /**
   * Perspective or orthographic (parallel) for the 3D view. The picture stays
   * put: the plane through the orbit point keeps its size on screen, and the
   * orbit point (the point a click set, else the middle of the model) stays the pivot.
   * In plan it is remembered for the next 3D view.
   */
  setProjection(projection: Projection) {
    if (projection === this.projection) return;
    const from = this.camera3d();
    this.projection = projection;
    const to = this.camera3d();
    const { width, height } = this.size();
    const pivot = new THREE.Vector3();
    this.controls.getTarget(pivot);
    if (this.mode === "plan") {
      // Plan's controls drive the plan camera; carry the 3D camera across about the point it last looked at.
      matchCamera(from, to, this.last3dTarget, width / height);
      return;
    }
    const enabled = this.controls.enabled;
    const centre = matchCamera(from, to, pivot, width / height);
    this.controls.dispose();
    this.controls = this.makeControls(to);
    this.carryControlState(enabled);
    void this.controls.setLookAt(to.position.x, to.position.y, to.position.z, centre.x, centre.y, centre.z, false);
    this.controls.update(0);
    to.updateMatrixWorld();
    this.controls.setOrbitPoint(pivot.x, pivot.y, pivot.z);
    this.controls.update(0);
    for (const { model } of this.references.values()) model.useCamera(to);
    void this.fragments.update(true);
    for (const listener of this.cameraListeners) listener();
  }

  getProjection(): Projection {
    return this.projection;
  }

  /** Look from `eye` at `target`; a parallel view zooms to frame what a perspective eye there would see. */
  private async lookFrom(eye: THREE.Vector3, target: THREE.Vector3, animate: boolean) {
    const camera = this.camera();
    const moving = this.controls.setLookAt(eye.x, eye.y, eye.z, target.x, target.y, target.z, animate);
    if (this.mode === "plan" || !(camera instanceof THREE.OrthographicCamera)) return moving;
    await Promise.all([moving, this.controls.zoomTo(orthoZoomFor(camera, eye.distanceTo(target), this.perspective.fov), animate)]);
  }

  /** Move the plan cut plane (mm above project zero). Only while looking down in plan. */
  /**
   * The whole-model plan's cut: just above all authored work, as a fresh plan
   * opens, so a cut left by a saved plan view (4 ft above Level 1) never hides
   * the other levels of "All levels, looking down".
   */
  resetPlanCut() {
    if (this.mode !== "plan" || !this.cutPlane) return;
    const work = this.authoredBox();
    this.setPlanCut((work.isEmpty() ? 1.2 : work.max.y + 0.3) / MM);
  }

  setPlanCut(elevationMm: number) {
    if (this.mode !== "plan" || !this.cutPlane) return;
    this.cutPlane.constant = elevationMm * MM;
    this.applyClipping();
    this.placeMarkers();
    this.drawPlanSymbols();
  }

  /**
   * A vertical section along a plan cut line (kernel mm): keep what lies on the
   * looked-at side of the line, up to `depthMm` beyond it and between its ends,
   * and look at it straight on from behind the cut. Null removes it.
   */
  async setVerticalSection(cut: { start: { x: number; y: number }; end: { x: number; y: number }; direction: 1 | -1; depthMm: number; eyeElevationMm: number } | null) {
    if (!cut) {
      this.sectionPlanes = [];
      this.applyClipping();
      return;
    }
    if (this.mode === "plan") this.setMode("3d");
    const dx = cut.end.x - cut.start.x;
    const dy = cut.end.y - cut.start.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) return;
    const ax = { x: dx / len, y: dy / len };
    const look = { x: -ax.y * cut.direction, y: ax.x * cut.direction };
    const toScene = (v: { x: number; y: number }) => new THREE.Vector3(v.x, 0, -v.y);
    const n = toScene(look).normalize();
    const a = toScene(ax).normalize();
    const p0 = new THREE.Vector3(cut.start.x * MM, 0, -cut.start.y * MM);
    const depth = cut.depthMm * MM;
    const along = len * MM;
    this.sectionPlanes = [
      new THREE.Plane(n.clone(), -n.dot(p0)),
      new THREE.Plane(n.clone().negate(), n.dot(p0) + depth),
      new THREE.Plane(a.clone(), -a.dot(p0)),
      new THREE.Plane(a.clone().negate(), a.dot(p0) + along),
    ];
    this.applyClipping();
    const mid = p0.clone().add(a.clone().multiplyScalar(along / 2));
    mid.y = cut.eyeElevationMm * MM;
    const back = Math.max(along, 12) * 0.9;
    const eye = mid.clone().sub(n.clone().multiplyScalar(back));
    const target = mid.clone().add(n.clone().multiplyScalar(depth / 2));
    await this.lookFrom(eye, target, true);
  }

  /** Floor elevation (mm) of a storey, from the bottoms of its elements (10th percentile); null when no reference has it. */
  async levelElevationMm(levelName: string): Promise<number | null> {
    const bottoms: number[] = [];
    for (const { model, info } of this.references.values()) {
      const level = findLevelByName(info.levels, levelName);
      if (!level || level.localIds.length === 0) continue;
      const ids = level.localIds.length > 4000 ? level.localIds.filter((_, i) => i % Math.ceil(level.localIds.length / 4000) === 0) : level.localIds;
      for (const box of await model.getBoxes([...ids])) if (!box.isEmpty()) bottoms.push(box.min.y);
    }
    if (bottoms.length === 0) return null;
    bottoms.sort((x, y) => x - y);
    return Math.round((bottoms[Math.floor(bottoms.length * 0.1)] ?? 0) / MM);
  }

  /** Pixel position, relative to the canvas's top-left, of a kernel plan point at an elevation (overlays drawn over the canvas). */
  canvasPointOf(x: number, y: number, elevationMm: number): { x: number; y: number } | null {
    const p = new THREE.Vector3(x * MM, elevationMm * MM, -y * MM).project(this.camera());
    if (p.z < -1 || p.z > 1) return null;
    const { width, height } = this.size();
    return { x: ((p.x + 1) / 2) * width, y: ((1 - p.y) / 2) * height };
  }

  /** Frame a plan rectangle given in kernel millimetres (a view's crop region). `animate: false` opens a view already framed, so its crop grips are where they stay. */
  async framePlanRect(min: { x: number; y: number }, max: { x: number; y: number }, opts: { readonly animate?: boolean } = {}) {
    const scene = await this.sceneBox();
    const box = new THREE.Box3(new THREE.Vector3(min.x * MM, scene.isEmpty() ? 0 : scene.min.y, -max.y * MM), new THREE.Vector3(max.x * MM, scene.isEmpty() ? 3 : scene.max.y, -min.y * MM));
    await this.frame(box, opts.animate ?? true);
  }

  /** The work area (authored work plus `marginM` around it, else the whole scene) as a kernel plan rectangle in mm; null when nothing is loaded. */
  async workRectMm(marginM = 30): Promise<{ min: { x: number; y: number }; max: { x: number; y: number } } | null> {
    const box = await this.workBox(marginM);
    if (box.isEmpty()) return null;
    return { min: { x: Math.round(box.min.x / MM), y: Math.round(-box.max.z / MM) }, max: { x: Math.round(box.max.x / MM), y: Math.round(-box.min.z / MM) } };
  }

  /** Called whenever the camera moves (overlays follow it). Returns an unsubscribe. */
  onCameraChange(listener: () => void): () => void {
    this.cameraListeners.add(listener);
    return () => this.cameraListeners.delete(listener);
  }

  /** Hear when the camera has stopped moving (every change ends with one). */
  onCameraSettled(listener: () => void): () => void {
    this.cameraSettledListeners.add(listener);
    return () => this.cameraSettledListeners.delete(listener);
  }

  /** Clip to a view's plan crop box (kernel mm), at every height. Null removes it. */
  setPlanCrop(crop: { min: { x: number; y: number }; max: { x: number; y: number } } | null) {
    this.sectionPlanes = crop
      ? [
          new THREE.Plane(new THREE.Vector3(1, 0, 0), -crop.min.x * MM),
          new THREE.Plane(new THREE.Vector3(-1, 0, 0), crop.max.x * MM),
          new THREE.Plane(new THREE.Vector3(0, 0, -1), -crop.min.y * MM),
          new THREE.Plane(new THREE.Vector3(0, 0, 1), crop.max.y * MM),
        ]
      : [];
    this.applyClipping();
  }

  /** Clip everything outside the box (scene metres). Null removes the section. */
  setSectionBox(box: THREE.Box3 | null) {
    this.sectionPlanes = box
      ? [
          new THREE.Plane(new THREE.Vector3(1, 0, 0), -box.min.x),
          new THREE.Plane(new THREE.Vector3(-1, 0, 0), box.max.x),
          new THREE.Plane(new THREE.Vector3(0, 1, 0), -box.min.y),
          new THREE.Plane(new THREE.Vector3(0, -1, 0), box.max.y),
          new THREE.Plane(new THREE.Vector3(0, 0, 1), -box.min.z),
          new THREE.Plane(new THREE.Vector3(0, 0, -1), box.max.z),
        ]
      : [];
    this.applyClipping();
  }

  private applyClipping() {
    this.renderer.clippingPlanes = [...(this.cutPlane ? [this.cutPlane] : []), ...this.sectionPlanes, ...this.cropBoxPlanes];
    void this.fragments.update(true);
  }

  /**
   * The 3D crop box (kernel mm): `crop` clips everything outside it (linked
   * models, authored work, previews; picking skips what is clipped away),
   * `show` draws its outline and lets `cropGrips` report its face grips.
   * Null removes both.
   */
  setCropBox(box: CropBox3d | null, opts: { readonly crop: boolean; readonly show: boolean } = { crop: true, show: true }) {
    this.cropBox = box;
    this.cropBoxPlanes = box && opts.crop ? cropBoxScenePlanes(box) : [];
    this.cropOutline.set(box && opts.show ? box : null);
    this.applyClipping();
    for (const listener of this.cameraListeners) listener();
  }

  /** The crop box's face grips on the canvas (px from its top-left); null when the box is hidden or in plan. */
  cropGrips(): GripOnScreen[] | null {
    if (!this.cropBox || !this.cropOutline.object.visible || this.mode === "plan") return null;
    const { width, height } = this.size();
    return gripsOnScreen(this.cropBox, this.camera(), width, height);
  }

  /** How far (mm, outward) a face grip dragged to this pointer moves the face of `box` (the shown box by default); null when the pointer looks straight along the face's normal. */
  cropFaceOffsetAt(face: CropFace, clientX: number, clientY: number, box: CropBox3d | null = this.cropBox): number | null {
    if (!box) return null;
    this.raycaster.setFromCamera(this.ndc(clientX, clientY), this.camera());
    return faceDragOffsetMm(box, face, this.raycaster.ray);
  }

  /** Everything loaded and drawn (linked models included), kernel mm; null when nothing is. */
  async sceneExtentMm(): Promise<Aabb3 | null> {
    const box = await this.sceneBox();
    if (box.isEmpty()) return null;
    return { min: { x: box.min.x / MM, y: -box.max.z / MM, z: box.min.y / MM }, max: { x: box.max.x / MM, y: -box.min.z / MM, z: box.max.y / MM } };
  }

  /** The 3D camera as a saved 3D view stores it (kernel mm). Null in plan. */
  camera3dState(): View3dCamera | null {
    if (this.mode === "plan") return null;
    const camera = this.camera3d();
    const target = new THREE.Vector3();
    this.controls.getTarget(target);
    const k = (v: THREE.Vector3) => ({ x: v.x / MM, y: -v.z / MM, z: v.y / MM });
    const ortho = this.orthoView;
    return { eye: k(camera.position), target: k(target), up: { x: 0, y: 0, z: 1 }, fovDeg: this.perspective.fov, orthoHeightMm: (ortho.top - ortho.bottom) / ortho.zoom / MM };
  }

  /** Where the plan camera looks and how far it is zoomed; null outside plan. `setPlanCamera` puts it back. */
  planCameraState(): PlanCameraState | null {
    if (this.mode !== "plan") return null;
    const target = this.controls.getTarget(new THREE.Vector3(), true);
    return { targetX: target.x, targetZ: target.z, halfHeight: this.ortho.top, zoom: this.ortho.zoom };
  }

  /** Look at the plan exactly as `planCameraState` read it: same centre, same zoom. */
  async setPlanCamera(state: PlanCameraState) {
    if (this.mode !== "plan") this.setMode("plan");
    this.planFitted = null;
    this.ortho.top = state.halfHeight;
    this.ortho.bottom = -state.halfHeight;
    this.resize();
    const center = new THREE.Vector3(state.targetX, 0, state.targetZ);
    const eye = this.planEye(center);
    await this.controls.setLookAt(eye.x, 200, eye.z, center.x, 0, center.z, false);
    await this.controls.zoomTo(state.zoom, false);
    await this.fragments.update(true);
  }

  /** Look from a saved 3D view's camera (kernel mm). The projection is set separately (`setProjection`). */
  async setCamera3d(camera: View3dCamera, animate = false) {
    if (this.mode === "plan") this.setMode("3d");
    const s = (q: View3dCamera["eye"]) => new THREE.Vector3(q.x * MM, q.z * MM, -q.y * MM);
    const eye = s(camera.eye);
    const target = s(camera.target);
    if (Math.abs(this.perspective.fov - camera.fovDeg) > 1e-6) {
      this.perspective.fov = camera.fovDeg;
      this.perspective.updateProjectionMatrix();
    }
    const moving = this.controls.setLookAt(eye.x, eye.y, eye.z, target.x, target.y, target.z, animate);
    const cam = this.camera3d();
    if (cam instanceof THREE.OrthographicCamera) {
      await Promise.all([moving, this.controls.zoomTo((cam.top - cam.bottom) / Math.max(1e-6, camera.orthoHeightMm * MM), animate)]);
    } else await moving;
    await this.fragments.update(true);
  }

  /** Bounding box of everything visible (references + authored), scene metres. */
  async sceneBox(): Promise<THREE.Box3> {
    const box = (await this.referencesBox()).clone();
    box.union(new THREE.Box3().setFromObject(this.nativeRoot));
    return box;
  }

  /** The visible references' combined box (outliers trimmed), cached until a reference is added, removed, shown or hidden. */
  private referencesBox(): Promise<THREE.Box3> {
    this.referencesBoxCache ??= (async () => {
      const box = new THREE.Box3();
      const items: THREE.Box3[] = [];
      for (const { model } of this.references.values()) {
        if (!model.object.visible) continue;
        // Boxes come back in world space (the model's placement already applied).
        items.push(...(await model.getBoxes()));
      }
      for (const b of robustCore(items)) box.union(b);
      return box;
    })();
    return this.referencesBoxCache;
  }

  /**
   * Until a click or a wheel zoom chooses the orbit point, orbit about the
   * middle of the model (the project origin until something is loaded or
   * drawn). Moves the orbit point only; the camera stays where it is. Also
   * sizes the zoom floor to the model.
   */
  private async refreshOrbitFallback() {
    if (this.disposed) return;
    const box = await this.sceneBox();
    if (this.disposed) return;
    this.zoomFloor = zoomFloorFor(box);
    this.controls.zoomFloor = this.zoomFloor;
    // Checked after the boxes load: the view may have gone to plan, had a point set or closed meanwhile.
    if (!this.orbitsAboutModel()) return;
    this.controls.requestFallbackPivot(chooseOrbitPivot(null, box, this.projectOrigin));
  }

  private orbitsAboutModel(): boolean {
    return this.mode !== "plan" && !this.orbitPointPinned && !this.disposed;
  }

  /**
   * Set the 3D orbit point (a completed click's surface hit, scene metres), or
   * null to go back to the middle of the model. Only the orbit target changes;
   * the camera does not move. Ignored in plan. The wheel sets it too: each
   * zoom makes the point it zoomed toward the orbit point.
   */
  setOrbitPoint(point: Vec3Tuple | null) {
    if (this.mode === "plan" || this.disposed) return;
    if (point) {
      this.orbitPointPinned = true;
      this.controls.clearFallbackPivot();
      pinOrbitPoint(this.controls, new THREE.Vector3(...point));
    } else {
      this.orbitPointPinned = false;
      void this.refreshOrbitFallback();
    }
    for (const listener of this.cameraListeners) listener();
  }

  /** True once a click or a zoom has chosen the orbit point (until it is reset). */
  hasOrbitPoint(): boolean {
    return this.orbitPointPinned;
  }

  /** Where the orbit point is on the canvas (px from its top-left); null in plan or when it is behind the camera. */
  orbitPointScreen(): { x: number; y: number } | null {
    if (this.mode === "plan") return null;
    return this.screenPointOf(this.orbitPoint());
  }

  /** A mouse or touch orbit is turning the 3D view right now (the orbit point's marker shows only then). */
  orbiting(): boolean {
    return this.mode !== "plan" && this.controls.orbiting;
  }

  /**
   * The wheel's question: the nearest visible, unclipped surface along the
   * pointer's ray. Authored solids answer at once. Linked models cast rays
   * asynchronously, so they answer from the last cast while its hit still
   * lies on the ray (zooming toward the pointer keeps it there), and a new
   * cast starts for the next notch when it does not.
   */
  private readonly zoomAnchorAt = (query: ZoomAnchorQuery): THREE.Vector3 | null => {
    const native = this.nativeAlong(query.ray);
    const linked = this.linkedAlong(query);
    if (!native || !linked) return native ?? linked;
    const from = query.ray.origin;
    return native.distanceToSquared(from) <= linked.distanceToSquared(from) ? native : linked;
  };

  private nativeAlong(ray: THREE.Ray): THREE.Vector3 | null {
    this.anchorRaycaster.ray.copy(ray);
    const planes = this.renderer.clippingPlanes;
    for (const h of this.anchorRaycaster.intersectObjects(this.nativeRoot.children, true)) {
      if (!(h.object instanceof THREE.Mesh || h.object instanceof THREE.InstancedMesh)) continue;
      if (!shownInScene(h.object) || !keptByPlanes(planes, h.point)) continue;
      return h.point.clone();
    }
    return null;
  }

  private linkedAlong(query: ZoomAnchorQuery): THREE.Vector3 | null {
    if (this.references.size === 0) return null;
    const hit = this.linkedAnchor && liesOnRay(query.ray, this.linkedAnchor) ? this.linkedAnchor : null;
    const missedHere = this.linkedMiss !== null && sameRay(this.linkedMiss, query.ray);
    if (!hit && !missedHere) this.castLinked(query);
    return hit;
  }

  private castLinked(query: ZoomAnchorQuery) {
    if (this.linkedCast) return;
    const { camera } = query;
    const ray = query.ray.clone();
    const mouse = new THREE.Vector2(query.clientX, query.clientY);
    this.linkedCast = (async () => {
      let best: { point: THREE.Vector3; distance: number } | null = null;
      for (const { model } of this.references.values()) {
        if (!model.object.visible) continue;
        const result = await model.raycast({ camera, mouse, dom: this.renderer.domElement });
        if (result && (!best || result.distance < best.distance)) best = { point: result.point.clone(), distance: result.distance };
      }
      if (this.disposed) return;
      this.linkedAnchor = best?.point ?? null;
      this.linkedMiss = best ? null : ray;
    })()
      .catch((err: unknown) => console.error("[ModelViewer3D] wheel zoom ray cast on a linked model failed; zooming toward the orbit plane", err))
      .finally(() => {
        this.linkedCast = null;
      });
  }

  /** Bounding box of the authored (editable) model, scene metres; empty when there is none. */
  authoredBox(): THREE.Box3 {
    return new THREE.Box3().setFromObject(this.nativeRoot);
  }

  /** The authored work plus `marginM` of its surroundings, or the whole scene when nothing is authored. */
  async workBox(marginM = 30): Promise<THREE.Box3> {
    const work = this.authoredBox();
    const scene = await this.sceneBox();
    if (work.isEmpty()) return scene;
    const box = work.clone().expandByVector(new THREE.Vector3(marginM, 0, marginM));
    box.min.y = scene.min.y;
    box.max.y = scene.max.y;
    return box;
  }

  /**
   * `followInsets: false`: a panel opening over the canvas later leaves the camera where it is. The whole
   * model's plan opens framed, and selecting in it opens Properties: re-framing for that panel moved the
   * drawing between a click and the drag after it, so the drag landed beside what was just selected.
   */
  async frame(box?: THREE.Box3, animate = true, opts: { readonly followInsets?: boolean } = {}) {
    this.controls.clearPassThrough();
    this.emitPassThrough(false);
    const found = box ?? (await this.sceneBox());
    // Nothing linked or drawn yet: frame a room-sized area at the origin so a first part is visible when placed.
    const target = found.isEmpty() ? new THREE.Box3(new THREE.Vector3(-10, 0, -10), new THREE.Vector3(10, 3, 10)) : found;
    if (this.mode === "plan") {
      await this.applyPlanFit(target, animate, opts.followInsets ?? true);
    } else {
      this.planFitted = null;
      // fitToBox snaps to an axis-aligned face; keep a three-quarter view instead.
      await this.controls.rotateTo(Math.PI * 0.8, Math.PI / 3.6, false);
      await this.controls.fitToSphere(target.getBoundingSphere(new THREE.Sphere()), animate);
    }
    await this.fragments.update(true);
  }

  /** Fit a plan rectangle to the uncovered canvas and remember it until someone pans or zooms. */
  private async applyPlanFit(box: THREE.Box3, animate: boolean, followInsets: boolean) {
    const fit = planFit({ minX: box.min.x, maxX: box.max.x, minZ: box.min.z, maxZ: box.max.z }, this.planUpDeg, this.size(), this.frameInsets);
    this.ortho.top = fit.half;
    this.ortho.bottom = -fit.half;
    const center = new THREE.Vector3(fit.center.x, 0, fit.center.z);
    this.planFitted = { box: box.clone(), center, followInsets };
    this.resize();
    const eye = this.planEye(center);
    await this.controls.setLookAt(eye.x, 200, eye.z, center.x, 0, center.z, animate);
    await this.controls.zoomTo(1, animate);
  }

  /** The last plan fit still stands: the camera sits where it put it, at zoom 1. */
  private planFitHolds(): boolean {
    if (this.mode !== "plan" || !this.planFitted) return false;
    const target = this.controls.getTarget(new THREE.Vector3(), true);
    return Math.abs(this.ortho.zoom - 1) < 1e-3 && Math.hypot(target.x - this.planFitted.center.x, target.z - this.planFitted.center.z) < 1e-3;
  }

  /**
   * Canvas edges (px) covered by panels drawn over it. A plan that was just
   * framed is framed again into the part still visible, so a crop box never
   * opens with a side (and its grip) under the properties panel.
   */
  setFrameInsets(insets: FrameInsets) {
    const same = insets.left === this.frameInsets.left && insets.right === this.frameInsets.right && insets.top === this.frameInsets.top && insets.bottom === this.frameInsets.bottom;
    if (same) return;
    const refit = this.planFitHolds() && this.planFitted?.followInsets === true;
    this.frameInsets = insets;
    if (refit && this.planFitted) void this.applyPlanFit(this.planFitted.box, false, true).catch((err: unknown) => console.error("[ModelViewer3D] re-framing the plan for the panel failed", err));
  }

  async lookAtPoint(point: THREE.Vector3, distance: number) {
    await this.lookFrom(new THREE.Vector3(point.x + distance * 0.7, point.y + distance * 0.6, point.z + distance * 0.7), point, true);
  }

  // ---------------------------------------------------------------- orientation

  /** The 3D camera's angles (see orientation.ts); null while looking down in plan, where there is nothing to turn. */
  orientation(): Orientation | null {
    if (this.mode === "plan") return null;
    return { azimuth: this.controls.azimuthAngle, polar: this.controls.polarAngle };
  }

  /** Turn the camera to look from an orientation, the short way round, about the current orbit point (the point a click set, else the middle of the model). */
  async orientTo(target: Orientation) {
    if (this.mode === "plan") return;
    await this.controls.rotateTo(nearestTurn(this.controls.azimuthAngle, target.azimuth), target.polar, true);
  }

  /** Orbit by an angle (dragging the axis navigator). Free: it never settles on a preset view. */
  orbitBy(azimuth: number, polar: number) {
    if (this.mode === "plan" || !this.controls.enabled) return;
    void this.controls.rotate(azimuth, polar, true);
  }

  /** Everything visible, as a kernel plan rectangle in mm; null when nothing is loaded or drawn. */
  async sceneRectMm(): Promise<PlanRectMm | null> {
    const box = await this.sceneBox();
    if (box.isEmpty()) return null;
    return { min: { x: Math.round(box.min.x / MM), y: Math.round(-box.max.z / MM) }, max: { x: Math.round(box.max.x / MM), y: Math.round(-box.min.z / MM) } };
  }

  // ---------------------------------------------------------------- origin and orientation

  /**
   * Put the origin marker at a scene point and show or hide it. Its arrows are
   * drawn here; the overlay draws the axis lines and label from `originGizmoScreen`.
   */
  setOriginGizmo(position: Vec3Tuple, visible: boolean) {
    this.origin.position.set(...position);
    this.origin.visible = visible;
    for (const listener of this.cameraListeners) listener();
  }

  /** Where the origin marker and its axis lines are on the canvas (px from its top-left); null while hidden. */
  originGizmoScreen(): GizmoScreen | null {
    if (!this.origin.visible) return null;
    const { width, height } = this.size();
    return gizmoScreen(this.camera(), this.origin.position, width, height);
  }

  /** The marker handle under a client point: the point (move in plan), an arrow (move along it), or null. */
  originHandleAt(clientX: number, clientY: number): GizmoHandle | null {
    const screen = this.originGizmoScreen();
    if (!screen) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    return gizmoHandleAt(screen, { x: clientX - rect.left, y: clientY - rect.top });
  }

  /** Where a scene point (metres) is on the canvas (px from its top-left); null when it's behind the camera. */
  screenPointOf(position: Vec3Tuple): { x: number; y: number } | null {
    const { width, height } = this.size();
    return pointOnScreen(this.camera(), new THREE.Vector3(...position), width, height);
  }

  /** Where a scene point (metres) is in page (client) pixels; null when it's behind the camera. */
  clientPointOf(position: Vec3Tuple): { x: number; y: number } | null {
    const p = this.screenPointOf(position);
    if (!p) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    return { x: rect.left + p.x, y: rect.top + p.y };
  }

  /** The project origin (scene metres): what the 3D view orbits around while no orbit point is chosen and nothing is loaded or drawn. */
  setProjectOrigin(position: Vec3Tuple) {
    this.projectOrigin.set(...position);
    void this.refreshOrbitFallback();
  }

  /** What the 3D view orbits about now: the point the last click or wheel zoom chose, else the middle of the model. */
  orbitPoint(): Vec3Tuple {
    // setOrbitPoint moves the controls' target onto the point without moving the camera.
    const out = new THREE.Vector3();
    this.controls.getTarget(out);
    return [out.x, out.y, out.z];
  }

  /**
   * Which way is up in plan: degrees clockwise from plan north (0 = plan north
   * up; the true north angle puts true north up). Turns the open plan in place.
   */
  setPlanUp(deg: number) {
    if (deg === this.planUpDeg) return;
    this.planUpDeg = deg;
    if (this.mode !== "plan") return;
    const target = new THREE.Vector3();
    this.controls.getTarget(target);
    const enabled = this.controls.enabled;
    this.controls.dispose();
    this.ortho.up.copy(planUpVector(deg));
    this.controls = this.makeControls(this.ortho);
    const eye = this.planEye(target);
    this.controls.setLookAt(eye.x, 200, eye.z, target.x, 0, target.z, false);
    this.controls.mouseButtons.left = CameraControls.ACTION.TRUCK;
    this.controls.touches.one = CameraControls.ACTION.TOUCH_TRUCK;
    this.controls.minPolarAngle = 0;
    this.controls.maxPolarAngle = 0;
    this.carryControlState(enabled);
    for (const { model } of this.references.values()) model.useCamera(this.camera());
    for (const listener of this.cameraListeners) listener();
  }

  getPlanUp(): number {
    return this.planUpDeg;
  }

  /** A hair below the target on screen, so a straight-down camera knows which way is up. */
  private planEye(target: THREE.Vector3): THREE.Vector3 {
    return target.clone().addScaledVector(planUpVector(this.planUpDeg), -0.0001);
  }

  // ---------------------------------------------------------------- picking

  private ndc(clientX: number, clientY: number): THREE.Vector2 {
    const rect = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  }

  /**
   * Synchronous hit test against authored elements only. Pointer-down uses it so a
   * drag on ductwork can stop the camera before the camera starts moving.
   */
  pickNative(clientX: number, clientY: number, accept?: (elementId: string) => boolean): (Pick & { source: "native"; distance: number }) | null {
    // An 8" branch is a few pixels wide in plan; forgive a near miss.
    return pickPreferringSolid(
      PICK_TOLERANCE_PX,
      (dx, dy) => this.pickNativeExact(clientX + dx, clientY + dy, accept),
      () => (this.mode === "plan" ? this.pickPlanNearMiss(clientX, clientY, (id) => !this.isSeeThroughPick(id) && (!accept || accept(id))) : null),
    );
  }

  /** Drawn see-through over the model, so it loses a pick to anything solid under the pointer. */
  private isSeeThroughPick(elementId: string): boolean {
    const group = this.solidsById.get(elementId)?.[0]?.group;
    return group !== undefined && SEE_THROUGH_PICK_GROUPS.has(group);
  }

  /** A draw changed the solids: bring the footprint grid up to date when the page is idle, never inside the draw. */
  private markPlanFootprintsStale() {
    this.planFootprintsStale = true;
    if (this.planFootprintsIdle !== null || typeof window === "undefined") return;
    const run = () => {
      this.planFootprintsIdle = null;
      this.syncPlanFootprints();
    };
    this.planFootprintsIdle = typeof window.requestIdleCallback === "function" ? { id: window.requestIdleCallback(run, { timeout: 500 }), idle: true } : { id: window.setTimeout(run, 0), idle: false };
  }

  private syncPlanFootprints() {
    if (!this.planFootprintsStale) return;
    this.planFootprints.sync(this.solidsById);
    this.planFootprintsStale = false;
  }

  /** Plan: what lies between the tolerance rays (a receptacle under a pixel at a far zoom), by its footprint. */
  private pickPlanNearMiss(clientX: number, clientY: number, accept?: (elementId: string) => boolean): (Pick & { source: "native"; distance: number }) | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width === 0) return null;
    this.syncPlanFootprints();
    this.raycaster.setFromCamera(this.ndc(clientX, clientY), this.ortho);
    const at = this.raycaster.ray.origin;
    const metresPerPx = (this.ortho.right - this.ortho.left) / this.ortho.zoom / rect.width;
    const planes = this.renderer.clippingPlanes;
    const v = new THREE.Vector3();
    const { hit } = this.planFootprints.nearMiss(
      { x: at.x, z: at.z },
      metresPerPx * PICK_NEAR_MISS_PX,
      (s) => !this.hiddenElements.has(s.elementId) && !this.hiddenGroups.has(s.group) && keptByPlanes(planes, v.set(s.center[0], s.center[1], s.center[2])) && (!accept || accept(s.elementId)),
    );
    if (!hit) return null;
    const point = new THREE.Vector3(at.x, hit.center[1], at.z);
    return { source: "native", elementId: asElementId(hit.elementId), point, distance: this.ortho.position.distanceTo(point) };
  }


  /**
   * `pickNative`, unless a linked model's surface is in front of it (from the
   * linked models' last cast on this ray): what hover names and a drag grabs
   * is what the person sees under the pointer.
   */
  pickNativeInFront(clientX: number, clientY: number, accept?: (elementId: string) => boolean): (Pick & { source: "native"; distance: number }) | null {
    const native = this.pickNative(clientX, clientY, accept);
    if (!native || this.references.size === 0) return native;
    const front = this.surfacePicker.pick(this.surfaceQuery(clientX, clientY));
    return nativeHiddenByLinked(front, native.distance, (id) => this.referenceToneOf(id)) ? null : native;
  }

  /** `accept` skips hits it rejects (a live preview's own pieces, for example) and looks behind them. */
  private pickNativeExact(clientX: number, clientY: number, accept?: (elementId: string) => boolean): { readonly solid: (Pick & { source: "native"; distance: number }) | null; readonly seeThrough: (Pick & { source: "native"; distance: number }) | null } | null {
    this.raycaster.setFromCamera(this.ndc(clientX, clientY), this.camera());
    const planes = this.renderer.clippingPlanes;
    const hits: { readonly pick: Pick & { source: "native"; distance: number }; readonly seeThrough: boolean }[] = [];
    for (const h of this.raycaster.intersectObjects(this.nativeRoot.children, true)) {
      if (!keptByPlanes(planes, h.point)) continue;
      if (!(h.object instanceof THREE.Mesh || h.object instanceof THREE.InstancedMesh)) continue;
      const id = this.hitElementId(h);
      if (typeof id !== "string" || (accept && !accept(id))) continue;
      const seeThrough = this.isSeeThroughPick(id);
      hits.push({ pick: { source: "native", elementId: asElementId(id), point: h.point, distance: h.distance }, seeThrough });
      if (!seeThrough) break;
    }
    return hits.length === 0 ? null : choosePickHits(hits);
  }

  async pick(clientX: number, clientY: number): Promise<Pick | null> {
    // Fragments converts client pixels itself (screenToCast); it does not take NDC.
    const mouse = new THREE.Vector2(clientX, clientY);
    const native = this.pickNative(clientX, clientY);
    let best: Pick | null = native ? { source: "native", elementId: native.elementId, point: native.point } : null;
    let bestDistance = native?.distance ?? Infinity;
    for (const [referenceId, { model }] of this.references) {
      if (!model.object.visible) continue;
      // Our own element under the pointer beats a halftone or see-through linked model, even nearer.
      if (!referenceMayWinPick(this.referenceToneOf(referenceId), native !== null)) continue;
      const result = await model.raycast({ camera: this.camera(), mouse, dom: this.renderer.domElement });
      if (result && result.distance < bestDistance) {
        best = { source: "reference", referenceId, localId: result.localId, point: result.point };
        bestDistance = result.distance;
      }
    }
    // A symbol is drawn on top of what it sits in (a receptacle on a wall): it wins a near tie.
    const marker = this.pickMarker(clientX, clientY);
    if (marker && marker.distance <= bestDistance + MARKER_PICK_SLACK_M) best = marker.pick;
    return best;
  }

  private pickMarker(clientX: number, clientY: number): { pick: Pick & { source: "marker" }; distance: number } | null {
    this.raycaster.setFromCamera(this.ndc(clientX, clientY), this.camera());
    const visible = [...this.markers.values()].filter((m) => m.group.visible).map((m) => m.group);
    const planes = this.renderer.clippingPlanes;
    for (const h of this.raycaster.intersectObjects(visible, true)) {
      if (!(h.object instanceof THREE.Sprite) || !h.object.visible) continue;
      if (!keptByPlanes(planes, h.point)) continue;
      const { markerId, referenceId } = h.object.userData;
      if (typeof markerId === "string" && typeof referenceId === "string") {
        return { pick: { source: "marker", referenceId, markerId, point: h.point }, distance: h.distance };
      }
    }
    return null;
  }

  /**
   * The pointer's nearest point on the vertical line through plan (x, y), and
   * how far from that line the pointer is on screen: routing snaps to vertical
   * when the pointer comes near the last point's vertical line.
   */
  verticalPointAt(clientX: number, clientY: number, x: number, y: number): { elevationMm: number; pixelDistance: number } | null {
    if (this.mode === "plan") return null;
    this.raycaster.setFromCamera(this.ndc(clientX, clientY), this.camera());
    const ray = this.raycaster.ray;
    const [sx, , sz] = [x * MM, 0, -y * MM];
    // Closest points between the ray and the vertical line (sx, t, sz).
    const u = ray.direction;
    const w0 = new THREE.Vector3(ray.origin.x - sx, ray.origin.y, ray.origin.z - sz);
    const b = u.y;
    const d = u.dot(w0);
    const e = w0.y;
    const denom = 1 - b * b;
    if (denom < 1e-6) return null;
    const t = (b * e - d) / denom;
    if (t < 0) return null;
    const lineY = (e - b * d) / denom;
    const onLine = new THREE.Vector3(sx, lineY, sz);
    const rect = this.renderer.domElement.getBoundingClientRect();
    const p = onLine.clone().project(this.camera());
    const px = rect.left + ((p.x + 1) / 2) * rect.width;
    const py = rect.top + ((1 - p.y) / 2) * rect.height;
    return { elevationMm: lineY / MM, pixelDistance: Math.hypot(px - clientX, py - clientY) };
  }

  /**
   * The nearest visible, unclipped surface under the pointer (authored work
   * and linked models; the crop box, plan cut and section planes apply),
   * in kernel mm. Linked models answer from their last cast along this ray;
   * `onSurfaceHit` fires when a newer one lands. Never hits the ghost, the
   * hover highlight or the route-join marker.
   */
  pickSurface(clientX: number, clientY: number, accept?: (elementId: string) => boolean): SurfaceHit | null {
    const hit = this.surfacePicker.pick(this.surfaceQuery(clientX, clientY), accept);
    return hit ? toSurfaceHit(hit) : null;
  }

  /** `pickSurface`, waiting for the linked models (for a click that came before its hover cast landed). */
  async pickSurfaceAsync(clientX: number, clientY: number, accept?: (elementId: string) => boolean): Promise<SurfaceHit | null> {
    const hit = await this.surfacePicker.pickAsync(this.surfaceQuery(clientX, clientY), accept);
    return hit ? toSurfaceHit(hit) : null;
  }

  /** Told true when a wheel zoom carried the eye through the surface it zoomed toward, false once that no longer applies. */
  onPassThroughChange(listener: (passed: boolean) => void): () => void {
    this.passThroughListeners.add(listener);
    return () => this.passThroughListeners.delete(listener);
  }

  /** Put the eye back where it was just before it went through a surface (the person asked). False when there is nothing to step out of. */
  stepBackOut(): boolean {
    const stepped = this.controls.stepBackOut();
    this.emitPassThrough(false);
    return stepped;
  }

  /** The person dismissed the "zoomed through" notice: keep the view, forget the way back. */
  dismissPassThrough() {
    this.controls.clearPassThrough();
    this.emitPassThrough(false);
  }

  private readonly passThroughListeners = new Set<(passed: boolean) => void>();

  private emitPassThrough(passed: boolean) {
    for (const listener of this.passThroughListeners) listener(passed);
  }

  /** The surface under this pixel is known now (nothing linked is shown, or its cast on this ray landed): a click can act at once. */
  surfaceSettledAt(clientX: number, clientY: number): boolean {
    return this.surfacePicker.settled(this.surfaceQuery(clientX, clientY));
  }

  /** Told when a linked-model surface cast lands: re-run the preview at the last pointer. */
  onSurfaceHit(listener: () => void): () => void {
    this.surfaceListeners.add(listener);
    return () => this.surfaceListeners.delete(listener);
  }

  private surfaceQuery(clientX: number, clientY: number): SurfaceQuery {
    this.raycaster.setFromCamera(this.ndc(clientX, clientY), this.camera());
    return { ray: this.raycaster.ray.clone(), clientX, clientY };
  }

  private readonly surfaceListeners = new Set<() => void>();
  private readonly surfacePicker = new SurfacePicker(
    (ray, accept) => this.nativeSurfaceAlong(ray, accept),
    (query) => this.linkedSurfaceAlong(query),
    () => {
      for (const listener of this.surfaceListeners) listener();
    },
    () => [...this.references.values()].some(({ model }) => model.object.visible),
  );

  private nativeSurfaceAlong(ray: THREE.Ray, accept?: (elementId: string) => boolean): SceneSurfaceHit | null {
    this.anchorRaycaster.ray.copy(ray);
    const planes = this.renderer.clippingPlanes;
    for (const h of this.anchorRaycaster.intersectObjects(this.nativeRoot.children, true)) {
      if (!(h.object instanceof THREE.Mesh || h.object instanceof THREE.InstancedMesh)) continue;
      if (!shownInScene(h.object) || !keptByPlanes(planes, h.point)) continue;
      const id = this.hitElementId(h);
      if (typeof id === "string" && accept && !accept(id)) continue;
      let normal: THREE.Vector3 | null = null;
      if (h.face) {
        const world = new THREE.Matrix4().copy(h.object.matrixWorld);
        if (h.object instanceof THREE.InstancedMesh && h.instanceId !== undefined) {
          const instance = new THREE.Matrix4();
          h.object.getMatrixAt(h.instanceId, instance);
          world.multiply(instance);
        }
        normal = facingRay(h.face.normal.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(world)), ray);
      }
      return { point: h.point.clone(), normal, distance: h.distance, elementId: typeof id === "string" ? id : null, linked: null };
    }
    return null;
  }

  private async linkedSurfaceAlong(query: SurfaceQuery): Promise<SceneSurfaceHit | null> {
    if (this.references.size === 0) return null;
    const camera = this.camera();
    const mouse = new THREE.Vector2(query.clientX, query.clientY);
    let best: SceneSurfaceHit | null = null;
    for (const [referenceId, { model }] of this.references) {
      if (!model.object.visible) continue;
      const result = await model.raycast({ camera, mouse, dom: this.renderer.domElement });
      if (!result || (best && result.distance >= best.distance)) continue;
      best = { point: result.point.clone(), normal: result.normal ? facingRay(result.normal, query.ray) : null, distance: result.distance, elementId: null, linked: { referenceId, localId: result.localId } };
    }
    return best;
  }

  /** How far below level the camera looks, degrees: 0 looking level, 90 straight down (and in plan). */
  viewPitchDeg(): number {
    if (this.mode === "plan") return 90;
    const dir = this.camera().getWorldDirection(new THREE.Vector3());
    return (Math.asin(Math.min(1, Math.max(-1, -dir.y))) * 180) / Math.PI;
  }

  /**
   * Where the cursor meets the upright plane through a model point that faces
   * the camera (kernel mm; z above project zero). From a low view this is how a
   * drag follows the pointer both sideways and up and down. Null looking
   * straight down or when the ray runs along the plane.
   */
  facingPointAt(clientX: number, clientY: number, x: number, y: number, elevationMm: number): { x: number; y: number; z: number } | null {
    const camera = this.camera();
    const facing = camera.getWorldDirection(new THREE.Vector3()).setY(0);
    if (facing.lengthSq() < 1e-8) return null;
    this.raycaster.setFromCamera(this.ndc(clientX, clientY), camera);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(facing.normalize(), new THREE.Vector3(...kernelToScene(x, y, elevationMm)));
    const point = this.raycaster.ray.intersectPlane(plane, new THREE.Vector3());
    return point ? { ...sceneToKernel(point), z: point.y / MM } : null;
  }

  /** Where the cursor meets the horizontal plane at `elevationMm`, in kernel plan millimetres. */
  planPointAt(clientX: number, clientY: number, elevationMm: number): { x: number; y: number } | null {
    this.raycaster.setFromCamera(this.ndc(clientX, clientY), this.camera());
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -elevationMm * MM);
    const point = this.raycaster.ray.intersectPlane(plane, new THREE.Vector3());
    return point ? sceneToKernel(point) : null;
  }

  async select(pick: Pick | null) {
    const before = this.selected?.source === "reference" ? this.selected.referenceId : null;
    this.selected = pick;
    // Only the linked models losing or gaining the highlight repaint; the rest keep their tone untouched.
    const touched = new Set([before, pick?.source === "reference" ? pick.referenceId : null].filter((id): id is string => id !== null));
    for (const id of touched) {
      const entry = this.references.get(id);
      if (entry) await this.paintReference(id, entry);
    }
    if (this.markerMaterials) {
      const { normal, selected } = this.markerMaterials;
      for (const [referenceId, { items }] of this.markers) {
        for (const { sprite, spec } of items) {
          sprite.material = pick?.source === "marker" && pick.referenceId === referenceId && pick.markerId === spec.id ? selected : normal;
        }
      }
    }
    for (const entry of this.nativeEntries) {
      if (!(entry.object instanceof THREE.Mesh) || entry.batch) continue;
      if (pick?.source === "native" && entry.elementId === pick.elementId) entry.object.material = this.palette.selected;
      else if (entry.object.material === this.palette.selected) entry.object.material = this.material(groupOf(entry.object), tintOf(entry.object));
      const edges = entry.object.material === this.palette.selected ? this.palette.selectedEdge : this.palette.edge;
      for (const child of entry.object.children) {
        if (child instanceof THREE.LineSegments && (child.material === this.palette.edge || child.material === this.palette.selectedEdge)) child.material = edges;
      }
    }
    // A wall drawn in its level's batch shows selected as an overlay of its own body.
    if (pick?.source === "native" || this.selectedOverlayShown) {
      const inBatch = pick?.source === "native" && this.batchedIds.has(pick.elementId) ? pick.elementId : null;
      this.drawOverlay(this.selectedRoot, inBatch ? new Set([inBatch]) : null, this.palette.selected);
      this.selectedOverlayShown = inBatch !== null;
    }
    if (this.highlightIds) this.drawHighlight();
    // Selecting does not move the orbit point: a completed click (setOrbitPoint) or a wheel zoom sets it.
    await this.fragments.update(true);
  }

  /** Select an authored element by id (a pick made in a plan or section drawing); null clears. */
  async selectElement(elementId: ElementId | null) {
    await this.select(elementId ? { source: "native", elementId, point: new THREE.Vector3() } : null);
  }

  /** The selected thing's box in kernel millimetres (see `pickBoxMm`); null when nothing is selected or it can't be measured. */
  async selectedBoxMm(): Promise<Aabb3 | null> {
    return this.selected ? this.pickBoxMm(this.selected) : null;
  }

  /** The picked thing's bounding box in kernel millimetres (plan x / y, z = absolute elevation); null when it can't be measured. */
  async pickBoxMm(pick: Pick): Promise<{ min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null> {
    const box = new THREE.Box3();
    if (pick.source === "native") {
      for (const entry of this.nativeEntries) {
        if (entry.elementId === pick.elementId && !entry.batch && !(entry.object instanceof THREE.InstancedMesh)) box.expandByObject(entry.object);
      }
      // A batched wall: its own solids (batched solids are built in world axes, so centre plus vertices).
      if (this.batchedIds.has(pick.elementId)) {
        const v = new THREE.Vector3();
        for (const s of this.solidsById.get(pick.elementId) ?? []) {
          const p = s.mesh?.positions;
          if (!p) continue;
          for (let i = 0; i < p.length; i += 3) box.expandByPoint(v.set((p[i] ?? 0) + s.center[0], (p[i + 1] ?? 0) + s.center[1], (p[i + 2] ?? 0) + s.center[2]));
        }
      }
    } else if (pick.source === "reference") {
      const ref = this.references.get(pick.referenceId);
      if (ref) box.copy(await ref.model.getMergedBox([pick.localId]));
    }
    if (box.isEmpty()) return null;
    // Scene: x east, y up, z south (metres); kernel: x east, y north, z up (mm).
    return { min: { x: box.min.x / MM, y: -box.max.z / MM, z: box.min.y / MM }, max: { x: box.max.x / MM, y: -box.min.z / MM, z: box.max.y / MM } };
  }

  /** Turn camera navigation (buttons and wheel) off or on, e.g. while an overlay drags a grip. */
  setNavigationEnabled(enabled: boolean) {
    this.controls.enabled = enabled;
  }

  /**
   * An edit takes the pointer (`owner` names it: a duct drag, a route stroke, a
   * box). Until every claim is released, mouse buttons and touches do not move
   * the camera and the orbit point stays put; the wheel still zooms. Survives
   * switching between plan and 3D. Returns the release (safe to call twice).
   */
  claimPointer(owner: string): () => void {
    const token = Symbol(owner);
    this.pointerClaims.add(token);
    this.controls.setPointerBlocked(true);
    return () => {
      if (!this.pointerClaims.delete(token)) return;
      if (this.pointerClaims.size === 0) this.controls.setPointerBlocked(false);
    };
  }

  /** True while an edit owns the pointer. */
  pointerClaimed(): boolean {
    return this.pointerClaims.size > 0;
  }

  /** New controls (plan / 3D / projection / plan-up) start free; carry the switch and the claims across. */
  private carryControlState(enabled: boolean) {
    this.controls.enabled = enabled;
    this.controls.setPointerBlocked(this.pointerClaims.size > 0);
  }

  dispose() {
    if (this.planFootprintsIdle) {
      if (this.planFootprintsIdle.idle) window.cancelIdleCallback(this.planFootprintsIdle.id);
      else window.clearTimeout(this.planFootprintsIdle.id);
      this.planFootprintsIdle = null;
    }
    this.disposed = true;
    this.surfacePicker.dispose();
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    for (const entry of this.nativeEntries) disposeObject(entry.object);
    disposeObject(this.ghostRoot);
    disposeObject(this.joinRoot);
    disposeObject(this.planSymbolRoot);
    disposeObject(this.selectedRoot);
    this.planSymbolMaterial?.dispose();
    for (const { texture } of this.planTextTextures.values()) texture.dispose();
    this.planTextTextures.clear();
    disposeObject(this.origin);
    this.cropOutline.dispose();
    if (this.markerMaterials) {
      for (const m of [this.markerMaterials.normal, this.markerMaterials.selected]) {
        m.map?.dispose();
        m.dispose();
      }
    }
    for (const entry of this.toneMaterials.values()) entry.material.dispose();
    this.dashedEdge?.dispose();
    this.palette.dispose();
    void this.fragments.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

function groupOf(mesh: THREE.Mesh): RenderGroup {
  const g = mesh.userData.group;
  return isRenderGroup(g) ? g : "duct";
}

function tintOf(mesh: THREE.Mesh): number | undefined {
  const t: unknown = mesh.userData.tint;
  return typeof t === "number" ? t : undefined;
}

function isRenderGroup(value: unknown): value is RenderGroup {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(GROUP_STYLE, value);
}

/** Box and cylinder solids are unit primitives; fittings carry their own sheet-metal triangles. */
function solidGeometry(s: Solid): THREE.BufferGeometry {
  if (s.shape === "mesh" && s.mesh) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(s.mesh.positions, 3));
    g.setIndex(new THREE.BufferAttribute(s.mesh.indices, 1));
    g.computeVertexNormals();
    return g;
  }
  return s.shape === "box" ? new THREE.BoxGeometry(s.size[0], s.size[1], s.size[2]) : new THREE.CylinderGeometry(s.size[1] / 2, s.size[1] / 2, s.size[0], 24);
}

function placeSolid(object: THREE.Object3D, s: Solid) {
  object.position.set(s.center[0], s.center[1], s.center[2]);
  object.userData.group = s.group;
  if (s.tint !== undefined) object.userData.tint = s.tint;
  const [rx, ry, rz] = solidRotation(s);
  object.rotation.set(rx, ry, rz, "YXZ");
}

function disposeObject(object: THREE.Object3D) {
  object.traverse((child) => {
    if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) child.geometry.dispose();
  });
}

async function storeyItems(model: FragmentsModel): Promise<{ name: string; localIds: number[] }[]> {
  const tree = await model.getSpatialStructure();
  const storeys: { localId: number; children: SpatialNode[] }[] = [];
  // The tree alternates category groups (category set, no id) and items (id, no category).
  const walk = (node: SpatialNode) => {
    if (node.category === "IFCBUILDINGSTOREY") {
      for (const item of node.children ?? []) if (item.localId !== null) storeys.push({ localId: item.localId, children: item.children ?? [] });
      return;
    }
    for (const c of node.children ?? []) walk(c);
  };
  walk(tree);
  if (storeys.length === 0) return [];
  const names = await model.getItemsData(
    storeys.map((s) => s.localId),
    { attributesDefault: false, attributes: ["Name"] },
  );
  return storeys.map((s, i) => {
    const ids: number[] = [];
    const collect = (n: SpatialNode) => {
      if (n.localId !== null) ids.push(n.localId);
      for (const c of n.children ?? []) collect(c);
    };
    for (const c of s.children) collect(c);
    return { name: attributeText(names[i], "Name") ?? `Level ${i + 1}`, localIds: ids };
  });
}

interface SpatialNode {
  readonly category: string | null;
  readonly localId: number | null;
  readonly children?: SpatialNode[];
}

function attributeText(item: unknown, key: string): string | null {
  if (typeof item !== "object" || item === null || !(key in item)) return null;
  const attr: unknown = Reflect.get(item, key);
  if (typeof attr === "object" && attr !== null && "value" in attr) {
    const v: unknown = Reflect.get(attr, "value");
    return v === null || v === undefined ? null : String(v);
  }
  return null;
}

/** Drawn: the object and every parent up to the scene are visible. */
function shownInScene(object: THREE.Object3D): boolean {
  for (let o: THREE.Object3D | null = object; o; o = o.parent) if (!o.visible) return false;
  return true;
}

/** `point` is ahead on `ray` (within about a pixel's angle): a cached hit still under the pointer. */
function liesOnRay(ray: THREE.Ray, point: THREE.Vector3): boolean {
  const along = point.clone().sub(ray.origin).dot(ray.direction);
  return along > 0 && ray.distanceToPoint(point) <= Math.max(1e-3, along * 2e-3);
}

/** Two pointer rays along the same line (a zoom toward the pointer moves the eye along its own ray). */
function sameRay(a: THREE.Ray, b: THREE.Ray): boolean {
  return a.direction.angleTo(b.direction) < 1e-4 && a.distanceToPoint(b.origin) < 1e-3;
}
