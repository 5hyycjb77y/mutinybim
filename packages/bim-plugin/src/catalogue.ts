/**
 * The MutinyBIM agent tool packs: the one place pack membership lives.
 *
 * Each pack is one MCP endpoint and one Agent Skill of the same name, so any
 * client (Claude, Cursor, ChatGPT, OpenCode or a host's own agent) connects
 * the core plus only the packs a job needs. MCP 2026-07-28 forbids a tool
 * list that grows because of an earlier call on the connection, so packs are
 * separate servers chosen up front, never a list that changes mid-session.
 *
 * Every tool is in exactly one pack. Tool names are frozen: models, skills
 * and stored threads have used them since round 3. Host-neutral: no host
 * code, no client data.
 */
import type { AgentToolPackDescriptor } from "@permitzip/bim-kernel/packs";

/** A catalogue pack: the kernel's pack row plus its member tools, in list order. */
export interface BimToolPack extends AgentToolPackDescriptor {
  /** Member tools in the order an endpoint lists them (stable, for caches and prompt caching). */
  readonly tools: readonly string[];
}

/**
 * The core pack's id: the tool server's default list (`@permitzip/bim-mcp`
 * `CORE_TOOLS`): the script tools and four reads. With `bim_enable_pack` it
 * stays within the server's ten-tool budget.
 */
export const CORE_PACK_ID = "core";

/** How long a client may keep a pack's tool list (MCP `ttlMs`). Short, so a deploy reaches clients quickly. */
export const PACK_LIST_TTL_MS = 300_000;

/** Any core + two packs stays under this many tool-text tokens per agent step. */
export const CORE_PLUS_TWO_TOKEN_TARGET = 34_000;

