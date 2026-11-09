---
name: mutinybim-parts
description: "MutinyBIM pack for part definitions: draft a part from a cut sheet, a complete example definition, check and save definitions, read a saved part, the firm's part library, clearance zones, the slab or roof a part stands on, and mounting planes. Use with the mutinybim core. Trigger on: new part, cut sheet, part definition, firm library, clearance, working space, host, curb, mounting plane."
license: Apache-2.0
compatibility: "Needs the mutinybim MCP server with the parts family turned on (bim_enable_pack, --packs parts, or /packs/parts/mcp under the MutinyBIM base)."
metadata:
  pack: "parts"
  mcp-server: "mutinybim"
  family: "parts"
  token-cap: "4500"
  tools: "bim_draft_part_from_cut_sheet bim_read_picture_rows bim_part_definition_example bim_check_part_definition bim_read_part_definition bim_save_part_definition bim_list_firm_parts bim_save_firm_part bim_set_clearances bim_set_part_host bim_set_mounting_plane"
---

# MutinyBIM: make and change parts (part editor)

A family of the `mutinybim` core. Activate `mutinybim` first: it has the
script tools, the four starting reads and the rules for every change (preview, say the change, edit with `base_revision`, report the server's
answer), and a part script (`parts.part(…)`, then `bim_save_part_type`) is
the first way to make a part. `bim_list_part_types`, `bim_place_part` and
`bim_preview_part_edit` (which previews `bim_save_part_definition` too) are
the `model` family.

| Tool | Use it to |
| --- | --- |
| `bim_part_definition_example` | Get a complete, valid definition to start from (`rooftop_unit` or `floor_drain`) and a field guide. No approval. **Read this before writing a definition**: it is the reference for every field the check and save tools take |
| `bim_check_part_definition` | Dry run: every problem in plain words (per size), overall size, connector positions and sizes, plan / front / side SVG previews. Saves nothing, no approval. A definition whose fields don't fit is answered with each field and what is wrong with it. Warnings (they don't block saving) flag a connector below the base, facing into the body, or inside a solid piece (each feature's bounding box, cuts not subtracted), with how deep: put connectors on a face, pointing out. Openings at the bottom of a hollow curb, or on the cabinet's bottom looking down into it, are fine |
| `bim_read_part_definition` | Open a saved part the way Edit part does: a type id or a placed part's id in, `part_name` + `definition` out in exactly the form check and save take, with its sizes and `placed_count`. No approval |
| `bim_save_part_definition` (approval) | Save a modeled part (every size in its types table) to the project library; placed parts of those types update. Refused if a run is connected to a connector it would remove or move |
| `bim_draft_part_from_cut_sheet` | Read a cut sheet PDF uploaded to the project (`file_id` from `search_content`, or a storage link to it) and draft a rooftop unit, air terminal or water heater: the sheet's text by page, every fact found with its page and line, the assumptions made where the sheet is silent, and a checked definition (sizes, connector positions). Saves nothing, no approval |
| `bim_read_picture_rows` | Read an equipment schedule from a picture or a PDF on the project into planned equipment rows: each row with its page, the values the add-ons' columns read, and unsure cells marked "check this". The first call saves nothing; commit with the rows the person kept, `type_id`, `base_revision`, `preview_token` and `user_confirmed` (pauses on the Approve card; one undo step) |
| `bim_list_firm_parts` | Parts in the firm library (every project can place them): each size's type id, revision, where it came from. No approval |
| `bim_set_mounting_plane` | Make a mounting plane (`level_id`, `name`, `height_above_level_ft`, two corners) to place air devices on where there is no ceiling, or change one (`plane_id`): a new height moves the parts on it and their duct follows. `bim_list_levels` lists each level's planes |
| `bim_save_firm_part` (approval) | Save a modeled definition to the firm library. Same model id = the next revision of that part, not a second one. Decided by the host's firm library, not the model server |

A part definition is parameters + a **model**: reference planes positioned by
parameters, sketches on those planes (rectangles, lines, arcs, circles,
polylines; corners locked to planes with `on_plane`), and features in order
(`extrude` or `revolve`, each `join` = solid, `cut` = void, or `intersect`).
Rows of `model.types` are the sizes. Lengths are **millimetres** in the
part's own frame (x = the way it faces, y = its left, z = up from the
insertion point); formulas accept `12in` / `2ft` and `if, min, max, abs,
sqrt, round, floor, ceil, sin, cos, tan`. A parameter with a `formula` is
computed. Connectors: `domain` duct / pipe / electrical, `systemKind`,
`position` (dimensions), outward `direction`, `shape` with sizes, `flow`,
`flowDirection` in / out / bidirectional, `widthAxis` for rectangles.

