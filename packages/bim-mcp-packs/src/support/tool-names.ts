/**
 * MutinyBIM agent tool names, shared by the MCP tools, the approval policy and
 * the Cmd+J tool cards. No imports: safe in both server and client bundles.
 */
export const BIM_READ_TOOL_NAMES = [
  "bim_model_summary",
  "bim_query_elements",
  "bim_inspect_network",
  "bim_validation_issues",
  "bim_list_part_types",
  "bim_preview_part_edit",
  "bim_preview_route_edit",
  "bim_list_fitting_types",
  "bim_pressure_report",
  "bim_suggest_duct_size",
  "bim_pipe_report",
  "bim_list_views_and_sheets",
  "bim_preview_views_sheets_edit",
  "bim_print_sheet_pdf",
  "bim_list_groups_and_phases",
  "bim_preview_organization_edit",
  "bim_read_coordinates",
  "bim_preview_coordinates_edit",
  "bim_preview_sheet_layout",
  "bim_print_set_pdf",
  "bim_set_issue_status",
  "bim_part_definition_example",
  "bim_check_part_definition",
  "bim_read_part_definition",
  "bim_list_view_annotations",
  "bim_list_tag_styles",
  "bim_preview_auto_tag",
  "bim_list_detail_components",
  "bim_render_view_image",
  "bim_render_sheet_image",
  "bim_print_view_pdf",
  "bim_preview_one_line",
  "bim_list_linked_models",
  "bim_browse_autodesk_docs",
  "bim_list_levels",
  "bim_list_calcs",
  "bim_run_calc",
  "bim_electrical_report",
  "bim_propose_links_from_text",
  "bim_draft_part_from_cut_sheet",
  "bim_list_firm_parts",
  "bim_read_panel",
  "bim_preview_circuit_edit",
  "bim_electrical_catalog",
  // Schedules: read rows (core) and the classes, fields and relationships a schedule can show.
  "bim_schedule_read",
  "bim_schedule_fields",
  // Coordination lint: set it up once per session (own settings, no model edit), read every finding, status with pictures.
  "bim_lint_configure",
  "bim_lint_check",
  "bim_status_snapshot",
  // Proposers: receptacles by code spacing, service size from an equipment list.
  "bim_propose_receptacles",
  "bim_service_from_equipment_list",
  // Plumbing tab: pipe types, each pipe system's look and sizing, the project's sizing.
  "bim_plumbing_catalog",
  // Floor, ceiling, roof and structure at a part or a point, each height with its source.
  "bim_surfaces_at",
  // The exact fields of a command family a tool advertises in short form (draw shapes, modify operations, a static diagram).
  "bim_describe_commands",
  // Agent-written scripts: the kit's reference (and saved scripts), checks, a preview run on the thread's sealed script machine (saves nothing).
  "bim_script_reference",
  "bim_check_output",
  "bim_run_script",
] as const;

/**
 * Tools that name their one element by an older key: each also takes
 * `element_id` for it (the agent vocabulary, KERNEL-AUDIT §6.3). The MCP
 * registration, the route and fitting previews and the Approve card all read
 * this one map.
 */
export const BIM_ELEMENT_ID_ALIASES = {
  bim_slide_branch: "tap_id",
  bim_set_terminal_airflow: "terminal_id",
  bim_resize_run: "segment_id",
  bim_move_equipment: "equipment_id",
  bim_move_wall: "wall_id",
  bim_resize_riser: "riser_id",
  bim_set_tag_text: "tag_id",
  bim_swap_fitting: "fitting_id",
  bim_offset_run: "segment_id",
  bim_change_elevation: "segment_id",
  bim_set_fitting_coefficient_override: "fitting_id",
  bim_set_slope: "segment_id",
  bim_place_pipe_accessory: "segment_id",
  bim_split_run: "segment_id",
} as const satisfies Readonly<Record<string, string>>;

export type BimElementIdAliasTool = keyof typeof BIM_ELEMENT_ID_ALIASES;

export function bimElementIdAlias(tool: string): string | null {
  return Object.prototype.hasOwnProperty.call(BIM_ELEMENT_ID_ALIASES, tool) ? BIM_ELEMENT_ID_ALIASES[tool as BimElementIdAliasTool] : null;
}

/**
 * The arguments with `element_id` copied into the tool's older key when only
 * `element_id` was given; anything else (no alias, the older key present, not
 * an object) comes back unchanged.
 */