export const BIM_TOOL_PACKS: readonly BimToolPack[] = [
  {
    id: CORE_PACK_ID,
    label: "MutinyBIM core",
    purpose: "Write, check, preview and land scripts that read and change the model, save a part script's parts, and four reads to look before writing",
    skill: "mutinybim",
    slug: "core",
    tokenCap: 3_500,
    tools: [
      "bim_script_reference",
      "bim_check_output",
      "bim_run_script",
      "bim_apply_output",
      "bim_save_part_type",
      "bim_model_summary",
      "bim_query_elements",
      "bim_inspect_network",
      "bim_validation_issues",
    ],
  },
  {
    id: "model",
    label: "Model reads and everyday edits",
    purpose: "Schedule rows, levels, views and sheets, linked models, surfaces; previews and the everyday part edits; pictures, printing and issuing sheets; coordination lint",
    skill: "mutinybim-model",
    slug: "model",
    tokenCap: 9_600,
    tools: [
      "bim_schedule_read",
      "bim_list_part_types",
      "bim_list_levels",
      "bim_list_views_and_sheets",
      "bim_list_linked_models",
      "bim_surfaces_at",
      "bim_describe_commands",
      "bim_preview_part_edit",
      "bim_preview_route_edit",
      "bim_preview_views_sheets_edit",
      "bim_apply_views_sheets_edit",
      "bim_render_view_image",
      "bim_render_sheet_image",
      "bim_print_sheet_pdf",
      "bim_print_view_pdf",
      "bim_print_set_pdf",
      "bim_issue_set",
      "bim_place_part",
      "bim_move_elements",
      "bim_rotate_elements",
      "bim_copy_elements",
      "bim_delete_elements",
      "bim_set_parameters",
      "bim_move_wall",
      "bim_lint_configure",
      "bim_lint_check",
      "bim_status_snapshot",
    ],
  },
  {
    id: "drafting",
    label: "Drafting and annotation",
    purpose: "Dimensions, tags, notes with leaders, detail linework and detail components",
    skill: "mutinybim-drafting",
    slug: "drafting",
    tokenCap: 8_200,
    tools: [
      "bim_list_view_annotations",
      "bim_add_dimension",
      "bim_auto_dimension",
      "bim_add_tag",
      "bim_preview_auto_tag",
      "bim_auto_tag_view",
      "bim_add_note",
      "bim_edit_annotation",
      "bim_set_tag_text",
      "bim_list_tag_styles",
      "bim_save_tag_style",
      "bim_apply_tag_style",
      "bim_list_detail_components",
      "bim_draw_detail",
      "bim_modify_detail",
      "bim_copy_detail_items",
      "bim_set_detail_group",
    ],
  },
  {
    id: "ducts_pipes",
    label: "Duct and pipe runs",
    purpose: "Route, connect, resize, slope, insulate and fit duct and pipe runs",
    skill: "mutinybim-ducts-pipes",
    slug: "ducts-pipes",
    tokenCap: 10_800,
    tools: [
      "bim_route_run",
      "bim_connect_runs",
      "bim_disconnect_run",
      "bim_route_flex",
      "bim_resize_run",
      "bim_slide_branch",
      "bim_set_terminal_airflow",
      "bim_move_equipment",
      "bim_resize_riser",
      "bim_list_fitting_types",
      "bim_swap_fitting",
      "bim_offset_run",
      "bim_change_elevation",
      "bim_split_run",
      "bim_resize_stretch",
      "bim_drag_run",
      "bim_set_system_design",
      "bim_set_duct_insulation",
      "bim_set_slope",
      "bim_place_pipe_accessory",
    ],
  },
  {
    id: "electrical",
    label: "Electrical circuits and diagrams",
    purpose: "Panels, circuits, feeders, receptacle proposals, one-line and riser diagrams",
    skill: "mutinybim-electrical",
    slug: "electrical",
    tokenCap: 9_300,
    tools: [
      "bim_electrical_report",
      "bim_read_panel",
      "bim_electrical_catalog",
      "bim_propose_links_from_text",
      "bim_preview_circuit_edit",
      "bim_create_circuit",
      "bim_edit_circuit",
      "bim_add_to_circuit",
      "bim_remove_from_circuit",
      "bim_feed_panel",
      "bim_rebalance_panel",
      "bim_save_electrical_type",
      "bim_apply_circuit_template",
      "bim_preview_one_line",
      "bim_layout_one_line",
      "bim_propose_receptacles",
      "bim_accept_receptacles",
      "bim_place_service_layout",
    ],
  },
  {
    id: "plumbing",
    label: "Plumbing loads and design",
    purpose: "Fixture load points, connection types, pipe types and each pipe system's sizing",
    skill: "mutinybim-plumbing",
    slug: "plumbing",
    tokenCap: 6_300,
    tools: ["bim_place_load_points", "bim_edit_load_point", "bim_save_connection_type", "bim_plumbing_catalog", "bim_plumbing_design"],
  },
  {
    id: "views_sheets",
    label: "Views and sheets",
    purpose: "Views, crops, 3D views, sheets, viewports, sheet notes and layout",
    skill: "mutinybim-views-sheets",
    slug: "views-sheets",
    tokenCap: 10_600,
    tools: [
      "bim_create_view",
      "bim_set_view_properties",
      "bim_rename_view",
      "bim_duplicate_view",
      "bim_delete_view",
      "bim_create_sheet",
      "bim_set_sheet_properties",
      "bim_delete_sheet",
      "bim_place_viewport",
      "bim_edit_viewport",
      "bim_preview_sheet_layout",
      "bim_auto_layout_sheet",
      "bim_set_issue_status",
      "bim_add_sheet_note",
      "bim_edit_text_note",
      "bim_create_3d_view",
      "bim_set_3d_view_camera",
      "bim_set_3d_crop_box",
    ],
  },
  {
    id: "coordination",
    label: "Coordination and linked models",
    purpose: "Linked models, levels from them, coordinates, accepted findings and rooms",
    skill: "mutinybim-coordination",
    slug: "coordination",
    tokenCap: 6_000,
    tools: [
      "bim_browse_autodesk_docs",
      "bim_link_from_autodesk_docs",
      "bim_update_linked_model",
      "bim_unlink_linked_model",
      "bim_sync_linked_levels",
      "bim_update_level",
      "bim_create_level",
      "bim_read_coordinates",
      "bim_preview_coordinates_edit",
      "bim_set_project_origin",
      "bim_set_survey_point",
      "bim_set_true_north",
      "bim_set_working_angle",
      "bim_lint_accept_finding",
      "bim_lint_retract_acceptance",
      "bim_trace_rooms",
    ],
  },
  {
    id: "groups_phases",
    label: "Groups, phases and typed elements",
    purpose: "Groups, locks, phases, phase filters and typed element values",
    skill: "mutinybim-groups-phases",
    slug: "groups-phases",
    tokenCap: 5_200,
    tools: [
      "bim_list_groups_and_phases",
      "bim_preview_organization_edit",
      "bim_create_group",
      "bim_update_group",
      "bim_delete_group",
      "bim_assign_to_group",
      "bim_set_active_group_and_phase",
      "bim_create_phase",
      "bim_update_phase",
      "bim_set_element_phases",
      "bim_set_view_organization",
      "bim_set_phase_filter",
      "bim_delete_phase",
      "bim_delete_phase_filter",
      "bim_set_element",
    ],
  },
  {
    id: "parts",
    label: "Part definitions",
    purpose: "Draft, check and save parts, the firm's part library, clearances and hosts",
    skill: "mutinybim-parts",
    slug: "parts",
    tokenCap: 4_500,
    tools: [
      "bim_draft_part_from_cut_sheet",
      "bim_read_picture_rows",
      "bim_part_definition_example",
      "bim_check_part_definition",
      "bim_read_part_definition",
      "bim_save_part_definition",
      "bim_list_firm_parts",
      "bim_save_firm_part",
      "bim_set_clearances",
      "bim_set_part_host",
      "bim_set_mounting_plane",
    ],
  },
  {
    id: "calcs",
    label: "Calculations",
    purpose: "Code calculations, duct size advice, duct pressure and pipe hydraulics reports, pipe sizing and service size",
    skill: "mutinybim-calcs",
    slug: "calcs",
    tokenCap: 3_700,
    tools: ["bim_list_calcs", "bim_run_calc", "bim_suggest_duct_size", "bim_pressure_report", "bim_pipe_report", "bim_set_fitting_coefficient_override", "bim_size_pipes", "bim_service_from_equipment_list"],
  },
  {
    id: "schedules",
    label: "Schedules",
    purpose: "Define schedules, edit their cells and manage the schedule library",
    skill: "mutinybim-schedules",
    slug: "schedules",
    tokenCap: 1_900,
    tools: ["bim_schedule_fields", "bim_schedule_define", "bim_schedule_edit_cells", "bim_library"],
  },
];

