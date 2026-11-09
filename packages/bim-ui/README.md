# @permitzip/bim-ui

MutinyBIM's brand, theme and shell primitives. Open-source candidate: nothing
here imports host app code, its permissions, Supabase, or its environment variables.

## What's in it

- **`MutinyTheme`** (`src/theme.ts`): colors (surface, canvas, panel, field,
  text, muted, accent, accent subtle, selection, warning, danger…), viewer
  colors (background, plan background, selection, selection outline,
  provisional, edges, grid, axes), typography, radius and brand slots.
  `mutinyDefaultTheme` (light) is neutral: soft white `#FBFBFB` app, light gray
  `#F2F3F4` panels, white `#FFFFFF` fields and paper, `#DDE1E4` borders,
  charcoal `#182126` text, slate `#626C73` secondary text, electric lime
  `#D7E620` as a fill with charcoal on it (never as text on a light surface),
  pale lime `#F2F6D4` for a pressed tool. Cream stays in the logo artwork and
  the dark theme (`mutinyDarkTheme`).
- **`MutinyThemeProvider`**: resolves `default → host adapter → overrides` and
  writes `--mutiny-*` CSS variables on its own root element. Popovers and
  tooltips portal into that root so they keep the theme.
- **Theme adapter**: a host passes `adapter={useMyHostTheme}`, a hook that
  reads the host's tokens and returns `MutinyThemeOverrides`. A host app ships
  its own adapter (in its own tree, not here).
- **Vendored shadcn/ui** (`src/ui/`, MIT, Radix-based): Button, Badge, Tooltip,
  Separator, Spinner, Empty, Alert. They are styled only with `--mutiny-*`
  variables, so standalone and embedded MutinyBIM draw with the same components
  and a host only maps variables. A host can still hand in its own shadcn
  components with `<MutinyThemeProvider components={{ Button, … }}>`.
- **Brand**: `MutinyWordmark` (vector slab, `currentColor`), `MutinyIcon`,
  `MutinyMark` (the small embedded mark), `MutinySplash`, `MutinyEmptyState`.
- **Window**: `useFullscreen`, `openInNewWindow`, `WindowControls`.

## Styling

Components use Tailwind v4 utility classes that reference the variables
(`bg-(--mutiny-accent)`). A host using Tailwind adds the package to its
sources (`@source "<path>/packages/bim-ui/src";`). A host without Tailwind
will need the prebuilt stylesheet the extraction plan adds.

## Printing

Printed sheets and issued PDFs never read the theme. Paper is black on white.

## Licensing

Code: to be released under the license PermitZIP chooses for MutinyBIM. The vendored shadcn/ui components remain MIT
(`src/ui/LICENSE-shadcn.md`). Brand art in `assets/` is **not** covered by the
code license; see `assets/LICENSE.md`.
