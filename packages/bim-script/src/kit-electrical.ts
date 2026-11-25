import { builtinPartType, elementsOfKind, type ModelState, type ParamValue, type PartInstance, type ServiceLink, type ViewElement, type ViewProps } from "@permitzip/bim-kernel";
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
export type RadiosityMethod = "patch_radiosity" | "cavity";
export type DaylightSkyModel = "cie_overcast" | "cie_clear" | "cie_intermediate";

export interface DaylightSpec {
  /** Enable CIE sky dome + direct solar daylighting (default true when object is passed). */
  readonly enabled?: boolean;
  /** CIE sky luminance distribution (`"cie_overcast"` for Daylight Factor, `"cie_clear"`, or `"cie_intermediate"`). */
  readonly skyModel?: DaylightSkyModel;
  /** Unobstructed outdoor horizontal diffuse sky illuminance in fc (default 1000 fc). */
  readonly outdoorHorizontalFc?: number;
  /** Solar azimuth in degrees clockwise from +Y North (default 180°). */
  readonly sunAzimuthDeg?: number;
  /** Solar altitude above horizon in degrees (default 45°). */
  readonly sunElevationDeg?: number;
  /** Direct normal solar beam illuminance in fc for clear/intermediate skies. */
  readonly directSunNormalFc?: number;
  /** Include electric luminaires alongside daylight (default true in `runPhotometrics`, false in `runDaylightAnalysis`). */
  readonly includeElectric?: boolean;
}

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
   * - `"detailed"` (default): derives ceiling/wall/floor reflectances from the Materials Library, applies glazing transmittance, runs 4-bounce spatially-resolved patch radiosity, and includes furniture & stair occlusion.
   * - `"surfaces"`: full `"detailed"` physics plus fine-grid evaluation on kitchen countertops, islands, worktables, vanities & rising 3D stair treads.
   */
  readonly calculationMode?: PhotometricsCalculationMode;
  /** Derive ceiling/wall/floor reflectances from assigned Materials Library entries. */
  readonly useMaterialReflectances?: boolean;
  /** Include furniture, casework, kitchen counters & equipment in 3D ray occlusion. */
  readonly includeFurnitureOcclusion?: boolean;
  /** Evaluate horizontal task surfaces (counters, desks, vanities) & multi-flight 3D stair treads. */
  readonly includeTaskSurfaces?: boolean;
  /** Include diffuse inter-reflectance (default true). */
  readonly interReflectance?: boolean;
  /** Inter-reflectance solver: `"patch_radiosity"` (4-bounce spatially-resolved patch radiosity, default in detailed/surfaces) or `"cavity"` (fast uniform room average). */
  readonly radiosityMethod?: RadiosityMethod;
  /** Optional CIE sky dome + direct solar daylighting through windows, glazed curtain walls, and skylights. */
  readonly daylight?: DaylightSpec;
  /** Optional room surface reflectances overriding Materials Library & defaults. */
  readonly reflectances?: { readonly ceiling?: number; readonly wall?: number; readonly floor?: number };
}

export interface DaylightAnalysisSpec extends Omit<PhotometricsRunSpec, "daylight"> {
  /** CIE sky model (default `"cie_overcast"` for LEED / EN 17037 Daylight Factor). */
  readonly skyModel?: DaylightSkyModel;
  /** Unobstructed outdoor horizontal sky illuminance in fc (default 1000 fc). */
  readonly outdoorHorizontalFc?: number;
  /** Solar azimuth in degrees clockwise from +Y North (default 180°). */
  readonly sunAzimuthDeg?: number;
  /** Solar altitude above horizon in degrees (default 45°). */
  readonly sunElevationDeg?: number;
  /** Direct normal solar beam illuminance in fc for clear/intermediate skies. */
  readonly directSunNormalFc?: number;
  /** Include electric luminaires in addition to daylight (default false — pure Daylight Factor). */
  readonly includeElectric?: boolean;
}

