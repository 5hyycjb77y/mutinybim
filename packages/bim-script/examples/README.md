# Example scripts: start here

Four short scripts that each build something whole. Copy one, change it, run
it. Each one is a normal MutinyBIM script: it imports only
`@permitzip/bim-script`, and it runs as one preview you check and one
approval (`bim_run_script` → check → `bim_apply_output`).

| Example | What it builds |
| --- | --- |
| [`small-office.ts`](small-office.ts) | Two floors of a 40 x 30 ft office. Exterior and interior walls, doors and windows, and rooms found from the walls around them (open office, conference room, office), each with a 9 ft ceiling. A plan of each floor on its own sheet, and a report of the level and room ids it made. |
| [`rooftop-unit.ts`](rooftop-unit.ts) | A 10 ton rooftop unit. The script sizes the supply and return ducts from the airflow, builds the unit's part type with openings that size, places it on the roof and routes its ducts down into two rooms. Then it tags the ducts on a plan and puts an equipment schedule on a sheet. |
| [`plumbing-riser.ts`](plumbing-riser.ts) | Toilet rooms on two floors. The script counts their fixture units and sizes the branches, the stack and the building drain with the plumbing code's tables. It draws them sloped 1/4 in per ft, connects every fixture, works out the water demand, and tags the drain with its size, slope and fixture units. |
| [`electrical-room.ts`](electrical-room.ts) | A one-bedroom unit. Walls, rooms and a panel. Receptacles placed by the code's wall spacing (NEC 210.52), each room on its own circuit, and the panel schedule on a sheet with the code's demand factors. |

## Run one with an assistant

Connect your assistant to the MutinyBIM tool server
([docs/CONNECT-AN-AGENT.md](../../../docs/CONNECT-AN-AGENT.md)). Then paste
the script and say "run this script". The assistant checks it, previews it,
shows you what it will change and applies it when you approve.

An assistant can also fetch an example itself:
`bim_script_reference({ example: "rooftop-unit" })` returns its source.

## Run one on your own computer

```bash
npm run example -- rooftop-unit
```

This runs the example the same way an assistant does, through the same
tools, against a fresh empty model. It saves the model it made to
`mutinybim-examples/rooftop-unit.model.json` and prints a summary:

```text
rooftop-unit: RTU-1 (4000 CFM) with 46x12 supply and return ducts at 1043 fpm
  18 edits, applied in one approval (1.2 s)
  the model now has: 5 wall, 4 run_segment, 3 drawing_item, 2 space, …
  saved: mutinybim-examples/rooftop-unit.model.json
```

Give a path instead of a name to run your own script
(`npm run example -- ./my-script.ts`), and `--out <folder>` to save the
result somewhere else. A script run this way runs on your computer with your
permissions, so run only scripts you trust.

## What to read next

- `bim_script_reference` (or [docs/SCRIPTING.md](../../../docs/SCRIPTING.md))
  for every kit function, with a worked example for each.
- [docs/SCRIPTING-COVERAGE.md](../../../docs/SCRIPTING-COVERAGE.md) for what a
  script does of each tool.

These examples are tested: `packages/bim-mcp/__tests__/examples-run.test.ts`
runs every one end to end, so they keep working as the kit changes. After
editing one, run `node packages/bim-script/scripts/write-examples.mjs` so the
copy the reference serves matches the file.
