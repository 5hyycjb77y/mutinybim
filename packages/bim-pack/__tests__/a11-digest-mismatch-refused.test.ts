/**
 * @jest-environment node
 *
 * Round 11 A11 (D5): a pin is id + version + digest. A model that pinned one
 * build doesn't open with another build of the same version, and a library
 * refuses a second, different build under a version it already holds.
 * Fails on round 10's code: pins were id + version only.
 */
import { type ModelState } from "@permitzip/bim-kernel";
import { createFullBimModel, FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";
import { OutsideAddonLibrary, openWithOutsidePacks } from "../src/install";
import { doorAddon, LICENCES, REVIEWER, registry, signedPackage } from "./fixtures/a11-outside";

function model(pins: ModelState["settings"]["packs"]): ModelState {
  const m = createFullBimModel({ ...FULL_BIM_TIERS.XS, modelId: "a11-digest" });
  return { ...m, settings: { ...m.settings, packs: pins } };
}

describe("a11 digest mismatch refused", () => {
  it("a pin naming another build of the same version is blocked", async () => {
    const library = new OutsideAddonLibrary({ registry: registry(), licences: LICENCES });
    const outcome = await library.install(signedPackage());
    if (!outcome.ok) throw new Error(outcome.refused);
    library.act("@acme/doors", "1.2.0", { kind: "approve", by: REVIEWER, at: "2026-11-02T13:00:00Z" });
    const other = `sha256:${"0".repeat(64)}` as const;
    const opened = openWithOutsidePacks(model([{ id: "acme", version: "1.2.0", digest: other, tier: "data" }]), [], library.installed());
    expect(opened.set.packs).toEqual([]);
    expect(opened.needs).toEqual(["This model needs add-on Acme doors 1.2.0: This model pinned a different build of Acme doors 1.2.0 than the one this firm installed. Ask whoever pinned it to send that build, or update the model to the installed one through update review."]);
  });

  it("a second, different build under an installed version is refused", async () => {
    const library = new OutsideAddonLibrary({ registry: registry(), licences: LICENCES });
    const first = await library.install(signedPackage());
    expect(first.ok).toBe(true);
    const second = await library.install(signedPackage({ addon: doorAddon({ classes: 3 }) }));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.refused).toBe("@acme/doors 1.2.0 is already installed as a different build. A catalogue never changes a published version; report it to the catalogue.");
  });

  it("a pin from before digests opens with the approved build and says so", async () => {
    const library = new OutsideAddonLibrary({ registry: registry(), licences: LICENCES });
    const outcome = await library.install(signedPackage());
    if (!outcome.ok) throw new Error(outcome.refused);
    library.act("@acme/doors", "1.2.0", { kind: "approve", by: REVIEWER, at: "2026-11-02T13:00:00Z" });
    const opened = openWithOutsidePacks(model([{ id: "acme", version: "1.2.0" }]), [], library.installed());
    expect(opened.set.packs.map((p) => p.manifest.id)).toEqual(["acme"]);
    expect(opened.warnings).toEqual(["Acme doors 1.2.0 was pinned before builds were recorded; this model opens with the build this firm approved."]);
  });
});
