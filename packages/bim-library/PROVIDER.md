# `LibraryProvider`: storing and sharing MutinyBIM libraries

A **library** is a `mutinybim-library` v1 bundle: display profiles, object
classes, shared fields, named calculations, relationships, schedule templates
and tag types (`src/schema.ts`). A **provider** is how a host stores those
items, shares them between people, and decides who may change them.

MutinyBIM ships one provider, `FileLibraryProvider` (folders, files, URLs and
in-memory bundles). A host that keeps libraries somewhere else, such as a
database with its own permissions, implements the same interface and runs the
same conformance suite.

## What a provider does, and what it never does

A provider **stores, lists, versions and permissions** items. It never
evaluates them. When a schedule, tag or field uses a library item, the model
keeps a pinned copy (`LibraryPin`: id, revision, content hash and the item
itself). Drawing a schedule, printing a sheet and evaluating on the authority
read those pins, so:

- no provider call sits on a hot path;
- prints reproduce exactly, whatever the library later becomes;
- a firm edit never rewrites an issued sheet. A newer revision is offered
  (`pinUpdates`), and a person or an approved agent action updates selected
  pins (`updatePins`).

## The interface (`src/provider.ts`)

```ts
interface LibraryProvider {
  scopes(): Promise<readonly LibraryScope[]>;
  list(scope, query?): Promise<readonly LibraryItemSummary[]>;
  get(id, revision?): Promise<StoredLibraryItem>;
  publish?(scope, item, baseRevision): Promise<PublishResult>;
  capabilities(scope): Promise<ScopeCapabilities>;
  watch?(scope, onChange): Unsubscribe;
}
```

### Scopes

- `scopes()` returns every scope the caller can read, **in precedence order**:
  project, then firm, then built in. An item id found in an earlier scope wins
  (`get` follows the same order). Scope ids are unique and stable
  (`builtin`, `firm:permitzip`, `project:7301`).
- `kind` is `builtin`, `firm`, `project` or `file`. `name` is what a person
  sees.

### Reading

- `list(scope, query)` returns summaries: id, type, key, name, revision,
  content hash, scope, deprecated. Deprecated items are left out unless
  `includeDeprecated` is set. A `type` filter returns only that type.
- `get(id)` returns the item from the first scope holding it, with `scope`
  set and `body.contentHash` equal to `contentHashOf(item)`.
- `get(id, revision)` returns that past revision exactly as it was published.
  A provider keeps every published revision it accepted (append-only history).
- An unknown id or revision throws `LibraryError` with code `not_found`. An
  unknown scope throws code `unknown_scope`.

### Publishing

- `publish(scope, item, baseRevision)`: `baseRevision` is the revision the
  edit started from, `0` for a new item. If the stored revision differs, the
  result is `{ ok: false, code: "conflict", currentRevision }` and nothing is
  stored. Otherwise the item is stored at `baseRevision + 1` with its content
  hash recomputed.
- The item is validated as part of its scope **and** every scope above it
  (`loadBundle` with the lower layers as `lower` and their registry as
  `registry`). Any problem refuses the publish whole:
  `{ ok: false, code: "invalid", problems }`. Nothing changes.
- A scope the caller can't write returns `code: "read_only"` (the scope can't
  be written at all) or `"forbidden"` (this person may not), always with a
  message a person can act on. A provider that can never publish omits
  `publish`.
- `capabilities(scope)` says `read` and `publish`, with a `reason` whenever
  publishing is not allowed.

### Watching

`watch(scope, onChange)` is optional. When present, it reports every accepted
publish in that scope.

## Validation a provider must apply

A provider must reject, whole, any bundle or publish that `loadBundle`
refuses: schema errors, duplicate ids or keys, a content hash that doesn't
match, a class or field the registry refuses, a unit that doesn't measure its
kind, a calculation that doesn't type-check or returns the wrong kind, a call
cycle between calculations, or a failing example. Problems name the item and,
when the source was text, the line.

Validation needs a formula engine and a unit catalog
(`LibraryEnvironment`). A host passes the ones its kernel uses, so a library
is checked by the same code that will evaluate it. Over the MutinyBIM engines
that is:

```ts
import { bimFormulaEngine, bimUnitsCatalog } from "@permitzip/bim-library/bim-formula";
const env = { formula: bimFormulaEngine, units: bimUnitsCatalog, registry: fieldProviderRegistry() };
```

A calculation's expression uses the formula engine's syntax. Its own
parameters are bare names (`mbh * factor`); `{path}` reads a field of the
classes it applies to (`{own.mbh}`); `sum(serves, {load.gpm_fixed})`
aggregates over a relationship those classes can walk; `PZ.Name(a, b)` calls
another calculation. A parameter written in braces (`{mbh}`) is refused, so
there is one way to write it.

## Conformance

```ts
import { runProviderConformance } from "@permitzip/bim-library";

const report = await runProviderConformance({
  provider,
  writableScope: "firm:conformance", // a throwaway scope; test items are left deprecated
  readOnlyScope: "builtin",
});
expect(report.failures).toEqual([]);
```

The suite checks scope listing, read-back of every item (revision and content
hash), revision history, type filtering, `not_found`, read-only refusals, a
first publish, a stale-revision conflict, an edit that keeps the old revision
readable, an invalid publish that changes nothing, and watchers. It returns a
report instead of asserting, so it runs under any test runner. Without a
`writableScope` it checks that every scope refuses publishing.

## `FileLibraryProvider`

```ts
new FileLibraryProvider({
  env: { formula, units },
  fs: nodeLibraryFileSystem(), // from "@permitzip/bim-library/node"
  sources: [
    { scope: { id: "project:7301", kind: "project", name: "7301" }, kind: "file", path: "7301.mutinylib.json" },
    { scope: { id: "firm:acme", kind: "firm", name: "Acme" }, kind: "folder", path: "libraries/" },
    builtinLibrarySource(),
  ],
});
```

- `folder`: every `*.mutinylib.json` in it, as one scope. New items publish to
  `<scope>-published.mutinylib.json`; edits go back to the file that held the
  item.
- `file`: one bundle, rewritten on publish.
- `url`: read-only.
- `bundle`: in memory, read-only unless `writable: true`.
- Sources are validated bottom-up when first used. Any problem refuses the
  provider with every problem listed, never a partial library.
- `exportScope(scope)` returns a scope as one bundle; `resolved()` returns the
  layered library and the registry it produces.
