import { elementsOfKind, type ModelState, type ParamValue, type ViewElement, type ViewProps } from "@permitzip/bim-kernel";
import { measureIn, type Measure } from "@permitzip/bim-units";
import type { ScriptContext } from "./context";
import type { PlacedPart } from "./kit-building";
import { onWorking } from "./working";

/**
 * `electrical`: photometric & emergency egress lighting helpers for scripts.
 *
 * Keeps `@permitzip/bim-script` strictly free of direct pack imports by issuing
 * ordinary kernel edits (`save_catalog_entry`, `set_element_values`,
 * `set_view_properties`) and invoking the Electrical pack's registered
 * `CALC_POINT` calculations (`electrical.photometrics_normal`,
 * `electrical.photometrics_egress`) on the script's live working model.
 */

export type LuminaireEmergencyMode = "none" | "battery_pack" | "generator_circuit" | "inverter";
export type PhotometricOverlayMode = "off" | "normal" | "egress";

export interface LuminaireIesSpec {
  /** Built-in profile id (`"troffer_2x4_led"`, `"downlight_6_led"`, `"linear_pendant_led"`, `"exit_combo_wall_pack"`, `"exterior_wall_pack_led"`) or a model catalog profile name. */
  readonly profile?: string;
  /** Custom IES LM-63-1995/2002/19 file text. When `saveAsProfile` is given, saved once as a deduplicated `photometric_profile` catalog record. */
  readonly iesText?: string;
  /** Optional catalog name to save `iesText` under (`save_catalog_entry` type `"photometric_profile"`), then reference via `electrical.photometric_profile`. */
  readonly saveAsProfile?: string;
  /** Emergency lighting mode for NFPA 101 / IBC egress compliance. */
  readonly emergencyMode?: LuminaireEmergencyMode;
  /** Rated emergency lumen output (lm). */
  readonly emergencyLumens?: number;
  /** Emergency ballast/driver factor in [0, 1]. */
  readonly emergencyBallastFactor?: number;
  /** Explicitly mark luminaire as an emergency egress fixture. */
  readonly egressFixture?: boolean;
  /** Lamp Lumen Depreciation factor (default 0.90). */
  readonly lld?: number;
  /** Luminaire Dirt Depreciation factor (default 0.92). */
  readonly ldd?: number;
  /** Overall Light Loss Factor override (defaults to `lld * ldd`). */
  readonly llf?: number;
  /** Luminaire aiming tilt angle from nadir in degrees. */
  readonly tiltDeg?: number;
}

export type PhotometricsCalculationMode = "simplified" | "detailed" | "surfaces";

export interface PhotometricsRunSpec {
  /** Optional level id or level name filter. */
  readonly level?: string;
  /** Optional subset of space/room ids. */
  readonly spaceIds?: readonly string[];
  /** Grid spacing (length Measure or feet number; default 2 ft). */
  readonly gridSpacing?: Measure | number;
  /** Workplane elevation AFF (length Measure or inches number; defaults to 30" for rooms, 0" for corridors/stairs). */
  readonly workplaneHeight?: Measure | number;
  /**
   * Calculation fidelity mode:
   * - `"simplified"`: shell-only space plane at `workplaneHeight` with standard reflectances (ignores furniture).
   * - `"detailed"` (default): derives ceiling/wall/floor reflectances from the Materials Library, applies glazing transmittance, and includes furniture & stair occlusion.
   * - `"surfaces"`: full `"detailed"` physics plus fine-grid evaluation on kitchen countertops, islands, worktables, vanities & rising 3D stair treads.
   */
  readonly calculationMode?: PhotometricsCalculationMode;
  /** Derive ceiling/wall/floor reflectances from assigned Materials Library entries. */
  readonly useMaterialReflectances?: boolean;
  /** Include furniture, casework, kitchen counters & equipment in 3D ray occlusion. */
  readonly includeFurnitureOcclusion?: boolean;
  /** Evaluate horizontal task surfaces (counters, desks, vanities) & multi-flight 3D stair treads. */
  readonly includeTaskSurfaces?: boolean;
  /** Include 1-bounce diffuse / zonal-cavity inter-reflectance (default true). */
  readonly interReflectance?: boolean;
  /** Optional room surface reflectances overriding Materials Library & defaults. */
  readonly reflectances?: { readonly ceiling?: number; readonly wall?: number; readonly floor?: number };
}

