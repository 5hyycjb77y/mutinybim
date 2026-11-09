# Writing an add-on

An add-on (in code, a **pack**) is how a trade, a firm or anyone else extends
MutinyBIM. Every trade in this repository is built this way, with no edits to
the kernel. Yours can be too.

The contract lives in `@permitzip/bim-pack`. Its full, versioned reference is
`packages/bim-pack/PACK-CONTRACT.md`; this page is the short version.

> **Status.** The contract is at version 1.13.0. It is versioned and enforced
> by tests, and changes within a major version are additive. Until the first
> tagged public release it may still change; we will say so in the changelog
> of `PACK-CONTRACT.md` when it does.

## What a pack is

A pack is a **manifest** plus **contributions** to versioned **extension
points**.

```ts
import { contribute, definePack, CALC_POINT, LINT_RULE_POINT, PARAMETER_SET_POINT, type Pack } from "@permitzip/bim-pack/runtime";
import { RETENTION_PARAMETERS } from "./parameters";
import { VAULT_TOO_SMALL } from "./checks";
import { RETENTION_VOLUME_CALC } from "./calcs";

export const ACME_PACK: Pack = definePack(
  {
    id: "acme",                 // your namespace
    name: "Acme stormwater",
    version: "0.1.0",           // your pack's semver; models pin this exact version
    kernel: "^1.13.0",          // the contract range you wrote it for
    description: "Retention vaults and a sizing check.",
  },
  [
    contribute(PARAMETER_SET_POINT, RETENTION_PARAMETERS),
    contribute(LINT_RULE_POINT, [VAULT_TOO_SMALL]),
    contribute(CALC_POINT, [RETENTION_VOLUME_CALC]),
  ],
);
```

`definePack` throws a `PackDefinitionError` that lists **every** problem at
once. A host runs `runPackConformance(pack)` before it loads a pack; it returns
`{ ok, problems }`.

**Imports.** A pack imports `@permitzip/bim-pack` (or its lighter
`@permitzip/bim-pack/runtime` entry), `@permitzip/bim-units`, and the kernel's
published subpaths for types. Nothing else from MutinyBIM.

## The manifest

| Field | Rule |
| --- | --- |
| `id` | Your namespace: 2–24 lower-case letters, digits or underscores, starting with a letter. Reserved: `firm`, `core`, `kernel`, `builtin`, `project`, `user`, and the first-party ids (`electrical`, `plumbing_gas`, `mechanical`, …). |
| `name` | Display name. |
| `version` | Your pack's semver. |
| `kernel` | The contract range you wrote it for. Checked against `PACK_CONTRACT_VERSION`. |
| `requires` | Other packs you build on: `{ id, range }`. |
| `description` | One sentence in plain words. |

## Ids

- Built-in rows have bare ids (`sanitary`, `thermal`).
- Firm rows are `firm:<slug>`.
- **Your rows are `<pack>.<name>`**, lower snake case, at most 96 characters:
  `acme.retention_vault`, `acme.required_volume`.
- Agent tool names cannot hold dots, so they are `<pack>_<verb>`:
  `acme_size_vault`.

Two packs may not contribute the same id, and a pack row may not equal a
built-in row. Readers keep ids they do not know, so a newer server writing your
ids never breaks an older browser.

## Extension points

Every point has an id, a version and an item type. Import the point constant
from `@permitzip/bim-pack`. The most used ones:

| Point | Constant | What you contribute |
| --- | --- | --- |
| `kernel.class` | `CLASS_POINT` | Object classes: how elements are recognised, where they draw, their IFC mapping. |
| `kernel.element_kind` | `ELEMENT_KIND_POINT` | A whole element kind you own: its stored shape, values, ends, anchor, symbol, plan graphics and checks. |
| `kernel.parameter_set` | `PARAMETER_SET_POINT` | Parameters on classes. Every quantity names a unit kind and a unit. The Inspector, schedules, agent tools and IFC export read them with no host code. |
| `kernel.service` | `SERVICE_POINT` | What flows (storm water, gravity load), and which network adapter walks it. |
| `kernel.network_adapter` | `NETWORK_ADAPTER_POINT` | Link rules and/or a network the kernel walks and totals. |
| `kernel.command` | `COMMAND_POINT` | Your own commands, with a strict zod schema and an `execute`. They run through the same edit spine and conflict rules as kernel commands. |
| `kernel.pack_read` / `kernel.command_builder` | `PACK_READ_POINT` / `COMMAND_BUILDER_POINT` | Reads that never edit, and builders that turn input into a kernel command (or a refusal in words). |
| `kernel.agent_tool` | `AGENT_TOOL_POINT` | Agent tool descriptors: data only (name, description, JSON Schema input, read or write, and the command or read it maps to). |
| `lint.rule` | `LINT_RULE_POINT` | Checks that run in the coordination lint. |
| `calc.calc` | `CALC_POINT` | Calculations built with `defineCalc`: typed input, a worked example, and a result that names its method. |
| `calc.code_edition` | `CODE_EDITION_POINT` | A code family with its editions and resolver. |
| `library.space_use` / `library.space_use_rate_value` | `SPACE_USE_POINT` / `SPACE_USE_RATE_VALUE_POINT` | Space uses and per-use rates (a live load on the office use). |
| `kernel.library_rows` | `LIBRARY_ROWS_POINT` | Built-in library items as JSON rows (fields, formulas, schedule templates, tag types, lookup tables, design limits). |
| `kernel.symbol`, `kernel.view_graphics`, `kernel.diagram_layout` | | How things draw on plans and diagrams. |
| `kernel.ifc_import_rule`, `kernel.ifc_relation` | | How your classes come in from, and go out to, IFC. |

