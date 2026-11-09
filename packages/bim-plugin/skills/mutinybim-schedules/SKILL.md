---
name: mutinybim-schedules
description: "MutinyBIM pack for schedules: the classes and fields a schedule can show, define and change schedules, edit cell values, and the schedule library. The core reads schedule rows. Use with the mutinybim core. Trigger on: schedule, create a schedule, schedule fields, edit schedule values, schedule template, library."
license: Apache-2.0
compatibility: "Needs the mutinybim MCP server with the schedules family turned on (bim_enable_pack, --packs schedules, or /packs/schedules/mcp under the MutinyBIM base)."
metadata:
  pack: "schedules"
  mcp-server: "mutinybim"
  family: "schedules"
  token-cap: "1900"
  tools: "bim_schedule_fields bim_schedule_define bim_schedule_edit_cells bim_library"
---

# MutinyBIM: schedules

A family of the `mutinybim` core. Activate `mutinybim` first: it has the
script tools, the four starting reads and the rules for every change (read before you plan, say the change in plain words, report the
server's answer). `bim_schedule_read` (rows of any schedule), the pictures
and printing are the `model` family.

A schedule is a view whose every value is read from the model at the revision
drawn. One engine serves the grid people type in, the sheet and you, for
every trade: equipment, air devices, fixtures, doors, rooms, beams, sprinkler
heads, panels. Every value carries its unit. A calculated value (a formula, a
Serves total) is locked and says where it comes from.

| Tool | Use it to |
| --- | --- |
| `bim_schedule_fields` (read) | No `classes`: every class a schedule can list, by discipline. With `classes`: each one's fields (`path`, label, kind, unit, `edit`: instance, type, or `locked` with why, and how it totals) and its relationships (`serves`, `source`, `fed_from`…) for aggregate and expand columns. Use these exact paths |
| `bim_schedule_define` (preview, then approval) | Create a schedule (a `definition`, a library `template` id, a built-in list as `template`: `space_loads` (Space loads: each space's estimate against the devices so far, per trade), `panel_loads` (Panel loads: each panel with the estimates and devices that name it), `loads`, `equipment_list`, `not_placed_yet`, or a `form`). Offer the built-in lists before building load columns by hand; they are the MutinyBIM editor's Views › Schedules › Load schedules or replace an existing one's definition (`schedule`). `place_on: { sheet, top_left_in? }` places a new one in the same edit. The preview shows problems in plain words or the first rows, with a `preview_token` |
| `bim_schedule_edit_cells` (preview, then approval) | Change cells: `edits: [{ row, column, value }]` with `row` the row key and `column` the column id from `bim_schedule_read`. Quantities take a unit (`"199 MBH"`, `"10'-6\""`); a bare number reads in the unit the schedule shows. The preview lists every change, every type-wide change as `"WH-1 type: 14 parts"`, and every refused cell with the reason |
| `bim_library` | `list` scopes and items (and the panel / feeder form templates), `read` an item (its body and the `pin` a schedule uses), `test` an item (schema, units, expression, every example), `publish` to the firm or project library (preview, then approval; needs firm library write access) |

## Preview, then the Approve card

`bim_schedule_define`, `bim_schedule_edit_cells` and a `bim_library` publish
work in two calls:

1. Call without `user_confirmed`. Nothing is saved. Read the preview and tell
   the person in plain words what will change, **including every
   `type_scope` line** ("This changes all 14 parts of type WH-1, not just this
   row").
2. Call again with exactly the same arguments plus `base_revision` and
   `preview_token` from the preview and `user_confirmed: true`. That call
   waits for the person's approval; they approve or deny it.
   Report the saved revision, or the refusal or conflict, word for word.

If anything changed since the preview (a part was added to the type, someone
edited the same cell), the commit is refused: preview again. Don't commit a
batch with refused cells; fix or drop them first.

## Definitions

A definition (ScheduleDefinition v2) is JSON. Only `source` and `columns` are
required; the rest default (no filters, no groups, list presentation).

```json
{
  "name": "Water heater schedule",
  "source": { "kind": "classes", "classes": ["mep.mechanical_equipment"], "includeSubclasses": true },
  "columns": [
    { "id": "mark", "kind": "field", "path": "mark" },
    { "id": "mbh", "kind": "field", "path": "own.mbh", "total": true },
    { "id": "btuh", "kind": "formula", "expression": "{own.mbh} * 1000", "unit": "Btu/h" },
    { "id": "served", "kind": "aggregate", "fn": "count", "relationship": "serves" },
    { "id": "serves", "kind": "expand", "relationship": "serves", "columns": ["mark", "connection_type.mark"], "paper": "nested" }
  ],
  "filters": [{ "path": "family", "op": "contains", "value": "Water heater" }],
  "sort": [{ "path": "mark", "direction": "asc" }],
  "grandTotals": true
}
```

- **Columns.** `field` (any path from `bim_schedule_fields`), `parameter` (a
  firm shared field), `formula` (`{path}` fields, numbers with units, `+ - * /`,
  `if`, `round`, `min`, `max`, `coalesce`, named calculations), `aggregate`
  (`fn` sum, count, min, max, avg or list over a `relationship`, with a
  `path`), `expand` (a sub-list under each row, `paper` nested, summary or
  hidden). Options: `heading`, `unit`, `precision`, `total`, `hideWhenEmpty`,
  `widthMm`, `highlights: [{ when, tone, reason }]`.
- **Serves is one number or a sub-list.** "Serves WSFU" is an `aggregate`
  sum over `serves`; "Served fixtures" is `list`; the full list with each
  fixture's data is an `expand` column. A total of a Serves column is refused
  ("served loads are already counted on the fixtures"); that is correct, so
  don't work around it.
- **Units.** A formula that adds different kinds (feet + MBH) is refused with
  where; fix the formula. Numbers without units only work for counts.
- **Named calculations** from the library are used through pins: `bim_library`
  `read` the item and add its `pin` to the definition's `pins`, then call it in
  a formula (`PZ.GasDemandBtuh({own.mbh})`). The model keeps its own copy, so a
  later library change never alters a drawn sheet.
- **Templates.** A firm schedule template is a definition saved in the
  library: `bim_schedule_define` with `template: "<item id>"` and a `name`.
- **Forms.** Panel, switchboard, feeder, connection type, equipment connection
  and gas schedules print as forms: `form: { kind, panel, template_name,
  nec_edition }` instead of a definition. Their cells come from the model
  (circuits, loads); never type a load into one. `bim_library` `read` id
  `form:panel` shows the template, its field paths and the template language;
  `form.template` replaces a schedule's template.

## Workflows

**New equipment schedule on M-601:** `bim_schedule_fields` (no classes, then
the classes you need) → draft the definition → `bim_schedule_define` with
`place_on: { sheet: "M-601" }` (preview: check the first rows and say what it
lists) → commit (approval) → `bim_render_sheet_image` on M-601 in the core.

**Change values from the schedule:** `bim_schedule_read` (row keys, column
ids, which columns edit per type) → `bim_schedule_edit_cells` preview → tell
the person every type-wide line → commit (approval) → `bim_schedule_read`
again to show the new values. A locked column can't be typed in: read
`explain` and change its source instead.

**Firm calculation:** draft the item (`formula` with `key`, `expression`,
`result` kind and unit, `appliesTo`, `examples`) → `bim_library` `test` until
it says valid → `publish` preview to the firm scope → commit only when the
person says it is the firm's standard.

If a tool here is missing after turning this family on, say exactly which
tool is missing; don't substitute another.

<!-- tools: rendered from the catalogue by `npm run build:files`; edit the catalogue, not this list -->

## Tools in this family

| Tool |
| --- |
| `bim_schedule_fields` |
| `bim_schedule_define` |
| `bim_schedule_edit_cells` |
| `bim_library` |

<!-- end tools -->
