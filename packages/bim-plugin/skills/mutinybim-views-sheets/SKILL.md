---
name: mutinybim-views-sheets
description: "MutinyBIM pack for views and sheets: create, rename, duplicate and delete views, view properties and crops, 3D views with camera and crop box, sheets, title block properties, viewports and their layout, sheet notes and text notes, issue status. Use with the mutinybim core, which previews and saves view and sheet batches and prints and issues the set. Trigger on: create a view, crop, 3D view, create sheet, viewport, title block, sheet layout, sheet note."
license: Apache-2.0
compatibility: "Needs the mutinybim MCP server with the views-sheets family turned on (bim_enable_pack, --packs views-sheets, or /packs/views-sheets/mcp under the MutinyBIM base)."
metadata:
  pack: "views_sheets"
  mcp-server: "mutinybim"
  family: "views-sheets"
  token-cap: "10600"
  tools: "bim_create_view bim_set_view_properties bim_rename_view bim_duplicate_view bim_delete_view bim_create_sheet bim_set_sheet_properties bim_delete_sheet bim_place_viewport bim_edit_viewport bim_preview_sheet_layout bim_auto_layout_sheet bim_set_issue_status bim_add_sheet_note bim_edit_text_note bim_create_3d_view bim_set_3d_view_camera bim_set_3d_crop_box"
---

# MutinyBIM: views, sheets and drawing sets

A family of the `mutinybim` core. Activate `mutinybim` first: it has the
script tools, the four starting reads and the rules for every change: preview, say the change, edit with `base_revision`, report the server's
answer, and look at every drawing you change. Turn on the `model` family
too: it has `bim_list_views_and_sheets`, the views/sheets preview and apply
(`bim_preview_views_sheets_edit`, `bim_apply_views_sheets_edit`), the
pictures (`bim_render_view_image`, `bim_render_sheet_image`), printing and
`bim_issue_set`. A sheet and a plan view per level, with their viewports, is
one script (`documents.sheet`, `planView`, `place`; there is no sheet set
function, so number the sheets in print order); the tools
here are for single changes and for laying out and checking what a script
made.

Dimensions, tags, notes with leaders and details are the `mutinybim-drafting`
pack; activate it too when the sheets need them.

## Views, crops and sheets (each needs approval)

