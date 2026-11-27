import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * The 138 non-core legacy MCP tools that `@permitzip/bim-script` already covers,
 * mapped to their concise script equivalent. Keep in sync with
 * `docs/SCRIPTING-COVERAGE.md` (enforced by tests).
 *
 * Architectural rule: `@permitzip/bim-script` is the primary AI capability layer;
 * the daily-driver MCP surface stays at <= 10 tools and no new legacy MCP tools
 * are added. Every tool below is slated for retirement.
 */
export const LEGACY_TOOL_SCRIPT_EQUIVALENTS: Readonly<Record<string, string>> = {
  // core (model family — 19 covered)
  bim_schedule_read: "documents.scheduleRows(ctx, schedule) (or ctx.read(\"electrical.loads\") for panel/feeder forms)",
  bim_list_part_types: "parts.starterTypes(ctx, words) and ctx.model.partTypes()",
  bim_list_levels: "bim_query_elements (kind: level) or ctx.model.levels()",
  bim_list_views_and_sheets: "bim_query_elements (kind: view / sheet)",
  bim_list_linked_models: "bim_query_elements (linked references are elements)",
  bim_surfaces_at: "building.surfacesAt(ctx, { at, level } | { element })",
  bim_describe_commands: "bim_script_reference({ command })",
  bim_preview_part_edit: "bim_run_script (every script run is a preview)",
  bim_preview_route_edit: "bim_run_script (every script run is a preview)",
  bim_preview_views_sheets_edit: "bim_run_script (every script run is a preview)",
  bim_apply_views_sheets_edit: "bim_apply_output",
  bim_place_part: "equipment.place (or ctx.edit: place_part)",
  bim_move_elements: "ctx.edit: move_elements",
  bim_rotate_elements: "ctx.edit: rotate_elements",
  bim_copy_elements: "ctx.edit: copy_elements",
  bim_delete_elements: "ctx.edit: delete_elements",
  bim_set_parameters: "ctx.edit: set_parameters",
  bim_move_wall: "ctx.edit: move_wall",
  bim_lint_check: "checks.clashes(ctx, { ruleset })",

  // drafting (17 covered)
  bim_list_view_annotations: "bim_query_elements (drawing items of a view)",
  bim_add_dimension: "documents.dimension (or ctx.edit: add_drawing_item)",
  bim_auto_dimension: "documents.autoDimension(ctx, { view, elements, mode })",
  bim_add_tag: "documents.tag (or ctx.edit: add_drawing_item)",
  bim_preview_auto_tag: "documents.autoTag in bim_run_script",
  bim_auto_tag_view: "documents.autoTag(ctx, { view, categories })",
  bim_add_note: "ctx.edit: create_text_note",
  bim_edit_annotation: "ctx.edit: update_drawing_item, delete_drawing_item, move_text_note, delete_text_note",
  bim_set_tag_text: "ctx.edit: set_tag_text",
  bim_list_tag_styles: "bim_query_elements (tag styles)",
  bim_save_tag_style: "ctx.edit: create_tag_style, update_tag_style, delete_tag_style",
  bim_apply_tag_style: "ctx.edit: update_drawing_item",
  bim_list_detail_components: "documents.detailLibrary(ctx)",
  bim_draw_detail: "ctx.edit: add_drawing_item",
  bim_modify_detail: "ctx.edit: update_drawing_item",
  bim_copy_detail_items: "ctx.edit: copy_drawing_items",
  bim_set_detail_group: "ctx.edit: update_drawing_item",

  // ducts-pipes (20 covered)
  bim_route_run: "routes.along, routes.branch, routes.drop (or ctx.edit: route_run)",
  bim_connect_runs: "routes.connectInto (or ctx.edit: connect_runs, auto_connect_runs)",
  bim_disconnect_run: "ctx.edit: disconnect_run",
  bim_route_flex: "ctx.edit: route_flex, route_into_flex",
  bim_resize_run: "ctx.edit: resize_run",
  bim_slide_branch: "ctx.edit: slide_branch",
  bim_set_terminal_airflow: "ctx.edit: set_terminal_cfm",
  bim_move_equipment: "ctx.edit: move_equipment",
  bim_resize_riser: "ctx.edit: resize_riser",
  bim_list_fitting_types: "routes.fittingTypes(ctx, { domain, service })",
  bim_swap_fitting: "ctx.edit: swap_fitting, elbow_to_tee",
  bim_offset_run: "ctx.edit: offset_run",
  bim_change_elevation: "ctx.edit: change_elevation",
  bim_split_run: "ctx.edit: split_run",
  bim_resize_stretch: "ctx.edit: resize_stretch, stretch_to_side",
  bim_drag_run: "ctx.edit: drag_run",
  bim_set_system_design: "ctx.edit: set_system_design",
  bim_set_duct_insulation: "ctx.edit: set_run_insulation",
  bim_set_slope: "routes.along with slope (or ctx.edit: set_slope)",
  bim_place_pipe_accessory: "ctx.edit: place_run_accessory",

  // electrical (18 covered)
  bim_electrical_report: "ctx.read(\"electrical.loads\", { panel }) and ctx.read(\"electrical.check\")",
  bim_read_panel: "ctx.read(\"bim_read_panel\", { panel }) and ctx.read(\"electrical.loads\")",
  bim_electrical_catalog: "ctx.read(\"electrical.catalog\"), \"electrical.feeder_proposal\", \"electrical.check\"",
  bim_propose_links_from_text: "ctx.read(\"bim_propose_links_from_text\")",
  bim_preview_circuit_edit: "bim_run_script",
  bim_create_circuit: "ctx.edit: create_service_link, add_link_members",
  bim_edit_circuit: "ctx.edit: edit_service_link",
  bim_add_to_circuit: "ctx.edit: add_link_members",
  bim_remove_from_circuit: "ctx.edit: remove_link_members",
  bim_feed_panel: "ctx.edit: create_service_link, edit_service_link",
  bim_rebalance_panel: "ctx.read(\"electrical.rebalance_plan\", { panel }), then ctx.editSteps(plan.command)",
  bim_save_electrical_type: "ctx.edit: save_catalog_entry",
  bim_apply_circuit_template: "ctx.read(\"electrical.circuit_template_plan\", { template, units }), then ctx.editSteps(plan.command)",
  bim_preview_one_line: "documents.oneLine in bim_run_script",
  bim_layout_one_line: "documents.oneLine(ctx, { name, diagram } | { name, live })",
  bim_propose_receptacles: "ctx.propose(\"electrical.receptacles\", { typeId, roomIds, options }), then ctx.acceptGhosts",
  bim_accept_receptacles: "ctx.edit: place_devices",
  bim_place_service_layout: "ctx.edit: place_service_layout",

  // plumbing (5 covered)
  bim_place_load_points: "ctx.edit: create_load_point",
  bim_edit_load_point: "ctx.edit: edit_load_point, delete_load_points",
  bim_save_connection_type: "ctx.edit: save_connection_type",
  bim_plumbing_catalog: "ctx.read(\"bim_plumbing_catalog\")",
  bim_plumbing_design: "ctx.edit: set_system_design, set_project_parameters",

  // views-sheets (17 covered)
  bim_create_view: "documents.planView, documents.ceilingView (or ctx.edit: create_view)",
  bim_set_view_properties: "ctx.edit: set_view_properties, set_view_crop",
  bim_rename_view: "ctx.edit: rename_view",
  bim_duplicate_view: "documents.duplicateView (or ctx.edit: duplicate_view)",
  bim_delete_view: "ctx.edit: delete_view",
  bim_create_sheet: "documents.sheet (or ctx.edit: create_sheet)",
  bim_set_sheet_properties: "documents.setSheet (or ctx.edit: set_sheet_properties)",
  bim_delete_sheet: "ctx.edit: delete_sheet",
  bim_place_viewport: "documents.place (or ctx.edit: place_viewport)",
  bim_edit_viewport: "ctx.edit: move_viewport, resize_viewport, set_viewport_scale, set_viewport_north_arrow, remove_viewport",
  bim_preview_sheet_layout: "documents.packSheet in bim_run_script",
  bim_auto_layout_sheet: "documents.packSheet(ctx, sheet, { mode, fitScales })",
  bim_add_sheet_note: "ctx.edit: create_text_note",
  bim_edit_text_note: "ctx.edit: edit_text_note, resize_text_note",
  bim_create_3d_view: "documents.view3d(ctx, spec)",
  bim_set_3d_view_camera: "documents.setCamera3d(ctx, view, camera)",
  bim_set_3d_crop_box: "ctx.edit: set_3d_crop_box",

  // coordination (10 covered)
  bim_sync_linked_levels: "building.levelSyncPlan and building.syncLevels",
  bim_update_level: "ctx.edit: update_level",
  bim_create_level: "building.level (or ctx.edit: create_level)",
  bim_read_coordinates: "bim_model_summary / bim_query_elements",
  bim_preview_coordinates_edit: "bim_run_script",
  bim_set_project_origin: "ctx.edit: set_project_origin",
  bim_set_survey_point: "ctx.edit: set_survey_point",
  bim_set_true_north: "ctx.edit: set_true_north",
  bim_set_working_angle: "ctx.edit: set_working_angle",
  bim_trace_rooms: "building.spaceInWalls (or ctx.edit: place_space_in_walls)",

  // groups-phases (15 covered)
  bim_list_groups_and_phases: "bim_query_elements (groups, phases)",
  bim_preview_organization_edit: "bim_run_script",
  bim_create_group: "ctx.edit: create_group",
  bim_update_group: "ctx.edit: update_group, lock_group, set_group_typical",
  bim_delete_group: "ctx.edit: delete_group",
  bim_assign_to_group: "ctx.edit: assign_elements_to_group",
  bim_set_active_group_and_phase: "ctx.edit: set_active_group, set_active_phase",
  bim_create_phase: "ctx.edit: create_phase",
  bim_update_phase: "ctx.edit: update_phase",
  bim_set_element_phases: "ctx.edit: set_element_phases, demolish_elements",
  bim_set_view_organization: "ctx.edit: set_view_properties",
  bim_set_phase_filter: "ctx.edit: create_phase_filter, update_phase_filter",
  bim_delete_phase: "ctx.edit: delete_phase",
  bim_delete_phase_filter: "ctx.edit: delete_phase_filter",
  bim_set_element: "ctx.edit: set_element_class, set_element_type, set_element_values",

  // parts (6 covered)
  bim_part_definition_example: "bim_script_reference (Part definition recipe)",
  bim_check_part_definition: "PartBuilder.check and bim_check_output",
  bim_save_part_definition: "ctx.parts.define + bim_save_part_type",
  bim_set_clearances: "PartBuilder.clearance (or ctx.edit: set_part_clearances)",
  bim_set_part_host: "ctx.edit: set_part_host",
  bim_set_mounting_plane: "ctx.edit: set_mounting_plane, create_mounting_plane",

  // calcs (8 covered)
  bim_list_calcs: "ctx.calcs()",
  bim_run_calc: "ctx.calc({ calc, inputs, ...edition })",
  bim_suggest_duct_size: "ctx.read(\"mechanical.duct_size\", { cfm, shape, height_mm } | { element_id })",
  bim_pressure_report: "ctx.calc({ calc: \"mech.duct_system_pressure\" })",
  bim_pipe_report: "ctx.calc({ calc: \"plumbing.pipe_system\" }) or plumbing.pressure_report",
  bim_set_fitting_coefficient_override: "ctx.edit: set_fitting_coefficient",
  bim_size_pipes: "ctx.calc({ calc: \"plumbing.size_system\" }), then ctx.edit: set_pipe_sizes",
  bim_service_from_equipment_list: "ctx.calc({ calc: \"nec.service_size\" })",

  // schedules (3 covered)
  bim_schedule_fields: "documents.scheduleFields(ctx, classes)",
  bim_schedule_define: "documents.schedule (or ctx.edit: create_view, edit_schedule)",
  bim_schedule_edit_cells: "ctx.edit: set_element_values, set_parameters",
};

