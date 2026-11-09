import { z } from "zod";
import { round } from "../geometry";
import { TrackedReader } from "../model";
import { GLOBAL_PARTITION } from "../partition";
import { draftElements, elementValues } from "../store";
import { modelLevels, normalizeLevelName } from "../levels";
import { asElementId, type BimElement, type ElementId, type Level, type LevelSource, type ModelState } from "../types";
import { feetInches } from "../drawing/sheet";
import { tiedHeightMm, tiedToAny, topTieOf, withTiedHeight } from "../placement/top-tie";
import { finish, guard, refuse, type AuthoredWrite, type ExecuteResult, type IntentPredicate } from "../command-core";
import { peerReads } from "../elements/feature";

/** How a refusal names an element: its kind and id (wall arch-wall-3). */
const elementLabel = (el: BimElement): string => `${el.kind.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())} ${el.id}`;

/**
 * Level commands beyond create_level (part-commands.ts):
 *
 * - update_level: rename a level and/or move its elevation. Everything on the
 *   level goes with it (parts and runs store their heights relative to it),
 *   and every element, plan and schedule that names the level follows a
 *   rename.
 * - sync_levels: make the model's levels match a linked model's storeys in
 *   one change. A storey already made into a level updates it (moved or
 *   renamed by the architect); a level a person made for the same floor (same
 *   name, or same elevation) is matched and keeps its name; anything else is
 *   added. Nothing is deleted. Sending the same storeys again changes nothing.
 *
 * - ensure_starter_level: an empty model (no levels at all) gets "Level 1" at
 *   elevation 0, so a person can draw the moment it opens. The id is fixed,
 *   so two people opening the same empty model at once, or a reconnect
 *   resending it, make one level; a model that has any level refuses it.
 *   The level is an ordinary level (rename, move, delete once another
 *   exists); `starter` only says nobody has made it theirs yet, and a sync
 *   with a linked model turns an empty starter into the architect's floor.
 *
 * `planLevelSync` is what both the command and every preview (the dialog, the
 * agent's list) read, so what a person sees is what the command does.
 */

/** Floors closer than this are the same floor (levels.ts uses the same tolerance for views). */
const SAME_FLOOR_MM = 5;
/** Changes smaller than this are not moves (a storey's elevation is rounded to its export's unit). */
const MOVE_EPS_MM = 0.5;

const idSchema = z.string().min(1).max(200);
const nameSchema = z.string().trim().min(1).max(40);
const elevationSchema = z.number().finite().min(-1_000_000).max(1_000_000);

export const levelCommandSchemas = [
  z.object({
    type: z.literal("update_level"),
    levelId: idSchema,
    name: nameSchema.optional(),
    elevationMm: elevationSchema.optional(),
  }),
  z.object({
    type: z.literal("sync_levels"),
    /** The linked model the storeys come from. */
    referenceId: idSchema,
    storeys: z
      .array(
        z.object({
          /** IFC GlobalId. */
          storeyId: idSchema,
          name: nameSchema,
          /** Where the storey sits in this model (link placement applied). */
          elevationMm: elevationSchema,
          /** Id for the level if this storey becomes a new one, chosen by the sender so a retry adds the same level. */
          levelId: idSchema,
        }),
      )
      .min(1)
      .max(200),
  }),
  z.object({
    type: z.literal("set_level_linked_storey"),
    levelId: idSchema,
    /** The linked model, by its link id (stable across its versions). */
    linkId: idSchema,
    /** The linked model's storey this level is; null forgets the choice. */
    storeyName: z.string().trim().min(1).max(120).nullable(),
  }),
  z.object({
    type: z.literal("ensure_starter_level"),
  }),
] as const;

export type LevelCommand = z.infer<(typeof levelCommandSchemas)[number]>;
export type SyncLevelsCommand = Extract<LevelCommand, { type: "sync_levels" }>;
export type SyncStorey = SyncLevelsCommand["storeys"][number];

/** Peers that store a starter level (`ensure_starter_level`, `Level.starter`). */
export const LEVELS_STARTER_FEATURE = "levels:starter";
/** The starter level's id: fixed, so every client asking for it asks for the same level. */
export const STARTER_LEVEL_ID = "level-1";
export const STARTER_LEVEL_NAME = "Level 1";

