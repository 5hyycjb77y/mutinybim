---
name: mutinybim-model
description: "MutinyBIM family for model reads and everyday edits: schedule rows, part types, levels, views and sheets, linked models, surfaces at a point; previews of part, route and views/sheets edits; placing, moving, rotating, copying and deleting parts, parameters, moving walls; pictures of views and sheets; printing and issuing a set; coordination lint and status snapshots. Use with the mutinybim core. Trigger on: list levels, list views, list sheets, schedule rows, preview an edit, place a part, move equipment, delete elements, render a view, print the set, issue the set, lint."
license: Apache-2.0
compatibility: "Needs the mutinybim MCP server with the model family turned on (bim_enable_pack, --packs model, or /packs/model/mcp under the MutinyBIM base)."
metadata:
  pack: "model"
  mcp-server: "mutinybim"
  family: "model"
  token-cap: "9600"
  tools: "bim_schedule_read bim_list_part_types bim_list_levels bim_list_views_and_sheets bim_list_linked_models bim_surfaces_at bim_describe_commands bim_preview_part_edit bim_preview_route_edit bim_preview_views_sheets_edit bim_apply_views_sheets_edit bim_render_view_image bim_render_sheet_image bim_print_sheet_pdf bim_print_view_pdf bim_print_set_pdf bim_issue_set bim_place_part bim_move_elements bim_rotate_elements bim_copy_elements bim_delete_elements bim_set_parameters bim_move_wall bim_lint_configure bim_lint_check bim_status_snapshot"
---

# MutinyBIM: model reads and everyday edits

A family of the `mutinybim` core. Activate `mutinybim` first: it has the
script tools, the four starting reads and the rules for every change. Turn
this family on for the reads a script plans from (levels, views and sheets,
schedule rows, linked models, what is under a point), the previews of the
family edits, single part edits, pictures, printing and issuing, and the
coordination lint. For more than one or two changes, prefer one script.

## Coordination lint: you are not working blind

