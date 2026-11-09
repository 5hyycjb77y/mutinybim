import type { Command } from "../commands";
import { defineExtensionPoint } from "../packs/contract";
import { activePackSet } from "../packs/scope";
import type { TagLeaderEnd, TagStyleArrow, TagStyleBox, TagStyleCategory, TagStyleOrientation, TagStyleUnits } from "../organization/model";

/**
 * Tag style presets: ready-made tag looks a trade contributes, that a person
 * (Tag styles › Start from) or an agent (`bim_save_tag_style` `preset`) turns
 * into a project tag style with one `create_tag_style`. A preset is only a
 * starting point: the style it makes is the project's own, edited like any
 * other, and the preset can change later without touching it.
 *
 * Lines are the shared field-template language (`fields/template.ts`) that
 * schedules and live diagrams read: `{pipe.size}`, `{circuit}`,
 * `[ {insulation}]` (a group that drops when its field is empty). So a tag,
 * a schedule column and a riser label built on the same path print the same
 * value.
 *
 * A pack adds its own as rows of `TAG_STYLE_PRESET_POINT`; ids are unique.
 */

export interface TagStylePreset {
  /** Stable id: `<trade>.<what>` (`gas.size_length`). */
  readonly id: string;
  /** The name the style gets (a number is added if the project already has one). */
  readonly name: string;
  /** Which trade offers it, for grouping in the picker. */
  readonly trade: "general" | "mechanical" | "plumbing" | "electrical" | "gas" | "fire";
  /** One sentence a person reads in the picker. */
  readonly description: string;
  readonly lines: readonly string[];
  readonly textSizeMm?: number;
  readonly leader?: boolean;
  readonly box?: TagStyleBox;
  readonly orientation?: TagStyleOrientation;
  readonly units?: TagStyleUnits;
  readonly leaderEnd?: TagLeaderEnd;
  readonly prefix?: string;
  readonly suffix?: string;
  readonly appliesTo?: readonly TagStyleCategory[];
  /** An arrow along the labelled run, towards its lower or higher end (`TagStyleEntry.arrow`). */
  readonly arrow?: TagStyleArrow;
}

/**
 * One preset a pack offers (v1). `rank` orders the picker (lower first; ties
 * keep set order), so presets stay grouped by trade.
 */
export interface TagStylePresetRow {
  readonly id: string;
  readonly rank: number;
  readonly preset: TagStylePreset;
}

/** Tag style presets (v1), by preset id (stored on nothing; bare for first-party packs). */
export const TAG_STYLE_PRESET_POINT = defineExtensionPoint<TagStylePresetRow>({ id: "kernel.tag_style_preset", version: 1, label: "Tag style presets", idOf: (r) => r.id, namespaced: false });

/**
 * Tag field aliases (v1): a field name a tag style line may use (`{name}`),
 * read from another of the part's parameters when the part has none by that
 * name. The names are a trade's words, so each pack brings its own rows and
 * the kernel keeps none.
 */
export interface TagFieldAliasRow {
  /** Stable id: `<pack>.<field>`. */
  readonly id: string;
  /** The field a style line names. */
  readonly field: string;
  /** The part parameters it reads, first with a value wins. */
  readonly reads: readonly string[];
}

/** Tag field aliases (v1), by row id (stored on nothing; bare for first-party packs). */
export const TAG_FIELD_ALIAS_POINT = defineExtensionPoint<TagFieldAliasRow>({ id: "kernel.tag_field_alias", version: 1, label: "Tag field aliases", idOf: (r) => r.id, namespaced: false });

/** The parameters the packs in force read for a tag field `field`, in row order; none when no pack names it. */
export function tagFieldAliases(field: string): readonly string[] {
  const set = activePackSet();
  const table = set.memo("kernel.tag_field_alias#table", () => {
    const out = new Map<string, string[]>();
    for (const row of set.items(TAG_FIELD_ALIAS_POINT)) out.set(row.field, [...(out.get(row.field) ?? []), ...row.reads.filter((r) => r !== row.field)]);
    return out;
  });
  return table.get(field) ?? [];
}

function presetProblem(preset: TagStylePreset): string | null {
  if (!/^[a-z]+\.[a-z0-9_]+$/.test(preset.id)) return `Tag style preset id "${preset.id}" must look like trade.what`;
  if (preset.lines.length === 0 || preset.lines.length > 6) return `Tag style preset ${preset.id} needs one to six lines`;
  return null;
}

function presetTable(): ReadonlyMap<string, TagStylePreset> {
  const set = activePackSet();
  return set.memo("kernel.tag_style_preset#table", () => {
    const rows = set.items(TAG_STYLE_PRESET_POINT).map((row, i) => ({ row, i }));
    rows.sort((a, b) => a.row.rank - b.row.rank || a.i - b.i);
    const out = new Map<string, TagStylePreset>();
    for (const { row } of rows) {
      const problem = presetProblem(row.preset);
      if (problem) {
        console.error("[bim-kernel/tags] a pack's tag style preset was refused", { id: row.id, problem });
        throw new Error(problem);
      }
      out.set(row.preset.id, row.preset);
    }
    return out;
  });
}

/** Every preset of the set in force, grouped by trade (by rank). */
export function tagStylePresets(): readonly TagStylePreset[] {
  return [...presetTable().values()];
}

export function tagStylePreset(id: string): TagStylePreset | null {
  return presetTable().get(id) ?? null;
}

/** The `create_tag_style` that makes a project style from a preset, named so it doesn't clash with `takenNames`. */
export function createTagStyleFromPreset(preset: TagStylePreset, styleId: string, takenNames: readonly string[]): Extract<Command, { type: "create_tag_style" }> {
  const taken = new Set(takenNames.map((n) => n.trim().toLowerCase()));
  let name = preset.name;
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${preset.name} ${n}`;
  return {
    type: "create_tag_style",
    styleId,
    name,
    lines: [...preset.lines],
    ...(preset.textSizeMm !== undefined ? { textSizeMm: preset.textSizeMm } : {}),
    ...(preset.leader !== undefined ? { leader: preset.leader } : {}),
    ...(preset.box ? { box: preset.box } : {}),
    ...(preset.orientation ? { orientation: preset.orientation } : {}),
    ...(preset.units ? { units: preset.units } : {}),
    ...(preset.leaderEnd ? { leaderEnd: preset.leaderEnd } : {}),
    ...(preset.prefix ? { prefix: preset.prefix } : {}),
    ...(preset.suffix ? { suffix: preset.suffix } : {}),
    ...(preset.appliesTo ? { appliesTo: [...preset.appliesTo] } : {}),
    ...(preset.arrow ? { arrow: preset.arrow } : {}),
  };
}