export function withElementIdArg(tool: string, input: unknown): unknown {
  const key = bimElementIdAlias(tool);
  if (!key || typeof input !== "object" || input === null || Array.isArray(input)) return input;
  const r = input as Record<string, unknown>;
  if (r[key] !== undefined || typeof r.element_id !== "string") return input;
  const { element_id: id, ...rest } = r;
  return { ...rest, [key]: id };
}

/** Part edits: any part, any discipline. Each pauses for approval like the duct edits. */
export const BIM_PART_EDIT_TOOL_NAMES = [
  "bim_place_part",
  "bim_move_elements",
  "bim_rotate_elements",
  "bim_copy_elements",
  "bim_delete_elements",
  "bim_set_parameters",
  "bim_create_level",
  "bim_save_part_definition",
  "bim_set_mounting_plane",
  // Typed elements: class, shared type, values, geometric placement and locks on walls, slabs, beams, rooms… (a part's class and add-on values too).
  "bim_set_element",
] as const;

export type BimPartEditToolName = (typeof BIM_PART_EDIT_TOOL_NAMES)[number];

/** Firm part library edits: decided by the host (its library store), not the model server. Each pauses for approval. */
export const BIM_PART_LIBRARY_EDIT_TOOL_NAMES = ["bim_save_firm_part", "bim_save_part_type"] as const;

/** Script results: land a previewed, checked script output in the model as one undo step. Pauses for approval. */
export const BIM_SCRIPT_EDIT_TOOL_NAMES = ["bim_apply_output"] as const;

/** Routing edits: duct and pipe runs between parts and runs. Each pauses for approval. */
export const BIM_ROUTE_EDIT_TOOL_NAMES = ["bim_route_run", "bim_connect_runs", "bim_disconnect_run", "bim_route_flex"] as const;

export type BimRouteEditToolName = (typeof BIM_ROUTE_EDIT_TOOL_NAMES)[number];

/** Fitting edits: change a fitting's type, offsets and height changes, coefficients, a system's fittings, drain slope, inline pipe accessories, splitting a run, resizing a stretch, dragging a piece and duct insulation. Each pauses for approval. */
export const BIM_FITTING_EDIT_TOOL_NAMES = [
  "bim_swap_fitting",
  "bim_offset_run",
  "bim_change_elevation",
  "bim_set_fitting_coefficient_override",
  "bim_set_system_design",
  "bim_set_slope",
  "bim_place_pipe_accessory",
  "bim_split_run",
  "bim_resize_stretch",
  "bim_drag_run",
  "bim_set_duct_insulation",
] as const;

export type BimFittingEditToolName = (typeof BIM_FITTING_EDIT_TOOL_NAMES)[number];

/** Groups and phases edits: groups, locks, phases, phase filters, element membership and a view's phase / groups. Each pauses for approval. */
export const BIM_ORGANIZATION_EDIT_TOOL_NAMES = [
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
] as const;

export type BimOrganizationEditToolName = (typeof BIM_ORGANIZATION_EDIT_TOOL_NAMES)[number];
/** Coordinates edits: the project base point, the survey point, true north and the working angle. Each pauses for approval. */
export const BIM_COORDINATE_EDIT_TOOL_NAMES = ["bim_set_project_origin", "bim_set_survey_point", "bim_set_true_north", "bim_set_working_angle"] as const;

export type BimCoordinateEditToolName = (typeof BIM_COORDINATE_EDIT_TOOL_NAMES)[number];

/** Linked-model edits: bring a model in from Autodesk Docs, refresh, line up, position, switch version, unlink. Each pauses for approval. */
export const BIM_LINKED_MODEL_EDIT_TOOL_NAMES = ["bim_link_from_autodesk_docs", "bim_update_linked_model", "bim_unlink_linked_model"] as const;

export type BimLinkedModelEditToolName = (typeof BIM_LINKED_MODEL_EDIT_TOOL_NAMES)[number];

const LINKED_MODEL_EDIT_NAMES: ReadonlySet<string> = new Set(BIM_LINKED_MODEL_EDIT_TOOL_NAMES);

/** Linked-model edits are decided by the host (its linked-model store and worker), not the model server. */
export function isBimLinkedModelEditTool(name: string): name is BimLinkedModelEditToolName {
  return LINKED_MODEL_EDIT_NAMES.has(name);
}

/** Drawing-set edits: save a previewed views/sheets change (one or a batch), views, title blocks, viewports, layout and issuing the set. Each pauses for approval. */
export const BIM_DRAWING_SET_EDIT_TOOL_NAMES = [
  "bim_apply_views_sheets_edit",
  "bim_rename_view",
  "bim_duplicate_view",
  "bim_delete_view",
  "bim_set_sheet_properties",
  "bim_delete_sheet",
  "bim_edit_viewport",
  "bim_auto_layout_sheet",
  "bim_issue_set",
] as const;