export interface RadianceExportSpec {
  /** Sky model for `sky.rad` `!gensky` header (default `"cie_overcast"`). */
  readonly skyModel?: DaylightSkyModel;
  /** Solar azimuth in degrees clockwise from +Y North (default 180°). */
  readonly sunAzimuthDeg?: number;
  /** Solar altitude above horizon in degrees (default 45°). */
  readonly sunElevationDeg?: number;
  /** Include electric luminaires & `.ies` files (default true). */
  readonly includeLuminaires?: boolean;
  /** Sensor grid spacing for `sensors.pts` (length Measure or feet number; default 2 ft). */
  readonly gridSpacing?: Measure | number;
  /** Workplane elevation AFF for `sensors.pts` (length Measure or inches number; default 30"). */
  readonly workplaneHeight?: Measure | number;
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

export interface InsertDisconnectSpec {
  /** Optional explicit disconnect part ID (defaults to `disc-<equipmentId>`). */
  readonly disconnectId?: string;
  /** Disconnect mark shown on plan & One-Line (defaults to `SD-<equipment.mark>`). */
  readonly mark?: string;
  /** Optional explicit built-in or model part type ID (defaults to NEMA 3R/1 non-fused or fused disconnect matched to ratingA). */
  readonly typeId?: string;
  /** Choose a fused disconnect switch when auto-selecting the built-in type (default false). */
  readonly fused?: boolean;
  /** Optional XY offset from the equipment's position (defaults to `[-900 mm, 0]`, within sight per NEC 440.14). */
  readonly offset?: { readonly x?: Measure | number; readonly y?: Measure | number };
  /** Optional mounting height AFF (defaults to the equipment's offsetMm or 1200 mm). */
  readonly height?: Measure | number;
  /** Optional upstream panel/bus ID when the equipment is not yet circuited. */
  readonly sourceId?: string;
  /** Optional breaker positions on `sourceId` when creating a new upstream link. */
  readonly positions?: readonly number[];
  /** Optional circuit rating in amps (defaults to existing circuit rating or 30 A). */
  readonly ratingA?: number;
  /** Optional downstream link ID (defaults to `ckt-<disconnectId>-to-<equipmentId>`). */
  readonly downstreamLinkId?: string;
}

export interface InsertDisconnectResult {
  readonly disconnectId: string;
  readonly mark: string;
  readonly typeId: string;
  readonly upstreamLinkId: string | null;
  readonly downstreamLinkId: string;
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

