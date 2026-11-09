---
name: mutinybim-drafting
description: "MutinyBIM pack for drafting and annotation: dimensions and automatic dimension strings, tags, tag styles and automatic tagging, notes with leaders, editing annotations, detail linework, hatched and masking regions, detail components, batt insulation and the modify tools (trim, extend, split, fillet, offset, mirror, array) on drawn items. Use with the mutinybim core. Trigger on: dimension, tag, annotate, leader, note, detail, hatch, detail component, linework, trim, fillet, offset, mirror, array, drafting view."
license: Apache-2.0
compatibility: "Needs the mutinybim MCP server with the drafting family turned on (bim_enable_pack, --packs drafting, or /packs/drafting/mcp under the MutinyBIM base)."
metadata:
  pack: "drafting"
  mcp-server: "mutinybim"
  family: "drafting"
  token-cap: "8200"
  tools: "bim_list_view_annotations bim_add_dimension bim_auto_dimension bim_add_tag bim_preview_auto_tag bim_auto_tag_view bim_add_note bim_edit_annotation bim_set_tag_text bim_list_tag_styles bim_save_tag_style bim_apply_tag_style bim_list_detail_components bim_draw_detail bim_modify_detail bim_copy_detail_items bim_set_detail_group"
---

# MutinyBIM: drafting, annotation and detailing

A family of the `mutinybim` core. Activate `mutinybim` first: it has the
script tools, the four starting reads and the rules for every change: preview, say the change, edit with `base_revision`, report the server's
answer, look at what you drew. The views/sheets preview and apply (a
`batch_documents` of many annotation edits saves in one approval) and the
pictures you check your drawing with (`bim_render_view_image`,
`bim_render_sheet_image`) are the `model` family. Tags and dimensions on
every plan of a set are one script.

New views, crops, sheets and sheet notes, and replacing a note's words
(`bim_edit_text_note`), are the `mutinybim-views-sheets` pack.

## Drafting and annotation (dimensions, tags, notes with leaders)

