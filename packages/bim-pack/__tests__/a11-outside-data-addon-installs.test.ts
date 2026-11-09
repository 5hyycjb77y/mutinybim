/**
 * @jest-environment node
 *
 * Round 11 A11 (D5): an outside data add-on installs through the one gate,
 * waits for review, and once a person approves it a model that pins it opens
 * with its rows: door classes in the class registry, its parameter set in the
 * field registry, its zone purpose at the point. Nothing here edits the
 * kernel: the add-on is a JSON file in a signed package. Fails on round 10's
 * code: there was no install path, no review and no pin with a digest.
 */
import { activeClassRegistry, ZONE_PURPOSE_POINT, type ModelState } from "@permitzip/bim-kernel";
import { createFullBimModel, FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";
import { withPackSet } from "@permitzip/bim-kernel/packs";
import { packFieldRegistry } from "../src";
import { OutsideAddonLibrary, openWithOutsidePacks } from "../src/install";
import { LICENCES, REVIEWER, registry, signedPackage } from "./fixtures/a11-outside";

function model(pins: ModelState["settings"]["packs"]): ModelState {
  const m = createFullBimModel({ ...FULL_BIM_TIERS.XS, modelId: "a11-installs" });
  return { ...m, settings: { ...m.settings, packs: pins } };
}

describe("a11 outside data add-on installs", () => {
  it("installs pending, is approved by a person, pins and works on a model", async () => {
    const library = new OutsideAddonLibrary({ registry: registry(), licences: LICENCES, hostName: "Example Host" });
    const outcome = await library.install(signedPackage());
    if (!outcome.ok) throw new Error(`${outcome.refused} ${JSON.stringify(outcome.checks)}`);
    expect(outcome.review.state).toBe("pending");
    expect(outcome.review.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(outcome.review.checks).toEqual({ signature: { status: "pass", problems: [] }, licence: { status: "pass", problems: [] }, conformance: { status: "pass", problems: [] } });
    expect(outcome.signers.map((s) => s.subject)).toEqual(["acme-publisher"]);

    library.act("@acme/doors", "1.2.0", { kind: "approve", by: REVIEWER, at: "2026-11-02T13:00:00Z" });
    const pins = library.pinsFor("@acme/doors", "1.2.0");
    expect(pins).toEqual([{ id: "acme", version: "1.2.0", digest: outcome.review.digest, tier: "data" }]);

    const opened = openWithOutsidePacks(model(pins), [], library.installed());
    expect(opened.needs).toEqual([]);
    expect(opened.warnings).toEqual([]);
    withPackSet(opened.set, () => {
      expect(activeClassRegistry().getClass("acme.door_1")?.label).toBe("Acme door type 1");
      expect(activeClassRegistry().isA("acme.door_1", "arch.door")).toBe(true);
    });
    expect(opened.set.items(ZONE_PURPOSE_POINT).map((p) => p.id)).toContain("acme.egress");
    expect(packFieldRegistry(opened.set).field("acme.door_1", "acme.hardware_set")).toBeDefined();
  });

  it("a model that doesn't pin the add-on opens exactly as before", async () => {
    const library = new OutsideAddonLibrary({ registry: registry(), licences: LICENCES });
    const outcome = await library.install(signedPackage());
    expect(outcome.ok).toBe(true);
    library.act("@acme/doors", "1.2.0", { kind: "approve", by: REVIEWER, at: "2026-11-02T13:00:00Z" });
    const opened = openWithOutsidePacks(model(undefined), [], library.installed());
    expect(opened.set.packs).toEqual([]);
    expect(opened.needs).toEqual([]);
  });
});
