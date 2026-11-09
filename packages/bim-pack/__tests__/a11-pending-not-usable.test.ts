/**
 * @jest-environment node
 *
 * Round 11 A11 (D5): an installed package is pending until a person approves
 * it, and a pending (or rejected) add-on is not usable on any model, even one
 * that pins it. An agent can't approve or reject: those are person-only acts.
 * Fails on round 10's code: any add-on a host had was loaded for a pin.
 */
import { activeClassRegistry, type ModelState } from "@permitzip/bim-kernel";
import { createFullBimModel, FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";
import { withPackSet } from "@permitzip/bim-kernel/packs";
import { ReviewActError } from "@permitzip/bim-kernel/packs";
import { OutsideAddonLibrary, openWithOutsidePacks } from "../src/install";
import { AGENT, LICENCES, REVIEWER, registry, signedPackage } from "./fixtures/a11-outside";

function model(pins: ModelState["settings"]["packs"]): ModelState {
  const m = createFullBimModel({ ...FULL_BIM_TIERS.XS, modelId: "a11-pending" });
  return { ...m, settings: { ...m.settings, packs: pins } };
}

async function installed(): Promise<OutsideAddonLibrary> {
  const library = new OutsideAddonLibrary({ registry: registry(), licences: LICENCES });
  const outcome = await library.install(signedPackage());
  if (!outcome.ok) throw new Error(outcome.refused);
  return library;
}

describe("a11 pending is not usable", () => {
  it("a pinned add-on waiting for review doesn't load, and says so", async () => {
    const library = await installed();
    const opened = openWithOutsidePacks(model(library.pinsFor("@acme/doors", "1.2.0")), [], library.installed());
    expect(opened.set.packs).toEqual([]);
    expect(opened.needs).toEqual(["This model needs add-on Acme doors 1.2.0: Acme doors 1.2.0 is waiting for review. A person with library approval can approve it in Library › Packages."]);
    withPackSet(opened.set, () => expect(activeClassRegistry().getClass("acme.door_1")).toBeUndefined());
  });

  it("an agent can't approve or reject; a person can", async () => {
    const library = await installed();
    expect(() => library.act("@acme/doors", "1.2.0", { kind: "approve", by: AGENT, at: "2026-11-02T13:00:00Z" })).toThrow(ReviewActError);
    expect(() => library.act("@acme/doors", "1.2.0", { kind: "approve", by: AGENT, at: "2026-11-02T13:00:00Z" })).toThrow("Only a person can approve an add-on. R. Reviewer does this in Library › Packages.");
    expect(() => library.act("@acme/doors", "1.2.0", { kind: "reject", by: AGENT, at: "2026-11-02T13:00:00Z", reason: "no" })).toThrow(ReviewActError);
    expect(library.review("@acme/doors", "1.2.0")?.state).toBe("pending");
    const after = library.act("@acme/doors", "1.2.0", { kind: "approve", by: REVIEWER, at: "2026-11-02T13:00:00Z" });
    expect(after).toMatchObject({ state: "approved", by: REVIEWER, at: "2026-11-02T13:00:00Z" });
  });

  it("a rejected add-on stays blocked, with the reason", async () => {
    const library = await installed();
    library.act("@acme/doors", "1.2.0", { kind: "reject", by: REVIEWER, at: "2026-11-02T13:00:00Z", reason: "We use our own door classes" });
    const opened = openWithOutsidePacks(model(library.pinsFor("@acme/doors", "1.2.0")), [], library.installed());
    expect(opened.set.packs).toEqual([]);
    expect(opened.needs[0]).toContain("was rejected in review: We use our own door classes.");
    expect(() => library.act("@acme/doors", "1.2.0", { kind: "approve", by: REVIEWER, at: "2026-11-02T14:00:00Z" })).toThrow("is rejected, not waiting for review");
  });
});
