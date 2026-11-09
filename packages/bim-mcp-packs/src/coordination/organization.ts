import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  GROUP_VISIBILITIES,
  PHASE_DISPLAYS,
  canonicalJson,
  commandSchema,
  documentIndex,
  elementValues,
  executeCommand,
  groupIdOf,
  isOrganizationCommand,
  isOrganized,
  organizationOf,
  phaseDemolishedOf,
  viewPhaseFilterId,
  viewPhaseId,
  displayContextOf,
  type Command,
  type ModelState,
  type Organization,
} from "@permitzip/bim-kernel";
import { installedPacks } from "@permitzip/bim-editor/contracts/building-model/installed-packs";
import { agentBranchSchema, readAgentBranchAction } from "./branch-input";
import type { BranchActions } from "./capabilities";
import { baseRevision, explain, failure, runEdit, target, text, withSession, type Extra, type ResolveBimCaller } from "../runtime";

/**
 * Groups and phases for agents: the same kernel commands the Building Model's
 * Manage › Groups & phases dialogs, status bar and properties panel send,
 * through the same model authority. Every edit pauses for approval in Cmd+J.
 * A locked group refuses agent edits exactly as it refuses a person's.
 */

const colorInput = z.string().regex(/^#[0-9a-fA-F]{6}$/).describe("Swatch colour, #rrggbb.");
const groupRef = z.string().min(1).max(200).describe("Group id or exact name (from bim_list_groups_and_phases).");
const phaseRef = z.string().min(1).max(200).describe("Phase id or exact name.");
const filterRef = z.string().min(1).max(200).describe("Phase filter id or exact name.");
const idsInput = z.array(z.string().min(1).max(200)).min(1).max(5000).describe("Element ids (from bim_query_elements or bim_inspect_network).");
const statusDisplay = z.enum(PHASE_DISPLAYS);

/**
 * `branch` on bim_set_active_group_and_phase (round 8b, product decision): the
 * call already paused for the person's Approve, like every edit here. Start:
 * a session on Main asks the model server for the branch, then the thread is
 * pointed at it. Propose: on the thread's branch. Never a preflight tool (a
 * check must not start anything), and nothing here approves or applies a merge.
 */
async function branchAction(caller: ResolveBimCaller, branches: BranchActions, extra: Extra, projectId: string, modelId: string, input: z.infer<typeof agentBranchSchema>) {
  try {
    const action = readAgentBranchAction(input);
    if (typeof action === "string") return failure(action);
    const who = await caller(extra, projectId, true);
    const actions = await branches(extra, projectId);
    const result =
      action.kind === "start"
        ? await withSession({ ...who, branchId: null }, modelId, undefined, (session) =>
            actions.start({
              session,
              name: action.name,
              ...(action.fromVersion !== undefined ? { fromVersion: action.fromVersion } : {}),
            }),
          )
        : await withSession(who, modelId, undefined, (session) => actions.proposeMerge({ session, userId: who.userId }));
    if (result.status === "refused") return failure(result.message);
    return text({ ...result, model_id: modelId });
  } catch (err) {
    return explain(err, "bim_set_active_group_and_phase");
  }
}

function stableId(prefix: string, extra: Extra, args: unknown): string {
  const who = extra.authInfo?.clientId ?? "agent";
  return `${prefix}-${createHash("sha256").update(canonicalJson({ who, args })).digest("hex").slice(0, 16)}`;
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function findGroup(org: Organization, ref: string): string | null {
  return org.groups.find((g) => g.id === ref || sameName(g.entry.name, ref))?.id ?? null;
}
function findPhase(org: Organization, ref: string): string | null {
  return org.phases.find((p) => p.id === ref || sameName(p.entry.name, ref))?.id ?? null;
}
function findFilter(org: Organization, ref: string): string | null {
  return org.filters.find((f) => f.id === ref || sameName(f.entry.name, ref))?.id ?? null;
}
function findView(model: ModelState, ref: string): string | null {
  const key = ref.trim().toLowerCase();
  return documentIndex(model).views.find((v) => v.id === ref || v.name.trim().toLowerCase() === key)?.id ?? null;
}

const notFound = (what: string, ref: string) => `No ${what} named or numbered "${ref}". List groups and phases first.`;

/** Groups, phases, filters and how each view uses them, as an agent reads them. */
export function listGroupsAndPhases(model: ModelState, withCounts: boolean) {
  const org = organizationOf(model);
  const counts = new Map<string, number>();
  let demolished = 0;
  if (withCounts) {
    for (const el of elementValues(model.elements)) {
      if (!isOrganized(el)) continue;
      const g = groupIdOf(org, el);
      counts.set(g, (counts.get(g) ?? 0) + 1);
      if (phaseDemolishedOf(org, el) !== null) demolished++;
    }
  }
  return {
    revision: model.revision,
    active_group: org.activeGroupId,
    active_phase: org.activePhaseId,
    typicals: { count: org.groups.filter((g) => g.entry.typical).length, contract_covers: org.typicalCap },
    groups: org.groups.map((g) => ({
      id: g.id,
      name: g.entry.name,
      color: g.entry.color,
      description: g.entry.description,
      locked: g.entry.locked,
      default_visibility: g.entry.defaultVisibility,
      ...(g.entry.typical ? { typical: { label: g.entry.typical.label, mark: g.entry.typical.mark, instances: g.entry.typical.copies.length + 1 } } : {}),
      ...(withCounts ? { elements: counts.get(g.id) ?? 0 } : {}),
    })),
    phases: org.phases.map((p, i) => ({ id: p.id, name: p.entry.name, order: i + 1 })),
    phase_filters: org.filters.map((f) => ({ id: f.id, name: f.entry.name, ...f.entry.statuses })),
    views: documentIndex(model).views.map((v) => {
      const ctx = displayContextOf(v);
      return { id: v.id, name: v.name, phase: viewPhaseId(org, ctx), phase_filter: viewPhaseFilterId(org, ctx), group_visibility: ctx.groupDisplay ?? {} };
    }),
    ...(withCounts ? { demolished_elements: demolished } : {}),
  };
}

export function registerBimOrganizationTools(server: McpServer, caller: ResolveBimCaller, branches: BranchActions) {
  server.registerTool(
    "bim_list_groups_and_phases",
    {
      title: "List groups and phases",
      description:
        "The model's groups (name, colour, locked, default visibility), phases in time order, phase filters (how new / existing / demolished / temporary elements draw), the active group and phase new work goes in, and each view's phase, filter and group visibility. include_counts adds elements per group (reads the whole model; skip on very large models unless needed). Every element is in one group; elements with no group are in General, with no phase are built in New construction.",
      inputSchema: { ...target, include_counts: z.boolean().optional() },
    },
    async (args, extra) => {
      try {
        const who = await caller(extra, args.project_id, false);
        return await withSession(who, args.model_id, undefined, async (s) => text(listGroupsAndPhases(s.model(), args.include_counts === true)));
      } catch (err) {
        return explain(err, "bim_list_groups_and_phases");
      }
    },
  );

  server.registerTool(
    "bim_preview_organization_edit",
    {
      title: "Preview a groups or phases change",
      description:
        "Run one groups/phases command against the latest revision without saving: what would change, or the plain reason it would be refused (a locked group, a phase in use, demolished before built). Commands: create_group, update_group, lock_group, delete_group (moveTo), set_active_group, assign_elements_to_group, create_phase, update_phase (after), delete_phase, set_active_phase, set_element_phases, demolish_elements, undemolish_elements, create_phase_filter, update_phase_filter, delete_phase_filter, set_group_typical (repeat a unit: array { count, columns, spacingMm } or copies; its loads count once per copy where it is served from outside), clear_group_typical. Ids, not names.",
      inputSchema: { ...target, command: z.record(z.string(), z.unknown()).describe("The kernel command, e.g. { type: 'assign_elements_to_group', ids: [...], groupId: 'grp-new' }.") },
    },
    async (args, extra) => {
      try {
        const parsed = commandSchema.safeParse(args.command);
        if (!parsed.success || !isOrganizationCommand(parsed.data)) return failure(`Not a groups or phases command: ${parsed.success ? parsed.data.type : (parsed.error.issues[0]?.message ?? "invalid")}`);
        const command = parsed.data;
        const who = await caller(extra, args.project_id, false);
        return await withSession(who, args.model_id, undefined, async (s) => {
          const model = s.model();
          const result = executeCommand(model, command);
          if (!result.ok) return text({ status: "would_be_refused", message: result.error.message, revision: model.revision });
          return text({ status: "would_save", revision: model.revision, changed: result.changedIds.length, changed_ids: result.changedIds.slice(0, 50), summary: result.summary ?? [] });
        });
      } catch (err) {
        return explain(err, "bim_preview_organization_edit");
      }
    },
  );

  server.registerTool(
    "bim_create_group",
    {
      title: "Create a group",
      description: "Add a group (e.g. 'Phase 2 tenant fit-out'). New work goes in it only once it is made active. Refused if the name is taken.",
      inputSchema: {
        ...target,
        ...baseRevision,
        name: z.string().trim().min(1).max(80),
        color: colorInput.optional(),
        description: z.string().max(400).optional(),
        default_visibility: z.enum(GROUP_VISIBILITIES).optional().describe("How views that don't set it show the group (default show)."),
      },
    },
    async (args, extra) =>
      runEdit(caller, "bim_create_group", extra, args, {
        type: "create_group",
        groupId: stableId("grp", extra, { name: args.name }),
        name: args.name,
        ...(args.color ? { color: args.color } : {}),
        ...(args.description !== undefined ? { description: args.description } : {}),
        ...(args.default_visibility ? { defaultVisibility: args.default_visibility } : {}),
      }),
  );

  server.registerTool(
    "bim_update_group",
    {
      title: "Change a group",
      description:
        "Rename a group, change its colour, description or default visibility, or lock / unlock it. Locked: nobody (people or agents) can create, change, move, demolish or delete its elements until it is unlocked. typical repeats the group (unit 001 x24: copies draw on plans and count in every trade's totals: drain, service, meter, project); typical null stops. Send locked or typical on its own call.",
      inputSchema: {
        ...target,
        ...baseRevision,
        group: groupRef,
        name: z.string().trim().min(1).max(80).optional(),
        color: colorInput.optional(),
        description: z.string().max(400).optional(),
        default_visibility: z.enum(GROUP_VISIBILITIES).optional(),
        locked: z.boolean().optional(),
        typical: z
          .object({ count: z.number().int().min(1).max(500).describe("Instances in all, the original included."), columns: z.number().int().min(1).max(100), spacing_ft: z.object({ x: z.number().finite(), y: z.number().finite() }).strict().describe("Apart across, and between rows (negative: down the plan)."), mark: z.string().trim().min(1).max(20).optional().describe("The original's mark (default 001); copies count on from it."), label: z.string().trim().min(1).max(40).optional(), phase_rotation: z.enum(["rotate", "same"]).optional().describe("rotate (default through a feeder): copies spread A-B, B-C, C-A on a 3-phase house panel; same: all on the original's phases.") })
          .strict()
          .nullable()
          .optional(),
      },
    },
    async (args, extra) =>
      editWithModel(caller, "bim_update_group", extra, args, (model) => {
        const groupId = findGroup(organizationOf(model), args.group);
        if (!groupId) return notFound("group", args.group);
        const other = args.name !== undefined || args.color !== undefined || args.description !== undefined || args.default_visibility !== undefined;
        if (args.typical !== undefined) {
          if (other || args.locked !== undefined) return "Make a group typical (or stop) on its own call, without other changes.";
          if (args.typical === null) return { type: "clear_group_typical", groupId };
          const t = args.typical;
          return { type: "set_group_typical", groupId, ...(t.label ? { label: t.label } : {}), ...(t.mark ? { mark: t.mark } : {}), ...(t.phase_rotation ? { phaseRotation: t.phase_rotation } : {}), array: { count: t.count, columns: t.columns, spacingMm: { x: t.spacing_ft.x * 304.8, y: t.spacing_ft.y * 304.8 } } };
        }
        if (args.locked !== undefined) {
          if (other) return "Lock or unlock a group on its own call, without other changes.";
          return { type: "lock_group", groupId, locked: args.locked };
        }
        if (!other) return "Nothing to change: give a name, color, description, default_visibility or locked.";
        return {
          type: "update_group",
          groupId,
          ...(args.name !== undefined ? { name: args.name } : {}),
          ...(args.color !== undefined ? { color: args.color } : {}),
          ...(args.description !== undefined ? { description: args.description } : {}),
          ...(args.default_visibility !== undefined ? { defaultVisibility: args.default_visibility } : {}),
        };
      }),
  );

  server.registerTool(
    "bim_delete_group",
    {
      title: "Delete a group",
      description: "Delete a group. If elements are in it, give move_to (the group they go to); without it a group with elements is refused. General can't be deleted. Undo brings the group back.",
      inputSchema: { ...target, ...baseRevision, group: groupRef, move_to: groupRef.optional() },
    },
    async (args, extra) =>
      editWithModel(caller, "bim_delete_group", extra, args, (model) => {
        const org = organizationOf(model);
        const groupId = findGroup(org, args.group);
        if (!groupId) return notFound("group", args.group);
        const moveTo = args.move_to === undefined ? undefined : findGroup(org, args.move_to);
        if (moveTo === null) return notFound("group", args.move_to ?? "");
        return { type: "delete_group", groupId, ...(moveTo ? { moveTo } : {}) };
      }),
  );

  server.registerTool(
    "bim_assign_to_group",
    {
      title: "Put elements in a group",
      description: "Move elements (a run, a branch, a box selection's ids) into a group. Refused, with nothing changed, if any of them, or the target, is in a locked group.",
      inputSchema: { ...target, ...baseRevision, element_ids: idsInput, group: groupRef },
    },
    async (args, extra) =>
      editWithModel(caller, "bim_assign_to_group", extra, args, (model) => {
        const groupId = findGroup(organizationOf(model), args.group);
        if (!groupId) return notFound("group", args.group);
        return { type: "assign_elements_to_group", ids: args.element_ids, groupId };
      }),
  );

  server.registerTool(
    "bim_set_active_group_and_phase",
    {
      title: "Set where new work goes",
      description: "Set the model's active group (new ducts, pipes and parts go in it) or active phase (new elements are built in it; demolish uses it), typical_cap, switch an add-on on or off for this model (addon), or branch: start one (Main is untouched) or propose this thread's branch to Main; people approve merges. Give one of them per call. A locked group can't be made active.",
      inputSchema: { ...target, ...baseRevision, group: groupRef.optional(), phase: phaseRef.optional(), typical_cap: z.number().int().min(1).max(500).optional().describe("How many typical types the contract covers; more is a coordination warning."), addon: z.object({ id: z.string().min(1).max(100), on: z.boolean() }).optional().describe("Add-on id (e.g. struct); off hides its rows, deletes nothing."), branch: agentBranchSchema.optional() },
    },
    async (args, extra) => {
      const given = [args.group, args.phase, args.typical_cap, args.addon, args.branch].filter((v) => v !== undefined).length;
      if (given !== 1) return failure("Give one of group, phase, typical_cap or addon per call, or branch on its own.");
      if (args.branch !== undefined) return branchAction(caller, branches, extra, args.project_id, args.model_id, args.branch);
      return editWithModel(caller, "bim_set_active_group_and_phase", extra, args, (model) => {
        const org = organizationOf(model);
        if (args.typical_cap !== undefined) return { type: "set_typical_cap", cap: args.typical_cap };
        if (args.addon !== undefined) {
          const ref = args.addon.id.trim().toLowerCase();
          const pack = installedPacks().find((p) => p.manifest.id === args.addon?.id || p.manifest.name.trim().toLowerCase() === ref);
          if (!pack) return `No add-on "${args.addon.id}" is installed here. Installed: ${installedPacks().map((p) => `${p.manifest.name} (${p.manifest.id})`).join(", ") || "none"}.`;
          return { type: "set_model_addon", packId: pack.manifest.id, version: pack.manifest.version, on: args.addon.on };
        }
        if (args.group !== undefined) {
          const groupId = findGroup(org, args.group);
          return groupId ? { type: "set_active_group", groupId } : notFound("group", args.group);
        }
        const phaseId = findPhase(org, args.phase ?? "");
        return phaseId ? { type: "set_active_phase", phaseId } : notFound("phase", args.phase ?? "");
      });
    },
  );

  server.registerTool(
    "bim_create_phase",
    {
      title: "Add a phase",
      description: "Add a phase in time order: after a named phase, first (after: null), or last (after absent).",
      inputSchema: { ...target, ...baseRevision, name: z.string().trim().min(1).max(80), after: phaseRef.nullable().optional() },
    },
    async (args, extra) =>
      editWithModel(caller, "bim_create_phase", extra, args, (model) => {
        const org = organizationOf(model);
        const after = args.after === undefined || args.after === null ? args.after : findPhase(org, args.after);
        if (after === null && args.after !== null && args.after !== undefined) return notFound("phase", args.after);
        return { type: "create_phase", phaseId: stableId("phase", extra, { name: args.name }), name: args.name, ...(after !== undefined ? { after } : {}) };
      }),
  );

  server.registerTool(
    "bim_update_phase",
    {
      title: "Rename or move a phase",
      description: "Rename a phase, or move it in time (after: a phase, or null for first). Moving is refused if something would be demolished before it is built.",
      inputSchema: { ...target, ...baseRevision, phase: phaseRef, name: z.string().trim().min(1).max(80).optional(), after: phaseRef.nullable().optional() },
    },
    async (args, extra) =>
      editWithModel(caller, "bim_update_phase", extra, args, (model) => {
        const org = organizationOf(model);
        const phaseId = findPhase(org, args.phase);
        if (!phaseId) return notFound("phase", args.phase);
        const after = args.after === undefined || args.after === null ? args.after : findPhase(org, args.after);
        if (after === null && args.after !== null && args.after !== undefined) return notFound("phase", args.after);
        if (args.name === undefined && after === undefined) return "Nothing to change: give a name or after.";
        return { type: "update_phase", phaseId, ...(args.name !== undefined ? { name: args.name } : {}), ...(after !== undefined ? { after } : {}) };
      }),
  );

  server.registerTool(
    "bim_delete_phase",
    {
      title: "Delete a phase",
      description: "Delete a phase nothing uses. Refused, with the reason, if any element is built or demolished in it, a view shows it, it is the default phase, or it is the last one. Undo brings it back.",
      inputSchema: { ...target, ...baseRevision, phase: phaseRef },
    },
    async (args, extra) =>
      editWithModel(caller, "bim_delete_phase", extra, args, (model) => {
        const phaseId = findPhase(organizationOf(model), args.phase);
        if (!phaseId) return notFound("phase", args.phase);
        return { type: "delete_phase", phaseId };
      }),
  );

  server.registerTool(
    "bim_delete_phase_filter",
    {
      title: "Delete a phase filter",
      description: "Delete a phase filter no view uses. Refused, with the views that use it, otherwise; the last filter can't be deleted. Undo brings it back.",
      inputSchema: { ...target, ...baseRevision, filter: filterRef },
    },
    async (args, extra) =>
      editWithModel(caller, "bim_delete_phase_filter", extra, args, (model) => {
        const filterId = findFilter(organizationOf(model), args.filter);
        if (!filterId) return notFound("phase filter", args.filter);
        return { type: "delete_phase_filter", filterId };
      }),
  );

  server.registerTool(
    "bim_set_element_phases",
    {
      title: "Set elements' phases, demolish or restore",
      description:
        "Set the phase elements are built in and/or demolished in (demolished_in: null = not demolished), or action 'demolish' (in the given phase, default the active phase) / 'restore' (not demolished). Refused if something would be demolished before it is built, or is in a locked group.",
      inputSchema: {
        ...target,
        ...baseRevision,
        element_ids: idsInput,
        action: z.enum(["set", "demolish", "restore"]).optional().describe("Default set."),
        built_in: phaseRef.optional(),
        demolished_in: phaseRef.nullable().optional(),
        phase: phaseRef.optional().describe("For demolish: the phase it is removed in (default the active phase)."),
      },
    },
    async (args, extra) =>
      editWithModel(caller, "bim_set_element_phases", extra, args, (model) => {
        const org = organizationOf(model);
        const action = args.action ?? "set";
        if (action === "restore") return { type: "undemolish_elements", ids: args.element_ids };
        if (action === "demolish") {
          const phaseId = args.phase === undefined ? undefined : findPhase(org, args.phase);
          if (phaseId === null) return notFound("phase", args.phase ?? "");
          return { type: "demolish_elements", ids: args.element_ids, ...(phaseId ? { phaseId } : {}) };
        }
        const created = args.built_in === undefined ? undefined : findPhase(org, args.built_in);
        if (created === null) return notFound("phase", args.built_in ?? "");
        const demolished = args.demolished_in === undefined || args.demolished_in === null ? args.demolished_in : findPhase(org, args.demolished_in);
        if (demolished === null && args.demolished_in !== null && args.demolished_in !== undefined) return notFound("phase", args.demolished_in);
        if (created === undefined && demolished === undefined) return "Nothing to change: give built_in, demolished_in, or an action.";
        return { type: "set_element_phases", ids: args.element_ids, ...(created ? { phaseCreated: created } : {}), ...(demolished !== undefined ? { phaseDemolished: demolished } : {}) };
      }),
  );

  server.registerTool(
    "bim_set_view_organization",
    {
      title: "Set a view's phase, filter and group visibility",
      description:
        "Set which phase a view shows the model as of, its phase filter, and per group show / halftone / hide in that view (only the groups given change). This reaches the live canvas, the printed drawing, sheets and PDF.",
      inputSchema: {
        ...target,
        ...baseRevision,
        view: z.string().min(1).max(200).describe("View id or exact name."),
        phase: phaseRef.optional(),
        phase_filter: filterRef.optional(),
        groups: z.record(z.string().min(1).max(200), z.enum(GROUP_VISIBILITIES)).optional().describe("Group id or name → show | halftone | hide."),
      },
    },
    async (args, extra) =>
      editWithModel(caller, "bim_set_view_organization", extra, args, (model) => {
        const org = organizationOf(model);
        const viewId = findView(model, args.view);
        if (!viewId) return `No view "${args.view}". List views and sheets first.`;
        const phaseId = args.phase === undefined ? undefined : findPhase(org, args.phase);
        if (phaseId === null) return notFound("phase", args.phase ?? "");
        const filterId = args.phase_filter === undefined ? undefined : findFilter(org, args.phase_filter);
        if (filterId === null) return notFound("phase filter", args.phase_filter ?? "");
        let groupDisplay: Record<string, (typeof GROUP_VISIBILITIES)[number]> | undefined;
        if (args.groups) {
          const view = model.elements[viewId];
          groupDisplay = { ...(view?.kind === "view" ? view.props?.groupDisplay : undefined) };
          for (const [ref, visibility] of Object.entries(args.groups)) {
            const groupId = findGroup(org, ref);
            if (!groupId) return notFound("group", ref);
            groupDisplay[groupId] = visibility;
          }
        }
        if (phaseId === undefined && filterId === undefined && groupDisplay === undefined) return "Nothing to change: give phase, phase_filter or groups.";
        return {
          type: "set_view_properties",
          viewId,
          props: { ...(phaseId ? { phaseId } : {}), ...(filterId ? { phaseFilterId: filterId } : {}), ...(groupDisplay ? { groupDisplay } : {}) },
        };
      }),
  );

  server.registerTool(
    "bim_set_phase_filter",
    {
      title: "Create or change a phase filter",
      description:
        "Create a phase filter (give name and all four statuses) or change one (give filter and any of name / statuses). Each status draws as show, halftone, dashed or hide. new = built in the view's phase; existing = built earlier and still there; demolished = removed in the view's phase; temporary = built and removed in it.",
      inputSchema: {
        ...target,
        ...baseRevision,
        filter: filterRef.optional().describe("Absent: create a new filter."),
        name: z.string().trim().min(1).max(80).optional(),
        new: statusDisplay.optional(),
        existing: statusDisplay.optional(),
        demolished: statusDisplay.optional(),
        temporary: statusDisplay.optional(),
      },
    },
    async (args, extra) =>
      editWithModel(caller, "bim_set_phase_filter", extra, args, (model) => {
        const statuses = {
          ...(args.new ? { new: args.new } : {}),
          ...(args.existing ? { existing: args.existing } : {}),
          ...(args.demolished ? { demolished: args.demolished } : {}),
          ...(args.temporary ? { temporary: args.temporary } : {}),
        };
        if (args.filter === undefined) {
          if (!args.name || !args.new || !args.existing || !args.demolished || !args.temporary) return "A new filter needs a name and all four of new, existing, demolished and temporary.";
          return { type: "create_phase_filter", filterId: stableId("pf", extra, { name: args.name }), name: args.name, statuses: { new: args.new, existing: args.existing, demolished: args.demolished, temporary: args.temporary } };
        }
        const filterId = findFilter(organizationOf(model), args.filter);
        if (!filterId) return notFound("phase filter", args.filter);
        if (args.name === undefined && Object.keys(statuses).length === 0) return "Nothing to change: give a name or a status.";
        return { type: "update_phase_filter", filterId, ...(args.name !== undefined ? { name: args.name } : {}), ...(Object.keys(statuses).length > 0 ? { statuses } : {}) };
      }),
  );
}

/** An edit whose command needs the current model (names → ids); a string is a plain refusal before anything is sent. */
async function editWithModel(
  caller: ResolveBimCaller,
  tool: string,
  extra: Extra,
  args: { project_id: string; model_id: string; base_revision?: number },
  build: (model: ModelState) => Command | string,
) {
  try {
    const who = await caller(extra, args.project_id, false);
    const built = await withSession(who, args.model_id, undefined, async (s) => build(s.model()));
    if (typeof built === "string") return failure(built);
    return runEdit(caller, tool, extra, args, built);
  } catch (err) {
    return explain(err, tool);
  }
}
