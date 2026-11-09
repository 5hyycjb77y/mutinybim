# Scripting coverage: what a script does of each tool

The script API is the product. The MutinyBIM tool server lists 10 tools by default: five script tools (`bim_script_reference`, `bim_check_output`, `bim_run_script`, `bim_apply_output`, `bim_save_part_type`), four reads (`bim_model_summary`, `bim_query_elements`, `bim_inspect_network`, `bim_validation_issues`) and `bim_enable_pack`. Everything else is done by writing a script with `@permitzip/bim-script`.

The other 159 tools stay on the server, off, in families an agent can turn on (`--packs`, `/packs/<family>/mcp`, or `bim_enable_pack`). This page says, for each of them, what a script uses instead. Every tool marked **covered** is a retirement candidate; retiring any of them is the maintainer's call.

How a script reaches the model: `ctx.edit(command)` takes any of the kernel's and the add-ons' commands (198 today; `bim_script_reference({ command })` shows one's fields), the kit's helpers build the common ones with typed units, `ctx.model` reads the model as far as the script's reads go, `ctx.calc` runs the engineering calculations on it, `ctx.read` runs the add-ons' computed reads (panel loads, rebalance and room-template plans, duct size advice, catalogues), `ctx.propose` / `ctx.acceptGhosts` place devices by a code's spacing, and the kit's planners (`documents.autoTag`, `autoDimension`, `packSheet`, `oneLine`, `scheduleRows`, `checks.clashes`, `building.surfacesAt`) work on the model as the script has it so far. A script imports only `@permitzip/bim-script` and runs sealed: no files, network or host services.

## Summary

| | Covered | Partial | Host step | Missing |
| --- | ---: | ---: | ---: | ---: |
| Before (Nov 7, start of the change) | 108 | 22 | 21 | 8 |
| After script-first (PR #3358) | 114 | 23 | 21 | 1 |
| Now (script API gaps closed) | 138 | 0 | 21 | 0 |

**Covered**: a script does the same job today. **Partial**: a script does most of it; the note says what is missing. **Host step**: the job needs the host app (rendering, printing, issuing, another company's cloud, reading pictures with AI, libraries the host stores), so it stays a tool or a host action by design. **Missing**: not in the script API yet.

| Family | Tools | Covered | Partial | Host step | Missing |
| --- | ---: | ---: | ---: | ---: | ---: |
| core | 27 | 19 | 0 | 8 | 0 |
| drafting | 17 | 17 | 0 | 0 | 0 |
| ducts-pipes | 20 | 20 | 0 | 0 | 0 |
| electrical | 18 | 18 | 0 | 0 | 0 |
| plumbing | 5 | 5 | 0 | 0 | 0 |
| views-sheets | 18 | 17 | 0 | 1 | 0 |
| coordination | 16 | 10 | 0 | 6 | 0 |
| groups-phases | 15 | 15 | 0 | 0 | 0 |
| parts | 11 | 6 | 0 | 5 | 0 |
| calcs | 8 | 8 | 0 | 0 | 0 |
| schedules | 4 | 3 | 0 | 1 | 0 |
| **All** | **159** | **138** | **0** | **21** | **0** |

The `core` family is the catalogue's core pack less the four reads already in the default list; the `scripts` family is entirely in the default list.

## core

| Tool | Script equivalent | Status | Note |
| --- | --- | --- | --- |
| `bim_schedule_read` | `documents.scheduleRows(ctx, schedule)`: cells by column (SI), totals, row count | covered | panel and feeder forms are add-on reads (`electrical.loads`); script covers it → retirement candidate (maintainer's call) |
| `bim_list_part_types` | `parts.starterTypes(ctx, words)` and `ctx.model.partTypes()` | covered | the firm library's saved types are `bim_list_firm_parts`, a host read; script covers it → retirement candidate (maintainer's call) |
| `bim_list_levels` | `bim_query_elements` kind level; `ctx.model.levels()` in a script | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_list_views_and_sheets` | `bim_query_elements` kind view / sheet | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_list_linked_models` | `bim_query_elements` (linked references are elements) | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_surfaces_at` | `building.surfacesAt(ctx, { at, level } | { element })` | covered | the model's own surfaces; a linked model's come from the host's link; script covers it → retirement candidate (maintainer's call) |
| `bim_describe_commands` | `bim_script_reference({ command })` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_preview_part_edit` | `bim_run_script` (every script run is a preview) | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_preview_route_edit` | `bim_run_script` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_preview_views_sheets_edit` | `bim_run_script` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_apply_views_sheets_edit` | `bim_apply_output` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_render_view_image` | none | host step | drawing pictures needs the host's renderer |
| `bim_render_sheet_image` | none | host step | drawing pictures needs the host's renderer |
| `bim_print_sheet_pdf` | none | host step | printing writes files through the host |
| `bim_print_view_pdf` | none | host step | printing writes files through the host |
| `bim_print_set_pdf` | none | host step | printing writes files through the host |
| `bim_issue_set` | none | host step | issuing records a set and its files in the host |
| `bim_place_part` | `equipment.place`; ctx.edit: `place_part` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_move_elements` | ctx.edit: `move_elements` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_rotate_elements` | ctx.edit: `rotate_elements` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_copy_elements` | ctx.edit: `copy_elements` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_delete_elements` | ctx.edit: `delete_elements` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_set_parameters` | ctx.edit: `set_parameters` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_move_wall` | ctx.edit: `move_wall` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_lint_configure` | none | host step | lint settings are stored by the host |
| `bim_lint_check` | `checks.clashes(ctx, { ruleset })` on the script's model | covered | linked models' elements and accepted findings are the host's; script covers it → retirement candidate (maintainer's call) |
| `bim_status_snapshot` | `bim_model_summary` and `checks.clashes` for the model's part | host step | prints and issues are the host's record |

## drafting

| Tool | Script equivalent | Status | Note |
| --- | --- | --- | --- |
| `bim_list_view_annotations` | `bim_query_elements` (drawing items of a view) | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_add_dimension` | `documents.dimension`; ctx.edit: `add_drawing_item` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_auto_dimension` | `documents.autoDimension(ctx, { view, elements, mode })` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_add_tag` | `documents.tag`; ctx.edit: `add_drawing_item` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_preview_auto_tag` | `documents.autoTag` in `bim_run_script` (the run is the preview) | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_auto_tag_view` | `documents.autoTag(ctx, { view, categories })` | covered | same planner: tags placed clear of each other; script covers it → retirement candidate (maintainer's call) |
| `bim_add_note` | ctx.edit: `create_text_note` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_edit_annotation` | ctx.edit: `update_drawing_item`, `delete_drawing_item`, `move_text_note`, `delete_text_note` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_set_tag_text` | ctx.edit: `set_tag_text` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_list_tag_styles` | `bim_query_elements` (tag styles) | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_save_tag_style` | ctx.edit: `create_tag_style`, `update_tag_style`, `delete_tag_style` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_apply_tag_style` | ctx.edit: `update_drawing_item` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_list_detail_components` | `documents.detailLibrary(ctx)` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_draw_detail` | ctx.edit: `add_drawing_item` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_modify_detail` | ctx.edit: `update_drawing_item` | covered | trim, extend and fillet geometry is computed by the script itself; script covers it → retirement candidate (maintainer's call) |
| `bim_copy_detail_items` | ctx.edit: `copy_drawing_items` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_set_detail_group` | ctx.edit: `update_drawing_item` | covered | script covers it → retirement candidate (maintainer's call) |

## ducts-pipes

| Tool | Script equivalent | Status | Note |
| --- | --- | --- | --- |
| `bim_route_run` | `routes.along`, `routes.branch`, `routes.drop`; ctx.edit: `route_run` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_connect_runs` | `routes.connectInto`; ctx.edit: `connect_runs`, `auto_connect_runs` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_disconnect_run` | ctx.edit: `disconnect_run` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_route_flex` | ctx.edit: `route_flex`, `route_into_flex` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_resize_run` | ctx.edit: `resize_run` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_slide_branch` | ctx.edit: `slide_branch` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_set_terminal_airflow` | ctx.edit: `set_terminal_cfm` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_move_equipment` | ctx.edit: `move_equipment` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_resize_riser` | ctx.edit: `resize_riser` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_list_fitting_types` | `routes.fittingTypes(ctx, { domain, service })` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_swap_fitting` | ctx.edit: `swap_fitting`, `elbow_to_tee` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_offset_run` | ctx.edit: `offset_run` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_change_elevation` | ctx.edit: `change_elevation` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_split_run` | ctx.edit: `split_run` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_resize_stretch` | ctx.edit: `resize_stretch`, `stretch_to_side` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_drag_run` | ctx.edit: `drag_run` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_set_system_design` | ctx.edit: `set_system_design` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_set_duct_insulation` | ctx.edit: `set_run_insulation` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_set_slope` | `routes.along` with `slope`; ctx.edit: `set_slope` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_place_pipe_accessory` | ctx.edit: `place_run_accessory` | covered | script covers it → retirement candidate (maintainer's call) |

## electrical

| Tool | Script equivalent | Status | Note |
| --- | --- | --- | --- |
| `bim_electrical_report` | `ctx.read("electrical.loads", { panel })` per panel and `ctx.read("electrical.check")` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_read_panel` | `ctx.read("bim_read_panel", { panel })` for slots, `ctx.read("electrical.loads")` for loads and phase totals | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_electrical_catalog` | `ctx.read("electrical.catalog")`, `"electrical.feeder_proposal"`, `"electrical.check"` | covered | name the NEC edition; script covers it → retirement candidate (maintainer's call) |
| `bim_propose_links_from_text` | `ctx.read("bim_propose_links_from_text")` | covered | reads the circuit numbers typed on devices in the model; no AI; script covers it → retirement candidate (maintainer's call) |
| `bim_preview_circuit_edit` | `bim_run_script` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_create_circuit` | ctx.edit: `create_service_link`, `add_link_members` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_edit_circuit` | ctx.edit: `edit_service_link` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_add_to_circuit` | ctx.edit: `add_link_members` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_remove_from_circuit` | ctx.edit: `remove_link_members` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_feed_panel` | ctx.edit: `create_service_link`, `edit_service_link` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_rebalance_panel` | `ctx.read("electrical.rebalance_plan", { panel })`, then `ctx.editSteps(plan.command)` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_save_electrical_type` | ctx.edit: `save_catalog_entry` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_apply_circuit_template` | `ctx.read("electrical.circuit_template_plan", { template, units })`, then `ctx.editSteps(plan.command)` | covered | the script names each unit's panel; script covers it → retirement candidate (maintainer's call) |
| `bim_preview_one_line` | `documents.oneLine` in `bim_run_script` (the run is the preview) | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_layout_one_line` | `documents.oneLine(ctx, { name, diagram } | { name, live })` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_propose_receptacles` | `ctx.propose("electrical.receptacles", { typeId, roomIds, options })`, then `ctx.acceptGhosts` | covered | NEC 210.52 spacing or a density preset; name the edition; script covers it → retirement candidate (maintainer's call) |
| `bim_accept_receptacles` | ctx.edit: `place_devices` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_place_service_layout` | ctx.edit: `place_service_layout` | covered | script covers it → retirement candidate (maintainer's call) |

## plumbing

| Tool | Script equivalent | Status | Note |
| --- | --- | --- | --- |
| `bim_place_load_points` | ctx.edit: `create_load_point` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_edit_load_point` | ctx.edit: `edit_load_point`, `delete_load_points` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_save_connection_type` | ctx.edit: `save_connection_type` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_plumbing_catalog` | `ctx.read("bim_plumbing_catalog")` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_plumbing_design` | ctx.edit: `set_system_design`, `set_project_parameters` | covered | script covers it → retirement candidate (maintainer's call) |

## views-sheets

| Tool | Script equivalent | Status | Note |
| --- | --- | --- | --- |
| `bim_create_view` | `documents.planView`, `documents.ceilingView`; ctx.edit: `create_view` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_set_view_properties` | ctx.edit: `set_view_properties`, `set_view_crop` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_rename_view` | ctx.edit: `rename_view` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_duplicate_view` | `documents.duplicateView`; ctx.edit: `duplicate_view` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_delete_view` | ctx.edit: `delete_view` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_create_sheet` | `documents.sheet`; ctx.edit: `create_sheet` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_set_sheet_properties` | `documents.setSheet`; ctx.edit: `set_sheet_properties` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_delete_sheet` | ctx.edit: `delete_sheet` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_place_viewport` | `documents.place`; ctx.edit: `place_viewport` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_edit_viewport` | ctx.edit: `move_viewport`, `resize_viewport`, `set_viewport_scale`, `set_viewport_north_arrow`, `remove_viewport` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_preview_sheet_layout` | `documents.packSheet` in `bim_run_script` (the run is the preview) | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_auto_layout_sheet` | `documents.packSheet(ctx, sheet, { mode, fitScales })` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_set_issue_status` | none | host step | issue status is recorded by the host's issuing |
| `bim_add_sheet_note` | ctx.edit: `create_text_note` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_edit_text_note` | ctx.edit: `edit_text_note`, `resize_text_note` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_create_3d_view` | ctx.edit: `create_3d_view` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_set_3d_view_camera` | ctx.edit: `set_3d_view_camera` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_set_3d_crop_box` | ctx.edit: `set_3d_crop_box` | covered | script covers it → retirement candidate (maintainer's call) |

## coordination

| Tool | Script equivalent | Status | Note |
| --- | --- | --- | --- |
| `bim_browse_autodesk_docs` | none | host step | reads another company's cloud through the host's connection |
| `bim_link_from_autodesk_docs` | none | host step | links an outside model through the host's connection |
| `bim_update_linked_model` | none | host step | fetches a new version through the host's connection |
| `bim_unlink_linked_model` | none | host step | the host keeps the link records |
| `bim_sync_linked_levels` | `building.levelSyncPlan` and `building.syncLevels` | covered | the linked model's storeys come from the host's link; a script takes them as values; script covers it → retirement candidate (maintainer's call) |
| `bim_update_level` | ctx.edit: `update_level` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_create_level` | `building.level`; ctx.edit: `create_level` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_read_coordinates` | `bim_model_summary` / `bim_query_elements` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_preview_coordinates_edit` | `bim_run_script` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_set_project_origin` | ctx.edit: `set_project_origin` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_set_survey_point` | ctx.edit: `set_survey_point` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_set_true_north` | ctx.edit: `set_true_north` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_set_working_angle` | ctx.edit: `set_working_angle` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_lint_accept_finding` | none | host step | accepted findings are stored by the host |
| `bim_lint_retract_acceptance` | none | host step | accepted findings are stored by the host |
| `bim_trace_rooms` | `building.spaceInWalls`; ctx.edit: `place_space_in_walls` | covered | script covers it → retirement candidate (maintainer's call) |

## groups-phases

| Tool | Script equivalent | Status | Note |
| --- | --- | --- | --- |
| `bim_list_groups_and_phases` | `bim_query_elements` (groups, phases) | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_preview_organization_edit` | `bim_run_script` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_create_group` | ctx.edit: `create_group` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_update_group` | ctx.edit: `update_group`, `lock_group`, `set_group_typical` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_delete_group` | ctx.edit: `delete_group` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_assign_to_group` | ctx.edit: `assign_elements_to_group` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_set_active_group_and_phase` | ctx.edit: `set_active_group`, `set_active_phase` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_create_phase` | ctx.edit: `create_phase` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_update_phase` | ctx.edit: `update_phase` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_set_element_phases` | ctx.edit: `set_element_phases`, `demolish_elements` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_set_view_organization` | ctx.edit: `set_view_properties` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_set_phase_filter` | ctx.edit: `create_phase_filter`, `update_phase_filter` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_delete_phase` | ctx.edit: `delete_phase` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_delete_phase_filter` | ctx.edit: `delete_phase_filter` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_set_element` | ctx.edit: `set_element_class`, `set_element_type`, `set_element_values` | covered | script covers it → retirement candidate (maintainer's call) |

## parts

| Tool | Script equivalent | Status | Note |
| --- | --- | --- | --- |
| `bim_draft_part_from_cut_sheet` | none | host step | reads a cut sheet with AI on the host |
| `bim_read_picture_rows` | none | host step | reads a picture with AI on the host |
| `bim_part_definition_example` | `bim_script_reference` (Part definition recipe) | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_check_part_definition` | `PartBuilder.check`; `bim_check_output` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_read_part_definition` | none | host step | the firm library is stored by the host |
| `bim_save_part_definition` | `ctx.parts.define` + `bim_save_part_type` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_list_firm_parts` | none | host step | the firm library is stored by the host |
| `bim_save_firm_part` | none | host step | the firm library is stored by the host |
| `bim_set_clearances` | `PartBuilder.clearance`; ctx.edit: `set_part_clearances` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_set_part_host` | ctx.edit: `set_part_host` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_set_mounting_plane` | ctx.edit: `set_mounting_plane`, `create_mounting_plane` | covered | script covers it → retirement candidate (maintainer's call) |

## calcs

| Tool | Script equivalent | Status | Note |
| --- | --- | --- | --- |
| `bim_list_calcs` | `ctx.calcs()` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_run_calc` | `ctx.calc({ calc, inputs, …edition })` | covered | name the code edition; the host's adopted codes are not read from a script; script covers it → retirement candidate (maintainer's call) |
| `bim_suggest_duct_size` | `ctx.read("mechanical.duct_size", { cfm, shape, height_mm } | { element_id })` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_pressure_report` | `ctx.calc({ calc: "mech.duct_system_pressure" })` on the script's model | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_pipe_report` | `ctx.calc({ calc: "plumbing.pipe_system" })` or `plumbing.pressure_report` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_set_fitting_coefficient_override` | ctx.edit: `set_fitting_coefficient` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_size_pipes` | `ctx.calc({ calc: "plumbing.size_system" })`, then ctx.edit: `set_pipe_sizes` | covered | name the plumbing or fuel gas edition; script covers it → retirement candidate (maintainer's call) |
| `bim_service_from_equipment_list` | `ctx.calc({ calc: "nec.service_size" })` with loads the script reads from `ctx.model` | covered | script covers it → retirement candidate (maintainer's call) |

## schedules

| Tool | Script equivalent | Status | Note |
| --- | --- | --- | --- |
| `bim_schedule_fields` | `documents.scheduleFields(ctx, classes)` | covered | a firm's own schedule-library classes come from the host's library (`bim_library`); script covers it → retirement candidate (maintainer's call) |
| `bim_schedule_define` | `documents.schedule`; ctx.edit: `create_view`, `edit_schedule` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_schedule_edit_cells` | ctx.edit: `set_element_values`, `set_parameters` | covered | script covers it → retirement candidate (maintainer's call) |
| `bim_library` | none | host step | the schedule library is stored by the host |

## Still to fill in the script API

Nothing: every tool is covered by a script or is a host step by design.

## Stays a host step

- `bim_render_view_image`: drawing pictures needs the host's renderer.
- `bim_render_sheet_image`: drawing pictures needs the host's renderer.
- `bim_print_sheet_pdf`: printing writes files through the host.
- `bim_print_view_pdf`: printing writes files through the host.
- `bim_print_set_pdf`: printing writes files through the host.
- `bim_issue_set`: issuing records a set and its files in the host.
- `bim_lint_configure`: lint settings are stored by the host.
- `bim_status_snapshot`: prints and issues are the host's record.
- `bim_set_issue_status`: issue status is recorded by the host's issuing.
- `bim_browse_autodesk_docs`: reads another company's cloud through the host's connection.
- `bim_link_from_autodesk_docs`: links an outside model through the host's connection.
- `bim_update_linked_model`: fetches a new version through the host's connection.
- `bim_unlink_linked_model`: the host keeps the link records.
- `bim_lint_accept_finding`: accepted findings are stored by the host.
- `bim_lint_retract_acceptance`: accepted findings are stored by the host.
- `bim_draft_part_from_cut_sheet`: reads a cut sheet with AI on the host.
- `bim_read_picture_rows`: reads a picture with AI on the host.
- `bim_read_part_definition`: the firm library is stored by the host.
- `bim_list_firm_parts`: the firm library is stored by the host.
- `bim_save_firm_part`: the firm library is stored by the host.
- `bim_library`: the schedule library is stored by the host.

## Proof

`packages/bim-mcp/__tests__/core-only-tasks.test.ts` runs, with only the core tools on the server, one script each to: create sheets with a plan placed on each; make a schedule on a sheet; find a room from the walls around it; build, place and duct a rooftop unit; route a drain sized by the plumbing code with its slope; and tag elements in a plan. `packages/bim-mcp/__tests__/core-only-gaps.test.ts` does the same for the jobs that needed add-on tools: receptacles by code spacing, a room schedule, a schedule's numbers, a dwelling unit circuited from a room template with the panel's loads per phase, a phase rebalance, every duct tagged and dimensioned, a packed sheet, one-line diagrams (described and live), ducts sized from airflow, the clash check, levels from a linked model, the catalogues, and a duct height from the surfaces over it. The scripts are the worked examples `bim_script_reference` serves. `packages/bim-mcp/__tests__/core-tool-budget.test.ts` holds the default list to 10.
