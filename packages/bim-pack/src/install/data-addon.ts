/**
 * A data add-on (D5's `data` tier): an add-on that is rows only, as one JSON
 * document inside a package (`contents[].type === "addon"`). Nothing in it
 * runs: every row is plain JSON, contributed to an extension point whose rows
 * are data (`DATA_ADDON_POINTS`), then put through the same contract checks
 * and conformance suite every first-party pack passes. That is the whole
 * install path: no kernel edit makes an outside data add-on work.
 *
 * Stored shape (`format: "mutinybim-addon"`, `formatVersion: 1`), forever
 * after the release: a newer format version or an unknown field is refused in
 * words or kept, never misread.
 */
import {
  CLASS_POINT,
  CLASSIFICATION_POINT,
  PARAMETER_SET_POINT,
  PIPE_MATERIAL_POINT,
  SURFACE_ROLE_POINT,
  ZONE_PURPOSE_POINT,
  canonicalize,
  CanonicalJsonError,
} from "@permitzip/bim-kernel";
import { PackDefinitionError, definePack, manifestProblems, type ErasedContribution, type Pack, type PackManifest, type PackRequirement, PACK_TIERS, type PackTier } from "@permitzip/bim-kernel/packs";

export const DATA_ADDON_FORMAT = "mutinybim-addon";
export const DATA_ADDON_FORMAT_VERSION = 1;

/** A point a data add-on may contribute to: its rows are plain data its readers never call. */
export interface DataAddonPoint {
  readonly id: string;
  readonly version: number;
  readonly label: string;
  readonly idOf: ((item: unknown) => string) | null;
  readonly namespaced: boolean;
}

function dataPoint<T>(point: { readonly id: string; readonly version: number; readonly label: string; readonly idOf?: (item: T) => string; readonly namespaced?: boolean }): DataAddonPoint {
  const idOf = point.idOf;
  return {
    id: point.id,
    version: point.version,
    label: point.label,
    // Called only on rows already checked to be plain objects; a missing id reads as "" and is refused by the contract check.
    idOf: idOf ? (item: unknown) => String(idOf(item as T) ?? "") : null,
    namespaced: point.namespaced ?? Boolean(idOf),
  };
}

/**
 * Points whose rows are data (classes, parameter sets, zone purposes, surface
 * roles, pipe materials, classification systems). Additive: a point joins
 * when its rows carry no function its readers call. A row for any other point
 * is code and needs the code tier.
 */
export const DATA_ADDON_POINTS: readonly DataAddonPoint[] = [
  dataPoint(CLASS_POINT),
  dataPoint(PARAMETER_SET_POINT),
  dataPoint(ZONE_PURPOSE_POINT),
  dataPoint(SURFACE_ROLE_POINT),
  dataPoint(PIPE_MATERIAL_POINT),
  dataPoint(CLASSIFICATION_POINT),
];

/** One point's rows in the document. */
export interface DataAddonContribution {
  readonly point: string;
  readonly version: number;
  readonly items: readonly unknown[];
}

/** The add-on document a package carries (`addons/<name>.json`). */
export interface DataAddonDocument {
  readonly format: typeof DATA_ADDON_FORMAT;
  readonly formatVersion: number;
  /** `data` (rows only) or `code` (it names a module to run). */
  readonly tier: PackTier;
  readonly manifest: PackManifest;
  readonly contributions: readonly DataAddonContribution[];
  /** Code tier only: the module the host would run. Never read for data. */
  readonly main?: string;
}

export type DataAddonRead =
  | { readonly ok: true; readonly tier: PackTier; readonly manifest: PackManifest; readonly document: DataAddonDocument }
  | { readonly ok: false; readonly problems: readonly string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRequires(value: unknown, problems: string[]): PackRequirement[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    problems.push("manifest.requires must be a list of { id, range }");
    return undefined;
  }
  const out: PackRequirement[] = [];
  for (const r of value) {
    if (isRecord(r) && typeof r.id === "string" && typeof r.range === "string") out.push({ id: r.id, range: r.range });
    else problems.push("each of manifest.requires must be { id, range }");
  }
  return out;
}

