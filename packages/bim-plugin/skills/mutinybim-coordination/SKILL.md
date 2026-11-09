---
name: mutinybim-coordination
description: "MutinyBIM pack for coordination: browse Autodesk Docs and link, update or unlink models, match levels to a linked model, create and update levels, read and set coordinates (project base point, survey point, true north, working angle), accept or retract a lint finding, and trace rooms. Use with the mutinybim core. Trigger on: linked model, architect's model, Autodesk Docs, levels from the link, coordinates, true north, survey point, accept finding, rooms."
license: Apache-2.0
compatibility: "Needs the mutinybim MCP server with the coordination family turned on (bim_enable_pack, --packs coordination, or /packs/coordination/mcp under the MutinyBIM base)."
metadata:
  pack: "coordination"
  mcp-server: "mutinybim"
  family: "coordination"
  token-cap: "6000"
  tools: "bim_browse_autodesk_docs bim_link_from_autodesk_docs bim_update_linked_model bim_unlink_linked_model bim_sync_linked_levels bim_update_level bim_create_level bim_read_coordinates bim_preview_coordinates_edit bim_set_project_origin bim_set_survey_point bim_set_true_north bim_set_working_angle bim_lint_accept_finding bim_lint_retract_acceptance bim_trace_rooms"
---

# MutinyBIM: linked models, levels and coordinates

A family of the `mutinybim` core. Activate `mutinybim` first: it has the
script tools, the four starting reads and the rules for every change (preview, say the change, edit with `base_revision`, report the server's
answer). `bim_list_linked_models`, `bim_list_levels`, the pictures and
`bim_preview_part_edit` (which previews `bim_create_level`) are the `model`
family.

## Levels (each needs approval)

| Tool | Use it to |
| --- | --- |
| `bim_sync_linked_levels` | Use the architect's levels: one undoable change that adds a level for every storey of the linked model (default: the architectural one) at its height here (units and the link placement applied) and updates the levels made from storeys the architect moved or renamed. A level someone already drew for the same floor is tied to the storey and keeps its name. Never deletes; a second run with nothing new is refused with that reason |
| `bim_update_level` | Move a level to a new elevation and/or rename it. Everything on it moves with it; plans, schedules and elements that name it follow a rename |
| `bim_create_level` | Add a level with a name and floor elevation (preview with `bim_preview_part_edit`, `tool: "bim_create_level"`) |

## Linked models: bring in, refresh, line up

Linked models are the architect's model, structure, existing MEP and our own
Revit model, shown under MutinyBIM's work. They belong to the project (no
`model_id`). These are the Linked models panel's actions (Manage › Link a
model, and the panel's row menu). Everyone on the project sees the result.
Read them first with `bim_list_linked_models` (model family).

| Tool | Use it to |
| --- | --- |
| `bim_browse_autodesk_docs` | List a folder of the project's Autodesk Docs project, or search by name. Each file says `can_link` and `why_not`, and `already_linked_as`. Needs edit access and the person's Autodesk sign-in (Settings) |
| `bim_link_from_autodesk_docs` (approval) | Bring up to 25 Docs files in as linked models, each with a `label` people see and a `discipline`. A file already linked adds a new version. Returns `queued`: Autodesk exports and converts in the background |
| `bim_update_linked_model` (approval) | One `action` on one linked model: `check_for_new_version` / `relink_from_docs` (Docs files), `line_up` (place a Docs file again against our Revit model as it is now), `reexport_project_model` (export our own Revit model again; no `reference_id`), `retry_conversion` (a failed version), `show_version` (`version_id`), `adjust_position` (`east_ft`, `north_ft`, `up_ft`, `rotation_deg` counter-clockwise; give only what changes) |
| `bim_unlink_linked_model` (approval) | Take a linked model out for everyone. Its files and versions are kept. Say what views stop drawing it before you ask |

Results are `saved` (done now), `queued` (the linked-models worker finishes it,
usually in a few minutes: read `bim_list_linked_models` again to see it
`ready`), `unchanged` (nothing to do, e.g. already the newest Docs version) or
`refused` with the reason in the person's words (no edit access, no Autodesk
sign-in, a file Autodesk can't open). Say `queued` as "started", never as done.
Uploading an IFC file from the person's computer stays in the browser (Manage ›
Link a model › Upload IFC): tell them where to click.

## Linked models in a view

Each view says how every linked model (the architect's model, a consultant's
MEP model) draws in it, so MutinyBIM's own work reads clearly. Set it with
`bim_set_view_properties` (`mutinybim-views-sheets`)
`linked_models: { <linked model id>: { ... } }`; linked models you leave out
keep their setting. Read it back from `bim_list_views_and_sheets`
(`linked_models` on each view, with the `display` it matches or `custom`).