Annotation belongs to the view it is drawn in (a plan, ceiling plan, section or
detail view) or to a sheet, and prints at paper size at any view scale. Points
in a view are **view feet** (plan x / y; a section's distance along the cut and
elevation; a detail view's drawing feet); on a sheet, paper inches. Offsets and
text heights are paper inches.

| Tool | Use it to |
| --- | --- |
| `bim_list_view_annotations` (read) | Every dimension, tag, note, line, rectangle and cloud in a view or on a sheet: id, what it prints, points, paper box, what each dimension or tag follows (and any it lost), note leaders, and which annotations overlap. Read this before editing a detail or tidying a plan |
| `bim_add_dimension` (approval) | linear (horizontal / vertical), aligned, angular, radial, diameter, arc_length, spot_elevation, spot_coordinate. Each point either **follows an element** (`element_id` + `anchor`: start, end, mid, edge_left, edge_right, center) or is a fixed point. Several points with `chain`: continuous or baseline. `offset_in`, `text_override`, `prefix`, `suffix`, `style` (units, rounding, tick / arrow / dot, text height) |
| `bim_auto_dimension` (approval) | Deterministic: `each` dimensions every run, wall or grid along its length; `chain` puts one continuous string across several elements' centrelines. One edit; every dimension follows its element |
| `bim_add_tag` (approval) | Tag one element in a plan or section. `template` auto (by what it is), duct_size, pipe_size, mark, air_terminal (mark + CFM), equipment, fixture, or fields (parameter names). The words always come from the element. `at_ft` for the head, else the first clear spot; `leader` on or off. `style` (a tag style's id or name) makes it follow that style; without it the tag takes the default style for its kind, if one is set. Returns `looks`: what it prints, its paper box, `overlaps` (other tags, notes, dimensions), `crosses_lines`, `nearby_tags`, `from_element_in`, `clear` |
| `bim_preview_auto_tag` (read) + `bim_auto_tag_view` (approval) | Tag every untagged element of the given categories (duct, pipe, air_terminal, equipment, fixture, part): each at the first clear spot beside it, never overlapping linework or another annotation; one size tag per straight run of one size; existing tags never move. Preview, say what it will tag, then apply with the `preview_token` |
| `bim_add_note` (approval) | A rich note (same as sheet notes: bold, italic, lists, sizes, prints as shown) in any plan, section or detail view, or on a sheet, with any number of `leaders`: `to`, optional `elbow`, `arrow` (arrow, dot, tick, none) |
| `bim_edit_annotation` (approval) | One annotation by id: `move` (dx / dy, or `auto_place: true` for a tag: the first clear spot beside its element), `dimension` (override, prefix, suffix, offset, style, re-point it), `tag` (template, fields, leader, `tag_style`: a tag style id or name, `""` takes it off its style; `elbow: "auto"` gives it an elbow leader, a short level shoulder then one bend, and is also "Straighten leader" for a bend placed by hand; `elbow: { x, y }` in view feet places the bend), `spread` (`item_id` plus `item_ids`: the tags move clear of every other tag, note and dimension, each with an elbow leader, one undo step; a bend placed by hand is kept; `need_a_hand` lists any with no clear spot), `leaders` (replace a note's leaders), `delete`. Tag moves and retypes return `looks` like `bim_add_tag`. Many at once: a `batch_documents` through `bim_apply_views_sheets_edit` |
| `bim_list_tag_styles` (read) | The model's tag styles: each one's lines, text height, box, leader, the kinds it is the default for and how many tags use it, plus every field name a style can read (size, size_with_insulation, insulation, cfm, mark, type, system, elevation, length, and every part parameter, custom ones included) |
| `bim_save_tag_style` (approval) | Create a style (`name`, `lines`), start one from a trade's ready-made style (`preset`, ids from `bim_list_tag_styles` `presets`), or change one (`style` + what changes): `lines` one template per printed line, words plus `{field}` (the field paths schedules and diagrams use: `["{size}[ {insulation}]"]`, `["{mark}", "{cfm} CFM"]`, `["{pipe.size}", "{pipe.length_lf}"]`, `["{circuit}"]`; `[ … ]` drops when its field is empty); `text_height_in`; `box` (true, false, or `rounded`, `circle`, `hexagon`, `diamond`); `orientation` (`along`: words turn with the run, never upside down); `prefix` / `suffix` (`""` clears); `units` for lengths and heights (`ft_in`, `ft`, `in`, `mm`, `m`); `leader`; `applies_to` (kinds it may label; a tag on anything else is refused); `default_for` (duct, pipe, air_terminal, equipment, fixture, part; a kind is the default of one style at most, so taking it moves it off another style). Changing a style changes every tag that uses it. `delete: true` removes a style no tag uses |
| `bim_apply_tag_style` (approval) | Give many tags in one plan or section a style in one edit: every tag there, or only those on `kinds`, or only `item_ids` |
| `bim_set_tag_text` (approval) | Change a model-linked tag's text |

**Tag styles.** A tag style is a named, reusable tag look. A tag that uses one
prints the style's lines, at its text height, with its box and leader; a line
whose fields are all empty is left out (a bare duct prints no insulation line).
`bim_auto_tag_view` takes `style` too, and otherwise uses each kind's default
style. People manage them in Annotate › Tag styles, pick one on a selected tag
(Style), and give it to every tag of that kind in the view with "Use on N more
… tags here"; name those when you hand work back. Say "tag style", never
"tag family".

Dimensions and tags are **associative**: when the model moves, they follow at
the next drawing. A dimension point that lost its element prints at its last
spot and `bim_list_view_annotations` lists it under `orphaned_points`: re-point
it or delete it. Notes' leaders point at fixed spots; move them with the note
when the thing they point at moves.

## Detailing (linework, regions, components, insulation, modify)

Detailing draws in a detail view, over a plan or section, or on a sheet, the
same as people's Draft tab. Units: in a view, points are **view feet** and
sizes **inches** (real size: a 6" valve is `width_in: 6`); on a sheet, paper
inches for both. A circle's `radius` and an arc's points are positions, so they
are view feet too: in a 1½" = 1'-0" view, `radius: 6` prints 18 in across.
Text in a drafting view is `bim_add_note` with the view as owner, not a sheet
note. Line style: a named `line_style` (thin, medium, wide, heavy, hidden,
dashed, center, phantom, dotted lines), the list people pick from;
`weight` / `pattern` override it.

| Tool | Use it to |
| --- | --- |
| `bim_list_detail_components` (read) | The 2D component library (ducts and pipes in section, flex duct, threaded rod, trapeze and strap hangers, strut, gate / ball / check valves, concrete anchors, beam clamps, steel angle, and the **electrical one-line symbols** `elec_*`: utility source, meter, CT cabinet, breaker, draw-out breaker, fuse, fused and non-fused disconnects, contactor, transformer, generator, motor, ATS, VFD, UPS, switchboard, panelboard, MCC, bus, busway, ground, surge protective device, equipment box), hatch patterns, line weights and patterns, drafting categories |
| `bim_draw_detail` (approval) | Draw up to 500 items as **one** edit. Detail lines follow BIM drafting-view conventions: every line and arc is its own element, joined where its ends meet. `rect` (four joined lines), `polygon` (`sides`, `inscribed` true or false), `chain` (lines through points, `closed` to shut it; `polyline` means the same) each make one line per side, with ids `<id>-0`, `-1`, …. Also `line`, `arc` (centre, start, end), `arc_radius` (start, end, radius, `toward` the bulge side), `arc_tangent` (continues the line from `from` through `start`), `circle`, `spline`, `region` (`hatch`: concrete, earth, masonry, insulation_rigid, crosshatch, diagonal…, or `masking: true` to hide what is under it), `component` (`symbol` at a point, `width_in`, `height_in`, `rotation_deg`, `mirror`), `repeat` (a symbol from one point to another: rods, flex), `batt` (insulation `thickness_in` between two points). Each takes `line_style` (thin, medium, wide, heavy, hidden, dashed, center, phantom, dotted: the usual way to pick linework), `weight` / `pattern` (override the named style), `category`, `group` |
| `bim_modify_detail` (approval) | One operation on drawn items, by id. `trim_extend_corner` (two items; `keep1` / `keep2` a point on the part of each to keep), `trim_extend_single` (one item to `boundary_id`, `keep`), `trim_extend_multiple` (many items to one boundary, one `keeps` point each), `split` (`at`; `delete_to` removes the piece between two points), `split_gap` (`at`, `gap`), `fillet_arc` (two lines, `radius`; `near1` / `near2` pick the parts to keep), `chamfer`, `offset` (`distance`, `toward`; pick a whole chain and its corners still meet; `copy: false` moves the originals), `move` (`disjoin` to leave joined lines behind), `copy`, `rotate`, `scale`, `mirror`, `array` / `polar_array` (`group`: each copy its own detail group), `align`, `move_end` (drag one end), `pin` / `unpin`, `delete`, `match_type` (`source_id`'s line style and category). `trim`, `extend` and `fillet` are older names that still work; prefer the ones above. Items in a detail group come along for move, copy, rotate, scale, mirror, array, align and pin. Dimensions that follow moved items update by themselves |
| `bim_copy_detail_items` (approval) | Copy drawn items (or everything) from one view or sheet into another, shifted. Dimensions among them follow the copies; groups stay together |
| `bim_set_detail_group` (approval) | Put items in a named detail group (they then select, move and copy together), or take them out (`group: null`) |

### Joined detail lines

- A rectangle is four lines, not one shape. To round one of its corners, pick
  the two lines that meet there and `fillet_arc` them. To round every corner,
  run `fillet_arc` once per corner (one approval each, or one
  `batch_documents`).
- Joined ends stay joined. Moving, rotating, trimming or dragging the end of a
  line stretches the line joined to it that you did not pick, so the outline
  stays closed. Say so in the plain-words preview ("the two sides joined to it
  stretch to follow"). Use `move` with `disjoin: true` only when the person
  wants the pieces pulled apart.
- To work on a whole outline, read the view with `bim_list_view_annotations`
  and pass every line of the chain: `offset` of all four sides of a rectangle
  gives four new joined sides; offset of one side gives one parallel line.
- A rectangle drawn before joined lines existed reads and prints as before.
  Its first edit turns it into four joined lines, ids `<rect id>~s0` to `~s3`
  (bottom, right, top, left from the first corner), in the same approval and
  the same undo. Naming that rectangle with two `keep` / `near` points (for
  `fillet_arc`, `chamfer`, `trim_extend_corner`) picks the two sides at that
  corner. Dimensions that followed its corners follow the new line ends. If a
  dimension follows its middle, the tool refuses and says so; redraw that
  dimension first.
- Pinned items refuse Move, Rotate, trims, splits, fillets and Delete until
  `unpin`. Pin linework another discipline depends on before big edits.
- Pick linework by named `line_style` (`hidden` for work above or behind,
  `center` for centre lines, `wide` for cut outlines), the same list people
  pick from in the options bar (`bim_list_detail_components` returns
  `line_styles`). Use `match_type` to give lines the style of one already
  right, instead of restyling each.
- People do the same things by hand: Annotate › Detail line ▾ (Rectangle,
  Polygon, Lines (chain) draw joined lines), Annotate › Fillet arc, Modify ›
  Trim/Extend ▾, Split ▾, Offset (Copy, Numerical / Graphical), Pin ▾, and a
  region's Edit boundary (Finish / Cancel). When you hand work back, name
  those so the person can carry on without an agent.

Per view, `bim_set_view_properties` (`mutinybim-views-sheets`)
`hidden_drafting_categories` hides detail_lines, hatching, masking, components,
insulation, text, dimensions, tags or clouds there only (a coordination copy of
a detail with hatching off). Draw order is the order in the batch: put masking
regions after what they cover and before the note that sits on them.

Never build an electrical one-line or riser by hand from `bim_draw_detail`
circles and rectangles, and never draw on a live diagram view: it is drawn
from the model by `mutinybim-electrical` (`bim_layout_one_line` with
`from_model: true`); change its layout with hints there.

### Charts and pictures on a sheet

A `figure` item in `bim_draw_detail` (sheets only; `corner` / `opposite` are
the frame's corners in paper inches) holds either a live chart, `chart:
"plumbing.hunter_curve"` (redrawn from the model at every show and print; it
marks each water system's design point), or a picture, `file_id` of a PNG or
JPEG already stored with the project plus its `file_name`. Never both. Move
or resize it with `bim_modify_detail` (move, scale) like any drawn item;
people use Sheets › Chart / Picture and drag the corners. A picture that can't
be read stops the sheet from printing with the picture's name: say so rather
than printing without it.

## Workflows

**Make a detail.** `bim_create_view` (`mutinybim-views-sheets`) with
`view_type: "detail"` and a detail scale (1 1/2" = 1'-0" is 8; 3" is 4) →
`bim_list_detail_components` → draw the whole detail as one `bim_draw_detail`
(the slab as a concrete `region`; outlines as `rect`, `polygon` or `chain` so
their corners are joined; rods as `component` threaded_rod or a `repeat`; the
hanger, the duct section, `batt` insulation, a `masking` region under each
note; hidden or centre lines where they belong) → round corners with
`bim_modify_detail` `fillet_arc`, meet lines with `trim_extend_corner`, cut
openings with `split` and `delete_to` → dimensions that follow the linework
(`bim_add_dimension` with `element_id` = a line's id and `anchor` start / end)
→ notes with leaders (`bim_add_note`) → `bim_set_view_properties` with
`fit_crop: true` (a detail's crop is set when it is empty; fit it so nothing
you drew is clipped) → `bim_render_view_image` and look (clipped notes,
overlaps, open corners) → `bim_place_viewport` on the details sheet →
`bim_print_set_pdf` and check it. Describe the detail in plain words before
the batch ("a 2'-0" wide trapeze hanger: two 3/8" rods, a strap, the duct;
width and maximum drop dimensioned; rod and strap noted").

**Edit a detail.** `bim_list_view_annotations` on the view (ids, what prints,
what follows what) → one `bim_modify_detail` per operation (groups come along
for move, copy, rotate, scale, mirror, array, align, pin; the trims, splits,
fillet arc, chamfer, offset, `move_end`, `match_type` and `delete` act on
exactly the items named; joined ends follow) → start a similar detail from
this one with `bim_copy_detail_items` → change words with `bim_edit_text_note`
(`mutinybim-views-sheets`, with its `expected_content`) → re-point or restyle
dimensions with `bim_edit_annotation` `dimension` → read again and say what
changed, including every line that stretched and every dimension value that
moved.

**Make tags say what the firm wants** ("tags should show the insulation",
"one line: size and CFM"). `bim_list_tag_styles` (reuse a style if one fits) →
`bim_save_tag_style` with the lines in plain fields (and `default_for` so new
tags take it) → `bim_apply_tag_style` on each plan with the kinds it covers →
`bim_list_view_annotations` and `bim_render_view_image`: every tag prints the
new words; fix overlaps the longer text made (`bim_edit_annotation` `move`
`auto_place`). To change all of them later, change the style once. A trade's
usual tag (duct size along the run, pipe size, equipment mark in a hexagon,
circuit) is a `preset`: start from it rather than typing the lines.

**Place a tag where it reads.** `bim_add_tag` (no `at_ft`: it picks the first
clear spot) → read `looks`: if `clear` is false, say what it overlaps or
crosses and `bim_edit_annotation` `move` `auto_place: true`, or give `dx` /
`dy` away from the `nearby_tags` → if `from_element_in` is large, add a leader
(`tag`, `leader: true`). Never leave a tag sitting on another tag.

**Annotate a plan.** `bim_preview_auto_tag` with the categories the sheet needs
(duct sizes, air terminals with CFM, equipment marks) → say how many and any it
couldn't place → `bim_auto_tag_view` → `bim_auto_dimension` for the runs or
grid lines that need locating → spot elevations on duct bottoms or tops where
heights matter (`bim_add_dimension` kind `spot_elevation`, first point the run's
`mid`) → general and specific notes with leaders → `bim_list_view_annotations`:
fix anything in `overlaps` (move one of the two) → `bim_render_view_image` and
look → print and check.

**Drafting conventions** (general practice; the firm's own standards win when
given):

- **Text** 3/32" (about 2.4 mm) for notes, tags and dimensions; titles larger.
  Never smaller to make something fit; move it or split it.
- **Line weights**: cut and outline heavier than detail linework, which is
  heavier than dimension and leader lines (the thinnest).
- **Dimensions**: dimension to things that are built (faces, centrelines,
  grids), not to other dimensions; a continuous string rather than a pile of
  separate ones; one overall dimension outside a string; don't dimension the
  same thing twice on one sheet. Ticks for architectural-style drawings,
  arrows for mechanical details, as the set already does.
- **Tags**: one per element per view; size tags on every straight run of a
  new size; leaders only when the tag can't sit next to what it labels.
- **Notes and keynotes**: short, imperative, uppercase; a general note applies
  to the whole sheet or set, a specific note points at one thing. Don't paste
  text from code books or published standards.
- **Callouts**: a box round the enlarged area, bound to the enlarged view
  (`add_drawing_item` `shape: "callout"`, `callout.viewId`). Never type a
  sheet number into a note for it: the callout's head reads the view's number
  and sheet live and follows it to another sheet.

If a tool here is missing after turning this family on, say exactly which
tool is missing; don't substitute another.

<!-- tools: rendered from the catalogue by `npm run build:files`; edit the catalogue, not this list -->

## Tools in this family

| Tool |
| --- |
| `bim_list_view_annotations` |
| `bim_add_dimension` |
| `bim_auto_dimension` |
| `bim_add_tag` |
| `bim_preview_auto_tag` |
| `bim_auto_tag_view` |
| `bim_add_note` |
| `bim_edit_annotation` |
| `bim_set_tag_text` |
| `bim_list_tag_styles` |
| `bim_save_tag_style` |
| `bim_apply_tag_style` |
| `bim_list_detail_components` |
| `bim_draw_detail` |
| `bim_modify_detail` |
| `bim_copy_detail_items` |
| `bim_set_detail_group` |

<!-- end tools -->
