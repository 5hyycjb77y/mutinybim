/**
 * Measure a BuildingProfile from private IFC files: counts only.
 *
 * Reads a linked architect's IFC (and optionally the MEP host's element count)
 * on this machine and prints a profile: storeys, typical floor-to-floor,
 * footprint, products per storey by IFC class (the median storey), and the
 * file's size. Names, ids, properties and geometry never leave the machine;
 * the output is safe to commit as fixtures/mutinybim/profiles/<slug>.json.
 *
 * Client files stay out of the repository and out of public CI artifacts: run
 * this on a laptop with the file downloaded to a temporary folder, or in a
 * private CI job that fetches it from private storage with existing secrets.
 *
 *   node --import tsx scripts/perf/mutinybim/extract-building-profile.ts --ifc=/tmp/arch.ifc --name=tower-14 [--mep-elements=142000] > profile.json
 */
import { readFileSync, statSync } from "node:fs";
import * as WebIFC from "web-ifc";
import { buildingProfileSchema, type BuildingProfile } from "./building-profile";

const arg = (name: string, fallback = ""): string => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=") ?? fallback;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function quantile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))] ?? 0;
}

/** Length unit of the file, in metres (SI with prefix, or a foot/inch conversion unit). */
function lengthUnitMetres(api: WebIFC.IfcAPI, modelId: number): number {
  const conversion = api.GetLineIDsWithType(modelId, WebIFC.IFCCONVERSIONBASEDUNIT);
  for (let i = 0; i < conversion.size(); i++) {
    const unit: unknown = api.GetLine(modelId, conversion.get(i));
    const name = typeof unit === "object" && unit !== null && "Name" in unit && typeof unit.Name === "object" && unit.Name !== null && "value" in unit.Name ? String(unit.Name.value).toUpperCase() : "";
    if (name === "FOOT") return 0.3048;
    if (name === "INCH") return 0.0254;
  }
  const si = api.GetLineIDsWithType(modelId, WebIFC.IFCSIUNIT);
  for (let i = 0; i < si.size(); i++) {
    const unit: unknown = api.GetLine(modelId, si.get(i));
    if (typeof unit !== "object" || unit === null || !("UnitType" in unit) || !("Prefix" in unit)) continue;
    const type = typeof unit.UnitType === "object" && unit.UnitType !== null && "value" in unit.UnitType ? String(unit.UnitType.value) : "";
    if (type !== "LENGTHUNIT") continue;
    const prefix = typeof unit.Prefix === "object" && unit.Prefix !== null && "value" in unit.Prefix ? String(unit.Prefix.value) : "";
    return prefix === "MILLI" ? 0.001 : prefix === "CENTI" ? 0.01 : 1;
  }
  return 1;
}

function refId(value: unknown): number | null {
  return typeof value === "object" && value !== null && "value" in value && typeof value.value === "number" ? value.value : null;
}

async function main(): Promise<void> {
  const file = arg("ifc");
  const name = arg("name");
  if (!file || !name) throw new Error("--ifc=<private IFC on this machine> and --name=<neutral slug> are required");
  const bytes = readFileSync(file);
  const api = new WebIFC.IfcAPI();
  await api.Init();
  const modelId = api.OpenModel(new Uint8Array(bytes), { COORDINATE_TO_ORIGIN: false });
  try {
    const toMetres = lengthUnitMetres(api, modelId);
    const toFt = toMetres / 0.3048;
    const storeyIds = api.GetLineIDsWithType(modelId, WebIFC.IFCBUILDINGSTOREY);
    const elevations = new Map<number, number>();
    for (let i = 0; i < storeyIds.size(); i++) {
      const id = storeyIds.get(i);
      const storey: unknown = api.GetLine(modelId, id);
      const elevation = typeof storey === "object" && storey !== null && "Elevation" in storey ? refId(storey.Elevation) : null;
      elevations.set(id, (elevation ?? 0) * toFt);
    }
    const perStorey = new Map<number, Record<string, number>>();
    const rels = api.GetLineIDsWithType(modelId, WebIFC.IFCRELCONTAINEDINSPATIALSTRUCTURE);
    for (let i = 0; i < rels.size(); i++) {
      const rel: unknown = api.GetLine(modelId, rels.get(i));
      if (typeof rel !== "object" || rel === null || !("RelatingStructure" in rel) || !("RelatedElements" in rel)) continue;
      const structure = refId(rel.RelatingStructure);
      if (structure === null || !elevations.has(structure) || !Array.isArray(rel.RelatedElements)) continue;
      const counts = perStorey.get(structure) ?? {};
      for (const element of rel.RelatedElements) {
        const id = refId(element);
        if (id === null) continue;
        const cls = api.GetNameFromTypeCode(api.GetLineType(modelId, id)).toUpperCase();
        counts[cls] = (counts[cls] ?? 0) + 1;
      }
      perStorey.set(structure, counts);
    }
    const populated = [...perStorey.entries()].filter(([, c]) => Object.values(c).reduce((a, b) => a + b, 0) > 0);
    const classes = new Set(populated.flatMap(([, c]) => Object.keys(c)));
    const perFloor: Record<string, number> = {};
    for (const cls of classes) perFloor[cls] = Math.round(median(populated.map(([, c]) => c[cls] ?? 0)));
    const sortedElevations = populated.map(([id]) => elevations.get(id) ?? 0).sort((a, b) => a - b);
    const gaps = sortedElevations.slice(1).map((e, i) => e - (sortedElevations[i] ?? 0)).filter((g) => g > 1);
    // Footprint from where placed elements sit (their placements; Revit exports place each element where it is), trimmed of outliers.
    const xs: number[] = [];
    const ys: number[] = [];
    api.StreamAllMeshes(modelId, (mesh) => {
      const placed = mesh.geometries;
      for (let i = 0; i < placed.size(); i++) {
        const m = placed.get(i).flatTransformation;
        // web-ifc hands geometry back Y-up in metres: plan x is x, plan y is -z.
        xs.push((m[12] ?? 0) / 0.3048);
        ys.push(-(m[14] ?? 0) / 0.3048);
      }
    });
    const span = (v: number[]) => Math.max(10, Math.round(quantile(v, 0.98) - quantile(v, 0.02)));
    const profile: BuildingProfile = buildingProfileSchema.parse({
      name,
      note: "Measured by extract-building-profile.ts. Statistics only.",
      provenance: { stats: "extracted", measuredOn: "private IFC (counts per storey, file size)", measuredAt: new Date().toISOString().slice(0, 10) },
      floors: Math.max(1, populated.length),
      floorToFloorFt: Math.round((gaps.length > 0 ? median(gaps) : 10) * 10) / 10,
      footprintFt: { x: span(xs), y: span(ys) },
      linked: { perFloor, ifcBytes: statSync(file).size },
      authored: { zonesPerFloor: Math.max(1, Math.round(Number(arg("mep-elements", "0")) / Math.max(1, populated.length) / 5086)) || 1, ...(arg("mep-elements") ? { measuredElements: Number(arg("mep-elements")) } : {}) },
    });
    process.stdout.write(`${JSON.stringify(profile, null, 2)}\n`);
  } finally {
    api.CloseModel(modelId);
  }
}

main().catch((err) => {
  console.error("[extract-building-profile] failed", err);
  process.exit(1);
});
