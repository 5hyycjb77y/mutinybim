---
name: mutinybim-groups-phases
description: "MutinyBIM pack for groups, phases and typed elements: create, update, lock and delete groups, assign elements, the active group and phase, phases and phase filters, a view's phase and groups, and the class, type and values of typed elements (walls, slabs, beams, rooms). Use with the mutinybim core. Trigger on: group, lock, phase, existing, demolition, new construction, phase filter, element type, element values."
license: Apache-2.0
compatibility: "Needs the mutinybim MCP server with the groups-phases family turned on (bim_enable_pack, --packs groups-phases, or /packs/groups-phases/mcp under the MutinyBIM base)."
metadata:
  pack: "groups_phases"
  mcp-server: "mutinybim"
  family: "groups-phases"
  token-cap: "5200"
  tools: "bim_list_groups_and_phases bim_preview_organization_edit bim_create_group bim_update_group bim_delete_group bim_assign_to_group bim_set_active_group_and_phase bim_create_phase bim_update_phase bim_set_element_phases bim_set_view_organization bim_set_phase_filter bim_delete_phase bim_delete_phase_filter bim_set_element"
---

# MutinyBIM: groups and phases

A family of the `mutinybim` core. Activate `mutinybim` first: it has the
script tools, the four starting reads and the rules for every change (preview, say the change, edit with `base_revision`, report the server's
answer). The pictures and printing are the `model` family.

Every MutinyBIM element (duct, pipe, part, wall…) is in one **group** and is
**built in** one **phase**, and may be **demolished in** a later one. Elements
with no group are in General; with no phase, New construction. Built-in
groups: General, Existing to remain, New work, Demolition, Coordination.
Built-in phases: Existing, New construction. A view shows the model as of its
**phase** through its **phase filter** (Show all, Show new, Show existing +
demo, Show complete), and shows / halftones / hides each group. Views, sheets,
levels and types have no group or phase.

| Tool | Use it to |
| --- | --- |
| `bim_list_groups_and_phases` (read) | Groups (locked?, default visibility), phases in time order, phase filters, the active group and phase, and each view's phase, filter and group visibility. `include_counts` adds elements per group (reads the whole model) |
| `bim_preview_organization_edit` (read) | Run one groups/phases kernel command without saving: what would change or the reason it would be refused |
| `bim_create_group` / `bim_update_group` / `bim_delete_group` (approval) | Add, rename, recolour, set default visibility, **lock / unlock** (on its own call), delete (`move_to` when it has elements; General can't be deleted) |
| `bim_assign_to_group` (approval) | Put `element_ids` (a run, a branch, a box selection) in a group |
| `bim_set_active_group_and_phase` (approval) | Where new work goes: the active group, or the phase new elements are built in (one per call) |
| `bim_create_phase` / `bim_update_phase` (approval) | Add a phase (`after` a phase, `null` = first, absent = last), rename, or move it in time |
| `bim_set_element_phases` (approval) | `built_in` / `demolished_in` (null = not demolished), or `action: "demolish"` (in `phase`, default the active one) / `"restore"` |
| `bim_set_view_organization` (approval) | A view's `phase`, `phase_filter`, and `groups` (name → show / halftone / hide; other groups keep theirs). Reaches the canvas, printed drawing, sheets and PDF |
| `bim_set_phase_filter` (approval) | Create a filter (name + all four of new, existing, demolished, temporary) or change one; each is show, halftone, dashed or hide |
| `bim_set_element` (approval) | **Typed elements**, one change per call on walls, slabs, openings, rooms, grids, columns, beams and components (see below): `class`, `type_id`, `values`, `place`, `lock` / `lock: false`, or `new_type`. A part takes its class and its add-on parameters (`<pack>.<name>`) here too |
| `bim_delete_phase` / `bim_delete_phase_filter` (approval) | Remove a phase or phase filter nothing uses; otherwise refused with what uses it (elements, views, the default phase, the last one) |

**Locked groups.** Nothing in a locked group can be created, changed, moved,
demolished or deleted, by anyone, agents included; an edit that would touch
one (a part move that would push a locked run, too) is refused and nothing
changes. Report the refusal word for word and ask the person whether to unlock
the group. Never unlock a group yourself unless the person asked for exactly
that, and never route around a lock.

## Workflows

**Demolition plan:** `bim_list_groups_and_phases` → `bim_set_element_phases`
with `built_in: "Existing"` on what was there before the project, then
`action: "demolish"` on what is removed (default: the active phase) →
`bim_create_view` (or reuse one; `mutinybim-views-sheets`) →
`bim_set_view_organization` with `phase_filter: "Show existing + demo"`:
demolished work prints dashed, new work is hidden → sheet and print as usual.

**Organise work by group:** `bim_inspect_network` or `bim_query_elements` for
the run's ids → `bim_assign_to_group` → `bim_set_view_organization` with
`groups` to hide or halftone it per view. Lock a finished group only when the
person asks.

**Typical unit or bay:** put one unit's elements in their own group
(`bim_create_group` → `bim_assign_to_group`), then `bim_update_group` with
`typical { count, columns, spacing_ft: { x, y }, mark? }` (count includes the
original; negative `y` goes down the plan) on its own call. Copies draw on
plans and count in every trade's totals (drain fixture units, service,
meter, project), once per copy. `typical: null` stops repeating. General
can't be a typical.