/** Whether an open model should be given the starter level: it has no level at all. */
export function needsStarterLevel(model: Pick<ModelState, "elements"> & Partial<Pick<ModelState, "connections">>): boolean {
  return modelLevels(model).length === 0;
}

/** Whether a level is a starter nobody has put anything on (nothing stands on it or sits in its partition; views and sheets don't count). */
export function isEmptyStarterLevel(model: Pick<ModelState, "elements">, level: Level): boolean {
  if (!level.starter) return false;
  for (const el of elementValues(model.elements)) {
    if (el.id === level.id || el.kind === "level" || el.kind === "view" || el.kind === "sheet") continue;
    if ("levelId" in el && el.levelId === level.id) return false;
    if (el.partition && el.partition !== GLOBAL_PARTITION && el.partition.level === level.name) return false;
  }
  return true;
}

const LEVEL_COMMAND_TYPES: ReadonlySet<string> = new Set(levelCommandSchemas.map((s) => s.shape.type.value));

export function isLevelCommand(command: { readonly type: string }): command is LevelCommand {
  return LEVEL_COMMAND_TYPES.has(command.type);
}

// ---------------------------------------------------------------- planning

export type LevelSyncAction = "add" | "update" | "match" | "unchanged";

export interface LevelSyncRow {
  readonly storeyId: string;
  /** The storey's name in the linked model. */
  readonly storeyName: string;
  /** Where the level ends up. */
  readonly elevationMm: number;
  /**
   * add: a new level. update: the level made from this storey moved or was renamed.
   * match: a level a person made for this floor is tied to the storey (it keeps its name; the elevation follows the storey).
   * unchanged: already in step.
   */
  readonly action: LevelSyncAction;
  /** The level it becomes or changes. */
  readonly levelId: string;
  /** The level's name afterwards. */
  readonly name: string;
  /** What the level was before, for update and match. */
  readonly before: { readonly name: string; readonly elevationMm: number } | null;
}

export interface LevelSyncPlan {
  readonly rows: readonly LevelSyncRow[];
  /** Levels made from this linked model whose storey is no longer in it. They are kept; the list says so. */
  readonly orphaned: readonly { readonly levelId: string; readonly name: string; readonly elevationMm: number }[];
  /** Whether running the sync would change anything. */
  readonly changes: boolean;
}

const fromStorey = (level: Level, referenceId: string, storeyId: string): boolean =>
  level.source?.referenceId === referenceId && level.source.storeyId === storeyId;

/**
 * What syncing these storeys would do. Matching, in order, for each storey:
 * the level already made from it; else a level a person drew (or one of this
 * linked model's whose storey is gone) with the same name, ignoring case,
 * punctuation and leading zeros; else one at the same elevation; else a new
 * level. Each level is matched at most once.
 */
