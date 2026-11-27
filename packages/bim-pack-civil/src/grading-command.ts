import { to } from "@permitzip/bim-units";
import { z } from "zod";
import { asElementId, draftElements, finish, guard, refuse, TrackedReader, type ElementId, type ExecuteResult, type ModelState, type PackCommand } from "@permitzip/bim-kernel";
import { defineCalc, type PackCommandDef } from "@permitzip/bim-pack/runtime";
import { TIN_PRISMOIDAL_VOLUME } from "./citations";
import { importLandXml } from "./landxml";
import { gradingSurfaceRecord, readGradingSurfaces, type GradingSurface } from "./surfaces";
import { cutFillBetween } from "./tin-volume";

/**
 * `civil.import_landxml_surfaces` writes one element per TIN. The mesh is the
 * element's own shape (`gradingSurfaceRecord`), not `set_element_values`:
 * a parameter value is a number, a flag or a string of at most 400 characters,
 * and the kernel has no terrain-mesh field. Peers that don't store add-on
 * shapes are refused by the kind row (`newForOlderPeers`) until they do.
 */

export const IMPORT_LANDXML_SURFACES = "civil.import_landxml_surfaces";

const surfaceRole = z.enum(["existing", "proposed"]);

export const importLandXmlCommandSchema = z
  .object({
    type: z.literal(IMPORT_LANDXML_SURFACES),
    landXml: z.string().trim().min(1).max(2_000_000),
    /** Role by surface name. Wins over a guess from the name. */
    roles: z.record(z.string().trim().min(1).max(120), surfaceRole).optional(),
  })
  .strict();

export type ImportLandXmlCommand = z.output<typeof importLandXmlCommandSchema>;

function executeImport(model: ModelState, command: PackCommand): ExecuteResult {
  const parsed = importLandXmlCommandSchema.safeParse(command);
  if (!parsed.success) refuse("invalid_value", "The LandXML import isn't valid. Give the LandXML text and, if you want, a role for each surface name.");
  const imported = importLandXml(parsed.data.landXml, parsed.data.roles ? { roles: parsed.data.roles } : {});
  if (imported.problems.length > 0) refuse("invalid_value", [...imported.problems, ...imported.notes].join(" "));
  const reader = new TrackedReader(model);
  const working = draftElements(model.elements);
  const touched: ElementId[] = [];
  for (const surface of imported.surfaces) {
    const id = asElementId(surface.id);
    if (working[id]) refuse("invalid_value", `${surface.name} would be saved as ${id}, which is already in the model. Rename the surface or remove that element, then import again.`, [id]);
    working[id] = gradingSurfaceRecord(id, surface);
    touched.push(id);
  }
  const names = imported.surfaces.map((s) => `${s.name} (${s.role === "unassigned" ? "role not set" : s.role})`).join(" and ");
  return finish(reader, working, touched, [], () => [], {
    summary: [`Imported ${names} from LandXML.`, ...imported.notes],
  });
}

export const IMPORT_LANDXML_SURFACES_COMMAND: PackCommandDef = {
  type: IMPORT_LANDXML_SURFACES,
  schema: importLandXmlCommandSchema,
  execute(model, command) {
    return guard(() => executeImport(model, command));
  },
};

export const surfaceCutFillInput = z
  .object({
    existingId: z.string().trim().min(1).max(200),
    proposedId: z.string().trim().min(1).max(200),
  })
  .strict();

export type SurfaceCutFillInput = z.output<typeof surfaceCutFillInput>;

const REVIEW = "A licensed civil engineer has not reviewed this volume. Don't use it for a permit or a bid until one has.";

function roleWarning(surface: GradingSurface, treatedAs: "existing" | "proposed"): string | null {
  if (surface.role === "unassigned" || surface.role === treatedAs) return null;
  return `${surface.name} is marked ${surface.role} ground, but this calc treats it as the ${treatedAs} surface.`;
}

function fmt(n: number, digits: number): string {
  return n.toFixed(digits);
}

/**
 * Cut and fill for two grading surfaces already in the model. The geometry
 * is `cutFillBetween`; this is the calc the registry runs, with both units
 * a grading takeoff is read in.
 */
