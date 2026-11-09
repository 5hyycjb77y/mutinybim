import { z } from "zod";
import { canonicalJson } from "../canonical";
import { finish, guard, refuse, type AuthoredWrite, type ExecuteResult } from "../command-core";
import { documentIndex } from "../commands/views";
import { TrackedReader } from "../model";
import { draftElements, elementOrder, elementValues, isFrozenElements } from "../store";
import { organizationMembersOf } from "./members";
import { asElementId, type BimElement, type ElementId, type ModelState } from "../types";
import {
  DEFAULT_GROUP_ID,
  DEFAULT_GROUPS,
  DEFAULT_PHASE_FILTERS,
  DEFAULT_PHASES,
  DEFAULT_PHASE_ID,
  DEFAULT_TAG_STYLES,
  GROUP_VISIBILITIES,
  TAG_LEADER_ENDS,
  TAG_STYLE_BOXES,
  TAG_STYLE_CATEGORIES,
  TAG_STYLE_ORIENTATIONS,
  TAG_STYLE_UNITS,
  ORGANIZATION_PARTITION,
  ORGANIZATION_SETTINGS_ID,
  PHASE_DISPLAYS,
  PHASE_STATUSES,
  groupIdOf,
  isOrganized,
  organizationOf,
  phaseCreatedOf,
  phaseDemolishedOf,
  type GroupEntry,
  type Organization,
  type OrganizationElementRecord,
  type OrganizationEntry,
  type OrganizationSettingsEntry,
  type PhaseEntry,
  type PhaseFilterEntry,
  type PhaseStatus,
  type Resolved,
  type TagStyleArrow,
  type TagStyleCategory,
  type TagStyleEntry,
} from "./model";
import { MAX_TYPICAL_COPIES, arrayCopies } from "./typicals";
import { ORG_FIELDS, organizationFieldValue } from "./fields";
import { DOCUMENTS_PRINT_BLACK_ONLY_FEATURE, TAGS_MASK_LEADER_FEATURE, TAGS_SLOPE_ARROW_FEATURE, TAG_STYLE_ARROWS, TAG_STYLE_CATEGORIES_B16, TYPICALS_MIRROR_FEATURE, type TypicalCopy, type TypicalSpec } from "./model";
import { ORGANIZATION_SETUP_FEATURE, addonSetupId, disciplineSetupId, modelSetupHostPacks, setupProblems, setupWithFirm, setupWithSwitch } from "./setup";
import { peerReads } from "../elements/feature";
import { partitionMembers } from "../partition";
import { disciplineLabel, isRegisteredDiscipline } from "../disciplines/registry";
import type { DisciplineDef } from "../disciplines/types";
import { firstPartyPackName, isFirstPartyPackId } from "../packs/first-party/manifests";
import { PACKS_OUTSIDE_PINS_FEATURE, isPackDigest } from "../packs/pin";
import {
  PARAMETER_VALUE_TYPES,
  PROJECT_PARAMETER_KEY,
  PROJECT_PARAMETER_MAX_TEXT,
  PROJECT_PARAMETERS_FEATURE,
  parseParameterValue,
  projectParameterId,
  standardProjectParameter,
  type ProjectParameterDef,
} from "../project-parameters";
import type { ProjectParameterEntry } from "./model";

/**
 * Commands that edit groups, phases and phase filters, set the active group
 * and phase, and put elements in groups and phases. Same contract as every
 * other command: validated against the head, attributed, conflict-checked by
 * field, and undone with `undo`. Removing a group, phase or filter is a
 * `deleted` flag so undo brings it back with its id.
 */

const id = z.string().min(1).max(200);
const name = z.string().trim().min(1).max(80);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Colours are #rrggbb");
const ids = z.array(id).min(1).max(50000);
const statusesSchema = z.object({
  new: z.enum(PHASE_DISPLAYS),
  existing: z.enum(PHASE_DISPLAYS),
  demolished: z.enum(PHASE_DISPLAYS),
  temporary: z.enum(PHASE_DISPLAYS),
});
const tagStyleLines = z.array(z.string().trim().min(1).max(120)).min(1).max(6).readonly();
const tagTextSize = z.number().min(1.5).max(10);
const tagStyleDefaults = z.array(z.enum(TAG_STYLE_CATEGORIES)).max(TAG_STYLE_CATEGORIES.length).readonly();
/** The rest of a tag style's look. On update, "" clears a prefix or suffix and [] clears applies-to. */
const tagStyleExtras = {
  prefix: z.string().max(20).optional(),
  suffix: z.string().max(20).optional(),
  orientation: z.enum(TAG_STYLE_ORIENTATIONS).optional(),
  units: z.enum(TAG_STYLE_UNITS).optional(),
  leaderEnd: z.enum(TAG_LEADER_ENDS).optional(),
  appliesTo: tagStyleDefaults.optional(),
  /** "none" clears it on update. */
  arrow: z.enum(["none", ...TAG_STYLE_ARROWS]).optional(),
};
const typicalMark = z.string().trim().min(1).max(20);
const typicalPoint = z.object({ x: z.number().finite().min(-1e7).max(1e7), y: z.number().finite().min(-1e7).max(1e7) }).strict();
const addonId = z.string().regex(/^[a-z][a-z0-9_-]{0,59}$/, "An add-on id is lower case letters, digits, - and _");
const addonVersion = z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, "An add-on version is x.y.z").max(40);
/** An outside add-on's reviewed build (`sha256:<64 hex>`) and the tier it was installed at (round 11). */
const addonDigest = z.string().regex(/^sha256:[0-9a-f]{64}$/, "An add-on build is sha256: and 64 lower-case hex digits");
const addonTier = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, "A trust tier is a lower-case word, such as data");
const firmDisciplineId = z.string().regex(/^firm:[a-z0-9][a-z0-9_]*$/, 'A firm discipline id is "firm:<name>" (lower case letters, digits and underscores)').max(80);
const firmDisciplineSchema = z
  .object({
    id: firmDisciplineId,
    label: name,
    parent: z.string().min(1).max(80).optional(),
    group: z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9_]*$/).max(40), label: name }).strict().optional(),
    display: z.object({ colour: color, icon: z.string().min(1).max(60).optional() }).strict(),
    defaultResponsibleRole: z.string().trim().min(1).max(120).optional(),
    ifc: z.object({ systemType: z.string().min(1).max(80).optional(), name: z.string().min(1).max(80).optional() }).strict().optional(),
  })
  .strict();

/** Room and space tag styles are stored only by peers that read them; say so before an older one refuses the shape. */
function tagStyleKindsStored(kinds: readonly TagStyleCategory[]): void {
  if (kinds.some((k) => TAG_STYLE_CATEGORIES_B16.includes(k)) && !peerReads(TAGS_MASK_LEADER_FEATURE)) {
    refuse("invalid_value", "Room and space tag styles can't be saved yet: the model server this model is open on is an older version. Try again once the server is updated", []);
  }
}

