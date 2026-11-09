import { GLOBAL_LEVEL, hasPartitionLevel, partitionMembers } from "./partition";
import { elementValues } from "./store";
import type { Level, ModelState } from "./types";

/**
 * Which model levels a view's level means. A plan names its level by what the
 * person picked: often the linked model's storey ("LEVEL 1", "01 - Level 1"),
 * while ductwork routed here belongs to the model level someone added
 * ("Level 1"). Elements carry their level's name in their partition, so a
 * view resolves its level to every model level that is the same floor: the
 * same name ignoring case, punctuation and leading zeros, or the same floor
 * elevation when the view knows it.
 */

/** Floors closer than this are the same floor (a linked storey's elevation is rounded to the export's unit). */
const SAME_FLOOR_MM = 5;

/** "LEVEL 01", "Level 1" and "level-1" all read "level1". */
export function normalizeLevelName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b0+(\d)/g, "$1")
    .replace(/ /g, "");
}

type LevelSource = Pick<ModelState, "elements"> & Partial<Pick<ModelState, "connections">>;

/** The model's level elements. They live in the global partition, read through the shared partition index when the model has one. */
export function modelLevels(model: LevelSource): Level[] {
  const all = model.connections ? partitionMembers({ elements: model.elements, connections: model.connections }, (p) => p.level === GLOBAL_LEVEL) : elementValues(model.elements);
  return all.filter((el): el is Level => el.kind === "level");
}

/** Does a model level name the same floor as a view's level? */
export function sameFloor(level: Pick<Level, "name" | "elevationMm">, viewLevel: string, viewElevationMm: number | undefined): boolean {
  if (level.name === viewLevel || normalizeLevelName(level.name) === normalizeLevelName(viewLevel)) return true;
  return viewElevationMm !== undefined && Math.abs(level.elevationMm - viewElevationMm) < SAME_FLOOR_MM;
}

/**
 * Partition level names that belong to a view's level: the name itself plus
 * every model level on the same floor. Null when the view has no level (it
 * shows every level).
 */
export function viewLevelNames(model: LevelSource, level: string | undefined, elevationMm?: number): ReadonlySet<string> | null {
  if (!level) return null;
  const levels = modelLevels(model);
  const byId = levelById(levels, level);
  const name = byId?.name ?? level;
  const floorMm = elevationMm ?? byId?.elevationMm;
  const names = new Set<string>([name]);
  for (const l of levels) if (sameFloor(l, name, floorMm)) names.add(l.name);
  return names;
}

/**
 * The level a view's stored level means when it is a level's id rather than its
 * name (a script or agent that named the level it made by id). Views store the
 * name (`canonicalViewLevel`); older views stored the id, and still read right.
 */
function levelById(levels: readonly Level[], ref: string): Level | undefined {
  return levels.some((l) => l.name === ref) ? undefined : levels.find((l) => l.id === ref);
}

/** A view's level as views store it: the level's name when the reference is a model level's id, else as given. */
export function canonicalViewLevel(model: LevelSource, level: string | undefined): string | undefined {
  if (!level) return level;
  return levelById(modelLevels(model), level)?.name ?? level;
}

/** The item named for a view's level: the exact name, else the same name ignoring case, punctuation and leading zeros. */
export function findLevelByName<T extends { readonly name: string }>(items: readonly T[], level: string): T | undefined {
  const wanted = normalizeLevelName(level);
  return items.find((l) => l.name === level) ?? items.find((l) => normalizeLevelName(l.name) === wanted);
}

/** A level reference that matched no single level, with the levels it could have meant. */
export interface LevelRefMiss<T> {
  readonly ok: false;
  readonly reason: "unknown" | "ambiguous";
  readonly ref: string;
  /** ambiguous: the levels sharing the name. unknown: every level, closest name first. */
  readonly candidates: readonly T[];
  /** Plain words naming the candidates (no host's tool names). */
  readonly message: string;
}

export type LevelRef<T> = { readonly ok: true; readonly level: T } | LevelRefMiss<T>;

type NamedLevel = { readonly id: string; readonly name: string };

const MAX_LISTED = 12;

function listed(levels: readonly NamedLevel[]): string {
  const shown = levels.slice(0, MAX_LISTED).map((l) => (l.id === l.name ? l.name : `${l.name} (${l.id})`));
  return `${shown.join(", ")}${levels.length > MAX_LISTED ? ` and ${levels.length - MAX_LISTED} more` : ""}`;
}

/** Edit distance between two short names (level names are a few characters). */
function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length] ?? 0;
}

/**
 * The one rule for a level as a person or an agent names it: its id; else its
 * name when exactly one level has it, exact first, then ignoring case,
 * punctuation and leading zeros ("LEVEL 01" finds "Level 1"). Two levels with
 * the name, or none, is a miss that names the candidates, never a silent
 * empty match.
 */
export function resolveLevelRef<T extends NamedLevel>(levels: readonly T[], ref: string): LevelRef<T> {
  const wanted = ref.trim();
  const byId = levels.find((l) => l.id === wanted);
  if (byId) return { ok: true, level: byId };
  const exact = levels.filter((l) => l.name === wanted);
  const key = normalizeLevelName(wanted);
  const named = exact.length > 0 ? exact : key ? levels.filter((l) => normalizeLevelName(l.name) === key) : [];
  const [only] = named;
  if (only && named.length === 1) return { ok: true, level: only };
  if (named.length > 1) return { ok: false, reason: "ambiguous", ref: wanted, candidates: named, message: `${named.length} levels are called "${wanted}" (${listed(named)}); give the level id.` };
  const candidates = [...levels].sort((a, b) => distance(normalizeLevelName(a.name), key) - distance(normalizeLevelName(b.name), key));
  const message = candidates.length > 0 ? `No level "${wanted}" in this model. Levels: ${listed(candidates)}.` : `No level "${wanted}" in this model. It has no levels yet; create one first.`;
  return { ok: false, reason: "unknown", ref: wanted, candidates, message };
}

/** A model area's level, by reference: the level element, or a partition level name elements sit on that no level element carries (older and generated models). */
export type ModelLevelRef = { readonly ok: true; readonly name: string; readonly level: Level | null } | LevelRefMiss<Level>;

/**
 * resolveLevelRef over the model's levels, for filters and areas that match
 * by the canonical level name. A name no level element has still counts when
 * elements sit on it exactly (a model whose areas predate level elements).
 */
export function resolveModelLevel(model: Pick<ModelState, "elements" | "connections">, ref: string): ModelLevelRef {
  const found = resolveLevelRef(modelLevels(model), ref);
  if (found.ok) return { ok: true, name: found.level.name, level: found.level };
  const wanted = ref.trim();
  if (found.reason === "unknown" && wanted && hasPartitionLevel(model, wanted)) return { ok: true, name: wanted, level: null };
  return found;
}

/** The model level a view draws its floor from: same name, else same floor elevation, else none. */
export function viewModelLevel(model: LevelSource, level: string | undefined, elevationMm?: number): Level | null {
  if (!level) return null;
  const levels = modelLevels(model);
  return findLevelByName(levels, level) ?? levelById(levels, level) ?? levels.find((l) => sameFloor(l, level, elevationMm)) ?? null;
}

/**
 * Floor elevation a view stands on: the same-floor model level's (where its
 * ductwork is drawn from), else the elevation the view saved, else null.
 * The drawing engine and the live canvas both cut from this.
 */
export function viewFloorMm(model: LevelSource, level: string | undefined, elevationMm?: number): number | null {
  return viewModelLevel(model, level, elevationMm)?.elevationMm ?? elevationMm ?? null;
}