export const SURFACE_CUT_FILL_CALC = defineCalc({
  id: "civil.surface_cut_fill",
  version: "1.0.0",
  domain: "civil",
  title: "TIN cut and fill",
  summary: "Cut, fill and net between an existing TIN and a proposed TIN over the ground both cover. Prismoidal volume on the composite triangles: plan area times the mean of the three corner height differences. Reports cubic yards and cubic metres.",
  codeFamily: null,
  needsModel: true,
  input: surfaceCutFillInput,
  example: { existingId: "gs-existing", proposedId: "gs-proposed" },
  run(input, ctx) {
    const review = { severity: "info" as const, message: REVIEW, cite: [TIN_PRISMOIDAL_VOLUME] };
    if (!ctx.model) {
      return { values: [], steps: [], issues: [{ severity: "error", message: "Cut and fill reads the model's grading surfaces. Open a model first.", cite: [] }], detail: null };
    }
    if (input.existingId === input.proposedId) {
      return { values: [], steps: [], issues: [{ severity: "error", message: "Pick two different surfaces. Cut and fill compares existing ground to proposed ground.", cite: [] }, review], detail: null };
    }
    const { surfaces, problems } = readGradingSurfaces(ctx.model.elements);
    const existing = surfaces.find((s) => s.id === input.existingId);
    const proposed = surfaces.find((s) => s.id === input.proposedId);
    const missing = [
      existing ? null : `There's no grading surface ${input.existingId} in this model. Import the LandXML first.`,
      proposed ? null : `There's no grading surface ${input.proposedId} in this model. Import the LandXML first.`,
    ].filter((m): m is string => m !== null);
    if (!existing || !proposed) {
      return { values: [], steps: [], issues: [...missing.map((message) => ({ severity: "error" as const, message, cite: [] as [] })), ...problems.map((message) => ({ severity: "warning" as const, message, cite: [] as [] })), review], detail: null };
    }
    const result = cutFillBetween(existing, proposed);
    const cutYd3 = to(result.cut, "yd3");
    const fillYd3 = to(result.fill, "yd3");
    const netYd3 = to(result.net, "yd3");
    const cutM3 = to(result.cut, "m3");
    const fillM3 = to(result.fill, "m3");
    const netM3 = to(result.net, "m3");
    const overlapFt2 = to(result.overlapArea, "ft2");
    const overlapM2 = to(result.overlapArea, "m2");
    const warnings = [...result.issues, roleWarning(existing, "existing"), roleWarning(proposed, "proposed")].filter((m): m is string => m !== null);
    const netWords = netYd3 > 0 ? "net fill, haul in" : netYd3 < 0 ? "net cut, haul off" : "balanced";
    return {
      values: [
        { key: "cut_yd3", label: "Cut", value: cutYd3, unit: "yd3", cite: [TIN_PRISMOIDAL_VOLUME] },
        { key: "fill_yd3", label: "Fill", value: fillYd3, unit: "yd3", cite: [TIN_PRISMOIDAL_VOLUME] },
        { key: "net_yd3", label: "Net (fill − cut)", value: netYd3, unit: "yd3", cite: [TIN_PRISMOIDAL_VOLUME] },
        { key: "cut_m3", label: "Cut", value: cutM3, unit: "m3", cite: [TIN_PRISMOIDAL_VOLUME] },
        { key: "fill_m3", label: "Fill", value: fillM3, unit: "m3", cite: [TIN_PRISMOIDAL_VOLUME] },
        { key: "net_m3", label: "Net (fill − cut)", value: netM3, unit: "m3", cite: [TIN_PRISMOIDAL_VOLUME] },
        { key: "overlap_area_ft2", label: "Overlap area", value: overlapFt2, unit: "ft2", cite: [] },
        { key: "overlap_area_m2", label: "Overlap area", value: overlapM2, unit: "m2", cite: [] },
      ],
      steps: [
        { label: "Surfaces", detail: `${existing.name} (${existing.linearUnit}, from ${existing.sourceLinearUnit}) against ${proposed.name} (${proposed.linearUnit}, from ${proposed.sourceLinearUnit}).`, cite: [] },
        { label: "Overlap", detail: `Both surfaces cover ${fmt(overlapFt2, 2)} ft² (${fmt(overlapM2, 3)} m²). Ground only one of them covers is not in the volume.`, cite: [TIN_PRISMOIDAL_VOLUME] },
        {
          label: "Cut and fill",
          detail: `V = A·(Δz1+Δz2+Δz3)/3 on each overlay triangle, Δz = proposed − existing. Cut ${fmt(cutYd3, 3)} yd³ (${fmt(cutM3, 3)} m³), fill ${fmt(fillYd3, 3)} yd³ (${fmt(fillM3, 3)} m³), net ${fmt(netYd3, 3)} yd³ (${netWords}).`,
          cite: [TIN_PRISMOIDAL_VOLUME],
        },
      ],
      issues: [...warnings.map((message) => ({ severity: "warning" as const, message, cite: [TIN_PRISMOIDAL_VOLUME] })), review],
      detail: result,
    };
  },
});
