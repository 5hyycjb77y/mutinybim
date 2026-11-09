/**
 * What the live canvas shows for an open saved view. It follows the view's
 * printed drawing: the same model levels (the kernel's same-floor match, so a
 * plan of the linked storey "LEVEL 1" shows ductwork routed on "Level 1"), the
 * same floor, and a plan cut that never slices away the work its drawing shows.
 */
import { DEFAULT_CUT_HEIGHT_MM, viewFloorMm, viewLevelNames, type ModelState, type ViewElement } from "@permitzip/bim-kernel";
import { MM } from "./coords";
import { DEFAULT_ELEVATIONS, modelSolids, type ElevationRules, type Solid } from "./native-geometry";

/** Room the live cut keeps above a plan's own work (mm). */
const CUT_HEADROOM_MM = 300;

type LiveViewSource = Pick<ViewElement, "viewType" | "props">;

export interface LiveView {
  /** Partition levels whose authored work is drawn; null draws every level. */
  readonly levels: ReadonlySet<string> | null;
  /** Floor the view stands on; null when neither a model level nor the view knows it. */
  readonly floorMm: number | null;
}

export function liveView(model: ModelState, view: LiveViewSource): LiveView {
  const props = view.props ?? {};
  if (view.viewType === "detail") return { levels: null, floorMm: null };
  return {
    levels: viewLevelNames(model, props.level, props.levelElevationMm),
    floorMm: viewFloorMm(model, props.level, props.levelElevationMm),
  };
}

/** Highest point of these solids (mm above project zero); null when there are none. */
export function solidsTopMm(solids: readonly Solid[]): number | null {
  let top = -Infinity;
  for (const s of solids) {
    let half: number;
    if (s.shape === "mesh" && s.mesh) {
      half = 0;
      for (let i = 1; i < s.mesh.positions.length; i += 3) half = Math.max(half, s.mesh.positions[i] ?? 0);
    } else if (s.shape === "cylinder") half = (s.vertical ? s.size[0] : s.size[1]) / 2;
    else half = s.size[1] / 2;
    top = Math.max(top, s.center[1] + half);
  }
  return Number.isFinite(top) ? top / MM : null;
}

/** Where a plan cuts the live model: its cut height above its floor, raised above the work on its levels. */
export function livePlanCutMm(model: ModelState, view: LiveViewSource, floorMm: number, rules: ElevationRules = DEFAULT_ELEVATIONS): number {
  const cut = floorMm + (view.props?.cutHeightMm ?? DEFAULT_CUT_HEIGHT_MM);
  const top = solidsTopMm(modelSolids(model, rules, liveView(model, view).levels ?? undefined));
  return top === null ? cut : Math.max(cut, top + CUT_HEADROOM_MM);
}