export interface EgressLightingCheckSpec {
  /** Optional level id or level name filter. */
  readonly level?: string;
  /** Grid spacing (length Measure or feet number; default 2 ft). */
  readonly gridSpacing?: Measure | number;
  /** Floor plane elevation AFF (length Measure or inches number; default 0"). */
  readonly workplaneHeight?: Measure | number;
  /** Calculation fidelity mode (`"simplified"` ignores furniture occlusion; `"detailed"` includes furniture & 3D multi-flight stair treads). */
  readonly calculationMode?: PhotometricsCalculationMode;
  /** Include furniture/casework occlusion along egress paths. */
  readonly includeFurnitureOcclusion?: boolean;
  /** Include diffuse inter-reflectance (default false — conservative direct-only per NFPA 101). */
  readonly interReflectance?: boolean;
  /** Battery 90-minute end-of-discharge derate factor (default 0.60). */
  readonly battery90MinDerate?: number;
  /** Optional explicit egress path polygons or polylines (coordinates in length Measures or mm). */
  readonly egressPaths?: readonly {
    readonly id: string;
    readonly name: string;
    readonly levelId?: string;
    readonly levelName?: string;
    readonly outline?: readonly { readonly x: Measure | number; readonly y: Measure | number }[];
    readonly polyline?: readonly { readonly x: Measure | number; readonly y: Measure | number }[];
    readonly widthFt?: number;
  }[];
  /** Evaluate only explicit `egressPaths`, skipping auto-derived corridor/stair/exit-discharge zones. */
  readonly explicitOnly?: boolean;
}

export interface PhotometricOverlaySpec {
  readonly mode: PhotometricOverlayMode;
  readonly showContours?: boolean;
  readonly showGridValues?: boolean;
  readonly showFailingHighlights?: boolean;
  readonly gridSpacing?: Measure | number;
  readonly workplaneHeight?: Measure | number;
  readonly contourLevels?: readonly number[];
}

function asFt(value: Measure | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  return typeof value === "number" ? value : measureIn(value, "ft");
}

function asIn(value: Measure | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  return typeof value === "number" ? value : measureIn(value, "in");
}

function asMm(value: Measure | number): number {
  return typeof value === "number" ? value : measureIn(value, "mm");
}

function resolveView(model: ModelState, ref: string): ViewElement {
  const exact = model.elements[ref];
  if (exact?.kind === "view") return exact;
  const low = ref.trim().toLowerCase();
  const byName = [...elementsOfKind(model.elements, "view")].find((v) => v.name.trim().toLowerCase() === low);
  if (byName) return byName;
  throw new Error(`No view "${ref}" in the model. Create or pass a floor/ceiling plan view id or name.`);
}

function resolveLuminaireIds(
  model: ModelState,
  target: string | PlacedPart | readonly (string | PlacedPart)[],
): string[] {
  const refs = Array.isArray(target) ? target : [target];
  const ids = new Set<string>();
  for (const r of refs) {
    const id = typeof r === "string" ? r : r.id;
    const el = model.elements[id];
    if (!el) throw new Error(`No element "${id}" found in the working model.`);
    if (el.kind === "part") {
      ids.add(el.id);
    } else if (el.kind === "part_type") {
      // Apply to every placed luminaire instance of this part type
      for (const part of elementsOfKind(model.elements, "part")) {
        if (part.typeId === el.id) ids.add(part.id);
      }
    } else {
      throw new Error(`Expected a lighting fixture part or part_type, got ${el.kind} (${id}).`);
    }
  }
  return [...ids];
}