/** Tolerant read of an add-on document's shape (tier, manifest, contributions). Refuses, in words, what can't be one. */
export function readDataAddonDocument(value: unknown): DataAddonRead {
  if (!isRecord(value)) return { ok: false, problems: ["The add-on file isn't a JSON object."] };
  if (value.format !== DATA_ADDON_FORMAT) return { ok: false, problems: [`The add-on file's format is "${String(value.format)}", not "${DATA_ADDON_FORMAT}".`] };
  if (typeof value.formatVersion !== "number" || !Number.isInteger(value.formatVersion) || value.formatVersion < 1) return { ok: false, problems: ["The add-on file has no format version."] };
  if (value.formatVersion > DATA_ADDON_FORMAT_VERSION) return { ok: false, problems: [`The add-on file uses format version ${value.formatVersion}; this release reads version ${DATA_ADDON_FORMAT_VERSION}. Update MutinyBIM, or ask the publisher for a version ${DATA_ADDON_FORMAT_VERSION} file.`] };
  const tier: PackTier = typeof value.tier === "string" && value.tier !== "" ? value.tier : "data";
  const m = value.manifest;
  if (!isRecord(m)) return { ok: false, problems: ["The add-on file has no manifest."] };
  const problems: string[] = [];
  for (const key of ["id", "name", "version", "kernel"] as const) if (typeof m[key] !== "string") problems.push(`manifest.${key} must be text`);
  if (m.firstParty !== undefined) problems.push("an outside add-on can't call itself first-party (manifest.firstParty)");
  const requires = readRequires(m.requires, problems);
  if (!Array.isArray(value.contributions)) problems.push("contributions must be a list");
  if (problems.length > 0) return { ok: false, problems };
  const manifest: PackManifest = {
    id: String(m.id),
    name: String(m.name),
    version: String(m.version),
    kernel: String(m.kernel),
    ...(typeof m.description === "string" ? { description: m.description } : {}),
    ...(requires ? { requires } : {}),
  };
  const contributions: DataAddonContribution[] = [];
  for (const c of value.contributions as unknown[]) {
    if (isRecord(c) && typeof c.point === "string" && typeof c.version === "number" && Array.isArray(c.items)) contributions.push({ point: c.point, version: c.version, items: c.items });
    else return { ok: false, problems: ["each contribution must be { point, version, items: [...] }"] };
  }
  return {
    ok: true,
    tier,
    manifest,
    document: { format: DATA_ADDON_FORMAT, formatVersion: value.formatVersion, tier, manifest, contributions, ...(typeof value.main === "string" ? { main: value.main } : {}) },
  };
}

export type DataAddonBuild = { readonly ok: true; readonly pack: Pack } | { readonly ok: false; readonly problems: readonly string[] };

/**
 * The pack a data add-on document builds: every row plain JSON, at a data
 * point this release reads at the same major, ids in the add-on's namespace
 * (`definePack`). Lists every problem. Code-tier documents are refused here:
 * nothing in this path runs code.
 */
export function buildDataAddon(document: DataAddonDocument, points: readonly DataAddonPoint[] = DATA_ADDON_POINTS): DataAddonBuild {
  const { manifest } = document;
  if (document.tier !== "data") {
    const known = (PACK_TIERS as readonly string[]).includes(document.tier);
    return { ok: false, problems: [known ? `${manifest.name} runs code (tier "${document.tier}"); only data add-ons build here.` : `${manifest.name} asks for trust tier "${document.tier}", which this release doesn't know.`] };
  }
  const problems: string[] = [...manifestProblems(manifest)];
  const contributions: ErasedContribution[] = [];
  for (const c of document.contributions) {
    const point = points.find((p) => p.id === c.point);
    if (!point) {
      problems.push(`${manifest.name} adds rows to "${c.point}", which isn't a data point; rows there need code. Data add-ons may add: ${points.map((p) => p.label.toLowerCase()).join(", ")}.`);
      continue;
    }
    if (point.version !== c.version) {
      problems.push(`${manifest.name} was written for ${point.label} v${c.version}; this release reads v${point.version}.`);
      continue;
    }
    let rowsOk = true;
    c.items.forEach((item, i) => {
      if (!isRecord(item)) {
        problems.push(`${point.label} row ${i + 1} isn't an object.`);
        rowsOk = false;
        return;
      }
      try {
        canonicalize(item);
      } catch (err) {
        if (!(err instanceof CanonicalJsonError)) throw err;
        problems.push(`${point.label} row ${i + 1} isn't plain data: ${err.message}.`);
        rowsOk = false;
      }
    });
    if (!rowsOk) continue;
    contributions.push({ pointId: point.id, pointVersion: point.version, pointLabel: point.label, items: c.items, idOf: point.idOf, namespaced: point.namespaced });
  }
  if (problems.length > 0) return { ok: false, problems: [...new Set(problems)] };
  try {
    return { ok: true, pack: definePack(manifest, contributions) };
  } catch (err) {
    if (err instanceof PackDefinitionError) return { ok: false, problems: [...err.problems] };
    console.error("[bim-pack/install] building a data add-on threw", { addon: manifest.id, err });
    return { ok: false, problems: [`${manifest.name} couldn't be read: ${err instanceof Error ? err.message : String(err)}`] };
  }
}