export function planLevelSync(model: Pick<ModelState, "elements"> & Partial<Pick<ModelState, "connections">>, referenceId: string, storeys: readonly SyncStorey[]): LevelSyncPlan {
  const levels = modelLevels(model);
  const claimed = new Set<string>();
  const wanted = new Set(storeys.map((s) => s.storeyId));
  const sorted = [...storeys].sort((a, b) => a.elevationMm - b.elevationMm);
  // Levels tied to a storey of this linked model that is still there are that storey's, not up for matching.
  for (const s of sorted) {
    const own = levels.find((l) => fromStorey(l, referenceId, s.storeyId));
    if (own) claimed.add(own.id);
  }
  // Up for matching: levels a person drew, and this linked model's levels whose storey is gone (the architect re-made it).
  // Another linked model's levels are that model's.
  const free = (l: Level) => !claimed.has(l.id) && (!l.source || (l.source.referenceId === referenceId && !wanted.has(l.source.storeyId)));
  const taken = new Set(levels.map((l) => l.name.toLowerCase()));
  // An empty starter level is a stand-in: the architect's floor replaces it (its name and height), never a level beside it.
  const starter = levels.find((l) => l.starter && free(l) && isEmptyStarterLevel(model, l)) ?? null;
  const replaceStarter = (s: SyncStorey, elevationMm: number): LevelSyncRow => {
    if (!starter) throw new Error("no starter level to replace");
    claimed.add(starter.id);
    taken.delete(starter.name.toLowerCase());
    const name = uniqueName(s.name, taken);
    taken.add(name.toLowerCase());
    return { storeyId: s.storeyId, storeyName: s.name, elevationMm, action: "update", levelId: starter.id, name, before: { name: starter.name, elevationMm: starter.elevationMm } };
  };
  const rows: LevelSyncRow[] = [];
  for (const s of sorted) {
    const elevationMm = round(s.elevationMm);
    const own = levels.find((l) => fromStorey(l, referenceId, s.storeyId));
    if (own) {
      const moved = Math.abs(own.elevationMm - elevationMm) >= MOVE_EPS_MM;
      // A storey renamed by the architect renames a level still called what the storey was; a name a person gave stays.
      // Never onto a name another level has.
      const wasStoreyName = own.name === own.source?.storeyName;
      const renamed = wasStoreyName && own.name !== s.name && !(taken.has(s.name.toLowerCase()) && own.name.toLowerCase() !== s.name.toLowerCase());
      const name = renamed ? s.name : own.name;
      if (renamed) {
        taken.delete(own.name.toLowerCase());
        taken.add(name.toLowerCase());
      }
      const restated = own.source?.storeyName !== s.name;
      rows.push({ storeyId: s.storeyId, storeyName: s.name, elevationMm: moved ? elevationMm : own.elevationMm, action: moved || renamed || restated ? "update" : "unchanged", levelId: own.id, name, before: { name: own.name, elevationMm: own.elevationMm } });
      continue;
    }
    const wantedName = normalizeLevelName(s.name);
    const match =
      levels.find((l) => free(l) && normalizeLevelName(l.name) === wantedName) ??
      levels
        .filter((l) => free(l) && Math.abs(l.elevationMm - elevationMm) < SAME_FLOOR_MM)
        .sort((a, b) => Math.abs(a.elevationMm - elevationMm) - Math.abs(b.elevationMm - elevationMm))[0];
    if (match && match === starter) {
      rows.push(replaceStarter(s, elevationMm));
      continue;
    }
    if (match) {
      claimed.add(match.id);
      const moved = Math.abs(match.elevationMm - elevationMm) >= MOVE_EPS_MM;
      rows.push({ storeyId: s.storeyId, storeyName: s.name, elevationMm: moved ? elevationMm : match.elevationMm, action: "match", levelId: match.id, name: match.name, before: { name: match.name, elevationMm: match.elevationMm } });
      continue;
    }
    if (starter && !claimed.has(starter.id)) {
      rows.push(replaceStarter(s, elevationMm));
      continue;
    }
    const name = uniqueName(s.name, taken);
    taken.add(name.toLowerCase());
    rows.push({ storeyId: s.storeyId, storeyName: s.name, elevationMm, action: "add", levelId: s.levelId, name, before: null });
  }
  const orphaned = levels
    .filter((l) => l.source?.referenceId === referenceId && !wanted.has(l.source.storeyId))
    .map((l) => ({ levelId: l.id, name: l.name, elevationMm: l.elevationMm }));
  return { rows, orphaned, changes: rows.some((r) => r.action !== "unchanged") };
}