Every saved modeling, drafting, view and sheet edit comes back with a `lint`
block from the same engine people use in Manage › Coordination: `new`
findings the edit caused (rule, severity, element ids with `linked:<GlobalId>`
for the architect's model, a plain message, a `fix` tool and hint),
`resolved` finding ids, `near` (level, room, the surface under it, things
within the scope radius), `open_errors` around the edit, and `truncated`.
`status: "deferred"` means it ran past its time; call `bim_lint_check` for
that area. A refused edit carries `lint.blocking`: the open issues on what it
blames.

1. **Configure once.** Call `bim_lint_configure` at the start of a modeling
   session (ruleset, tolerance; `snapshot: "auto_if_vision"` adds a small
   picture every few edits when this thread's model reads images, and none
   when it doesn't). Never pass lint options per edit.
2. **Read the `lint` block after every edit.** A new `error` is fixed (with
   the tool its `fix` names, or another plan) or explained to the person
   before the next edit. Never stack edits on a new hard clash.
3. **Never claim "clash-free", "coordinated" or "complete"** unless
   `bim_lint_check` ran with `include_linked: true` on the scope you describe
   and returned zero errors. Quote its ruleset and tolerance. Validation,
   open issues, network, pressure and part checks don't look at shape.
4. **Render and look.** After placing or making parts, finishing an
   assembly, or laying out a sheet, call `bim_status_snapshot` (or a cropped
   `bim_render_view_image` plus the sheet render) and say what you see. If
   the picture and the model disagree (a part that doesn't draw), stop and
   report it.
5. **Issue sets.** Run `bim_lint_check` with ruleset `issue` before
   `bim_issue_set`, and print again if the schedules changed since.
6. **Accepting a finding is the person's call.** When the person says a
   finding is acceptable, `bim_lint_accept_finding` (in
   `mutinybim-coordination`) records it with their reason, using an `id`
   from `bim_lint_check` (other ids are refused). Never accept one to make a
   check pass, or to try the tool out. `bim_lint_retract_acceptance` takes
   one back, with the person's reason.
7. **Don't change a person's own view** (`{3D - name}`): duplicate it.

Units: distances, offsets and elevations in feet; duct sizes and paper
positions in inches; airflow in CFM; pipe by nominal inches plus material.
Kernel commands inside `bim_preview_views_sheets_edit` are millimetres
unless you use the standalone tools' names (`crop_min_ft`, `cut_height_ft`,
`center_in`, top-level `level`…), which are converted.

Levels: every level input (`level`, `level_id`, area `level` on reads and
edits, lint, schedules, views, `bim_update_level`) takes the level's id or its
name. A loose spelling works when only one level matches ("LEVEL 01" finds
"Level 1"). An unknown or ambiguous level is refused with the candidates; pick
one or call `bim_list_levels`. Views and schedules store the level's real name,
so renaming the level carries them along.

## Tools

### Reads (no approval)

| Tool | Use it to |
| --- | --- |
| `bim_schedule_read` | Rows of any schedule view (or an ad hoc definition): columns with unit and whether a cell edits per instance or per type (or why it's locked), rows as `[row_key, ...cells]` (≤200 per call from `offset`), totals, `explain` for locked cells. No `schedule`: lists the schedule views. Panel and feeder form schedules return what prints |
| `bim_list_part_types` | Placeable types in every discipline (model's own first, then the starter library), their parameters, choices, connectors, plus levels |
| `bim_list_levels` | The model's levels (name, elevation in feet, the linked storey each was made from) and every linked model's storeys at their height in this model, with what `bim_sync_linked_levels` would do to each (`in_step` when nothing would change) |
| `bim_list_views_and_sheets` | Every view (plan, ceiling plan, section, 3D, detail) with level, scale, crop and sheet; every sheet with viewports, notes and live `blocks` (id, title, what it says now, `unresolved` fields) |
| `bim_surfaces_at` | **What is under and over a part or a point**: the floor (or roof) it stands on and the ceiling, roof and structure above, each `height` as `{ value, unit: "ft" }` (with `above_floor`) and its `source` in words (the host it stands on, a space's ceiling height, our slabs, a linked model's slab, roof or ceiling). Give `element_id` (RTU-1's id), or `x_ft`, `y_ft` and `level`. Use it for "how high is the roof where RTU-1 sits", ceiling heights for devices, roof curbs. If the linked models can't be read it answers from this model and says so in `notes` |
| `bim_list_linked_models` | Every linked model: source (IFC upload, our Revit export, a Docs file), the version shown and every version with its status (`queued`, `converting`, `ready`, `failed` with the reason), `alignment` and what fixes it (`fix`), the position adjustment in feet, the latest export from Revit and Docs files still coming in |
| `bim_print_sheet_pdf` | Vector PDF of one sheet at true scale from the **last saved** revision; 5-minute link with revision and sha256. Does not issue the sheet |
| `bim_print_view_pdf` | Vector PDF of one view on its own (plan, section, 3D, detail or drafting view, schedule), sized to the view at its scale; 5-minute link with revision and sha256. For several sheets in one file use `bim_print_set_pdf` |
| `bim_render_view_image` | **Look at a view**: a PNG of any view exactly as it prints, returned as an image you can see. `region_ft` (view feet) or `region_in` (paper inches) to zoom, `focus_ids` to frame elements, `highlight_ids` to outline them in red, `dpi` / `max_px` (1,280 px on the long side unless you ask; zoom into a region before raising it). `keep_copy` stores the PNG and returns a link for the person |
| `bim_render_sheet_image` | **Look at a sheet**: a PNG of one sheet as it prints (viewports, notes, schedules, title block). A whole 36 x 24 sheet is an overview; zoom with `region_in` (paper inches from the top-left) to read notes and tags |

### Coordination lint

| Tool | Use it to |
| --- | --- |
| `bim_lint_configure` (no approval) | Once per session: ruleset (`default`, `coordination`, `documents`, `issue`), tolerance and clearances, scope radius, linked models on or off, `snapshot`. Saved for this thread (`for: "me"`: your default on this model). Returns the settings and the rules this model can't run yet |
| `bim_lint_check` (no approval) | Every finding on the model, a `level`, or around `ids`, with the ruleset and tolerance used; `include_linked`, `include_accepted`; 25 a page (`offset`). The only basis for saying something is clash-free. With linked models, read `linked_coverage`: `complete` (every linked model checked), `none` (the project links none), `indexing` / `incomplete` (status `partial`, "linked coverage INCOMPLETE: N of M"): clashes with linked models are missing, so re-run in a minute and never call it clash-free until `complete` |
| `bim_status_snapshot` (no approval) | End of a batch: counts, open findings by rule, this thread's last edits, up to 3 small pictures (the last-edited plan, sheet, a 3D view, or the `views` / `sheets` you name). Look at them and say what you see. Findings carry the same `linked_coverage`; the `lint` block on a saved edit never waits for linked models, so the first edits of a session may say they are still being indexed |

### Previews and the views/sheets apply

| Tool | Covers |
| --- | --- |
| `bim_preview_part_edit` | `bim_place_part`, `bim_move_elements`, `bim_rotate_elements`, `bim_copy_elements`, `bim_delete_elements`, `bim_set_parameters`, and from packs `bim_create_level`, `bim_save_part_definition` and `bim_set_element` |
| `bim_preview_route_edit` | Every duct and pipe edit in `mutinybim-ducts-pipes`: `bim_route_run`, `bim_connect_runs`, `bim_disconnect_run`, `bim_resize_run`, `bim_slide_branch`, `bim_swap_fitting`, `bim_offset_run`, `bim_change_elevation`, `bim_set_system_design`, `bim_set_slope`, `bim_place_pipe_accessory`, `bim_split_run`, `bim_resize_stretch`, `bim_drag_run`, `bim_set_duct_insulation`; also `bim_set_fitting_coefficient_override` (in `mutinybim-calcs`) |
| `bim_preview_views_sheets_edit` | Any views/sheets command (create / rename / duplicate / delete view, set view properties or crop, sheets and title blocks incl. `revisions`, viewports, drawing items: line, rect, cloud, dimension, and notes: `create_text_note`, `edit_text_note`, `resize_text_note`, `move_text_note`, `delete_text_note`), **or a `batch_documents` of up to 500 of them** (all or nothing, one approval). Also, one at a time: live sheet blocks (`add_field_block`, `edit_field_block`) and spaces, zones and underlays (`create_space`, `edit_space`, `delete_spaces`, `make_spaces_from_rooms`, `create_zone`, `edit_zone`, `delete_zones`, `place_underlay`, `calibrate_underlay`, `edit_underlay`, `delete_underlays`), loads, and questions (`add_question`, `answer_question`, `set_question_status`, `edit_question`, `delete_questions`). Returns a `preview_token`; save exactly that change with `bim_apply_views_sheets_edit`. Lengths in mm, paper positions and note widths / text heights in paper mm |
| `bim_apply_views_sheets_edit` (approval) | Save exactly the change `bim_preview_views_sheets_edit` returned: same `command`, its `base_revision` and `preview_token`. A different command or revision is refused before anything is sent; a retry never saves twice. This is how a whole batch of sheets, viewports or annotation edits saves in one approval |

### Parts, any discipline (each needs approval)

| Tool | Use it to |
| --- | --- |
| `bim_place_part` | Place equipment, terminals, receptacles, panels, lights, fixtures… on a level at a plan position. Values are checked against the type. **No `level_id`, `x_ft`, `y_ft`: the part is planned** (exists for circuits, schedules and the one-line, waits in Not placed yet; optional `level_hint`, `space_hint`, `note`). `part_id` instead of `type_id` with a location draws that planned part (same id, circuits and values kept); `part_id` with `unplace: true` takes a placed part off the drawing (disconnect its runs first). A firm-library size (`bim_list_firm_parts`, in `mutinybim-parts`) needs `from_firm_library: true`. `mount: "turned_over"` (a floor register: neck down) or `"on_side"` (a sidewall register, facing `rotation_deg`); `on_plane_id` puts it on a mounting plane at the plane's height; `intakes` sets a hood / louver / screen on an outdoor-air opening. **`equipment_list` (alone): a pasted vendor or mechanical schedule** becomes planned items, one per unit (K-14 ×2 → K-14.1, K-14.2) with each row's volts, phase, load, gas MBH and water / waste sizes, in one approval, exactly as Equipment list › Add. A row the reader can't use refuses the whole list and names the row: tell the person, never guess the value |
| `bim_move_elements` | Move parts by an offset (also up/down); equipment drags its connected ducts; tags follow |
| `bim_rotate_elements` | Rotate about the insertion point, a pivot, or the group centre |
| `bim_copy_elements` | Copy by an offset; copies keep type and values, start without a mark |
| `bim_delete_elements` | Delete. Default `refuse` lists dependents; `disconnect` cuts connections; `cascade` removes dependents too. Preview first and say what goes |
| `bim_set_parameters` | Set instance values (this part) or type values (every part of that type); a value may be `{ value, unit }`. Instance scope also takes `mount` (disconnect its runs first) and `intakes` |
| `bim_move_wall` | Move a wall; its doors, windows, tags and room dimensions follow |

New levels are `mutinybim-coordination`; new part types are `mutinybim-parts`.

### Print and issue the set

| Tool | Use it to |
| --- | --- |
| `bim_print_set_pdf` (read) | Every sheet (or the `sheets` given, in that order) from the last saved revision to **one** vector PDF with linked backgrounds, in binding order (G, H, V, B, C, L, S, A, I, Q, F, FP, P, D, M, E, T…, then number). Returns pages, revision, sha256 and a 5-minute link, and records how each sheet drew for the issue check. Does not issue |
| `bim_issue_set` (approval) | Issue (live blocks on the issued sheets are frozen as issued; afterwards each reads "Matches" or "Changed since" that issue): optional `add_revision` (one row on every issued sheet, one edit), then capture the model at that revision, draw the set **only from the capture**, store the snapshot, PDF and manifest write-once and hand the PDF to the host to file with the project's issued drawings. `expected_revision` = the revision you checked; if anything was saved since, **nothing is issued**. Refused as `needs_print` when a sheet draws differently than in the last `bim_print_set_pdf` (live schedules): print again, or `accept_changes_since_print: true` after checking those sheets. Check first with `bim_set_issue_status` (read only, in `mutinybim-views-sheets`; it gives the `revision` to pass as `expected_revision`). A retry returns the same issue |

Issue only when the person says to issue, with `expected_revision` = the
revision you printed and checked. If it says the model moved, someone saved
since you checked: review, print, and ask again. Never issue a set you didn't
print and check.

**Locked groups.** Nothing in a locked group can be created, changed, moved,
demolished or deleted, by anyone, agents included; an edit that would touch
one is refused and nothing changes. Report the refusal word for word and ask
the person whether to unlock the group (`mutinybim-groups-phases`). Never
unlock a group yourself unless the person asked for exactly that, and never
route around a lock.

## Workflows

**Place a part:** `bim_list_part_types` (category or search) → pick type and
level → `bim_preview_part_edit` with `tool: "bim_place_part"` → describe →
`bim_place_part` with `base_revision`.

**List first, draw second.** A part can exist before it is drawn: plan it
with `bim_place_part` and no location, circuit it, schedule it, put it on the
one-line, then place it when the drawing is ready. Check the Not placed yet
list (`bim_model_summary`) before saying a job is drawn, and never invent a
location to get a part onto the drawing: ask where it goes. People see the
same list in the MutinyBIM editor (Electrical, Mechanical or Plumbing tab ›
Not placed yet) and can place each one in the view they are in.

**Kitchen equipment list → circuits → schematic design.** First turn on
every family the job needs: `mutinybim-electrical` (it has
`bim_electrical_report`, `bim_place_service_layout` and `bim_create_circuit`)
and, for the schematic design issue, `mutinybim-views-sheets`. The person
pastes the vendor's schedule: `bim_place_part` with `equipment_list` (one
approval; the items wait in Not placed yet). Once it saves, go straight on to
the panel and the circuits in the same turn; the list is the first step, not
the end. No panel yet (`bim_electrical_report` lists
none): plan the main panel the way "Add a planned panel (MDP)" does,
`bim_place_service_layout` with `plan_only: true`, the service size and system
the person gives, distribution name MDP (one approval). Then
`bim_create_circuit` with `source_id` the panel, `members: []` and
`one_circuit_each: true` is Circuit all: every item waiting for a circuit gets
its own, breaker sized by the project's NEC edition (one approval). Read back
`circuits` and `not_circuited` (an item on the wrong voltage says so: report
it, never move it to another panel yourself). Issue the schematic design set only when asked
(`mutinybim-views-sheets`).

**Loads list → building drain.** Turn on `mutinybim-schedules` and
`mutinybim-calcs` first. `bim_schedule_define` with
`template: "loads"` and a `name` previews the built-in Loads list (nothing
saved, a `preview_token`); call it again with the same arguments plus
`base_revision`, `preview_token` and `user_confirmed: true`, which waits on the
Approve card. Then `bim_schedule_read` for its totals, and `bim_run_calc`
(`plumbing.size_drain`, role `building_drain`) for the total drainage fixture
units. Report the DFU total and the size with the clause it cites.

**Questions and assumptions.** When the engineer says "ask the architect
whether …", pin a question to the elements it is about: `add_question`
`{ questions: [{ questionId, text, askOf: "architect", anchor: { elementIds },
blocksIssue? }] }` through `bim_preview_views_sheets_edit` →
`bim_apply_views_sheets_edit`. `answer_question` records the answer
(`status: "assumed"` with the assumption the design goes ahead on);
`set_question_status` withdraws (`withdrawn`) or asks again (`open`). Before
drafting an email, `bim_model_summary` with `questions: "<audience>"`: it
skips what the model already answers and returns the text only (nothing is
sent: the person sends it). A sheet that shows an element with an open
holding question can't be issued: quote the hold reason the refusal gives,
never say only "it can't issue".

**Loads, one concept for every trade.** A load starts as an estimate on a
space or zone (lighting 5 kW on the kitchen), becomes a point, then a real
device once placed, and keeps its id the whole way. Everywhere a total shows,
the estimate is shown against the devices so far ("estimate 5,000 VA, devices
so far 800 VA"); the estimate counts until the devices exceed it. Say it that
way, never "allocated" alone. Create, move, name a source or set the policy
with `bim_preview_views_sheets_edit` (`create_load`, `move_load`,
`split_load`, `edit_load_point` with `servedBy`, `set_load_allocation_policy`)
or, with `mutinybim-plumbing`, `bim_edit_load_point`. `bim_query_elements` on
a space or zone returns `loads` in those words.

**Spaces and zones.** Most jobs have only a PDF or a CAD file, no linked
model. People draw spaces by tracing over that drawing (Spaces › Draw space);
the area comes from the outline, never typed. You may make spaces from the
architect's rooms (`make_spaces_from_rooms`), type rows that have no outline
yet (`create_space` without `outline`), group spaces into zones and say what
serves each (`create_zone` / `edit_zone` `servedBy`, planned equipment
included), and place or scale an underlay when the person asks. Never invent
an outline. All of these go through `bim_preview_views_sheets_edit` →
`bim_apply_views_sheets_edit`. Each space says how its estimates count
(`estimates_count` on its row); `edit_space { spaceId, estimateCounting }`
sets `max` (estimate until devices exceed it), `actual_only`,
`allocation_only`, or `null` (the model's setting), the same as the space's
Loads › Estimates count field.

**Live load summary on a sheet:** `bim_preview_views_sheets_edit` with
`{ type: "add_field_block", itemId, sheetId, at_in: { x, y } }` (no `block`:
the electrical load summary at the service; `block: { template, title,
subjectId }` for another; `block: { table: { kind: "ventilation" } }` or
`"pressurization"` for that table, the whole model unless `scope: { kind:
"level", levelId }` or `{ kind: "zone", zoneId }`) → approve →
`bim_list_views_and_sheets` shows what it says now. `edit_field_block` changes it (`title: null` removes the title);
move it with `update_drawing_item { itemId, points: [at] }`. It updates with
every edit and freezes when the set is issued; `bim_set_issue_status` says
whether it still matches the last issue.

**Rebalance airflow:** `bim_query_elements` (terminals, CFM) → activate
`mutinybim-ducts-pipes` → one `bim_set_terminal_airflow` per terminal, each on
the latest saved revision → read the terminals again and report the new totals.

**Produce a construction drawing set:** activate `mutinybim-views-sheets` and
follow its "Produce a construction drawing set" workflow (plan, views, sheets
in one approval, layout, schedules, notes, verify, print, issue). Add
`mutinybim-drafting` for dimensions, tags and details.

<!-- tools: rendered from the catalogue by `npm run build:files`; edit the catalogue, not this list -->

## Tools in this family

| Tool |
| --- |
| `bim_schedule_read` |
| `bim_list_part_types` |
| `bim_list_levels` |
| `bim_list_views_and_sheets` |
| `bim_list_linked_models` |
| `bim_surfaces_at` |
| `bim_describe_commands` |
| `bim_preview_part_edit` |
| `bim_preview_route_edit` |
| `bim_preview_views_sheets_edit` |
| `bim_apply_views_sheets_edit` |
| `bim_render_view_image` |
| `bim_render_sheet_image` |
| `bim_print_sheet_pdf` |
| `bim_print_view_pdf` |
| `bim_print_set_pdf` |
| `bim_issue_set` |
| `bim_place_part` |
| `bim_move_elements` |
| `bim_rotate_elements` |
| `bim_copy_elements` |
| `bim_delete_elements` |
| `bim_set_parameters` |
| `bim_move_wall` |
| `bim_lint_configure` |
| `bim_lint_check` |
| `bim_status_snapshot` |

<!-- end tools -->