**Contract cap on typicals:** `bim_set_active_group_and_phase` with
`typical_cap` alone sets how many typical types the contract covers;
`bim_list_groups_and_phases` reads `typicals { count, contract_covers }`.
More typicals than the cap is a coordination warning, not a refusal: say it
and let the person decide. A finding id like `<group>#<mark>/<element>` is
copy `<mark>` of that group: explain it as "copy 002 of Unit A" and point at
`<element>`.

If a tool here is missing after turning this family on, say exactly which
tool is missing; don't substitute another.

## Typed elements (`bim_set_element`)

Building and structure elements carry what the engineer says about them, the
same way in every trade. Preview with `bim_preview_part_edit`
(`tool: "bim_set_element"`), say the change, then call it (one Approve card).
Give `element_ids` (from `bim_query_elements`) and exactly one of:

- `class`: a class id from the model's registry (`arch.wall`, `struct.beam`,
  an add-on's or the firm's class; `bim_schedule_fields` in
  `mutinybim-schedules` lists them). `null` clears it so the class is
  recognised from the element again. A class that doesn't admit the kind is
  refused with the reason.
- `type_id`: a shared type (`null` clears it). Make one first with
  `new_type: { name, class?, for_kinds? }` (no `element_ids`); its id comes
  back in the saved answer. Type values read under the element's own.
- `values`: by parameter key. A plain value goes as given; `{ "value": 1.3935456,
  "unit": "m2/occ" }` converts to the unit the parameter stores and is refused,
  in words, when the key has no definition for that element's class or the
  unit is of the wrong kind. `null` removes a value. On a part, only add-on
  parameters (`<pack>.<name>`) go here; its type's parameters stay with
  `bim_set_parameters`.
- `place`: geometry in plan feet on a `level`: `point` (one point, with
  `rotation_deg`), `line` (start, end: walls, beams, grids), `path` (two or
  more), `area` (three or more: slabs, rooms); `z_ft` above the level.
  `null` clears it.
- `lock: { state: "existing" | "issued", reason }` stops anyone changing the
  elements until `lock: false`. Lock only when the person asks, and quote
  their reason.

`bim_query_elements` reads it back: `class`, `type`, `value.<key>` (in the
parameter's stored unit) and `locked`. Built-in building parameters use
namespaced keys: `arch.fire_resistance` (hours) on walls, `arch.area_per_occupant`
on rooms, `arch.fire_rating` on doors, `struct.camber` on beams; the bare names
still read. Add-on classes bring their own `<pack>.<name>` parameters with units.

<!-- tools: rendered from the catalogue by `npm run build:files`; edit the catalogue, not this list -->

## Tools in this family

| Tool |
| --- |
| `bim_list_groups_and_phases` |
| `bim_preview_organization_edit` |
| `bim_create_group` |
| `bim_update_group` |
| `bim_delete_group` |
| `bim_assign_to_group` |
| `bim_set_active_group_and_phase` |
| `bim_create_phase` |
| `bim_update_phase` |
| `bim_set_element_phases` |
| `bim_set_view_organization` |
| `bim_set_phase_filter` |
| `bim_delete_phase` |
| `bim_delete_phase_filter` |
| `bim_set_element` |

<!-- end tools -->