| Field | Meaning |
| --- | --- |
| `display` | `normal` (full colour), `halftone` (grey linework on paper; grey and 30% see-through in 3D for architecture), `transparent` (grey, 60% see-through in 3D), `underlay` (screened lighter on paper, faint beneath our work in 3D, never hides it), `hidden` (not drawn or printed) |
| `transparency_pct` | 3D only, 0–90. Combine with a `display` or change it alone |
| `categories` | Per IFC category of the linked model, e.g. `{"IFCDOOR": {"visible": false}, "IFCWALL": {"halftone": false}}`; `null` clears one exception |
| `cut_line_weight` / `beyond_line_weight` | Drawings: the pen (thin, medium, wide, heavy) for what the cut passes through (walls; default wide) and for what is seen below the cut (furniture, slab edges; default thin). `null` goes back to the default. Kept when you change `display` |

Two view-wide settings simplify every linked model on paper (also on
`bim_set_view_properties`): `linked_hidden_lines` (default on) removes linked
lines covered by something nearer, such as a chair tucked under a table or a
wall behind the one a section cuts; `linked_min_object_in` leaves out linked
furniture, fixtures and other non-cut things smaller than that across (cups,
outlets). Walls are always drawn. When a person says the architecture is
"busy", "I can see chairs through the tables" or "too much furniture", check
`linked_hidden_lines` is on, offer `linked_min_object_in` (6 or 12), lighten
with `beyond_line_weight: "thin"`, and show a picture.

Defaults with nothing set: drawings (plans, sections, sheets, PDFs, pictures)
draw every linked model halftone; 3D draws architecture halftone and 30%
see-through and MEP models in colour. A person's **working 3D view**
(`{3D - <name>}`, `working_view_of` in the listing) holds their own 3D
setting; change it only when they ask. In 3D, our own elements win a click
over a halftone or see-through linked model even when it is in front.
Pictures (`bim_render_view_image`, `bim_render_sheet_image`) and
`bim_print_view_pdf` draw the linked plan under the view's work with these
settings; `linked_models_missing` names any linked model that could not be cut.

When a person says "make the architect's model lighter", "I can't see my
ducts", or "ghost the architecture", set `display: "transparent"` (or
`halftone`) on the view they are looking at, then show a picture.

## Coordinates: base point, survey point, true north, working angle

Model coordinates (x east, y **plan north**, z up) are where geometry and
linked models sit. The **project base point** carries the project's site
coordinates (N/S, E/W, elevation) and true north; the **survey point** is fixed
to the site; the **internal origin** is model 0, 0, 0 and never moves.
Changing coordinates never moves geometry, views or linked models — only what
points read on the site.

On screen people see plain names: **Project origin** (the base point), **Site
point** (the survey point), **Model zero** (the internal origin). Use those
words with them; keep the tool argument names as they are.

The **working angle** is the direction people draw in, for a building that
sits skewed on the model axes: degrees counter-clockwise from model east, kept
in (−45, 45]. Route snaps (square and 45°), the placement grid, drafting
ortho/polar steps and **new** 3D crop boxes follow it. It is not true north
and never changes site coordinates or moves anything. The model has one; a
view may carry its own.

| Tool | Use it to |
| --- | --- |
| `bim_read_coordinates` | Read the base point and survey point (model feet and site N/S, E/W, elevation), the internal origin, true north and the placement an IFC export carries |
| `bim_preview_coordinates_edit` | Dry run of any edit below: what would change, or why it would be refused |
| `bim_set_project_origin` (approval) | `mode: "move_point"` moves only the base point on the model (`position`); nothing's site coordinates change. `mode: "relocate_project"` moves the building on the site: give the base point's new site coordinates (`shared`) and/or a new `position`; every element's site coordinates change by the same move and the survey point stays on the site |
| `bim_set_survey_point` (approval) | The site point. `mode: "move_point"` moves only its marker on the model (`position`); nothing's site coordinates change. `mode: "relocate_project"` gives it the site coordinates it should read (`shared`, e.g. the civil benchmark; optionally a new `position`): the site moves under the building, every element's site coordinates change, geometry stays put |
| `bim_set_true_north` (approval) | `angle_deg` clockwise from plan north to true north, or two plan points `from_ft` → `to_ft` along true north. Turns the building on the site about the base point |
| `bim_set_working_angle` (approval) | Line the working axes up with a skewed building: `angle_deg`, or two plan points `from_ft` → `to_ft` along a wall or slab edge (the axes turn square to it). `view` sets it for one view only; `view` + `use_model_angle: true` drops that view's own angle. Nothing moves. Read it back with `bim_read_coordinates` (`working_angle_deg`, `views_with_own_working_angle`) |

True north turns true-north plans (`orientation: true_north` on the view), the
3D view's compass dial and each sheet's north arrow; plans left on plan north do not
move. A plan set to `orientation: "working_angle"` (`bim_set_view_properties`)
draws turned so the building's walls run square to the paper; its north arrow
still points at true north. A 3D crop box turns to the working angle with
`bim_set_3d_crop_box` `align: "working_angle"`, or square to an edge with
`align: { from_ft, to_ft }`; its size is kept. There is no rotate handle on the
box: these (or `box_ft.turn_deg`) are how it turns. Ask which mode the person means before moving the base point: "move just
the marker" and "put the building at these site coordinates" are different
edits.

## Coordination findings