/** The name, or "Name (2)", "Name (3)"… when a level already has it. */
function uniqueName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 2; ; n++) {
    const suffix = ` (${n})`;
    const candidate = `${name.slice(0, 40 - suffix.length)}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

// ---------------------------------------------------------------- applying

/**
 * Elements standing on a level. Parts store their height above it and runs
 * their heights relative to it, so they move with the level unchanged; they
 * are still part of the change, so every view redraws them where they now are.
 */
function standsOn(el: BimElement, levelId: ElementId): boolean {
  return (el.kind === "part" || el.kind === "run_segment" || el.kind === "run_fitting") && el.levelId === levelId;
}

/** A copy of an element that named the level by `from`, naming it `to` instead; null when it doesn't name it. */
function renamedOn(el: BimElement, from: string, to: string): BimElement | null {
  let next: BimElement | null = null;
  if (el.partition && el.partition.level === from && el.partition !== GLOBAL_PARTITION) next = { ...el, partition: { ...el.partition, level: to } };
  if (el.kind === "view" && el.props) {
    const props = el.props;
    const level = props.level === from ? to : props.level;
    const schedule = props.schedule && props.schedule.level === from ? { ...props.schedule, level: to } : props.schedule;
    if (level !== props.level || schedule !== props.schedule) {
      const base = next ?? el;
      if (base.kind === "view") next = { ...base, props: { ...props, ...(level !== undefined ? { level } : {}), ...(schedule ? { schedule } : {}) } };
    }
  }
  return next;
}

interface LevelChange {
  readonly level: Level;
  readonly name: string;
  readonly elevationMm: number;
  readonly source?: LevelSource;
}

/**
 * Apply level changes to a working copy: the levels themselves, what stands on
 * moved levels, and every name reference on renamed ones. Refuses when a moved
 * level's runs connect to something that stays put.
 */
function applyLevelChanges(reader: TrackedReader, working: Record<string, BimElement>, changes: readonly LevelChange[]): { touched: ElementId[]; authored: AuthoredWrite[] } {
  const touched: ElementId[] = [];
  const authored: AuthoredWrite[] = [];
  const all = elementValues(reader.model.elements);
  const moving = new Map<ElementId, number>();
  for (const c of changes) {
    const dz = round(c.elevationMm - c.level.elevationMm);
    if (Math.abs(dz) >= MOVE_EPS_MM) moving.set(c.level.id, dz);
  }
  if (moving.size > 0) {
    const moved = new Set<ElementId>();
    const movingIds: ReadonlySet<ElementId> = new Set(moving.keys());
    const after = new Map(changes.map((c) => [c.level.id, round(c.elevationMm)] as const));
    const elevation = (id: ElementId): number | null => {
      const next = after.get(id);
      if (next !== undefined) return next;
      const l = reader.model.elements[id];
      return l?.kind === "level" ? l.elevationMm : null;
    };
    for (const el of all) {
      // A body tied between levels (a wall up to the level above) stretches with either one.
      const tie = tiedToAny(el, movingIds) ? topTieOf(el) : null;
      if (tie) {
        if (tiedHeightMm(tie, elevation) === null) {
          const top = tie.topLevelId ? reader.model.elements[tie.topLevelId] : undefined;
          refuse("invalid_value", `${elementLabel(el)} runs up to ${top?.kind === "level" ? top.name : "the level above"}; that move would put its top at or below its base. Untie its top in Properties, or move the level less`, [el.id]);
        }
        const stretched = withTiedHeight(el, elevation);
        if (stretched) {
          reader.get(el.id);
          working[el.id] = stretched;
          touched.push(el.id);
        }
      }
      for (const levelId of moving.keys()) {
        if (!standsOn(el, levelId)) continue;
        reader.get(el.id);
        moved.add(el.id);
        touched.push(el.id);
      }
    }
    for (const c of reader.model.connections) {
      const a = moved.has(c.a.elementId);
      const b = moved.has(c.b.elementId);
      if (a === b) continue;
      const [inside, outside] = a ? [c.a.elementId, c.b.elementId] : [c.b.elementId, c.a.elementId];
      const levelName = (id: ElementId) => {
        const el = reader.model.elements[id];
        const level = el && "levelId" in el && el.levelId ? reader.model.elements[el.levelId] : undefined;
        return level?.kind === "level" ? level.name : "another level";
      };
      refuse("invalid_value", `A run on ${levelName(inside)} connects to one on ${levelName(outside)}; moving the level would pull them apart. Move or disconnect that connection first.`, [inside, outside]);
    }
  }
  for (const c of changes) {
    const from = c.level.name;
    if (c.name !== from) {
      for (const el of all) {
        if (el.id === c.level.id) continue;
        const current = working[el.id] ?? el;
        const next = renamedOn(current, from, c.name);
        if (!next) continue;
        reader.get(el.id);
        working[el.id] = next;
        touched.push(el.id);
      }
    }
    // A level a person renamed, moved or tied to the architect's floor is theirs now, no longer a starter.
    const { starter: _starter, ...kept } = c.level;
    const level: Level = { ...kept, name: c.name, elevationMm: round(c.elevationMm), ...(c.source ? { source: c.source } : {}) };
    working[level.id] = level;
    touched.push(level.id);
    if (c.name !== from) authored.push({ elementId: level.id, field: "name", value: c.name });
    if (Math.abs(c.elevationMm - c.level.elevationMm) >= MOVE_EPS_MM) authored.push({ elementId: level.id, field: "elevationMm", value: level.elevationMm });
  }
  return { touched: [...new Set(touched)], authored };
}

function intentsOf(authored: readonly AuthoredWrite[]): () => IntentPredicate[] {
  return () => authored.map((a) => ({ kind: "field_equals" as const, elementId: a.elementId, field: a.field, value: a.value }));
}

function updateLevel(model: ModelState, command: Extract<LevelCommand, { type: "update_level" }>): ExecuteResult {
  const reader = new TrackedReader(model);
  const target = reader.get(asElementId(command.levelId));
  if (target.kind !== "level") refuse("wrong_kind", `${command.levelId} is not a level`, [target.id]);
  const name = command.name ?? target.name;
  const elevationMm = command.elevationMm ?? target.elevationMm;
  if (name.toLowerCase() !== target.name.toLowerCase()) {
    const clash = modelLevels(model).find((l) => l.id !== target.id && l.name.toLowerCase() === name.toLowerCase());
    if (clash) {
      reader.get(clash.id);
      refuse("already_exists", `There is already a level named ${clash.name}`, [clash.id]);
    }
  }
  if (name === target.name && Math.abs(elevationMm - target.elevationMm) < MOVE_EPS_MM) refuse("invalid_value", `${target.name} is already called that, at that height`, [target.id]);
  const working = draftElements(model.elements);
  const { touched, authored } = applyLevelChanges(reader, working, [{ level: target, name, elevationMm }]);
  return finish(reader, working, touched, authored, intentsOf(authored));
}

function syncLevels(model: ModelState, command: SyncLevelsCommand): ExecuteResult {
  const reader = new TrackedReader(model);
  const ids = new Set<string>();
  for (const s of command.storeys) {
    if (ids.has(s.storeyId)) refuse("invalid_value", `Storey ${s.name} is listed twice`);
    ids.add(s.storeyId);
  }
  const plan = planLevelSync(model, command.referenceId, command.storeys);
  for (const l of modelLevels(model)) reader.get(l.id);
  if (!plan.changes) refuse("invalid_value", "The levels already match the linked model's storeys; nothing to change");
  const working = draftElements(model.elements);
  const changes: LevelChange[] = [];
  const added: Level[] = [];
  for (const row of plan.rows) {
    const source: LevelSource = { referenceId: command.referenceId, storeyId: row.storeyId, storeyName: row.storeyName };
    if (row.action === "add") {
      const id = asElementId(row.levelId);
      if (reader.find(id)) refuse("already_exists", `${row.levelId} already exists; choose a new id`, [id]);
      added.push({ id, kind: "level", version: 0, authoredRev: {}, partition: GLOBAL_PARTITION, name: row.name, elevationMm: row.elevationMm, source });
      continue;
    }
    const level = reader.get(asElementId(row.levelId));
    if (level.kind !== "level") refuse("wrong_kind", `${row.levelId} is not a level`, [level.id]);
    if (row.action === "unchanged") continue;
    changes.push({ level, name: row.name, elevationMm: row.elevationMm, source });
  }
  const { touched, authored } = applyLevelChanges(reader, working, changes);
  for (const level of added) {
    working[level.id] = level;
    touched.push(level.id);
  }
  const summary = [
    ...plan.rows.filter((r) => r.action === "add").map((r) => `Added ${r.name} at ${levelHeightLabel(r.elevationMm)}`),
    ...plan.rows.filter((r) => r.action === "update" || r.action === "match").map((r) => describeChange(r)),
    ...plan.orphaned.map((o) => `${o.name} is no longer in the linked model; it was kept`),
  ];
  return finish(reader, working, touched, authored, intentsOf(authored), summary.length > 0 ? { summary } : {});
}

function ensureStarterLevel(model: ModelState): ExecuteResult {
  const reader = new TrackedReader(model);
  const id = asElementId(STARTER_LEVEL_ID);
  const levels = modelLevels(model);
  for (const l of levels) reader.get(l.id);
  if (levels.length > 0) refuse("already_exists", `This model already has ${levels.length === 1 ? `a level (${levels[0]?.name})` : `${levels.length} levels`}; it needs no starter level`, levels.map((l) => l.id));
  if (!peerReads(LEVELS_STARTER_FEATURE)) refuse("invalid_value", "The starter Level 1 can't be added yet: the model server this model is open on is an older version. Add a level yourself with Add level, or try again once the server is updated");
  if (reader.find(id)) refuse("already_exists", `${STARTER_LEVEL_ID} is already used by something that is not a level`, [id]);
  const level: Level = { id, kind: "level", version: 0, authoredRev: {}, partition: GLOBAL_PARTITION, name: STARTER_LEVEL_NAME, elevationMm: 0, starter: true };
  const working = draftElements(model.elements);
  working[id] = level;
  return finish(reader, working, [id], [], () => [], { summary: [`Added ${STARTER_LEVEL_NAME} at 0'-0" so the empty model can be drawn on`] });
}