## Workflows

**Make a part from a cut sheet PDF** (e.g. "here's the RTU cut sheet, make
the part and put it on the roof", "build this diffuser from its submittal",
"add this water heater to the firm library"):
1. Find the PDF on the project (`search_content`, or the file the person
   attached) and note its `file_id`. If it isn't uploaded, ask them to add it
   to the project; a link to somewhere else is refused.
2. `bim_draft_part_from_cut_sheet` with `project_id` and `file_id` (add
   `kind` if the sheet's title doesn't say rooftop unit, diffuser / grille or
   water heater). Read `facts` against `sheet_text`: overall length, width,
   height (or diameter), curb height, each duct opening's size and where its
   centre is, pipe connection sizes, voltage / phase / MCA / MOP / FLA,
   capacity, weight, manufacturer, model.
3. Say the `assumptions` to the person (e.g. curb wall 2" not on the sheet)
   and ask about any that change a shape or a connection. A cut sheet with
   several models in one table: draft once, then add one `model.types` row
   per model with that model's numbers from `sheet_text`.
4. Change the `definition` where the sheet says more than the draft caught
   (another connection, an opening on the side), then
   `bim_check_part_definition` until `status: ok`; compare each size's
   overall size and connector positions with the sheet and say them.
5. Save where the person wants it, each pausing for approval:
   - this project only: preview with `bim_preview_part_edit`
     (`tool: "bim_save_part_definition"`), then `bim_save_part_definition`;
   - every project: `bim_save_firm_part` (same `part_name` and `definition`).
6. To place a firm-library part: `bim_list_firm_parts` → a size's `type_id`
   → `bim_place_part` with `from_firm_library: true` (preview it the same
   way). Placing it adds the part to this project's library too.
7. Not drafted (`status: not_drafted`, e.g. a fan coil, a scanned sheet with
   no text, no overall size found): write the definition by hand from
   `sheet_text` with the workflow below. Never invent a size the sheet
   doesn't give: ask.

**Make a part from a description or a spec sheet** (e.g. "a rooftop unit
90 x 50 x 40 in on a 14 in curb, supply and return on the bottom, 208 V
3-phase", or a floor drain from a submittal):
1. Read the numbers you need: overall sizes per model/size, connection sizes
   and where they are, system, airflow / GPM, voltage and phase, weight,
   manufacturer and model. Ask for anything missing that changes the shape
   or a connection; never invent a connection size.
2. `bim_part_definition_example` (closest example) → copy its shape.
3. Parameters: one per size that varies (length, width, height, connection
   sizes) plus schedule data (manufacturer, model, airflow, cooling, voltage,
   phase, weight). Things derived from others get a `formula`.
4. Reference planes on every face a sketch or connector must follow
   (`front` = length / 2, `left` = width / 2, a top at height…). Lock sketch
   corners to them with `on_plane`, so every size flexes correctly.
5. Features: the body as an `extrude` (or `revolve` about a construction
   line for round bodies), curbs as a rectangle with an inner rectangle
   (a hole), openings and recesses as `cut` features after the solids.
6. Connectors on the faces, positions as dimensions/formulas, sizes bound to
   parameters, direction pointing out of the part.
7. `model.types`: one row per size from the spec sheet.
8. `bim_check_part_definition` → fix every issue → check again until
   `status: ok`. Look at the previews and the per-size overall sizes and
   connector positions against the spec; say them to the person.
9. Preview with `bim_preview_part_edit` (`tool: "bim_save_part_definition"`)
   → describe → `bim_save_part_definition` (approval). The sizes become types
   `<model id>.<size>` for `bim_place_part`.
10. People can open the same part in the MutinyBIM editor: **Place part → Edit
    part** (pencil on the type), or select a placed part → **Edit
    definition**. New parts by hand: **Place part → New part** (it opens on
    the empty part's reference planes in 3D, with **Start with a box**). In
    Plan / Front / Side they click a dimension between planes to type its
    length or link it to a parameter; **Save to firm library** puts it in the
    firm library. Firm-library parts show in Place part marked "firm library".

**Change a part that is already in the model** (e.g. "add the 12.5 ton
size", "move the return to the side", "the curb is 18 in"): `bim_read_part_definition`
with the type id or a placed unit's id → change only what was asked in its
`definition` → `bim_check_part_definition` → say what changes and that the
`placed_count` placed parts update → preview and `bim_save_part_definition`
with the same `part_name`. Never redraw it from an example: that makes a
second part. A refusal about a connector means a run is connected where the
change would move or remove it; say which.

## What a part stands on and the space it needs

| Tool | Use it to |
| --- | --- |
| `bim_set_clearances` (approval) | Clearance zones: `scope: "type"` with `zones` (all of the type's zones, feet: `depth_ft`, optional `width_ft`, `height_ft`, `offset_ft` to slide off centre, `from_floor`), or `scope: "instance"` with `overrides` by zone id for one placed part (`off: true`, new sizes, `null` = back to the type; a full zone adds one). `working_space` sizes NEC 110.26 working space from Table 110.26(A)(1) for the `voltage_to_ground` and `condition` you chose (`extra_depth_multiplier: 2` for a noted double clearance); the edition is the project's unless you give `nec_edition`. `dedicated_space` adds the NEC 110.26(E) dedicated space above a panel or switchboard (equipment width and depth, 6 ft up or to structure, no ducts or pipes of other trades); at `scope: "instance"` give `suspended_ceiling_ft` / `structure_ft` only as the engineer states them, never guessed |
| `bim_set_part_host` (approval) | What parts stand on: `slab_id` (ours) or `linked` (model id, name, `top_ft`, GlobalId if known), with `curb_in`. Default `seat`: each part moves onto the top plus curb and carries its connected runs exactly like a move (a riser stretches or shrinks, level runs move whole). If a run can't follow, nothing saves and the refusal names the part, the height change (mm and in), the run piece and why: then move part and run together with `bim_move_elements` and set the host with `seat: false`, disconnect, or re-route. Don't disconnect first just to seat. `remove_host` takes it off |

Zones (service access, combustibles, economizer access, working space, keep
clear) sit against one face of the part (front = the way it faces), move and
turn with it, draw dashed, and are **never solid**. A cut sheet's service
clearances go on the type; a site condition (a wall closer on one side) is an
instance override. The coordination lint's `clearance-intrusion` names
anything inside a zone: errors for working space and combustibles. Never move
equipment or runs to clear a zone without saying so first; propose the move.

A rooftop unit should **stand on** the roof: `bim_set_part_host` with the
linked roof (its name and top are in the lint block's `near.host` after
placing; the roof level from `bim_list_levels` is the fallback) and the curb
height from the cut sheet. `floating-equipment` then checks it against that
host: floating above the curb, the host deleted ("nothing under it"), or the
architect's roof moved since. People get the host automatically when they
place a unit by pointing at the roof; Properties › Stands on shows it.

**Rooftop unit with service clearance, from the cut sheet:** draft and save
the part (above) → `bim_set_clearances` `scope: "type"` with the sheet's
service, economizer and combustible clearances → `bim_place_part` on the roof
→ `bim_set_part_host` with the linked roof and curb → read the lint block:
fix any `clearance-intrusion` or `floating-equipment` before the next edit.
A seat or move that would pull a straight duct or pipe piece back past its
other end is refused ("doubles back on … where they join"): move less, or
re-route.

**Panel working space:** `bim_set_clearances` on the placed panel with
`working_space` (voltage to ground: 120 for 120/208 V, 277 for 277/480 V; the
condition from what faces it) → say the depth, width and height it returned
and the code citation → read the lint block for what is inside.

If a tool here is missing after turning this family on, say exactly which
tool is missing; don't substitute another.

<!-- tools: rendered from the catalogue by `npm run build:files`; edit the catalogue, not this list -->

## Tools in this family

| Tool |
| --- |
| `bim_draft_part_from_cut_sheet` |
| `bim_read_picture_rows` |
| `bim_part_definition_example` |
| `bim_check_part_definition` |
| `bim_read_part_definition` |
| `bim_save_part_definition` |
| `bim_list_firm_parts` |
| `bim_save_firm_part` |
| `bim_set_clearances` |
| `bim_set_part_host` |
| `bim_set_mounting_plane` |

<!-- end tools -->