/** The catalogue's packs. */
export function bimPackCatalogue(): readonly BimToolPack[] {
  return BIM_TOOL_PACKS;
}

const PACK_BY_TOOL: ReadonlyMap<string, BimToolPack> = new Map(BIM_TOOL_PACKS.flatMap((pack) => pack.tools.map((tool) => [tool, pack] as const)));

/** The pack a catalogue tool belongs to, or null for a tool the catalogue doesn't list (an add-on's). */
export function bimPackOfTool(tool: string): BimToolPack | null {
  return PACK_BY_TOOL.get(tool) ?? null;
}

/** A pack by id, slug or skill name. */
export function bimPack(idOrSlugOrSkill: string): BimToolPack | null {
  return BIM_TOOL_PACKS.find((p) => p.id === idOrSlugOrSkill || p.slug === idOrSlugOrSkill || p.skill === idOrSlugOrSkill) ?? null;
}

/**
 * The endpoint path of a pack under a host's MutinyBIM base (the hosted
 * app's origin, or `/api/bim` in a host app): the core is the base's `/mcp`,
 * every other pack `/packs/<slug>/mcp`.
 */
export function bimPackEndpointPath(pack: Pick<AgentToolPackDescriptor, "slug">): string {
  return pack.slug === CORE_PACK_ID ? "/mcp" : `/packs/${pack.slug}/mcp`;
}

/** Problems inside the catalogue itself: duplicates, a tool in two packs, a malformed name. */
export function catalogueProblems(packs: readonly BimToolPack[] = BIM_TOOL_PACKS): string[] {
  const out: string[] = [];
  const owner = new Map<string, string>();
  for (const pack of packs) {
    for (const tool of pack.tools) {
      if (!/^bim_[a-z][a-z0-9_]{1,60}$/.test(tool)) out.push(`pack ${pack.id}: "${tool}" is not a bim_ tool name`);
      const prior = owner.get(tool);
      if (prior) out.push(`"${tool}" is in two packs: ${prior} and ${pack.id}`);
      owner.set(tool, pack.id);
    }
  }
  if (!packs.some((p) => p.id === CORE_PACK_ID)) out.push("the catalogue has no core pack");
  return out;
}