The coordination lint itself (`bim_lint_configure`, `bim_lint_check`, the
`lint` block on every edit, `bim_status_snapshot`) is in the `mutinybim`
core. Accepting a finding, and taking an acceptance back, are here because
they are rare and always the person's decision.

| Tool | Use it to |
| --- | --- |
| `bim_lint_accept_finding` (approval) | Record that a finding is acceptable, with the person's reason in their words. `finding_id` is a finding's `id` from `bim_lint_check` run now; any other id (made up, from an old check, a rule name) is refused as `lint_finding_not_current`, so run `bim_lint_check` first and copy the id. A refused id comes back refused before any Approve card shows; tell the person, don't retry it. It stops showing for everyone, people and agents, until one of its elements changes |
| `bim_lint_retract_acceptance` (approval) | Take an acceptance back with the person's reason: one made by mistake, or one that is no longer true. The finding shows again; who accepted it, who retracted it and why are kept. `lint_acceptance_not_found` lists what is accepted now. People do the same with Retract… in Manage › Coordination |

Never call either tool to test or inspect it: each one saves for the whole
project once approved.

## Rooms from the architect's plan

When the model has no rooms to measure (receptacle proposals in
`mutinybim-electrical` need them), trace them from the plan the person points
to, after they approve.

| Tool | Use it to |
| --- | --- |
| `bim_trace_rooms` (approval) | Add rooms the proposers can measure, from the architect's plan: `level`, `rooms [{ number, name, outline_ft }]`, `openings [{ kind door\|window, at_ft, width_ft }]` (centre on a room edge), `casework [{ type_name, at_ft, size_ft }]` (counters, "Kitchen island countertop", sinks, ranges, lavatories, washers). A wall goes on every room edge. Trace what the plan shows; ask when a dimension is missing |

## Workflows

**Square the work to a skewed building:** `bim_read_coordinates` → pick a long
straight wall or slab edge (read two of its plan points from the model or the
person) → `bim_preview_coordinates_edit` with `tool: "bim_set_working_angle"`
and `from_ft` / `to_ft` → say the angle → `bim_set_working_angle` → optionally
`bim_set_view_properties` with `orientation: "working_angle"` on the plans
they draw in, and `bim_set_3d_crop_box` `align: "working_angle"` on an existing
3D view. Never change true north for this: true north is the real compass.

**Set the site coordinates from a survey:** `bim_read_coordinates` →
`bim_preview_coordinates_edit` with `tool: "bim_set_project_origin"`,
`mode: "relocate_project"` and the surveyed `shared` values → say what every
point's coordinates become → `bim_set_project_origin` → `bim_set_true_north`
if the survey gives a bearing → read again and report. When the survey ties
the site to a benchmark rather than the base point, put the benchmark on the
survey point instead: `bim_set_survey_point` with `mode: "relocate_project"`
and its `shared` values.

**Bring in the architect's model:** `bim_list_linked_models` → if it is not
there, `bim_browse_autodesk_docs` (search by name, e.g. "arch") → tell the
person which file you'd link and why (newest, `can_link`) →
`bim_link_from_autodesk_docs` with a clear `label` and `discipline:
"architecture"` → say it started → `bim_list_linked_models` until it is
`ready` (a few minutes; tell the person rather than waiting silently). If it
is there but `alignment` is not placed, follow `fix`: `reexport_project_model`
then `line_up`, or ask the person how far it is off and `adjust_position`. If
Docs has a newer version, `check_for_new_version`. A failed version: say the
`error`, then `retry_conversion` only if the person agrees. Then levels from
the building (below), and look at a plan with `bim_render_view_image` to check
the architecture sits under the work.

**Levels from the building:** `bim_list_levels` → tell the person the storeys
and what syncing does to each (new, moved, tied to their level) →
`bim_sync_linked_levels` → `bim_list_levels` again and report the levels. For a
level at a surface the person names ("the roof is 26'-6\""), use
`bim_create_level`; to move or rename one, `bim_update_level` with its id.
People do the same in Manage › Levels (Add level, Pick a surface, Architect's
levels) and by dragging a level line in a section.

Equipment that stands on the architect's roof or slab, and the clearance zones
around it, are set with `bim_set_part_host` and `bim_set_clearances` in the
`mutinybim-parts` pack.

If a tool here is missing after turning this family on, say exactly which
tool is missing; don't substitute another.

<!-- tools: rendered from the catalogue by `npm run build:files`; edit the catalogue, not this list -->

## Tools in this family

| Tool |
| --- |
| `bim_browse_autodesk_docs` |
| `bim_link_from_autodesk_docs` |
| `bim_update_linked_model` |
| `bim_unlink_linked_model` |
| `bim_sync_linked_levels` |
| `bim_update_level` |
| `bim_create_level` |
| `bim_read_coordinates` |
| `bim_preview_coordinates_edit` |
| `bim_set_project_origin` |
| `bim_set_survey_point` |
| `bim_set_true_north` |
| `bim_set_working_angle` |
| `bim_lint_accept_finding` |
| `bim_lint_retract_acceptance` |
| `bim_trace_rooms` |

<!-- end tools -->