/** A tag style's arrow is stored only by peers that read it; say so before an older one refuses the shape. */
function tagStyleArrowStored(arrow: string | undefined): void {
  if (arrow !== undefined && arrow !== "none" && !peerReads(TAGS_SLOPE_ARROW_FEATURE)) {
    refuse("invalid_value", "A tag style's arrow can't be saved yet: the model server this model is open on is an older version. Save the style without the arrow, or try again once the server is updated", []);
  }
}

export const organizationCommandSchemas = [
  z.object({
    type: z.literal("create_group"),
    groupId: id,
    name,
    color: color.optional(),
    description: z.string().max(400).optional(),
    defaultVisibility: z.enum(GROUP_VISIBILITIES).optional(),
  }),
  z.object({
    type: z.literal("update_group"),
    groupId: id,
    name: name.optional(),
    color: color.optional(),
    description: z.string().max(400).optional(),
    defaultVisibility: z.enum(GROUP_VISIBILITIES).optional(),
  }),
  z.object({ type: z.literal("lock_group"), groupId: id, locked: z.boolean() }),
  z.object({
    type: z.literal("delete_group"),
    groupId: id,
    /** Where its elements go. Without it, a group that still has elements is not deleted. */
    moveTo: id.optional(),
  }),
  z.object({ type: z.literal("set_active_group"), groupId: id }),
  z.object({ type: z.literal("assign_elements_to_group"), ids, groupId: id }),
  z.object({
    type: z.literal("create_phase"),
    phaseId: id,
    name,
    /** Comes right after this phase; null puts it first; absent puts it last. */
    after: id.nullable().optional(),
  }),
  z.object({ type: z.literal("update_phase"), phaseId: id, name: name.optional(), after: id.nullable().optional() }),
  z.object({ type: z.literal("delete_phase"), phaseId: id }),
  z.object({ type: z.literal("set_active_phase"), phaseId: id }),
  z.object({
    type: z.literal("set_element_phases"),
    ids,
    phaseCreated: id.optional(),
    /** null: not demolished. */
    phaseDemolished: id.nullable().optional(),
  }),
  /** Demolish in a phase (default: the active phase). */
  z.object({ type: z.literal("demolish_elements"), ids, phaseId: id.optional() }),
  z.object({ type: z.literal("undemolish_elements"), ids }),
  z.object({ type: z.literal("create_phase_filter"), filterId: id, name, statuses: statusesSchema }),
  z.object({ type: z.literal("update_phase_filter"), filterId: id, name: name.optional(), statuses: statusesSchema.partial().optional() }),
  z.object({ type: z.literal("delete_phase_filter"), filterId: id }),
  z.object({
    type: z.literal("create_tag_style"),
    styleId: id,
    name,
    lines: tagStyleLines,
    textSizeMm: tagTextSize.optional(),
    leader: z.boolean().optional(),
    box: z.enum(TAG_STYLE_BOXES).optional(),
    defaultFor: tagStyleDefaults.optional(),
    ...tagStyleExtras,
  }),
  z.object({
    type: z.literal("update_tag_style"),
    styleId: id,
    name: name.optional(),
    lines: tagStyleLines.optional(),
    textSizeMm: tagTextSize.optional(),
    leader: z.boolean().optional(),
    box: z.enum(TAG_STYLE_BOXES).optional(),
    defaultFor: tagStyleDefaults.optional(),
    ...tagStyleExtras,
  }),
  z.object({ type: z.literal("delete_tag_style"), styleId: id }),
  /** Make a group a typical (unit 001 repeated): copies listed, or laid out with `array`. Fields left out keep their value. */
  z.object({
    type: z.literal("set_group_typical"),
    groupId: id,
    label: z.string().trim().min(1).max(40).optional(),
    mark: typicalMark.optional(),
    basePoint: typicalPoint.optional(),
    copies: z.array(z.object({ mark: typicalMark, offset: typicalPoint, rotationDeg: z.number().finite().min(-360).max(360).optional(), mirror: z.object({ axis: z.enum(["x", "y"]) }).strict().optional() }).strict()).max(MAX_TYPICAL_COPIES - 1).optional(),
    /** `count` instances in all, the original included, `columns` across, `spacingMm` apart. */
    array: z.object({ count: z.number().int().min(1).max(MAX_TYPICAL_COPIES), columns: z.number().int().min(1).max(100), spacingMm: typicalPoint }).strict().optional(),
    /** rotate: copies spread over a 3-phase source's phases; same: all on the original's. Left out: keeps its value (default: rotate through a feeder). */
    phaseRotation: z.enum(["rotate", "same"]).optional(),
  }),
  z.object({ type: z.literal("clear_group_typical"), groupId: id }),
  /** How many typical types the contract covers; more is a warning (STATUS decision 15). */
  z.object({ type: z.literal("set_typical_cap"), cap: z.number().int().min(1).max(MAX_TYPICAL_COPIES) }),
  /** The project's sheets print black only (true) or in colour (false). */
  z.object({ type: z.literal("set_print_black_only"), blackOnly: z.boolean() }),
  /** Switch an installed add-on on or off for this model (round 8). Off hides its rows; nothing is deleted. */
  z.object({
    type: z.literal("set_model_addon"),
    packId: addonId,
    version: addonVersion,
    on: z.boolean(),
    /** An outside add-on's reviewed build and trust tier, both or neither; written only to peers that read them (`packs:outside_pins`). */
    digest: addonDigest.optional(),
    tier: addonTier.optional(),
  }),
  /** Pin a firm library discipline to this model; the row travels with the model (round 8). Re-pinning replaces the copy. */
  z.object({ type: z.literal("pin_firm_discipline"), discipline: firmDisciplineSchema }),
  z.object({ type: z.literal("unpin_firm_discipline"), disciplineId: firmDisciplineId }),
  /**
   * State project facts once for every sheet (`project-parameters.ts`): each value checked against its type
   * (dates YYYY-MM-DD, a status from its list). "" or null clears one. A key outside the standard list needs `define`.
   */
  z.object({
    type: z.literal("set_project_parameters"),
    values: z.record(z.string().regex(PROJECT_PARAMETER_KEY, "A parameter key is lower case letters, digits and _"), z.string().max(PROJECT_PARAMETER_MAX_TEXT).nullable()),
    define: z
      .array(
        z
          .object({
            key: z.string().regex(PROJECT_PARAMETER_KEY),
            label: z.string().trim().min(1).max(80),
            valueType: z.enum(PARAMETER_VALUE_TYPES),
            choices: z.array(z.string().trim().min(1).max(80)).min(1).max(40).optional(),
          })
          .strict(),
      )
      .max(40)
      .optional(),
  }),
] as const;

export type OrganizationCommand = z.infer<(typeof organizationCommandSchemas)[number]>;

const COMMAND_TYPES: ReadonlySet<string> = new Set(organizationCommandSchemas.map((s) => s.shape.type.value));

export function isOrganizationCommand(command: { readonly type: string }): command is OrganizationCommand {
  return COMMAND_TYPES.has(command.type);
}

