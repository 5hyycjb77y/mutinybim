# Your first add-on: a planter

This walkthrough adds a made-up planter. It is not a manufacturer's product,
structural design or quantity take-off method. All example data is synthetic.

The finished code is in `packages/bim-pack-tutorial/src/index.ts`. Its only
package dependency is `@permitzip/bim-pack`. The host integration and test
engines belong to the host, not the add-on.

## 1. Make the package

From a checkout with Node 22.13 or newer:

```sh
npm ci
```

Read `packages/bim-pack-tutorial/package.json`. The repository's workspace
pattern already includes it. A fresh `npm ci` links the package; after adding
your own package to an existing checkout, run `npm install` to refresh links
and the lockfile. Add its public import to `packages/tsconfig.bim.json` too.

Use `@permitzip/bim-pack/runtime` for the pack's code and the package root for
its conformance and test tools. Do not import a kernel `src` path or another
trade's implementation. The [contract](ADD-ON-CONTRACT.md) lists the points.

## 2. Register a class and typed properties

Open the finished source beside this page. `PLANTER_CLASSES` declares
`garden.planter`, a subclass of `gen.generic_model`. Recognition limits it to
parts that explicitly carry that class. Contributing a class does not place
anything or assign the class to every generic part.

`PLANTER_PARAMETERS` adds two instance properties:

| Key | Type | Stored unit |
| --- | --- | --- |
| `garden.soil_volume` | quantity, kind `volume` | `m3` |
| `garden.plant` | text | none |

The unit is part of the definition, not a suffix attached to a number. A
value of `0.12` means 0.12 cubic metres. The schedule engine carries its
quantity kind and converts for display. These values are written with
`set_element_values` after assigning the class.

The `garden` prefix belongs to the pack's namespace. Keep stored ids stable.
A new label is harmless; a new id is a different class or property.

## 3. Give it a type, schedule and tag

A class is not geometry. `PLANTER_TYPE` contributes a separate stored part
type through `PART_TYPE_POINT`: a 600 mm box, a square plan symbol and no
connectors. `garden:planter@1` is the part type's stored id, not a registry
row id. This sample deliberately keeps the shape fixed. Soil volume is
metadata and does not change the box.

`PLANTER_SCHEDULE` contributes one `scheduleTemplates` library row through
`LIBRARY_ROWS_POINT`. Its class source finds only `garden.planter` instances.
Its fields are mark, plant and soil volume.

`PLANTER_TAGS` contributes a starter style through `TAG_STYLE_PRESET_POINT`.
It prints `{mark}` and `{type}`. This is a preset, not a tag already placed
in a view. Its `part` category makes it available to parts; it does not
filter the picker to the planter class. The example intentionally uses the
existing mark/type fields rather than assuming arbitrary namespaced
properties are supported by every tag field reader.

Finally, `definePack` combines the manifest and contributions. The manifest
pins the pack version separately from its supported contract range.

## 4. Run conformance and the working example

```sh
npx jest packages/bim-pack/__tests__/first-addon-tutorial.test.ts --runInBand
```

The test is part of the repository's ordinary Jest suite, so CI runs it too.
It checks conformance against the current contract, pins the pack, places
its part, assigns the class and writes both values. It then checks the real
schedule row values and rendered tag text. It also checks that the example
has only the contract dependency.

The engine test supplies `packFieldRegistry(set)` to `buildRowSet`. Without
it, the schedule engine's default registry does not include the pack's
classes and parameter fields. The host owns that registry and scope.

Conformance checks the pack's contract. It does not prove that geometry is
correct, that a host installed the pack, or that its rendered result is useful.

## 5. Load it in the local demo

Code packs run as application code. The demo does not discover arbitrary
packages from disk. For this local exercise, explicitly make the pack
available on **both** sides. These are temporary checkout edits, not changes
to ship in a production host.

In `packages/bim-editor/src/contracts/building-model/installed-packs.ts`,
add this import:

```ts
import { PLANTER_PACK } from '@permitzip/bim-pack-tutorial'
```

Append it to the existing `INSTALLED_PACKS` array, keeping `CIVIL_PACK`.
This makes it available in the browser's model settings. Availability alone
does not switch it on in a model.

In `packages/bim-devserver/src/server.ts`, add:

```ts
import { createPlanterDemoModel, installPlanterDemoHost } from '../../bim-pack/__tests__/fixtures/planter-demo'
```

Immediately after `installFirstPartyAddOns()`, call `installPlanterDemoHost()`.
For this exercise, replace the existing `const startingModel = ...` selection
with:

```ts
const startingModel = createPlanterDemoModel()
```

The helper is the same host code the test runs. It pins garden 0.1.0, creates
a Garden level, places P1 at the origin, assigns its class and writes Lavender
and 0.12 m3. It uses real kernel commands, not a hand-built element record.
Its feature-upgrade policy is for this current-checkout local demo only.
It is not part of the pack and must not be copied into a production host.
The helper installs only garden as an optional pack; retain any other optional
packs if you have modified this demo. First-party packs remain installed.

Restart the demo after these source changes:

```sh
npm run demo
```

Open the local address printed in the terminal. The model already has P1
placed on Garden. Its settings pin **Tutorial garden**; both hosts must have
that same version available. The add-on also appears in Building Model >
Manage > Model settings > Add-ons.

The helper shows the placement sequence for a second planter: `place_part`,
`set_element_class`, then `set_element_values`. Use your model's actual level
and element ids. A bare class contribution does not assign itself when a
part is placed from the catalog.

Create a schedule from **Planters**. It should have one row for P1, with
Lavender and a soil volume equivalent to 0.12 m3 in the model's display units.
Create a project tag style from **Planter mark and type**, then tag P1. It
should print two lines: `P1` and `600 mm square`.

If the class, template or type is missing, check both host lists, the model's
pack pin and the restart before changing the pack. A type can be stored in a
model while its pack's class or fields are unavailable.

Stop the demo and revert the two local host edits after the exercise. Keep
the tutorial package and its test as the starting point for your own pack.