/** Drafting annotation edits: dimensions, tags, auto-tag, notes with leaders anywhere, annotation edits, detailing and one-line diagrams. Each pauses for approval. */
export const BIM_ANNOTATION_EDIT_TOOL_NAMES = [
  "bim_add_dimension",
  "bim_auto_dimension",
  "bim_add_tag",
  "bim_auto_tag_view",
  "bim_add_note",
  "bim_edit_annotation",
  "bim_save_tag_style",
  "bim_apply_tag_style",
  "bim_draw_detail",
  "bim_modify_detail",
  "bim_copy_detail_items",
  "bim_set_detail_group",
  "bim_layout_one_line",
] as const;

export type BimAnnotationEditToolName = (typeof BIM_ANNOTATION_EDIT_TOOL_NAMES)[number];

/** Saved 3D view edits: create one (fitted, optionally placed on a sheet), turn its camera, size or fit its 3D crop box. Each pauses for approval. */
export const BIM_VIEW_3D_EDIT_TOOL_NAMES = ["bim_create_3d_view", "bim_set_3d_view_camera", "bim_set_3d_crop_box"] as const;

export type BimDrawingSetEditToolName = (typeof BIM_DRAWING_SET_EDIT_TOOL_NAMES)[number];

/** Level edits: make the levels match a linked model's storeys, and move or rename a level. Each pauses for approval. */
export const BIM_LEVEL_EDIT_TOOL_NAMES = ["bim_sync_linked_levels", "bim_update_level"] as const;

export type BimLevelEditToolName = (typeof BIM_LEVEL_EDIT_TOOL_NAMES)[number];

/** Spatial edits: clearance zones on a part (type or one placed part), and the slab or roof parts stand on with their curb. Each pauses for approval. */
export const BIM_SPATIAL_EDIT_TOOL_NAMES = ["bim_set_clearances", "bim_set_part_host"] as const;

export type BimSpatialEditToolName = (typeof BIM_SPATIAL_EDIT_TOOL_NAMES)[number];

/** Electrical circuits and feeders: make, change, add devices to and take them off, feed a panel. Each pauses for approval. */
export const BIM_ELECTRICAL_EDIT_TOOL_NAMES = ["bim_create_circuit", "bim_edit_circuit", "bim_add_to_circuit", "bim_remove_from_circuit", "bim_feed_panel"] as const;

export type BimElectricalEditToolName = (typeof BIM_ELECTRICAL_EDIT_TOOL_NAMES)[number];

/** Electrical design: rebalance a panel, save a connection type / feeder type / room template, apply a room template to units. Each pauses for approval. */
export const BIM_ELECTRICAL_DESIGN_EDIT_TOOL_NAMES = ["bim_rebalance_panel", "bim_save_electrical_type", "bim_apply_circuit_template"] as const;

export type BimElectricalDesignEditToolName = (typeof BIM_ELECTRICAL_DESIGN_EDIT_TOOL_NAMES)[number];

/** Proposals the person accepts (place the receptacles they kept, nothing circuited) and tracing the rooms proposals measure. Each pauses for approval. */
export const BIM_ELECTRICAL_PROPOSE_EDIT_TOOL_NAMES = ["bim_accept_receptacles", "bim_trace_rooms", "bim_place_service_layout"] as const;

/**
 * Confirm-gated tools: the first call previews and saves nothing; the commit
 * call (user_confirmed, with the preview's token) pauses on the Approve card
 * and runs once from the persisted action row. Not in BIM_EDIT_TOOL_NAMES,
 * which would put the preview behind a card too.
 */
export const BIM_CONFIRM_GATED_TOOL_NAMES = ["bim_schedule_define", "bim_schedule_edit_cells", "bim_library", "bim_read_picture_rows"] as const;

export type BimConfirmGatedToolName = (typeof BIM_CONFIRM_GATED_TOOL_NAMES)[number];

const CONFIRM_GATED_NAMES: ReadonlySet<string> = new Set(BIM_CONFIRM_GATED_TOOL_NAMES);

export function isBimConfirmGatedTool(name: string): name is BimConfirmGatedToolName {
  return CONFIRM_GATED_NAMES.has(name);
}