export const electrical = {
  /**
   * Attaches a built-in IES profile id or custom IES LM-63 text (optionally saved as a
   * deduplicated model `photometric_profile` catalog entry) and emergency/LLF metadata to
   * one or more placed luminaire parts or all instances of a luminaire `part_type`.
   */
  setLuminaireIes(
    ctx: ScriptContext,
    target: string | PlacedPart | readonly (string | PlacedPart)[],
    spec: LuminaireIesSpec,
  ): void {
    const elementIds = onWorking(ctx, "electrical.setLuminaireIes", (m) => resolveLuminaireIds(m, target));
    const values: Record<string, ParamValue> = {};

    if (spec.iesText && spec.saveAsProfile) {
      ctx.edit({
        type: "save_catalog_entry",
        entry: {
          type: "photometric_profile",
          name: spec.saveAsProfile,
          iesText: spec.iesText,
        },
      });
      values["electrical.photometric_profile"] = spec.saveAsProfile;
    } else {
      if (spec.profile !== undefined) values["electrical.photometric_profile"] = spec.profile;
      if (spec.iesText !== undefined) values["electrical.ies_file"] = spec.iesText;
    }

    if (spec.emergencyMode !== undefined) values["electrical.emergency_mode"] = spec.emergencyMode;
    if (spec.emergencyLumens !== undefined) values["electrical.emergency_lumens"] = spec.emergencyLumens;
    if (spec.emergencyBallastFactor !== undefined) values["electrical.emergency_ballast_factor"] = spec.emergencyBallastFactor;
    if (spec.egressFixture !== undefined) values["electrical.egress_fixture"] = spec.egressFixture;
    if (spec.lld !== undefined) values["electrical.lld"] = spec.lld;
    if (spec.ldd !== undefined) values["electrical.ldd"] = spec.ldd;
    if (spec.llf !== undefined) values["electrical.llf"] = spec.llf;
    if (spec.tiltDeg !== undefined) values["electrical.tilt_deg"] = spec.tiltDeg;

    if (Object.keys(values).length === 0) return;
    if (elementIds.length === 0) return;

    ctx.edit({
      type: "set_element_values",
      elementIds,
      values,
    });
  },

  /**
   * Runs `electrical.photometrics_normal` on the script's live working model and
   * returns the full calc result (including per-space `detail.spaces[]`, LPD,
   * uniformity ratios, grid points, and pass/fail status).
   */
  runPhotometrics<T = unknown>(ctx: ScriptContext, spec: PhotometricsRunSpec = {}): T {
    const gridSpacingFt = asFt(spec.gridSpacing);
    const workplaneHeightIn = asIn(spec.workplaneHeight);
    const result = ctx.calc({
      calc: "electrical.photometrics_normal",
      inputs: {
        ...(spec.level !== undefined ? { level: spec.level } : {}),
        ...(spec.spaceIds !== undefined ? { spaceIds: [...spec.spaceIds] } : {}),
        ...(gridSpacingFt !== undefined ? { gridSpacingFt } : {}),
        ...(workplaneHeightIn !== undefined ? { workplaneHeightIn } : {}),
        ...(spec.calculationMode !== undefined ? { calculationMode: spec.calculationMode } : {}),
        ...(spec.useMaterialReflectances !== undefined ? { useMaterialReflectances: spec.useMaterialReflectances } : {}),
        ...(spec.includeFurnitureOcclusion !== undefined ? { includeFurnitureOcclusion: spec.includeFurnitureOcclusion } : {}),
        ...(spec.includeTaskSurfaces !== undefined ? { includeTaskSurfaces: spec.includeTaskSurfaces } : {}),
        ...(spec.interReflectance !== undefined ? { interReflectance: spec.interReflectance } : {}),
        ...(spec.reflectances !== undefined ? { reflectances: spec.reflectances } : {}),
      },
    });
    return result as T;
  },

  /**
   * Runs `electrical.photometrics_egress` (NFPA 101 §7.9.2.1 / IBC §1008.3.5) on the
   * script's live working model and returns the full calc result (initial & 90-minute
   * floor-plane illuminance along corridors, stairs, exit discharge, and explicit paths).
   */
  runEgressLightingCheck<T = unknown>(ctx: ScriptContext, spec: EgressLightingCheckSpec = {}): T {
    const gridSpacingFt = asFt(spec.gridSpacing);
    const workplaneHeightIn = asIn(spec.workplaneHeight);
    const egressPaths = spec.egressPaths?.map((p) => ({
      id: p.id,
      name: p.name,
      ...(p.levelId !== undefined ? { levelId: p.levelId } : {}),
      ...(p.levelName !== undefined ? { levelName: p.levelName } : {}),
      ...(p.outline ? { outline: p.outline.map((pt) => ({ x: asMm(pt.x), y: asMm(pt.y) })) } : {}),
      ...(p.polyline ? { polyline: p.polyline.map((pt) => ({ x: asMm(pt.x), y: asMm(pt.y) })) } : {}),
      ...(p.widthFt !== undefined ? { widthFt: p.widthFt } : {}),
    }));
    const result = ctx.calc({
      calc: "electrical.photometrics_egress",
      inputs: {
        ...(spec.level !== undefined ? { level: spec.level } : {}),
        ...(gridSpacingFt !== undefined ? { gridSpacingFt } : {}),
        ...(workplaneHeightIn !== undefined ? { workplaneHeightIn } : {}),
        ...(spec.calculationMode !== undefined ? { calculationMode: spec.calculationMode } : {}),
        ...(spec.includeFurnitureOcclusion !== undefined ? { includeFurnitureOcclusion: spec.includeFurnitureOcclusion } : {}),
        ...(spec.interReflectance !== undefined ? { interReflectance: spec.interReflectance } : {}),
        ...(spec.battery90MinDerate !== undefined ? { battery90MinDerate: spec.battery90MinDerate } : {}),
        ...(egressPaths !== undefined ? { egressPaths } : {}),
        ...(spec.explicitOnly !== undefined ? { explicitOnly: spec.explicitOnly } : {}),
      },
    });
    return result as T;
  },

  /**
   * Configures the `electrical.photometric_grid` 2D plan overlay (footcandle grid values,
   * iso-contour lines, and sub-threshold fail highlights) on a floor or ceiling plan view.
   */
  enablePhotometricOverlay(ctx: ScriptContext, viewRef: string, spec: PhotometricOverlaySpec): void {
    const view = onWorking(ctx, "electrical.enablePhotometricOverlay", (m) => resolveView(m, viewRef));
    const gridSpacingFt = asFt(spec.gridSpacing);
    const workplaneHeightIn = asIn(spec.workplaneHeight);
    const photometrics: Record<string, unknown> = {
      photometricsMode: spec.mode,
      ...(spec.showContours !== undefined ? { showContours: spec.showContours } : {}),
      ...(spec.showGridValues !== undefined ? { showGridValues: spec.showGridValues } : {}),
      ...(spec.showFailingHighlights !== undefined ? { showFailingHighlights: spec.showFailingHighlights } : {}),
      ...(gridSpacingFt !== undefined ? { gridSpacingFt } : {}),
      ...(workplaneHeightIn !== undefined ? { workplaneHeightIn } : {}),
      ...(spec.contourLevels !== undefined ? { contourLevels: [...spec.contourLevels] } : {}),
    };
    ctx.edit({
      type: "set_view_properties",
      viewId: view.id,
      props: { photometrics } as ViewProps,
    });
  },
};