/** At most this many linked models keep a storey choice on one level. */
const MAX_LINKED_STOREYS = 64;

function setLevelLinkedStorey(model: ModelState, command: Extract<LevelCommand, { type: "set_level_linked_storey" }>): ExecuteResult {
  const reader = new TrackedReader(model);
  const target = reader.get(asElementId(command.levelId));
  if (target.kind !== "level") refuse("wrong_kind", `${command.levelId} is not a level`, [target.id]);
  const current = target.linkedStoreys ?? {};
  const had = current[command.linkId];
  if (command.storeyName === null ? had === undefined : had === command.storeyName) {
    refuse("invalid_value", command.storeyName === null ? `${target.name} has no linked level chosen for that model` : `${target.name} already uses ${command.storeyName} of that model`, [target.id]);
  }
  const next: Record<string, string> = { ...current };
  if (command.storeyName === null) delete next[command.linkId];
  else next[command.linkId] = command.storeyName;
  if (Object.keys(next).length > MAX_LINKED_STOREYS) refuse("invalid_value", `${target.name} can keep a linked level for at most ${MAX_LINKED_STOREYS} linked models`, [target.id]);
  const { linkedStoreys: _previous, ...rest } = target;
  const level: Level = Object.keys(next).length > 0 ? { ...rest, linkedStoreys: next } : rest;
  const working = draftElements(model.elements);
  working[level.id] = level;
  // Two people choosing different storeys for the same link conflict; choices for different links don't.
  const authored: AuthoredWrite[] = [{ elementId: level.id, field: `linkedStoreys.${command.linkId}`, value: command.storeyName ?? "" }];
  const summary = command.storeyName === null ? `${target.name} no longer has a linked level chosen` : `${target.name} now draws the linked model's ${command.storeyName}`;
  return finish(reader, working, [level.id], authored, intentsOf(authored), { summary: [summary] });
}

