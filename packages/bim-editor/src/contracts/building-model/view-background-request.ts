import { DEFAULT_CUT_HEIGHT_MM, anchorOnlyReference, findLevelByName, sameFloor, type Level, type LinkedReferenceModel, type ReferencePlan, type SheetReference, type ViewElement } from "@permitzip/bim-kernel";

/**
 * What to cut the linked models at for one drawing view, and how the cut is
 * stroked before the view screens it. Shared by the browser (sheet canvas,
 * Print PDF) and the agent's pictures, so both draw the same background.
 */

/** How a view simplifies its linked models: hidden lines removed (default on) and small things left out. */
export interface ViewBackgroundDetail {
  readonly hiddenLines?: boolean;
  readonly minObjectMm?: number;
  /** The linked elements the view's dimensions follow (`linkedAnchorKeysOfView`): the answer carries their current outlines, so a print measures to where they are now. */
  readonly linkedAnchors?: readonly string[];
}

export type ViewBackgroundCut =
  | ({
      readonly kind: "plan";
      readonly level: string;
      readonly levelElevationMm?: number;
      readonly cutHeightMm: number;
      readonly lowestAboveLevelMm?: number;
      /** The view's top, mm above its level. */
      readonly topAboveLevelMm?: number;
      /** A ceiling plan: looking up. */
      readonly lookingUp?: boolean;
      readonly detailLevel?: "coarse" | "medium" | "fine";
      /** Per linked model (link id), the storey a person said this view's level is. */
      readonly linkedStoreys?: Readonly<Record<string, string>>;
    } & ViewBackgroundDetail)
  | ({ readonly kind: "section"; readonly cut: NonNullable<NonNullable<ViewElement["props"]>["section"]> } & ViewBackgroundDetail);

/** Cut walls wide, what is seen beyond thin; the view's linked-model display screens them. */
export const REFERENCE_STROKES: SheetReference["strokes"] = { cut: { pen: "wide", tone: "ink" }, projection: { pen: "thin", tone: "ink" } };

function detailOf(view: ViewElement): ViewBackgroundDetail {
  const props = view.props ?? {};
  // Wireframe shows every edge, so the linked model's hidden lines stay too.
  const hiddenLines = props.linkedHiddenLines !== false && props.visualStyle !== "wireframe";
  return {
    ...(hiddenLines ? {} : { hiddenLines: false }),
    ...(props.linkedMinObjectMm ? { minObjectMm: props.linkedMinObjectMm } : {}),
  };
}

/** The model level a view stands on: its name, else the same floor. */
function hostLevel(levels: readonly Level[], level: string, elevationMm: number | undefined): Level | undefined {
  return findLevelByName(levels, level) ?? levels.find((l) => sameFloor(l, level, elevationMm));
}

/** `levels`: the model's levels, so the cut carries the linked storeys a person chose for the view's level. `linkedAnchors`: the linked elements its dimensions follow. */
export function backgroundCutFor(view: ViewElement, levels: readonly Level[] = [], linkedAnchors: readonly string[] = []): ViewBackgroundCut | null {
  const cut = backgroundCutOf(view, levels);
  return cut && linkedAnchors.length > 0 ? { ...cut, linkedAnchors } : cut;
}

function backgroundCutOf(view: ViewElement, levels: readonly Level[]): ViewBackgroundCut | null {
  const props = view.props ?? {};
  if ((view.viewType === "floor_plan" || view.viewType === "ceiling_plan") && props.level) {
    const chosen = hostLevel(levels, props.level, props.levelElevationMm)?.linkedStoreys;
    return {
      kind: "plan",
      level: props.level,
      ...(props.levelElevationMm !== undefined ? { levelElevationMm: props.levelElevationMm } : {}),
      cutHeightMm: props.cutHeightMm ?? DEFAULT_CUT_HEIGHT_MM,
      ...(props.viewBottomMm !== undefined ? { lowestAboveLevelMm: props.viewBottomMm - (props.viewDepthMm ?? 0) } : {}),
      ...(props.viewTopMm !== undefined ? { topAboveLevelMm: props.viewTopMm } : {}),
      ...(view.viewType === "ceiling_plan" ? { lookingUp: true } : {}),
      ...(props.detailLevel && props.detailLevel !== "medium" ? { detailLevel: props.detailLevel } : {}),
      ...(chosen && Object.keys(chosen).length > 0 ? { linkedStoreys: chosen } : {}),
      ...detailOf(view),
    };
  }
  if (view.viewType === "section" && props.section) return { kind: "section", cut: props.section, ...detailOf(view) };
  return null;
}

export function sheetReferenceOf(plan: ReferencePlan): SheetReference {
  return { plan, pen: "medium", tone: "ink", strokes: REFERENCE_STROKES };
}

/** A cut's answer as a view's backgrounds, carrying the linked elements its dimensions name (on the first background, or on one with no linework). */
export function sheetReferencesOf(plans: readonly ReferencePlan[], linkedAnchors: readonly LinkedReferenceModel[] = []): SheetReference[] {
  const refs = plans.map(sheetReferenceOf);
  if (linkedAnchors.length === 0) return refs;
  const [first, ...rest] = refs;
  return first ? [{ ...first, linkedAnchors }, ...rest] : [anchorOnlyReference(linkedAnchors)];
}