| Tool | Use it to |
| --- | --- |
| `bim_create_view` | Floor plan or ceiling plan for a level, section from a cut line, 3D, or detail view |
| `bim_set_view_properties` | Scale, what a plan shows (`top_ft`, `cut_height_ft`, `bottom_ft`, `view_depth_ft`), line weights by category (`line_weights`), discipline, hidden categories, **how each linked model draws** (`linked_models`, see `mutinybim-coordination`), detail level, and the **crop box**: `crop_min_ft` + `crop_max_ft` (both), `crop_view`, `show_crop_box`, `annotation_crop`, `far_clip_ft` (sections). `fit_crop` sizes the crop to the content and must be sent on its own. A placed viewport resizes with its crop. `projection: "perspective" \| "orthographic"` (3D views only; plans, sections and details are always orthographic and refuse it) sets how the live 3D view draws depth; sheets print 3D views orthographic either way. **`category_overrides`**: Visibility/Graphics for any category (see below) |
| `bim_create_sheet` | New sheet with number, name, title block (ARCH D 36x24 default, or ANSI B 17x11) and title block fields |
| `bim_place_viewport` | Put a view on a sheet at a paper position (inches from top-left). A view goes on one sheet only |
| `bim_add_sheet_note` | Note on a sheet: a box at `at_in` (its top-left, inches from the sheet's top-left) that wraps at `width_in` (default 4"). Plain `text`, or rich `paragraphs` (see below). Optional fixed `height_in`, `rotation_deg`, `leader_to_in`, default `text_height_in` (3/32") |
| `bim_edit_text_note` | Replace a note's whole text (sheet or detail view), keeping its box. Pass `expected_content` from `bim_list_views_and_sheets`; if anyone changed the note's words since, nothing is saved: read again and re-plan |
| `bim_rename_view` / `bim_duplicate_view` / `bim_delete_view` | Rename; copy with its properties and crop (not placed); delete (`if_placed: "remove_from_sheet"` to take it off its sheet too, else refused when placed) |
| `bim_set_sheet_properties` | Number, name, title block size, title block `fields` (client, address, drawn_by, checked_by, date, status, or any key; `""` clears one), and the revision table: `add_revision` appends one row; `revisions` replaces it (oldest first). Rows print in the title block, newest on top. `project_name`, `project_number` and `firm_name` fill the block's fixed PROJECT, PROJECT NO. and firm slots; left out, those print the project name, number and firm the host gives the model. `bim_render_sheet_image` returns `title_block` with what printed |
| `bim_delete_sheet` | Delete a sheet with its viewports, notes and linework; its views stay |
| `bim_edit_viewport` | One placed view: `action` move (`center_in`), resize (`size_in`, the crop follows), scale, north_arrow (`show`), remove. Name it by its view. A live diagram (one-line, riser, isometric) or a schedule is as big as what it draws: move only; resize and scale are refused with its real size. A frame that runs past the drawing area still saves, with a warning naming its size and the sheet's |
| `bim_preview_sheet_layout` (read) | Where every viewport on a sheet should go (packed rows or an aligned grid, inside the border and left of the title block, room for each view title, optional scale shrink to fit). Deterministic. Returns moves, what can't fit and why, and a `preview_token` for `bim_auto_layout_sheet` |
| `bim_auto_layout_sheet` | Apply the layout `bim_preview_sheet_layout` returned (same arguments, its `base_revision` and `preview_token`) as one edit |
| `bim_set_issue_status` (read only, issues nothing, despite the name) | Before issuing: each live block (`blocks`: `freshness` Live, Matches <issue> or Changed since <issue>, the text now and `issued_text` when it moved on), `print_check` (`matches_print`, `changed_since_print`, `not_printed`) with the sheets that draw differently than in the last `bim_print_set_pdf` (`changed_since_print`) or weren't in it (`not_in_print`), the `revision` to pass as `expected_revision`, `next_revision`, the last print and earlier issues with PDF links |

Many of these in one approval: a `batch_documents` through
`bim_preview_views_sheets_edit` → `bim_apply_views_sheets_edit` (model family).

## What a plan shows, and its lines

**Heights** (plans only, feet above the plan's level, on
`bim_set_view_properties`): `top_ft` (nothing above it draws; at or above the
cut; `null` = no limit, so ductwork above the cut still shows), `cut_height_ft`
(walls are cut here), `bottom_ft` (at or below the cut; negative is below the
level; `null` = no limit), `view_depth_ft` (how far below the bottom it still
sees; sending it alone sets the bottom at the level). Our model and the linked
models both follow them: an element wholly above the top or below
bottom − depth is left out of the drawing. Read them back as `shows` in
`bim_list_views_and_sheets`. Plans made before these existed have no top or
bottom and draw everything on their level, as before. Sections use
`far_clip_ft` instead and refuse top and bottom.

**Line weights by category** (`line_weights` on `bim_set_view_properties`):
`{"duct": {"cut": "wide", "beyond": "medium"}, "walls": {"cut": "heavy"}}`
with pens thin, medium, wide, heavy; `null` clears one pen or a whole category
back to the drawing default. Categories: duct, duct_fitting, pipe,
air_terminal, equipment, walls, doors_windows, rooms, grids, structure, tags,
dimensions, electrical_devices, lighting_fixtures, electrical_equipment
(panels and other gear), insulation. The same names hide categories. The linked models take their own pens under `linked_models`
(`cut_line_weight`, `beyond_line_weight`) plus `linked_hidden_lines` and
`linked_min_object_in`; see `mutinybim-coordination`. Read back as
`line_weights` in the listing.

**Visibility/Graphics by any category** (`category_overrides` on
`bim_set_view_properties`): one shape for every category, not only the
sixteen above. A category id is a view category (`duct`,
`electrical_devices`), a class (`mep.electrical_device`, `mep.air_terminal`,
`struct.beam`, a firm class or an add-on's class), `service:<id>`
(`service:grease_waste`) or `drafting:<id>`. Each takes `visible`,
`halftone`, `cut` and `beyond` pens, `pattern` (a system line pattern) and
`colour` (`#rrggbb`):
`{"mep.electrical_device": {"halftone": true}, "service:grease_waste": {"cut": "wide"}}`.
It merges into what the view has; `null` clears one category. An id no
library knows is refused with close ids: use one of those, never invent one.
A model server that can't store per-category graphics yet refuses the edit in
plain words (nothing changes); the older `hidden_categories` and
`line_weights` still work there. The saved answer and the listing read it
back as `category_overrides`.

People set all of this in View properties: **What this view shows** (Top,
Cut height, Bottom, Depth below bottom) and **Lines and colours** (visual
style, detail level, a line weight table by category, and the linked models:
halftone, Hide what is underneath, Leave out things smaller than, their cut
and below-the-cut pens), also reached from Views › Graphics in the ribbon.
Name those when you hand work back.

**Live model or printed drawing** is each person's own choice per view,
remembered for them on every computer. There is no tool for it: never tell a
person you changed it, and don't ask them to switch for you; pictures and
PDFs always draw the printed drawing.

## 3D views and 3D crop boxes (each needs approval)

| Tool | Use it to |
| --- | --- |
| `bim_create_3d_view` | A saved 3D view, pre-cropped. `of_elements` (ids) or `region_ft` (`{min, max}` corners) fits its 3D crop box to the **storey and grid bay** around them: floor of their level to the next level up, out to the grid lines within 40 ft (else the next 10 ft line). `box_ft` (`center`, `size`, `turn_deg`) sets the box exactly. `look_from`: `south_west` (default), `south_east`, `north_west`, `north_east` (isometric corners from above), `south` / `north` / `east` / `west` (elevations), `top` (plan, north up). `projection` defaults to orthographic. `place_on: { sheet, center_in, scale }` places it on a sheet in the same approval |
| `bim_set_3d_view_camera` | Turn a 3D view: `look_from`, or `eye_ft` + `target_ft` exactly; optional `projection`. It opens and prints from there; a placed viewport's frame resizes to the box seen from the new camera |
| `bim_set_3d_crop_box` | `box_ft` exactly; `fit: "selection"` with `element_ids` or `region_ft`; `fit: "model"` (whole model, square to the working angle); `align: "working_angle"` or `align: { from_ft, to_ft }` turns the box about its middle, size kept; `crop_on` (false shows everything, box kept); `show_box` (only what editors see; never prints) |

`bim_list_views_and_sheets` reports each 3D view's `crop_box_ft` (centre, size,
turn), `camera_ft` (eye, target), `projection`, `crop_on` and how it prints.
In `batch_documents` the kernel steps are `create_3d_view`,
`set_3d_view_camera` and `set_3d_crop_box`, in **millimetres**.

**How 3D views print.** Vector hidden-line from the view's own camera,
orthographic (a perspective view prints parallel from the same direction),
cropped to the **whole** 3D box, heights included; where the box cuts duct,
pipe or equipment the cut prints with the cut pen and fill. The viewport is
"3D VIEW, NOT TO SCALE"; its frame is the box seen from the camera, so you
cannot drag the frame's edges: change the box or the camera. **Linked models
(the architect's IFC) do not print in 3D views**; say so if the person expects
walls from the link on an isometric.

## Schedules

A schedule is a view: on a sheet it is as big as its rows and grows down from
its top-left corner; it has no scale or crop. Reading one is
`bim_schedule_read` (model family). Making or changing one (equipment, air devices,
fixtures, panels, the `sheet_list` index), typing into its cells and the firm
library are the `mutinybim-schedules` pack: activate it for step 5 below.

## Rich notes

Notes print exactly as people see them on screen (one layout engine, the same
embedded font). Send `paragraphs` instead of `text` for formatting:

```json
[
  { "runs": [{ "text": "GENERAL NOTES", "bold": true, "underline": true }], "align": "center" },
  { "list": "numbered", "runs": [{ "text": "Seal all " }, { "text": "supply", "bold": true }, { "text": " joints." }] },
  { "list": "bullet", "level": 1, "runs": [{ "text": "SMACNA seal class A", "text_height_in": 0.125 }] }
]
```

- A run is text with optional `bold`, `italic`, `underline`, `text_height_in`.
  `"\n"` inside a run is a line break in the same paragraph.
- A paragraph may be a list item: `list` (`bullet` / `numbered`), `level`
  (0–4), `start` (restart numbering). Numbering continues across a list and
  restarts after a plain paragraph. `align`: left, center, right, justify.
- Text wraps at the box width. A fixed `height_in` drops lines that don't fit
  (they won't print); leave it out to grow with the text.
- Only letters, numbers, Latin-1 accents and drafting symbols print (°, ±, ½,
  Ø, µ, –, —, •, ≤, ≥, ×). Anything else is refused with the characters named.
- `bim_list_views_and_sheets` returns each note's `id`, full `text`, `width_in`
  and `expected_content` (sheets, and detail views). People editing a note
  lock it for each other, not for you: `expected_content` is what keeps your
  edit from overwriting theirs.

## Workflows

**Make a sheet:** `bim_list_views_and_sheets` (reuse names and ids) →
`bim_create_view` if needed → `bim_set_view_properties` with `fit_crop: true`
(or an explicit crop) → `bim_create_sheet` → `bim_place_viewport` →
`bim_render_sheet_image` and look → `bim_print_sheet_pdf` once everything
reports saved. Read `print_notes` on every print: it names viewports that run
past the drawing area and labels the PDF font printed as plain text (`1⅜"` as
`1-3/8"`). The print still succeeds; fix the viewport before issuing.

**Produce a construction drawing set.** The whole job, end to end, with the
person approving in batches. Plan first, then do it in a few large, clearly
described edits rather than dozens of small ones.

1. **Plan.** `bim_model_summary`, `bim_list_linked_models` (the architect's
   model in, current and lined up), `bim_list_part_types` (levels),
   `bim_list_views_and_sheets`. Propose the sheet list in plain words and wait
   for the person to agree. A typical mechanical set (use `P-` and `E-` the
   same way for plumbing and electrical):
   - `M-001` legend, general notes and sheet index (`sheet_list` schedule)
   - `M-101`, `M-102`, … one plan per level (`M-1xx` floor plans; ceiling
     plans or enlarged plans `M-4xx` when asked)
   - `M-201` sections (and elevations)
   - `M-501` details (detail views)
   - `M-601` schedules (equipment, air devices; plumbing fixtures on `P-601`,
     panels on `E-601` when the model has them)
   Number within a discipline in steps the firm uses (101, 102…); never reuse a
   number. Ask before renaming or deleting someone else's sheet.
2. **Views.** `bim_create_view` per level (floor plans; crop is fitted to the
   level's content), sections through what the person wants to show, detail
   views. Check scales (see drafting guidance below).
3. **Sheets in one approval.** Build a `batch_documents` of `create_sheet`
   steps with the title block `fields` (client, address, drawn_by,
   checked_by, date, status) → `bim_preview_views_sheets_edit` → say "this
   creates sheets M-001 … M-601 with these title blocks" →
   `bim_apply_views_sheets_edit` with the `preview_token`.
4. **Place views in one approval**, same way (`place_viewport` steps), then
   `bim_preview_sheet_layout` per sheet (`fit_scales: true` if a view is too
   big) → `bim_auto_layout_sheet`. Report anything `could_not_place`.
5. **Schedules and index.** Activate `mutinybim-schedules`, then
   `bim_schedule_define` with `place_on` for each schedule (its preview shows
   the first rows), and put the sheet index on `M-001`.
6. **Notes and annotation.** `bim_add_sheet_note` (general notes as a numbered
   list), revision clouds and lines as `add_drawing_item` steps (cloud: two
   corners in paper mm around the change, on the sheet). Dimensions, tags and
   details: `mutinybim-drafting`.
7. **Verify.** `bim_list_views_and_sheets`, then look at every sheet with
   `bim_render_sheet_image` (zoom with `region_in` on notes, schedules and the
   title block), then `bim_print_set_pdf`. Fix what you see and look again
   before asking to issue.
8. **Issue.** Only when the person says to issue: `bim_set_issue_status`
   first. Schedules, tags and the sheet index are live: a sheet can change
   after your print without anyone touching it. `changed_since_print` or
   `not_printed`: print again, look at those sheets, then check again.
   Then `bim_issue_set` with `expected_revision` = the `revision` you checked,
   the issue `name` (e.g. "Issued for permit") and `add_revision` (`number` =
   `next_revision`, date, description). It refuses (`needs_print`) while
   sheets differ from the last print; pass `accept_changes_since_print: true`
   only after you have looked at exactly those sheets and the person agrees.
   If it says the model moved, someone saved since you checked: review, print,
   and ask again. Never issue a set you didn't print and check. People do the
   same from Views and sheets › Print set… / Issue set… with the same checks;
   the host files the issued PDF with the project's issued drawings.

Every edit above pauses for approval; describe each batch ("creates 5 sheets",
"places 3 views and arranges M-101 to M-201") so the person can approve it at
once. A refused step names the step and the reason; fix the plan, preview
again. Never send a different command with an old `preview_token`.

**Drafting guidance** (general practice; follow the firm's own standards when
the person gives them):

- **Scales.** Plans of a whole floor usually 1/8" = 1'-0" (96) or 1/4" (48);
  enlarged plans 1/4" to 1/2"; sections 1/4" to 1/2"; details 3/4" to 3" or
  none. Use the largest scale that fits the sheet's drawing area; one floor per
  sheet unless the person asks for a key plan.
- **Text.** Note and schedule text at least 3/32" (about 2.4 mm) printed;
  titles larger. Never shrink text to make something fit; split it.
- **Every placed view** has a number and title under it (automatic) and a
  scale; plans carry a north arrow (automatic).
- **Title blocks** are filled on every sheet with the same client, address,
  date and status; checked_by is the engineer, not the agent.
- **Revisions.** One row per issue, numbered in order, the same on every sheet
  it issues; cloud what changed since the last issue.
- **Sheet index** on the first sheet of the discipline, listing every sheet
  with its latest revision.
- Don't paste text from code books or published standards into notes; write
  plain project notes or use the firm's text.

**Isometric of a room or a riser on a sheet.** When a plan and section don't
make the work clear (a crowded mechanical room, a riser, a roof curb, a
congested ceiling), add a 3D view: `bim_query_elements` on the level → pick the
ids of the equipment and the duct and pipe in the room → `bim_create_3d_view`
with `of_elements`, `look_from` the corner that shows the most (usually from the
open side, above), and `place_on` the detail or enlarged-plans sheet → read it
back with `bim_list_views_and_sheets` → `bim_print_sheet_pdf` and check the cut
edges and that nothing important is hidden; turn it (`bim_set_3d_view_camera`)
or trim it (`bim_set_3d_crop_box` with `box_ft`) and print again. One 3D view per
idea; name it after the place ("Mech room 104 isometric"). Never use a 3D view
instead of the plan the permit needs; it supplements it. A person's working 3D
view (`working_view_of` in the read, named like `{3D - Name}`) is theirs: never
place it on a sheet (refused) or change it; duplicate it if they ask.

**Write or fix general notes:** `bim_list_views_and_sheets` (the sheet, its
notes and their `expected_content`) → new block: `bim_add_sheet_note` with
`paragraphs` and a `width_in` that fits the free space; changing one:
`bim_edit_text_note` with that note's `expected_content` → on a conflict, read
again, merge with the newer words, and propose again.

If a tool here is missing after turning this family on, say exactly which
tool is missing; don't substitute another.

<!-- tools: rendered from the catalogue by `npm run build:files`; edit the catalogue, not this list -->

## Tools in this family

| Tool |
| --- |
| `bim_create_view` |
| `bim_set_view_properties` |
| `bim_rename_view` |
| `bim_duplicate_view` |
| `bim_delete_view` |
| `bim_create_sheet` |
| `bim_set_sheet_properties` |
| `bim_delete_sheet` |
| `bim_place_viewport` |
| `bim_edit_viewport` |
| `bim_preview_sheet_layout` |
| `bim_auto_layout_sheet` |
| `bim_set_issue_status` |
| `bim_add_sheet_note` |
| `bim_edit_text_note` |
| `bim_create_3d_view` |
| `bim_set_3d_view_camera` |
| `bim_set_3d_crop_box` |

<!-- end tools -->