export { ORG_FIELDS, organizationFieldValue };

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function uniqueName<E extends OrganizationEntry & { name: string }>(list: readonly Resolved<E>[], wanted: string, self: string | null, what: string): void {
  const clash = list.find((x) => x.id !== self && sameName(x.entry.name, wanted));
  if (clash) refuse("already_exists", `There is already a ${what} named "${clash.entry.name}". Pick another name.`, [asElementId(clash.id)]);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Order value between two neighbours (or past the end). */
function orderBetween(before: number | undefined, after: number | undefined): number {
  if (before === undefined && after === undefined) return 0;
  if (before === undefined) return (after ?? 0) - 1;
  if (after === undefined) return before + 1;
  return (before + after) / 2;
}

class Edit {
  readonly reader: TrackedReader;
  readonly working: Record<string, BimElement>;
  readonly touched: ElementId[] = [];
  readonly authored: AuthoredWrite[] = [];
  readonly org: Organization;

  constructor(readonly model: ModelState) {
    this.reader = new TrackedReader(model);
    this.working = draftElements(model.elements);
    this.org = organizationOf(model);
  }

  /** Store an organization entry (creating the record the first time a built-in is edited). */
  putEntry(elementId: string, entry: OrganizationEntry, deleted = false): void {
    const eid = asElementId(elementId);
    const current = this.reader.find(eid);
    if (current && current.kind !== "organization") refuse("already_exists", `${elementId} is already used by another element`, [eid]);
    const record: OrganizationElementRecord = current?.kind === "organization"
      ? { ...current, entry, ...(deleted ? { deleted: true } : {}) }
      : { id: eid, version: 0, authoredRev: {}, partition: ORGANIZATION_PARTITION, kind: "organization", entry, ...(deleted ? { deleted: true } : {}) };
    if (!deleted && "deleted" in record && record.deleted) {
      const { deleted: _gone, ...rest } = record;
      this.write(rest);
    } else this.write(record);
    this.authored.push({ elementId: eid, field: ORG_FIELDS.entry, value: canonicalJson({ entry, deleted }) });
  }

  write(el: BimElement): void {
    this.working[el.id] = el;
    this.touched.push(el.id);
  }

  setSettings(change: Partial<Omit<OrganizationSettingsEntry, "type">>): void {
    const stored = this.org.stored.get(ORGANIZATION_SETTINGS_ID)?.entry;
    const kept = stored?.type === "settings" ? stored : null;
    // Every stored setting is kept; only the ones named change.
    const cap = kept?.typicalCap !== undefined ? { typicalCap: kept.typicalCap } : {};
    const black = kept?.printBlackOnly === true ? { printBlackOnly: true as const } : {};
    const merged: OrganizationSettingsEntry = { type: "settings", activeGroupId: this.org.activeGroupId, activePhaseId: this.org.activePhaseId, ...cap, ...black, ...change };
    // Colour is the default: say nothing rather than store false.
    const { printBlackOnly: blackNow, ...rest } = merged;
    const next: OrganizationSettingsEntry = blackNow ? merged : rest;
    this.putEntry(ORGANIZATION_SETTINGS_ID, next);
  }

  /** Change organized elements; each must exist and be model content. */
  members(list: readonly string[], change: (el: BimElement) => BimElement | null, fields: readonly (keyof typeof ORG_FIELDS)[]): number {
    let changed = 0;
    const seen = new Set<string>();
    for (const raw of list) {
      if (seen.has(raw)) continue;
      seen.add(raw);
      const el = this.reader.find(asElementId(raw));
      if (!el || ("deleted" in el && el.deleted)) refuse("element_not_found", `${raw} no longer exists. Someone may have removed it; select again.`, [asElementId(raw)]);
      if (!isOrganized(el)) refuse("wrong_kind", `A ${el.kind.replace(/_/g, " ")} has no group or phase; only model elements (ducts, pipes, parts, walls…) do.`, [el.id]);
      const next = change(el);
      if (!next || next === el) continue;
      this.write(next);
      changed++;
      for (const f of fields) {
        const value = organizationFieldValue(next, ORG_FIELDS[f]);
        if (value !== undefined) this.authored.push({ elementId: el.id, field: ORG_FIELDS[f], value });
      }
    }
    return changed;
  }

  done(summary?: string[]): ExecuteResult {
    const authored = this.authored;
    return finish(this.reader, this.working, this.touched, authored, () => authored.map((a) => ({ kind: "field_equals" as const, elementId: a.elementId, field: a.field, value: a.value })), summary && summary.length > 0 ? { summary } : {});
  }
}

function liveGroup(org: Organization, groupId: string): Resolved<GroupEntry> {
  const g = org.groupById.get(groupId);
  if (!g) refuse("element_not_found", `There is no group "${groupId}". It may have been deleted; reopen Manage groups.`, [asElementId(groupId)]);
  return g;
}

function livePhase(org: Organization, phaseId: string): Resolved<PhaseEntry> {
  const i = org.phaseIndex.get(phaseId);
  const p = i === undefined ? undefined : org.phases[i];
  if (!p) refuse("element_not_found", `There is no phase "${phaseId}". It may have been deleted; reopen Manage phases.`, [asElementId(phaseId)]);
  return p;
}

function liveFilter(org: Organization, filterId: string): Resolved<PhaseFilterEntry> {
  const f = org.filterById.get(filterId);
  if (!f) refuse("element_not_found", `There is no phase filter "${filterId}". It may have been deleted.`, [asElementId(filterId)]);
  return f;
}

function mustBeNewId(edit: Edit, elementId: string): void {
  if (edit.model.elements[elementId] || [...DEFAULT_GROUPS, ...DEFAULT_PHASES, ...DEFAULT_PHASE_FILTERS, ...DEFAULT_TAG_STYLES].some((d) => d.id === elementId) || elementId === ORGANIZATION_SETTINGS_ID) {
    refuse("already_exists", `${elementId} is already used; choose a new id`, [asElementId(elementId)]);
  }
}

/** Order for a phase placed right after `after` (null: first; undefined: last), skipping `self`. */
function phaseOrderAfter(org: Organization, after: string | null | undefined, self: string | null): number {
  const others = org.phases.filter((p) => p.id !== self);
  if (after === undefined) return orderBetween(others[others.length - 1]?.entry.order, undefined);
  if (after === null) return orderBetween(undefined, others[0]?.entry.order);
  const i = others.findIndex((p) => p.id === after);
  if (i < 0) refuse("element_not_found", `There is no phase "${after}" to put it after.`, [asElementId(after)]);
  return orderBetween(others[i]?.entry.order, others[i + 1]?.entry.order);
}

function phaseName(org: Organization, phaseId: string): string {
  const i = org.phaseIndex.get(phaseId);
  return (i === undefined ? undefined : org.phases[i]?.entry.name) ?? phaseId;
}

/** Elements that would be demolished before (or without being) created; a plain refusal if any. */
function checkPhaseOrder(org: Organization, el: BimElement, created: string, demolished: string | null): void {
  if (demolished === null) return;
  const c = org.phaseIndex.get(created) ?? 0;
  const d = org.phaseIndex.get(demolished) ?? 0;
  if (d < c) {
    refuse("invalid_value", `It can't be demolished in "${phaseName(org, demolished)}": it is created in "${phaseName(org, created)}", which comes later.`, [el.id]);
  }
}

/** `ids` as elements in model order; null when the record can't be ordered without sealing it (an unconfirmed prediction). */
function inModelOrder(model: ModelState, ids: Iterable<ElementId>): BimElement[] | null {
  if (!isFrozenElements(model.elements)) return null;
  const order = elementOrder(model.elements);
  const out: BimElement[] = [];
  for (const id of ids) {
    const el = model.elements[id];
    if (el) out.push(el);
  }
  return out.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

function membersOfGroup(model: ModelState, org: Organization, groupId: string): BimElement[] {
  const member = (el: BimElement) => isOrganized(el) && !("deleted" in el && el.deleted) && groupIdOf(org, el) === groupId;
  // Elements in a named group store its id; the default group also holds everything that names none.
  const candidates = groupId === DEFAULT_GROUP_ID ? null : inModelOrder(model, organizationMembersOf(model.elements).byGroup.get(groupId) ?? []);
  if (candidates) return candidates.filter(member);
  const out: BimElement[] = [];
  for (const el of elementValues(model.elements)) if (member(el)) out.push(el);
  return out;
}

function usersOfPhase(model: ModelState, phaseId: string): number {
  const m = organizationMembersOf(model.elements);
  return (m.created.get(phaseId) ?? 0) + (m.demolishedIn.get(phaseId) ?? 0) - (m.both.get(phaseId) ?? 0);
}

export function executeOrganizationCommand(model: ModelState, command: OrganizationCommand): ExecuteResult {
  return guard(() => {
    const edit = new Edit(model);
    const org = edit.org;
    switch (command.type) {
      case "create_group": {
        mustBeNewId(edit, command.groupId);
        uniqueName(org.groups, command.name, null, "group");
        const last = org.groups[org.groups.length - 1]?.entry.order;
        edit.putEntry(command.groupId, {
          type: "group",
          name: command.name,
          color: command.color ?? "#0ea5e9",
          description: command.description ?? "",
          locked: false,
          defaultVisibility: command.defaultVisibility ?? "show",
          order: orderBetween(last, undefined),
        });
        return edit.done();
      }
      case "update_group": {
        const g = liveGroup(org, command.groupId);
        if (command.name !== undefined) uniqueName(org.groups, command.name, g.id, "group");
        edit.putEntry(g.id, {
          ...g.entry,
          ...(command.name !== undefined ? { name: command.name } : {}),
          ...(command.color !== undefined ? { color: command.color } : {}),
          ...(command.description !== undefined ? { description: command.description } : {}),
          ...(command.defaultVisibility !== undefined ? { defaultVisibility: command.defaultVisibility } : {}),
        });
        return edit.done();
      }
      case "lock_group": {
        const g = liveGroup(org, command.groupId);
        if (g.entry.locked === command.locked) return edit.done([`"${g.entry.name}" is already ${command.locked ? "locked" : "unlocked"}`]);
        edit.putEntry(g.id, { ...g.entry, locked: command.locked });
        return edit.done([command.locked ? `"${g.entry.name}" is locked: its elements can't be changed until it is unlocked` : `"${g.entry.name}" is unlocked`]);
      }
      case "delete_group": {
        const g = liveGroup(org, command.groupId);
        if (g.id === DEFAULT_GROUP_ID) refuse("in_use", `"${g.entry.name}" holds everything not in another group, so it can't be deleted. Rename it instead.`, [asElementId(g.id)]);
        if (g.entry.locked) refuse("in_use", `"${g.entry.name}" is locked. Unlock it before deleting it.`, [asElementId(g.id)]);
        const members = membersOfGroup(model, org, g.id);
        const summary: string[] = [];
        if (members.length > 0) {
          if (command.moveTo === undefined) {
            refuse("has_dependents", `${plural(members.length, "element")} ${members.length === 1 ? "is" : "are"} in "${g.entry.name}". Choose a group to move ${members.length === 1 ? "it" : "them"} to, then delete.`, members.slice(0, 50).map((m) => m.id));
          }
          const target = liveGroup(org, command.moveTo);
          if (target.id === g.id) refuse("invalid_value", "Move the elements to a different group than the one being deleted.", [asElementId(g.id)]);
          edit.members(members.map((m) => m.id), (el) => moveToGroup(el, target.id), ["groupId"]);
          summary.push(`${plural(members.length, "element")} moved to "${target.entry.name}"`);
        }
        if (org.activeGroupId === g.id) {
          const next = command.moveTo ?? DEFAULT_GROUP_ID;
          edit.setSettings({ activeGroupId: next });
          summary.push(`"${org.groupById.get(next)?.entry.name ?? "General"}" is now the active group`);
        }
        edit.putEntry(g.id, g.entry, true);
        return edit.done(summary);
      }
      case "set_active_group": {
        const g = liveGroup(org, command.groupId);
        if (g.entry.locked) refuse("in_use", `"${g.entry.name}" is locked, so new elements can't go in it. Unlock it first, or pick another group.`, [asElementId(g.id)]);
        edit.setSettings({ activeGroupId: g.id });
        return edit.done();
      }
      case "assign_elements_to_group": {
        const g = liveGroup(org, command.groupId);
        const n = edit.members(command.ids, (el) => moveToGroup(el, g.id), ["groupId"]);
        return edit.done([n === 0 ? `Already in "${g.entry.name}"` : `${plural(n, "element")} moved to "${g.entry.name}"`]);
      }
      case "set_group_typical": {
        const g = liveGroup(org, command.groupId);
        if (g.id === DEFAULT_GROUP_ID) refuse("invalid_value", `"${g.entry.name}" holds everything not in another group, so it can't be a typical. Put one unit's elements in their own group first.`, [asElementId(g.id)]);
        if (g.entry.locked) refuse("in_use", `"${g.entry.name}" is locked. Unlock it before changing its copies.`, [asElementId(g.id)]);
        if (command.copies && command.array) refuse("invalid_value", "Give the copies as a list or as an array (count, columns, spacing), not both.", [asElementId(g.id)]);
        const prev = g.entry.typical;
        const mark = command.mark ?? prev?.mark ?? "001";
        const copies: TypicalCopy[] = command.array
          ? arrayCopies(g.id, mark, command.array.count, command.array.columns, command.array.spacingMm)
          : command.copies
            ? command.copies.map((c) => ({ id: `${g.id}:${c.mark}`, mark: c.mark, offset: c.offset, rotationDeg: c.rotationDeg ?? 0, ...(c.mirror ? { mirror: { axis: c.mirror.axis } } : {}) }))
            : [...(prev?.copies ?? [])];
        // Mixed versions: a mirrored copy goes only to peers that draw and check it mirrored (an older one would draw it unflipped).
        if (command.copies?.some((c) => c.mirror !== undefined) && !peerReads(TYPICALS_MIRROR_FEATURE)) {
          refuse("invalid_value", "This can't be saved yet: the model server this model is open on is an older version that doesn't draw mirrored copies. Try again once the server is updated", [asElementId(g.id)]);
        }
        const marks = new Set([mark]);
        for (const c of copies) {
          if (marks.has(c.mark)) refuse("already_exists", `Two instances of "${g.entry.name}" are both marked ${c.mark}. Give each its own mark.`, [asElementId(g.id)]);
          marks.add(c.mark);
        }
        const phaseRotation = command.phaseRotation ?? prev?.phaseRotation;
        const typical: TypicalSpec = { label: command.label ?? prev?.label ?? "Unit", mark, basePoint: command.basePoint ?? prev?.basePoint ?? { x: 0, y: 0 }, copies, ...(phaseRotation ? { phaseRotation } : {}) };
        edit.putEntry(g.id, { ...g.entry, typical });
        return edit.done([`"${g.entry.name}" is a typical ${typical.label.toLowerCase()}: ${plural(copies.length + 1, "instance")} (${mark} and ${plural(copies.length, "copy", "copies")}); loads count ${copies.length + 1}× where it is served from outside it`]);
      }
      case "clear_group_typical": {
        const g = liveGroup(org, command.groupId);
        if (!g.entry.typical) return edit.done([`"${g.entry.name}" isn't a typical`]);
        if (g.entry.locked) refuse("in_use", `"${g.entry.name}" is locked. Unlock it before changing its copies.`, [asElementId(g.id)]);
        const { typical: _gone, ...rest } = g.entry;
        edit.putEntry(g.id, rest);
        return edit.done([`"${g.entry.name}" is no longer a typical: its copies are gone and its loads count once`]);
      }
      case "set_print_black_only": {
        if (!peerReads(DOCUMENTS_PRINT_BLACK_ONLY_FEATURE)) refuse("invalid_value", "Black-only printing can't be saved yet: the model server this model is open on is an older version. Try again once the server is updated", []);
        if (org.printBlackOnly === command.blackOnly) return edit.done([command.blackOnly ? "Sheets already print black only" : "Sheets already print in colour"]);
        edit.setSettings({ printBlackOnly: command.blackOnly });
        return edit.done([command.blackOnly ? "Sheets now print black only: colours print black, halftone stays grey" : "Sheets now print in colour"]);
      }
      case "set_typical_cap": {
        if (org.typicalCap === command.cap) return edit.done([`The contract already covers ${plural(command.cap, "typical")}`]);
        edit.setSettings({ typicalCap: command.cap });
        const n = org.groups.filter((g) => g.entry.typical).length;
        return edit.done([`The contract covers ${plural(command.cap, "typical")}${n > command.cap ? `; this project has ${n}` : ""}`]);
      }
      case "create_phase": {
        mustBeNewId(edit, command.phaseId);
        uniqueName(org.phases, command.name, null, "phase");
        edit.putEntry(command.phaseId, { type: "phase", name: command.name, order: phaseOrderAfter(org, command.after, null) });
        return edit.done();
      }
      case "update_phase": {
        const p = livePhase(org, command.phaseId);
        if (command.name !== undefined) uniqueName(org.phases, command.name, p.id, "phase");
        const order = command.after === undefined ? p.entry.order : phaseOrderAfter(org, command.after, p.id);
        if (order !== p.entry.order) checkReorder(model, org, p.id, order);
        edit.putEntry(p.id, { ...p.entry, ...(command.name !== undefined ? { name: command.name } : {}), order });
        return edit.done();
      }
      case "delete_phase": {
        const p = livePhase(org, command.phaseId);
        if (p.id === DEFAULT_PHASE_ID) refuse("in_use", `"${p.entry.name}" is the phase elements without one are created in, so it can't be deleted. Rename it instead.`, [asElementId(p.id)]);
        if (org.phases.length <= 1) refuse("in_use", "A model needs at least one phase.", [asElementId(p.id)]);
        const used = usersOfPhase(model, p.id);
        if (used > 0) refuse("in_use", `${plural(used, "element")} ${used === 1 ? "is" : "are"} created or demolished in "${p.entry.name}". Move them to another phase first.`, [asElementId(p.id)]);
        const views = documentIndex(model).views.filter((v) => v.props?.phaseId === p.id);
        if (views.length > 0) refuse("in_use", `${plural(views.length, "view")} ${views.length === 1 ? "shows" : "show"} "${p.entry.name}" (${views.slice(0, 3).map((v) => v.name).join(", ")}). Give ${views.length === 1 ? "it" : "them"} another phase first.`, views.map((v) => v.id));
        if (org.activePhaseId === p.id) edit.setSettings({ activePhaseId: DEFAULT_PHASE_ID });
        edit.putEntry(p.id, p.entry, true);
        return edit.done();
      }
      case "set_active_phase": {
        const p = livePhase(org, command.phaseId);
        edit.setSettings({ activePhaseId: p.id });
        return edit.done();
      }
      case "set_element_phases": {
        if (command.phaseCreated !== undefined) livePhase(org, command.phaseCreated);
        if (command.phaseDemolished) livePhase(org, command.phaseDemolished);
        const n = edit.members(command.ids, (el) => {
          const created = command.phaseCreated ?? phaseCreatedOf(org, el);
          const demolished = command.phaseDemolished === undefined ? phaseDemolishedOf(org, el) : command.phaseDemolished;
          checkPhaseOrder(org, el, created, demolished);
          return withPhases(el, created, demolished);
        }, ["phaseCreated", "phaseDemolished"]);
        return edit.done(n === 0 ? ["Nothing changed: the phases were already set"] : []);
      }
      case "demolish_elements": {
        const phaseId = command.phaseId ?? org.activePhaseId;
        const p = livePhase(org, phaseId);
        const n = edit.members(command.ids, (el) => {
          const created = phaseCreatedOf(org, el);
          checkPhaseOrder(org, el, created, p.id);
          return withPhases(el, created, p.id);
        }, ["phaseDemolished"]);
        return edit.done([`${plural(n, "element")} demolished in "${p.entry.name}"`]);
      }
      case "undemolish_elements": {
        const n = edit.members(command.ids, (el) => withPhases(el, phaseCreatedOf(org, el), null), ["phaseDemolished"]);
        return edit.done([n === 0 ? "Nothing was demolished" : `${plural(n, "element")} no longer demolished`]);
      }
      case "create_phase_filter": {
        mustBeNewId(edit, command.filterId);
        uniqueName(org.filters, command.name, null, "phase filter");
        const last = org.filters[org.filters.length - 1]?.entry.order;
        edit.putEntry(command.filterId, { type: "phase_filter", name: command.name, statuses: command.statuses, order: orderBetween(last, undefined) });
        return edit.done();
      }
      case "update_phase_filter": {
        const f = liveFilter(org, command.filterId);
        if (command.name !== undefined) uniqueName(org.filters, command.name, f.id, "phase filter");
        const statuses: Record<PhaseStatus, PhaseFilterEntry["statuses"][PhaseStatus]> = { ...f.entry.statuses };
        for (const s of PHASE_STATUSES) {
          const v = command.statuses?.[s];
          if (v !== undefined) statuses[s] = v;
        }
        edit.putEntry(f.id, { ...f.entry, ...(command.name !== undefined ? { name: command.name } : {}), statuses });
        return edit.done();
      }
      case "delete_phase_filter": {
        const f = liveFilter(org, command.filterId);
        if (org.filters.length <= 1) refuse("in_use", "A model needs at least one phase filter.", [asElementId(f.id)]);
        const views = documentIndex(model).views.filter((v) => v.props?.phaseFilterId === f.id);
        if (views.length > 0) refuse("in_use", `${plural(views.length, "view")} ${views.length === 1 ? "uses" : "use"} "${f.entry.name}" (${views.slice(0, 3).map((v) => v.name).join(", ")}). Give ${views.length === 1 ? "it" : "them"} another filter first.`, views.map((v) => v.id));
        edit.putEntry(f.id, f.entry, true);
        return edit.done();
      }
      case "create_tag_style": {
        tagStyleKindsStored([...(command.defaultFor ?? []), ...(command.appliesTo ?? [])]);
        tagStyleArrowStored(command.arrow);
        mustBeNewId(edit, command.styleId);
        uniqueName(org.tagStyles, command.name, null, "tag style");
        const defaultFor = command.defaultFor ?? [];
        defaultsWithinAppliesTo(defaultFor, command.appliesTo ?? []);
        const summary = takeDefaults(edit, org, command.styleId, defaultFor);
        const last = org.tagStyles[org.tagStyles.length - 1]?.entry.order;
        edit.putEntry(command.styleId, {
          type: "tag_style",
          name: command.name,
          lines: [...command.lines],
          textSizeMm: command.textSizeMm ?? 2.4,
          leader: command.leader ?? false,
          box: command.box ?? "none",
          defaultFor: [...defaultFor],
          order: orderBetween(last, undefined),
          ...tagStyleExtrasFrom(undefined, command),
        });
        return edit.done(summary);
      }
      case "update_tag_style": {
        tagStyleKindsStored([...(command.defaultFor ?? []), ...(command.appliesTo ?? [])]);
        tagStyleArrowStored(command.arrow);
        const s = liveTagStyle(org, command.styleId);
        if (command.name !== undefined) uniqueName(org.tagStyles, command.name, s.id, "tag style");
        defaultsWithinAppliesTo(command.defaultFor ?? s.entry.defaultFor, command.appliesTo ?? s.entry.appliesTo ?? []);
        const summary = command.defaultFor ? takeDefaults(edit, org, s.id, command.defaultFor) : [];
        edit.putEntry(s.id, {
          ...tagStyleBase(s.entry),
          ...tagStyleExtrasFrom(s.entry, command),
          ...(command.name !== undefined ? { name: command.name } : {}),
          ...(command.lines !== undefined ? { lines: [...command.lines] } : {}),
          ...(command.textSizeMm !== undefined ? { textSizeMm: command.textSizeMm } : {}),
          ...(command.leader !== undefined ? { leader: command.leader } : {}),
          ...(command.box !== undefined ? { box: command.box } : {}),
          ...(command.defaultFor !== undefined ? { defaultFor: [...command.defaultFor] } : {}),
        });
        const users = tagsUsingStyle(model, s.id);
        if (users > 0) summary.push(`${plural(users, "tag")} using "${command.name ?? s.entry.name}" ${users === 1 ? "updates" : "update"}`);
        return edit.done(summary);
      }
      case "delete_tag_style": {
        const s = liveTagStyle(org, command.styleId);
        const users = tagsUsingStyle(model, s.id);
        if (users > 0) refuse("in_use", `${plural(users, "tag")} ${users === 1 ? "uses" : "use"} "${s.entry.name}". Give ${users === 1 ? "it" : "them"} another style first.`, [asElementId(s.id)]);
        edit.putEntry(s.id, s.entry, true);
        return edit.done();
      }
      case "set_model_addon":
        return setModelAddon(edit, command);
      case "pin_firm_discipline":
        return pinFirmDiscipline(edit, command);
      case "unpin_firm_discipline":
        return unpinFirmDiscipline(edit, command);
      case "set_project_parameters":
        return setProjectParameters(edit, command);
    }
  });
}

function setProjectParameters(edit: Edit, command: Extract<OrganizationCommand, { type: "set_project_parameters" }>): ExecuteResult {
  if (!peerReads(PROJECT_PARAMETERS_FEATURE)) {
    refuse("invalid_value", "Project information can't be saved yet: the model server this model is open on is an older version that doesn't store it. Try again once the server is updated", []);
  }
  const defined = new Map((command.define ?? []).map((d) => [d.key, d]));
  const stored = new Map(edit.org.projectParameters.map((p) => [p.entry.key, p.entry]));
  const summary: string[] = [];
  const entries = Object.entries(command.values);
  if (entries.length === 0) refuse("invalid_value", "Say which project facts to set", []);
  for (const [key, raw] of entries) {
    const recordId = projectParameterId(key);
    const own = defined.get(key);
    const standard = standardProjectParameter(key);
    if (own && standard) refuse("invalid_value", `${standard.label} is a standard project fact; it can't be redefined`, [asElementId(recordId)]);
    const keptDef = stored.get(key)?.def;
    const entryDef: ProjectParameterEntry["def"] | undefined = own ? { label: own.label, valueType: own.valueType, ...(own.choices ? { choices: [...own.choices] } : {}) } : keptDef;
    const def: ProjectParameterDef | undefined = standard ?? (entryDef ? { key, group: "project", ...entryDef } : undefined);
    if (!def) refuse("invalid_value", `"${key}" isn't a project fact yet. Define it (its label and whether it is text, a date or a list) before setting it`, [asElementId(recordId)]);
    if (def.valueType === "choice" && (def.choices ?? []).length === 0) refuse("invalid_value", `${def.label} is a list, so it needs its choices`, [asElementId(recordId)]);
    const clearing = raw === null || raw.trim() === "";
    const previous = stored.get(key);
    if (clearing) {
      if (!previous) continue;
      edit.putEntry(recordId, { ...previous, value: "" }, true);
      summary.push(`${def.label} cleared`);
      continue;
    }
    const parsed = parseParameterValue(def, raw);
    if (!parsed.ok) refuse("invalid_value", parsed.reason, [asElementId(recordId)]);
    if (previous && previous.value === parsed.value && canonicalJson(previous.def ?? null) === canonicalJson(entryDef ?? null)) continue;
    edit.putEntry(recordId, { type: "project_parameter", key, value: parsed.value, ...(entryDef ? { def: entryDef } : {}) });
    summary.push(`${def.label}: ${parsed.value}`);
  }
  return edit.done(summary);
}

/** Setup entries go only to peers that store them (mixed-version: tolerant readers, strict writers). */
function requireSetupPeers(): void {
  if (!peerReads(ORGANIZATION_SETUP_FEATURE)) {
    refuse("invalid_value", "This can't be saved yet: the model server this model is open on is an older version that doesn't store add-on and discipline settings. Try again once the server is updated", []);
  }
}

function setModelAddon(edit: Edit, command: Extract<OrganizationCommand, { type: "set_model_addon" }>): ExecuteResult {
  const recordId = asElementId(addonSetupId(command.packId));
  if (isFirstPartyPackId(command.packId)) refuse("invalid_value", `${firstPartyPackName(command.packId) ?? command.packId} is built in: every model has it, so it can't be switched per model`, [recordId]);
  requireSetupPeers();
  if ((command.digest === undefined) !== (command.tier === undefined)) refuse("invalid_value", "An outside add-on's switch names both the build it was reviewed as and its trust tier, or neither", [recordId]);
  if (command.digest !== undefined && !peerReads(PACKS_OUTSIDE_PINS_FEATURE)) {
    refuse("invalid_value", "This can't be saved yet: the model server this model is open on is an older version that doesn't store which build of an outside add-on a model uses. Try again once the server is updated", [recordId]);
  }
  const host = modelSetupHostPacks();
  const pack = host?.find((p) => p.manifest.id === command.packId && p.manifest.version === command.version) ?? null;
  const packName = pack?.manifest.name ?? host?.find((p) => p.manifest.id === command.packId)?.manifest.name ?? command.packId;
  if (command.on && !pack) {
    const other = host?.find((p) => p.manifest.id === command.packId);
    refuse("invalid_value", other ? `This server has ${packName} ${other.manifest.version}, not ${command.version}. Switch on the version it has` : `${packName} ${command.version} isn't installed on this server, so it can't be switched on. Settings › MutinyBIM library › Add-ons lists what is installed`, [recordId]);
  }
  const current = edit.org.addons.find((a) => a.entry.packId === command.packId);
  const pinnedInSettings = (edit.model.settings.packs ?? []).find((p) => p.id === command.packId);
  const nowOn = current ? current.entry.on : pinnedInSettings !== undefined;
  const nowVersion = current?.entry.version ?? pinnedInSettings?.version;
  // The build the switch keeps: the command's, else the one already recorded for this version (switching off and on never drops it).
  const kept = current?.entry.version === command.version && current.entry.digest !== undefined ? current.entry : pinnedInSettings?.version === command.version && pinnedInSettings.digest !== undefined ? pinnedInSettings : null;
  const build = command.digest !== undefined && isPackDigest(command.digest) && command.tier !== undefined ? { digest: command.digest, tier: command.tier } : kept?.digest !== undefined ? { digest: kept.digest, ...(kept.tier !== undefined ? { tier: kept.tier } : {}) } : {};
  const nowDigest = current?.entry.digest ?? pinnedInSettings?.digest;
  if (nowOn === command.on && (!command.on || (nowVersion === command.version && (command.digest === undefined || nowDigest === command.digest)))) return edit.done([`${packName} is already ${command.on ? "on" : "off"} for this model`]);
  if (command.on && host) {
    const problems = setupProblems(setupWithSwitch(edit.model, command.packId, command.version, true, build), host);
    if (problems.length > 0) refuse("invalid_value", `${packName} can't be switched on for this model: ${problems.join("; ")}`, [recordId]);
  }
  edit.putEntry(recordId, { type: "addon", packId: command.packId, version: command.version, on: command.on, ...build });
  return edit.done([command.on ? `${packName} is on for this model` : `${packName} is off for this model: its rows are hidden; nothing is deleted`]);
}

function pinFirmDiscipline(edit: Edit, command: Extract<OrganizationCommand, { type: "pin_firm_discipline" }>): ExecuteResult {
  const def = disciplineDefOf(command.discipline);
  const recordId = asElementId(disciplineSetupId(def.id));
  requireSetupPeers();
  const others = edit.org.pinnedDisciplines.map((d) => d.entry.discipline).filter((d) => d.id !== def.id);
  if (def.parent !== undefined && !others.some((d) => d.id === def.parent) && !isRegisteredDiscipline(def.parent)) {
    refuse("invalid_value", `${def.label} is filed under "${def.parent}", which this model doesn't have. Pin that discipline first, or switch on the add-on it comes from`, [recordId]);
  }
  if (isRegisteredDiscipline(def.id) && !edit.org.pinnedDisciplines.some((d) => d.entry.discipline.id === def.id)) {
    refuse("already_exists", `${disciplineLabel(def.id)} is already a discipline on this model`, [recordId]);
  }
  const current = edit.org.pinnedDisciplines.find((d) => d.entry.discipline.id === def.id);
  if (current && canonicalJson(current.entry.discipline) === canonicalJson(def)) return edit.done([`${def.label} is already pinned to this model`]);
  const problems = setupProblems(setupWithFirm(edit.model, [...others, def]), modelSetupHostPacks() ?? []);
  if (problems.length > 0) refuse("invalid_value", `${def.label} can't be pinned: ${problems.join("; ")}`, [recordId]);
  edit.putEntry(recordId, { type: "discipline", discipline: def });
  return edit.done([current ? `${def.label} on this model now matches the firm library` : `${def.label} is a discipline on this model`]);
}

function unpinFirmDiscipline(edit: Edit, command: Extract<OrganizationCommand, { type: "unpin_firm_discipline" }>): ExecuteResult {
  const recordId = asElementId(disciplineSetupId(command.disciplineId));
  const current = edit.org.pinnedDisciplines.find((d) => d.entry.discipline.id === command.disciplineId);
  if (!current) refuse("element_not_found", `"${command.disciplineId}" isn't pinned to this model`, [recordId]);
  requireSetupPeers();
  const children = edit.org.pinnedDisciplines.filter((d) => d.entry.discipline.parent === command.disciplineId);
  if (children.length > 0) refuse("has_dependents", `${children.map((d) => d.entry.discipline.label).join(", ")} ${children.length === 1 ? "is" : "are"} filed under ${current.entry.discipline.label}. Unpin ${children.length === 1 ? "it" : "them"} first`, children.map((d) => asElementId(d.id)));
  let filed = 0;
  for (const el of partitionMembers(edit.model, (p) => p.discipline === command.disciplineId)) if (!("deleted" in el && el.deleted)) filed++;
  edit.putEntry(recordId, current.entry, true);
  return edit.done([
    `${current.entry.discipline.label} is no longer a discipline on this model`,
    ...(filed > 0 ? [`${plural(filed, "element")} stay filed under it and keep its name; new work can't be filed there`] : []),
  ]);
}

/** The command's discipline as a stored row, without absent optional fields. */
function disciplineDefOf(input: Extract<OrganizationCommand, { type: "pin_firm_discipline" }>["discipline"]): DisciplineDef {
  return {
    id: input.id,
    label: input.label,
    ...(input.parent !== undefined ? { parent: input.parent } : {}),
    ...(input.group ? { group: { id: input.group.id, label: input.group.label } } : {}),
    display: { colour: input.display.colour, ...(input.display.icon !== undefined ? { icon: input.display.icon } : {}) },
    ...(input.defaultResponsibleRole !== undefined ? { defaultResponsibleRole: input.defaultResponsibleRole } : {}),
    ...(input.ifc ? { ifc: { ...(input.ifc.systemType !== undefined ? { systemType: input.ifc.systemType } : {}), ...(input.ifc.name !== undefined ? { name: input.ifc.name } : {}) } } : {}),
  };
}

type TagStyleExtrasInput = { readonly prefix?: string; readonly suffix?: string; readonly orientation?: TagStyleEntry["orientation"]; readonly units?: TagStyleEntry["units"]; readonly leaderEnd?: TagStyleEntry["leaderEnd"]; readonly appliesTo?: readonly TagStyleCategory[]; readonly arrow?: TagStyleArrow | "none" };

/** A style without its optional look fields, so an update can leave a cleared one out rather than store it empty. */
function tagStyleBase(entry: TagStyleEntry): TagStyleEntry {
  const { prefix: _p, suffix: _s, orientation: _o, units: _u, leaderEnd: _l, appliesTo: _a, arrow: _w, ...base } = entry;
  return base;
}

/** The optional look fields after a create or update: given ones win, "" / [] clear, the rest stay as they were. */
function tagStyleExtrasFrom(was: TagStyleEntry | undefined, c: TagStyleExtrasInput): Partial<TagStyleEntry> {
  const prefix = c.prefix ?? was?.prefix;
  const suffix = c.suffix ?? was?.suffix;
  const orientation = c.orientation ?? was?.orientation;
  const units = c.units ?? was?.units;
  const leaderEnd = c.leaderEnd ?? was?.leaderEnd;
  const appliesTo = c.appliesTo ?? was?.appliesTo;
  const arrow = c.arrow ?? was?.arrow;
  return {
    ...(prefix ? { prefix } : {}),
    ...(suffix ? { suffix } : {}),
    ...(orientation && orientation !== "horizontal" ? { orientation } : {}),
    ...(units && units !== "ft_in" ? { units } : {}),
    ...(leaderEnd && leaderEnd !== "dot" ? { leaderEnd } : {}),
    ...(appliesTo && appliesTo.length > 0 ? { appliesTo: [...appliesTo] } : {}),
    ...(arrow && arrow !== "none" ? { arrow } : {}),
  };
}

/** A style can only be the default for kinds it may label. */
function defaultsWithinAppliesTo(defaultFor: readonly TagStyleCategory[], appliesTo: readonly TagStyleCategory[]): void {
  if (appliesTo.length === 0) return;
  const outside = defaultFor.filter((k) => !appliesTo.includes(k));
  if (outside.length > 0) refuse("invalid_value", `A tag style can only be the default for kinds it labels. Add ${outside.map((k) => k.replace(/_/g, " ")).join(", ")} to what it applies to, or stop it being their default.`, []);
}

function liveTagStyle(org: Organization, styleId: string): Resolved<TagStyleEntry> {
  const s = org.tagStyleById.get(styleId);
  if (!s) refuse("element_not_found", `There is no tag style "${styleId}". It may have been deleted; reopen Tag styles.`, [asElementId(styleId)]);
  return s;
}

/** A kind is the default of one style: the kinds `styleId` now takes come off every other style. */
function takeDefaults(edit: Edit, org: Organization, styleId: string, kinds: readonly TagStyleCategory[]): string[] {
  const taking = new Set(kinds);
  const summary: string[] = [];
  for (const other of org.tagStyles) {
    if (other.id === styleId) continue;
    const kept = other.entry.defaultFor.filter((k) => !taking.has(k));
    if (kept.length === other.entry.defaultFor.length) continue;
    edit.putEntry(other.id, { ...other.entry, defaultFor: kept });
    summary.push(`"${other.entry.name}" is no longer the default for ${other.entry.defaultFor.filter((k) => taking.has(k)).map((k) => k.replace(/_/g, " ")).join(", ")}`);
  }
  return summary;
}

function tagsUsingStyle(model: ModelState, styleId: string): number {
  let n = 0;
  for (const items of documentIndex(model).itemsByOwner.values()) for (const el of items) if (!el.deleted && el.tag?.styleId === styleId) n++;
  return n;
}

function moveToGroup(el: BimElement, groupId: string): BimElement | null {
  const current = el.groupId ?? DEFAULT_GROUP_ID;
  if (current === groupId) return null;
  if (groupId === DEFAULT_GROUP_ID) {
    const { groupId: _cleared, ...rest } = el;
    return rest as BimElement;
  }
  return { ...el, groupId };
}

function withPhases(el: BimElement, created: string, demolished: string | null): BimElement | null {
  const nowCreated = el.phaseCreated ?? DEFAULT_PHASE_ID;
  const nowDemolished = el.phaseDemolished ?? null;
  if (nowCreated === created && nowDemolished === demolished) return null;
  const { phaseCreated: _c, phaseDemolished: _d, ...rest } = el;
  return { ...rest, ...(created !== DEFAULT_PHASE_ID ? { phaseCreated: created } : {}), ...(demolished !== null ? { phaseDemolished: demolished } : {}) } as BimElement;
}

/** Moving a phase in time must not leave anything demolished before it is created. */
function checkReorder(model: ModelState, org: Organization, phaseId: string, order: number): void {
  const orderOf = (id: string) => (id === phaseId ? order : (org.phases[org.phaseIndex.get(id) ?? -1]?.entry.order ?? 0));
  let bad = 0;
  let firstBad: ElementId | null = null;
  // Only an element that stores a demolished phase can be demolished before it is created.
  for (const el of inModelOrder(model, organizationMembersOf(model.elements).demolished) ?? elementValues(model.elements)) {
    if (!isOrganized(el)) continue;
    const demolished = phaseDemolishedOf(org, el);
    if (demolished === null) continue;
    const created = phaseCreatedOf(org, el);
    if (created !== phaseId && demolished !== phaseId) continue;
    if (orderOf(demolished) < orderOf(created)) {
      bad++;
      firstBad ??= el.id;
    }
  }
  if (bad > 0) refuse("invalid_value", `Moving "${phaseName(org, phaseId)}" there would put ${plural(bad, "element")} demolished before ${bad === 1 ? "it is" : "they are"} created. Change their phases first.`, firstBad ? [firstBad] : []);
}

/** Organization records an undo would remove that elements or views now name (undo is refused then). */
export function organizationUsers(model: ModelState, removedIds: readonly ElementId[]): ElementId[] {
  const gone = new Set<string>(removedIds.filter((rid) => model.elements[rid]?.kind === "organization"));
  if (gone.size === 0) return [];
  const users: ElementId[] = [];
  for (const el of elementValues(model.elements)) {
    if (gone.has(el.id)) continue;
    if (isOrganized(el) && ((el.groupId !== undefined && gone.has(el.groupId)) || (el.phaseCreated !== undefined && gone.has(el.phaseCreated)) || (el.phaseDemolished !== undefined && gone.has(el.phaseDemolished)))) users.push(el.id);
    else if (el.kind === "view" && !el.deleted && ((el.props?.phaseId && gone.has(el.props.phaseId)) || (el.props?.phaseFilterId && gone.has(el.props.phaseFilterId)))) users.push(el.id);
    else if (el.kind === "drawing_item" && !el.deleted && el.tag?.styleId && gone.has(el.tag.styleId)) users.push(el.id);
  }
  return users;
}