/** Plumbing load points and trade-neutral connection types (packages/bim-mcp-packs/src/trades/plumbing.ts). Each pauses for approval. */
export const BIM_PLUMBING_EDIT_TOOL_NAMES = ["bim_place_load_points", "bim_edit_load_point", "bim_save_connection_type"] as const;

export type BimPlumbingEditToolName = (typeof BIM_PLUMBING_EDIT_TOOL_NAMES)[number];

/** Pipe sizing: apply a system's code sizing proposal (gas zones). Pauses for approval. */
export const BIM_PIPE_SIZING_EDIT_TOOL_NAMES = ["bim_size_pipes"] as const;

/** Coordination lint: accept a finding with a reason, or retract an acceptance (people do the same in Manage › Coordination). Each pauses for approval. */
export const BIM_LINT_EDIT_TOOL_NAMES = ["bim_lint_accept_finding", "bim_lint_retract_acceptance"] as const;

export type BimLintEditToolName = (typeof BIM_LINT_EDIT_TOOL_NAMES)[number];

/** Plumbing tab design: a pipe system's look or sizing, the project's sizing and demand curve, a pipe type. Pauses for approval. */
export const BIM_PLUMBING_DESIGN_EDIT_TOOL_NAMES = ["bim_plumbing_design"] as const;

export type BimPlumbingDesignEditToolName = (typeof BIM_PLUMBING_DESIGN_EDIT_TOOL_NAMES)[number];

/** Tools that change a model. Each pauses for the person's approval in Cmd+J. */
export const BIM_EDIT_TOOL_NAMES = [
  "bim_slide_branch",
  "bim_set_terminal_airflow",
  "bim_resize_run",
  "bim_move_equipment",
  "bim_move_wall",
  "bim_resize_riser",
  "bim_set_tag_text",
  ...BIM_PART_EDIT_TOOL_NAMES,
  ...BIM_PART_LIBRARY_EDIT_TOOL_NAMES,
  ...BIM_ROUTE_EDIT_TOOL_NAMES,
  ...BIM_FITTING_EDIT_TOOL_NAMES,
  "bim_create_view",
  "bim_set_view_properties",
  "bim_create_sheet",
  "bim_place_viewport",
  "bim_add_sheet_note",
  "bim_edit_text_note",
  ...BIM_ORGANIZATION_EDIT_TOOL_NAMES,
  ...BIM_COORDINATE_EDIT_TOOL_NAMES,
  ...BIM_LINKED_MODEL_EDIT_TOOL_NAMES,
  ...BIM_DRAWING_SET_EDIT_TOOL_NAMES,
  ...BIM_ANNOTATION_EDIT_TOOL_NAMES,
  ...BIM_VIEW_3D_EDIT_TOOL_NAMES,
  ...BIM_LEVEL_EDIT_TOOL_NAMES,
  ...BIM_SPATIAL_EDIT_TOOL_NAMES,
  ...BIM_ELECTRICAL_EDIT_TOOL_NAMES,
  ...BIM_ELECTRICAL_DESIGN_EDIT_TOOL_NAMES,
  ...BIM_ELECTRICAL_PROPOSE_EDIT_TOOL_NAMES,
  ...BIM_PLUMBING_EDIT_TOOL_NAMES,
  ...BIM_PIPE_SIZING_EDIT_TOOL_NAMES,
  ...BIM_LINT_EDIT_TOOL_NAMES,
  ...BIM_PLUMBING_DESIGN_EDIT_TOOL_NAMES,
  ...BIM_SCRIPT_EDIT_TOOL_NAMES,
] as const;

export type BimEditToolName = (typeof BIM_EDIT_TOOL_NAMES)[number];

const EDIT_NAMES: ReadonlySet<string> = new Set(BIM_EDIT_TOOL_NAMES);

export function isBimEditTool(name: string): name is BimEditToolName {
  return EDIT_NAMES.has(name);
}

/**
 * Edit tools an installed MutinyBIM add-on declares, added when the host
 * registers them (packages/bim-mcp-packs/src/calc/pack-tools.ts). Each pauses for approval
 * like the tools above; the first-party add-ons' tools are already listed there.
 */
const PACK_EDIT_NAMES = new Set<string>();

export function registerBimPackEditTool(name: string): void {
  if (!EDIT_NAMES.has(name)) PACK_EDIT_NAMES.add(name);
}

/** Whether `name` changes a model: a listed edit tool, or an edit tool an installed add-on declared. */
export function isBimModelEditTool(name: string): boolean {
  return EDIT_NAMES.has(name) || PACK_EDIT_NAMES.has(name);
}
