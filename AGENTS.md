# Notes for coding agents

Read [CONTRIBUTING.md](CONTRIBUTING.md) first: sign-off, setup, tests and the
bedrock rule apply to agents exactly as to people.

**Start here:** the example scripts in `packages/bim-script/examples`
(`bim_script_reference({ example: "<name>" })` serves them). Copy the closest
one rather than starting from nothing; each runs as one
`bim_run_script` → check → `bim_apply_output`. Run one locally with
`npm run example -- <name>`. `packages/bim-mcp/__tests__/examples-run.test.ts`
runs them all; keep it green when you change the kit.

## Tools: script-first, ten at most

The script API is the product. AI writes code: an agent acts on a model by
writing a script with the kit (`packages/bim-script`), checking it, previewing
it and applying it after the person approves. The tools only run, check and
apply scripts, plus a few reads.

- The default tool list (the core pack) is at most 10 tools.
- New capabilities go into the script API and `bim_script_reference`, with a
  worked example, never as new default tools.
- Extra tool families are opt-in only: `--packs <family,…>`,
  `/packs/<family>/mcp`, or turned on in a session with `bim_enable_pack`
  (the server then sends `notifications/tools/list_changed`).
- Never make "all tools" the default anywhere: plugin bundle, hosted app, CLI.
- Never add a tool to the core pack without the maintainer's approval.
  `packages/bim-mcp/__tests__/core-tool-budget.test.ts` enforces the limit.
- What a script does of each add-on tool, and what is still missing:
  `docs/SCRIPTING-COVERAGE.md`. Close a gap in the kit, not with a tool.

### Why

Nov 7, 2026: we spent several thousand dollars building 159 add-on MCP tools
that no AI can use well. Models get confused by long tool lists. AI writes
code: the script API is the product. Stop building new MCP tools for features.
Build script API functions, documented in `bim_script_reference` with a worked
example.

### Forbidden

- A new MCP tool for a feature a script can do.
- Making "all tools" the default anywhere.
- Growing the core pack past 10 tools.

## Every screen uses the shared theme and components

MutinyBIM has one look, defined once in `packages/bim-ui`:

- **Theme**: the `--mutiny-*` CSS variables (colors, fonts, radius) from
  `mutinyDefaultTheme` and `mutinyDarkTheme`. React screens get them from
  `MutinyThemeProvider`; server-rendered pages get the same variables from
  `themeStyleSheet()`. Light, dark and the computer's setting all come from
  there.
- **Components**: `Button`, `Badge`, `Alert`, `Empty`, `Separator`,
  `Spinner`, `Tooltip`, `ToggleGroup`, `ThemeToggle`, `Card`, `Input`,
  `Textarea`, `NativeSelect`, `Label`, `Field` and the brand marks, exported
  from `@permitzip/bim-ui`.

Rules for every screen, in the editor and in every app under `apps/`:

1. Draw controls with those components. Do not hand-roll a button, input,
   card, badge or alert.
2. Take every color, font and radius from a `--mutiny-*` variable. No hex
   colors, no inline `style` colors and no one-off stylesheets that pick their
   own palette. Layout utilities (flex, grid, gap, width) are fine.
3. Check the screen in light and in dark before you finish.
4. If a screen needs a primitive bim-ui lacks, add it to
   `packages/bim-ui/src/ui/` (colors from `--mutiny-*` only) in the same
   change, then use it. Never style a local copy instead.
5. Printed sheets and issued PDFs are the exception: paper stays black on
   white and never reads the theme.