    // Keep control-wiring `emergency` / `emergency_mode` instance params in sync when declared on the part type
    if (spec.emergencyMode !== undefined) {
      const isEm = spec.emergencyMode !== "none";
      const updates = onWorking(ctx, "electrical.setLuminaireIes:syncControl", (m) => {
        const out: { id: string; values: Record<string, string | boolean> }[] = [];
        for (const id of elementIds) {
          const part = m.elements[id];
          if (part?.kind !== "part") continue;
          const pt = m.elements[part.typeId];
          if (pt?.kind !== "part_type") continue;
          const allowed = new Set(pt.definition.instanceParams.map((p) => p.name));
          const syncVals: Record<string, string | boolean> = {};
          if (allowed.has("emergency")) syncVals.emergency = isEm;
          if (allowed.has("emergency_mode")) {
            const cur = part.values.emergency_mode;
            syncVals.emergency_mode = isEm ? (cur === "switched" ? "switched" : "unswitched") : "none";
          }
          if (Object.keys(syncVals).length > 0) out.push({ id, values: syncVals });
        }
        return out;
      });
      for (const u of updates) {
        ctx.edit({ type: "set_parameters", id: u.id, scope: "instance", values: u.values });
      }
    }
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
        ...(spec.radiosityMethod !== undefined ? { radiosityMethod: spec.radiosityMethod } : {}),
        ...(spec.daylight !== undefined ? { daylight: { enabled: spec.daylight.enabled ?? true, ...spec.daylight } } : {}),
        ...(spec.reflectances !== undefined ? { reflectances: spec.reflectances } : {}),
      },
    });
    return result as T;
  },

  /**
   * Runs a CIE Sky Dome + Direct Solar daylighting & Daylight Factor (`DF%`) study across
   * active spaces/rooms on the script's live working model, including 4-bounce diffuse
   * patch radiosity and exact glazing `T_vis` transmission through windows & curtain walls.
   */
  runDaylightAnalysis<T = unknown>(ctx: ScriptContext, spec: DaylightAnalysisSpec = {}): T {
    const {
      skyModel = "cie_overcast",
      outdoorHorizontalFc = 1000,
      sunAzimuthDeg,
      sunElevationDeg,
      directSunNormalFc,
      includeElectric = false,
      ...base
    } = spec;
    return electrical.runPhotometrics<T>(ctx, {
      ...base,
      daylight: {
        enabled: true,
        skyModel,
        outdoorHorizontalFc,
        ...(sunAzimuthDeg !== undefined ? { sunAzimuthDeg } : {}),
        ...(sunElevationDeg !== undefined ? { sunElevationDeg } : {}),
        ...(directSunNormalFc !== undefined ? { directSunNormalFc } : {}),
        includeElectric,
      },
    });
  },

  /**
   * Exports the script's live working model into standard LBNL Radiance text files
   * (`materialsRad`, `geometryRad`, `luminairesRad`, `skyRad`, `sensorGridPts`, `iesFiles`,
   * and copy-paste `oconv`/`rtrace`/`rpict`/`evalglare` CLI commands).
   */
  exportRadiance<T = unknown>(ctx: ScriptContext, spec: RadianceExportSpec = {}): T {
    const gridSpacingFt = asFt(spec.gridSpacing);
    const workplaneHeightIn = asIn(spec.workplaneHeight);
    return ctx.read<T>("electrical.export_radiance", {
      ...(spec.skyModel !== undefined ? { skyModel: spec.skyModel } : {}),
      ...(spec.sunAzimuthDeg !== undefined ? { sunAzimuthDeg: spec.sunAzimuthDeg } : {}),
      ...(spec.sunElevationDeg !== undefined ? { sunElevationDeg: spec.sunElevationDeg } : {}),
      ...(spec.includeLuminaires !== undefined ? { includeLuminaires: spec.includeLuminaires } : {}),
      ...(gridSpacingFt !== undefined ? { gridSpacingFt } : {}),
      ...(workplaneHeightIn !== undefined ? { workplaneHeightIn } : {}),
    });
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

  /**
   * Places a local disconnect switch within sight of a piece of HVAC/motor equipment
   * (NEC 440.14 / 430.102) and routes power inline (`panel -> disconnect -> equipment`),
   * preserving the existing upstream circuit's breaker positions and ratings.
   */
  insertDisconnect(ctx: ScriptContext, equipmentRef: PlacedPart | string, spec: InsertDisconnectSpec = {}): InsertDisconnectResult {
    const refId = typeof equipmentRef === "string" ? equipmentRef : equipmentRef.id;
    const found = onWorking(ctx, "electrical.insertDisconnect", (m) => {
      const parts = elementsOfKind(m.elements, "part");
      const part: PartInstance | undefined =
        parts.find((p) => p.id === refId) ??
        parts.find((p) => p.mark.trim().toLowerCase() === refId.trim().toLowerCase());
      if (!part) throw new Error(`Equipment "${refId}" was not found in the model.`);
      const links = elementsOfKind(m.elements, "service_link");
      const upstream: ServiceLink | undefined = links.find((l) => l.members.some((mem) => mem.elementId === part.id));
      const ratingA = spec.ratingA ?? upstream?.electrical?.ratingA ?? 30;
      const typeId =
        spec.typeId ??
        (spec.fused
          ? ratingA > 60
            ? "builtin:disconnect-fused-100-480@1"
            : "builtin:disconnect-fused-60-480@1"
          : ratingA > 30
            ? "builtin:disconnect-nf-60-480@1"
            : "builtin:disconnect-nf-30-480@1");
      const inModel = m.elements[typeId]?.kind === "part_type";
      const libraryDef = inModel ? undefined : builtinPartType(typeId)?.definition;
      return { part, upstream, ratingA, typeId, libraryDef };
    });

    const slug = (found.part.mark.trim() || found.part.id).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "eq";
    const disconnectId = spec.disconnectId ?? `disc-${slug}`;
    const mark = spec.mark ?? `SD-${found.part.mark.trim() || found.part.id}`;
    const dx = spec.offset?.x !== undefined ? asMm(spec.offset.x) : -900;
    const dy = spec.offset?.y !== undefined ? asMm(spec.offset.y) : 0;
    const offsetMm = spec.height !== undefined ? asMm(spec.height) : found.part.offsetMm || 1200;

    ctx.edit({
      type: "place_part",
      partId: disconnectId,
      typeId: found.typeId,
      ...(found.libraryDef ? { partType: found.libraryDef } : {}),
      levelId: found.part.levelId,
      position: { x: Math.round(found.part.position.x + dx), y: Math.round(found.part.position.y + dy) },
      offsetMm: Math.round(offsetMm),
      mark,
    });

    let upstreamLinkId: string | null = null;
    if (found.upstream) {
      if (found.upstream.members.length === 1) {
        // Disconnect switches require their own dedicated feeder link (cannot share a circuit
        // with the downstream load), so replace the single-member link with the same ID,
        // source, breaker positions, and electrical rating pointing at the disconnect.
        upstreamLinkId = found.upstream.id;
        ctx.edit({
          type: "delete_elements",
          ids: [found.upstream.id],
          policy: "cascade",
        });
        ctx.edit({
          type: "create_service_link",
          linkId: upstreamLinkId,
          sourceId: found.upstream.source.elementId,
          ...(found.upstream.source.positions.length > 0 ? { positions: [...found.upstream.source.positions] } : {}),
          members: [{ elementId: disconnectId }],
          ...(found.upstream.description ? { description: found.upstream.description } : {}),
          ...(found.upstream.electrical ? { electrical: found.upstream.electrical } : { electrical: { ratingA: found.ratingA } }),
        });
      } else {
        // Multi-member branch circuit: pull the equipment off the shared circuit and feed the
        // disconnect on a dedicated feeder from the same source.
        ctx.edit({
          type: "remove_link_members",
          linkId: found.upstream.id,
          elementIds: [found.part.id],
        });
        upstreamLinkId = `ckt-${found.upstream.source.elementId}-to-${disconnectId}`;
        ctx.edit({
          type: "create_service_link",
          linkId: upstreamLinkId,
          sourceId: found.upstream.source.elementId,
          ...(spec.positions ? { positions: [...spec.positions] } : {}),
          members: [{ elementId: disconnectId }],
          description: `${found.part.mark || found.part.id} (via ${mark})`,
          electrical: { ratingA: found.ratingA },
        });
      }
    } else if (spec.sourceId) {
      upstreamLinkId = `ckt-${spec.sourceId}-to-${disconnectId}`;
      ctx.edit({
        type: "create_service_link",
        linkId: upstreamLinkId,
        sourceId: spec.sourceId,
        ...(spec.positions ? { positions: [...spec.positions] } : {}),
        members: [{ elementId: disconnectId }],
        description: `${found.part.mark || found.part.id} (via ${mark})`,
        electrical: { ratingA: found.ratingA },
      });
    }

    const downstreamLinkId = spec.downstreamLinkId ?? `ckt-${disconnectId}-to-${slug}`;
    ctx.edit({
      type: "create_service_link",
      linkId: downstreamLinkId,
      sourceId: disconnectId,
      members: [{ elementId: found.part.id }],
      description: `${found.part.mark || found.part.id} local feed`,
      electrical: { ratingA: found.ratingA },
    });

    return {
      disconnectId,
      mark,
      typeId: found.typeId,
      upstreamLinkId,
      downstreamLinkId,
    };
  },

  /**
   * Removes an inline local disconnect switch feeding a piece of equipment and restores
   * direct feed from its upstream panel circuit (preserving breaker positions and ratings).
   */
  removeDisconnect(ctx: ScriptContext, equipmentRef: PlacedPart | string): { readonly removedDisconnectId: string; readonly restoredLinkId: string | null } {
    const refId = typeof equipmentRef === "string" ? equipmentRef : equipmentRef.id;
    const found = onWorking(ctx, "electrical.removeDisconnect", (m) => {
      const parts = elementsOfKind(m.elements, "part");
      const part =
        parts.find((p) => p.id === refId) ??
        parts.find((p) => p.mark.trim().toLowerCase() === refId.trim().toLowerCase());
      if (!part) throw new Error(`Equipment "${refId}" was not found in the model.`);
      const links = elementsOfKind(m.elements, "service_link");
      const downstream = links.find((l) => l.members.some((mem) => mem.elementId === part.id));
      if (!downstream) throw new Error(`Equipment "${part.mark || part.id}" is not fed from a local disconnect.`);
      const disc = m.elements[downstream.source.elementId];
      const discType = disc?.kind === "part" ? m.elements[disc.typeId] : undefined;
      if (disc?.kind !== "part" || discType?.kind !== "part_type" || !/disconnect/i.test(discType.definition.familyName)) {
        throw new Error(`Equipment "${part.mark || part.id}" is fed directly, not through a local disconnect switch.`);
      }
      const upstream = links.find((l) => l.members.some((mem) => mem.elementId === disc.id)) ?? null;
      return { part, disc, downstream, upstream };
    });

    ctx.edit({
      type: "delete_elements",
      ids: [found.downstream.id, found.disc.id, ...(found.upstream ? [found.upstream.id] : [])],
      policy: "cascade",
    });
    let restoredLinkId: string | null = null;
    if (found.upstream) {
      restoredLinkId = ctx.id("ckt");
      ctx.edit({
        type: "create_service_link",
        linkId: restoredLinkId,
        sourceId: found.upstream.source.elementId,
        ...(found.upstream.source.positions.length > 0 ? { positions: [...found.upstream.source.positions] } : {}),
        members: [{ elementId: found.part.id }],
        ...(found.upstream.description ? { description: found.upstream.description } : {}),
        ...(found.upstream.electrical ? { electrical: found.upstream.electrical } : {}),
      });
    }
    return { removedDisconnectId: found.disc.id, restoredLinkId };
  },

  /**
   * Marks whether a piece of equipment requires a local disconnect switch (e.g. set `required: false`
   * when the unit has a factory-installed integral disconnect or lockable breaker per NEC 430.102(B)).
   */
  setDisconnectRequirement(
    ctx: ScriptContext,
    equipmentRef: PlacedPart | string,
    required: boolean,
    reason?: string,
  ): { readonly equipmentId: string; readonly disconnectRequired: boolean } {
    const refId = typeof equipmentRef === "string" ? equipmentRef : equipmentRef.id;
    const partId = onWorking(ctx, "electrical.setDisconnectRequirement", (m) => {
      const parts = elementsOfKind(m.elements, "part");
      const part =
        parts.find((p) => p.id === refId) ??
        parts.find((p) => p.mark.trim().toLowerCase() === refId.trim().toLowerCase());
      if (!part) throw new Error(`Equipment "${refId}" was not found in the model.`);
      return part.id;
    });
    ctx.edit({
      type: "set_element_values",
      elementIds: [partId],
      values: {
        "electrical.disconnect_required": required,
        "electrical.local_disconnect": required ? "required" : "not_required",
        ...(reason ? { "electrical.disconnect_note": reason } : {}),
      },
    });
    return { equipmentId: partId, disconnectRequired: required };
  },
};