/**
 * The 21 non-core MCP tools that remain genuine host steps (rendering, printing,
 * issuing, firm/schedule libraries, Autodesk Docs, host-stored lint/AI reads).
 * Never nudged toward scripts.
 */
export const HOST_STEP_TOOL_NAMES = [
  "bim_render_view_image",
  "bim_render_sheet_image",
  "bim_print_sheet_pdf",
  "bim_print_view_pdf",
  "bim_print_set_pdf",
  "bim_issue_set",
  "bim_lint_configure",
  "bim_status_snapshot",
  "bim_set_issue_status",
  "bim_browse_autodesk_docs",
  "bim_link_from_autodesk_docs",
  "bim_update_linked_model",
  "bim_unlink_linked_model",
  "bim_lint_accept_finding",
  "bim_lint_retract_acceptance",
  "bim_draft_part_from_cut_sheet",
  "bim_read_picture_rows",
  "bim_read_part_definition",
  "bim_list_firm_parts",
  "bim_save_firm_part",
  "bim_library",
] as const;

const HOST_STEP_SET: ReadonlySet<string> = new Set(HOST_STEP_TOOL_NAMES);

/** True when `toolName` is one of the 21 host-step tools that stay MCP tools by design. */
export function isHostStepTool(toolName: string): boolean {
  return HOST_STEP_SET.has(toolName);
}