function describeChange(row: LevelSyncRow): string {
  const before = row.before;
  if (!before) return `${row.name} at ${levelHeightLabel(row.elevationMm)}`;
  const renamed = before.name !== row.name;
  const moved = Math.abs(before.elevationMm - row.elevationMm) >= MOVE_EPS_MM;
  const move = `from ${levelHeightLabel(before.elevationMm)} to ${levelHeightLabel(row.elevationMm)}`;
  if (renamed && moved) return `Renamed ${before.name} to ${row.name} and moved it ${move}`;
  if (renamed) return `Renamed ${before.name} to ${row.name}`;
  if (moved) return `Moved ${row.name} ${move}`;
  return `${row.name} now follows ${row.storeyName} in the linked model`;
}

/** A level height for summaries: 14'-6", and -4'-0" below project zero. */
export function levelHeightLabel(mm: number): string {
  return `${mm < 0 ? "-" : ""}${feetInches(mm)}`;
}

export function executeLevelCommand(model: ModelState, command: LevelCommand): ExecuteResult {
  return guard(() => {
    switch (command.type) {
      case "update_level":
        return updateLevel(model, command);
      case "sync_levels":
        return syncLevels(model, command);
      case "set_level_linked_storey":
        return setLevelLinkedStorey(model, command);
      case "ensure_starter_level":
        return ensureStarterLevel(model);
    }
  });
}
