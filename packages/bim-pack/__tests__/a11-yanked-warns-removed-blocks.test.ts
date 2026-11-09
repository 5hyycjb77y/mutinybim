/**
 * @jest-environment node
 *
 * Round 11 A11 (D5): a version its catalogue withdrew (yanked) keeps working
 * where it is pinned, with a warning; a version removed as unsafe is blocked
 * everywhere and the model says why, its records kept. Fails on round 10's
 * code: there was no review state.
 */
import { type ModelState } from "@permitzip/bim-kernel";
import { createFullBimModel, FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";
import { OutsideAddonLibrary, openWithOutsidePacks } from "../src/install";
import { LICENCES, REVIEWER, registry, signedPackage } from "./fixtures/a11-outside";

async function approved(): Promise<{ library: OutsideAddonLibrary; model: ModelState }> {
  const library = new OutsideAddonLibrary({ registry: registry(), licences: LICENCES });
  const outcome = await library.install(signedPackage());
  if (!outcome.ok) throw new Error(outcome.refused);
  library.act("@acme/doors", "1.2.0", { kind: "approve", by: REVIEWER, at: "2026-11-02T13:00:00Z" });
  const m = createFullBimModel({ ...FULL_BIM_TIERS.XS, modelId: "a11-yank" });
  return { library, model: { ...m, settings: { ...m.settings, packs: library.pinsFor("@acme/doors", "1.2.0") } } };
}

describe("a11 yanked warns, removed blocks", () => {
  it("yanked: still loads, with a warning", async () => {
    const { library, model } = await approved();
    library.act("@acme/doors", "1.2.0", { kind: "yank", at: "2026-11-03T09:00:00Z", reason: "replaced by 1.2.1" });
    const opened = openWithOutsidePacks(model, [], library.installed());
    expect(opened.set.packs.map((p) => p.manifest.id)).toEqual(["acme"]);
    expect(opened.warnings).toEqual(["Acme doors 1.2.0 was withdrawn by its catalogue (replaced by 1.2.1). This model keeps working with it; plan to move to a newer version through update review."]);
    expect(opened.needs).toEqual([]);
  });

  it("removed: blocked, with why", async () => {
    const { library, model } = await approved();
    library.act("@acme/doors", "1.2.0", { kind: "remove", at: "2026-11-03T09:00:00Z", reason: "reported as harmful" });
    const opened = openWithOutsidePacks(model, [], library.installed());
    expect(opened.set.packs).toEqual([]);
    expect(opened.needs).toEqual(["This model needs add-on Acme doors 1.2.0: Acme doors 1.2.0 was removed as unsafe (reported as harmful). Its rows on this model are kept but not used; review where it was used."]);
  });

  it("a removal needs a reason", async () => {
    const { library } = await approved();
    expect(() => library.act("@acme/doors", "1.2.0", { kind: "remove", at: "2026-11-03T09:00:00Z", reason: " " })).toThrow("Say why it is removed.");
  });
});