const NUDGE_MARKER = "slated for retirement in favor of @permitzip/bim-script";

/**
 * Plain-language deprecation nudge for a script-covered legacy MCP tool, or null
 * for core tools, host-step tools, and external tools.
 */
export function legacyToolNudge(toolName: string): string | null {
  if (HOST_STEP_SET.has(toolName)) return null;
  const equivalent = LEGACY_TOOL_SCRIPT_EQUIVALENTS[toolName];
  if (!equivalent) return null;
  return `Note: ${toolName} is a legacy MCP tool ${NUDGE_MARKER}. Try the script equivalent first: ${equivalent} (see bim_script_reference).`;
}

function isToolResultWithContent(value: unknown): value is { content: readonly { type?: string; text?: string }[]; [k: string]: unknown } {
  return typeof value === "object" && value !== null && Array.isArray((value as { content?: unknown }).content);
}

/**
 * Attaches the legacy retirement hint to a script-covered tool's response:
 * - When the response is a single JSON object text block, injects
 *   `deprecation_note` into that JSON object so callers parsing either
 *   `content[0].text` or joined text blocks still receive valid JSON.
 * - Otherwise appends a separate trailing text content block.
 * Idempotent: safe even when multiple layers wrap the same tool.
 */
export function appendLegacyToolNudge<T>(toolName: string, result: T): T {
  const nudge = legacyToolNudge(toolName);
  if (!nudge || !isToolResultWithContent(result)) return result;
  const already = result.content.some((c) => c.type === "text" && typeof c.text === "string" && c.text.includes(NUDGE_MARKER));
  if (already) return result;
  const first = result.content.length === 1 ? result.content[0] : undefined;
  if (first && first.type === "text" && typeof first.text === "string" && first.text.trimStart().startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(first.text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        return {
          ...result,
          content: [{ ...first, text: JSON.stringify({ ...record, deprecation_note: nudge }, null, 2) }],
        };
      }
    } catch {
      // Fall through to appending a trailing text block when the text isn't pure JSON.
    }
  }
  return { ...result, content: [...result.content, { type: "text" as const, text: nudge }] };
}

/**
 * Wraps `server.registerTool` so every script-covered legacy tool appends a
 * concise retirement nudge to its response. Core tools and the 21 host-step
 * tools pass through untouched.
 */
export function withLegacyToolNudge(server: McpServer): McpServer {
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === "registerTool") {
        return (name: string, ...rest: unknown[]) => {
          const register = target.registerTool.bind(target) as (name: string, ...args: unknown[]) => RegisteredTool;
          const last = rest[rest.length - 1];
          if (typeof last === "function" && legacyToolNudge(name) !== null) {
            const next = last as (...args: unknown[]) => unknown;
            rest[rest.length - 1] = async (...args: unknown[]) => appendLegacyToolNudge(name, await next(...args));
          }
          return register(name, ...rest);
        };
      }
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