There are many more (fitting families, pipe products, connector end types,
route constraints, rating kinds, design limit defaults, calc sheets, finding
sources, identity providers, lifecycle stages…). `KNOWN_POINTS` lists every
point this release reads, and `PACK-CONTRACT.md` describes each.

### A parameter set

```ts
import type { PackParameterSet } from "@permitzip/bim-pack/runtime";
import { ACME_CLASS } from "./ids";

export const RETENTION_PARAMETERS: readonly PackParameterSet[] = [
  {
    id: "acme.retention",
    label: "Retention",
    parameters: [
      {
        key: "acme.required_volume",
        label: "Required volume",
        classes: [ACME_CLASS.vault],
        valueType: "quantity",
        kind: "volume",
        unit: "ft3",
        group: "Stormwater",
        ifc: { pset: "Acme_Retention", property: "RequiredVolume" },
      },
    ],
  },
];
```

Values live in the element's `values["acme.required_volume"]`, in the
parameter's unit, written with the ordinary `set_element_values` command.

### A lint rule

```ts
import type { RuleDef } from "@permitzip/bim-pack/runtime";

export const VAULT_TOO_SMALL: RuleDef = {
  id: "acme.vault_too_small",
  version: 1,
  pack: "acme",
  severity: "warning",
  title: "Retention vault is smaller than its required volume",
  scope: "element",
  kinds: ["part"],
  run(ctx, el) {
    // read el.values, then ctx.emit({ rule, severity, elementIds, at, message })
  },
};
```

Element rules run only on what an edit touched. If your rule reads other
kinds (a column rule that reads the footing under it), list them in `reads` so
it re-runs when they change.

## Rules every pack follows

- **Through the contract only.** No imports of kernel internals. The kernel
  never imports a pack.
- **Typed units.** Every quantity names a unit kind from `@permitzip/bim-units`.
- **Incremental.** A rule or network reads what changed, not the whole model.
  Cache per model state where it helps (the civil pack keeps one solve per
  `elements` record in a `WeakMap`).
- **Plain words.** Titles, refusals and findings say what a person sees and
  what to do.
- **Cite your method.** A calc names the method or clause it rests on. Values
  that need checking for permit work say so.
- **No money in the model.** Quantities only. Prices are a read-side view over
  a cost source.
- **Found a gap?** If your trade needs something the kernel cannot express,
  open a `kernel gap` issue. We generalise the kernel; we do not special-case
  your trade in it.

## Testing your pack

`@permitzip/bim-pack` ships a harness that runs your rows through the real
engines inside a pack set's scope:

```ts
import { PackSet, installedFirstPartyPacks, runPackCalc, runPackConformance, runPackLint } from "@permitzip/bim-pack";
import { ACME_PACK } from "../src/pack";

const set = PackSet.create([...installedFirstPartyPacks(), ACME_PACK]);

it("conforms", () => {
  expect(runPackConformance(ACME_PACK).problems).toEqual([]);
});

it("flags an undersized vault", () => {
  const findings = runPackLint(syntheticSiteModel(), set);
  expect(findings.some((f) => f.rule === "acme.vault_too_small")).toBe(true);
});

it("sizes a vault", () => {
  const result = runPackCalc(set, { calc: "acme.retention_volume", inputs: { area_ft2: 10_000, depth_in: 2 } });
  expect(result).toMatchObject({ ok: true });
});
```

Also available: `runPackNetwork(model, set, serviceId)` for network totals and
`packFieldRegistry(set)` for the fields the Inspector reads. The repository's
test setup installs the first-party add-ons before tests run.

Use synthetic models only. `packages/bim-pack-civil/__tests__/fixtures` and
`packages/bim-pack-structural/__tests__/two-bay-frame.ts` show how to build
one.

## How a host loads packs

- **First-party add-ons** are always installed (`installFirstPartyAddOns()`
  from `@permitzip/bim-first-party`) and sit under every model's own packs.
- **A model's own packs** are pinned in its settings with exact versions. When
  the model opens, the host calls `resolvePackPins(available, pins)`, builds
  the set and binds it to the model (`bindModelPacks`). A missing pack is
  reported by name, never silently dropped, and its records are kept.
- **Kernel code reads the set in force** (`activePackSet()`, `withPackSet`,
  `withModelPacks`). One process can serve many models with different packs.
- **Outside packages.** An add-on can be distributed as a package
  (`mutinybim.json`, format v1, in `@permitzip/bim-library`) with a license,
  authors, a rights declaration, hashed contents and a signature. A host
  installs a **data** add-on only after the checks pass and a person approves
  that exact version. **Code** add-ons are refused by default by the host's
  trust policy; an operator who trusts one installs it as ordinary software.

The demo server loads only the first-party add-ons today. Use the test
harness above to exercise your pack.

## Examples to read

| Package | Shows |
| --- | --- |
| `packages/bim-pack-civil` | Classes, a service and network, parameter sets, a pipe material, two lint rules and two calcs. A good first read. |
| `packages/bim-pack-structural` | Line- and point-placed elements, a section catalogue, load paths and tributary zones. |
| `packages/bim-pack-site`, `packages/bim-pack-development` | Records with no geometry, and a pro forma priced on the reader's side. |
| `packages/bim-pack-architecture` | Element kinds with joins, host voids, room bounding and IFC relations. |
| `packages/bim-pack-electrical`, `-mechanical`, `-plumbing` | Full first-party trades, including agent tools and commands. |
