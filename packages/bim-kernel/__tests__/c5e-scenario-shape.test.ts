/**
 * @jest-environment node
 *
 * The scenario stored shape, reserved for round 6 (5c item b, FOUNDATION §7):
 * a combination, alternative or what-if reads here, a kind this release
 * doesn't know is kept, and every field it doesn't read survives a read and
 * write unchanged. Fails on the code before 5c: there was no shape, so a
 * round-6 peer's overlay had nothing to read it.
 */
import { canonicalJson } from "../src";
import { readScenarioOverlay, scenarioOverlayRecord } from "../src/requirements/scenario";

describe("scenario overlays", () => {
  it("a load combination reads as itself", () => {
    const raw = { scenario: { id: "lc-1", label: "1.2D + 1.6L", kind: "combination" }, terms: [{ ref: "struct.dead", factor: 1.2 }, { ref: "struct.live", factor: 1.6 }] };
    const r = readScenarioOverlay(raw);
    expect(r).toEqual({ ok: true, overlay: raw, knownKind: true });
  });

  it("a newer kind and newer fields are kept, and write back byte for byte", () => {
    const raw = {
      scenario: { id: "alt-2", label: "DOAS instead of ERV", kind: "option_set", owner: "mech" },
      overrides: [{ elementId: "rtu-1", values: { "mech.oa_cfm": 1200 }, note: "from the alt study" }],
      createdRev: 41,
      extra: { anything: true },
    };
    const r = readScenarioOverlay(raw);
    if (!r.ok) throw new Error(r.reason);
    expect(r.knownKind).toBe(false);
    expect(canonicalJson(scenarioOverlayRecord(r.overlay))).toBe(canonicalJson(raw));
  });

  it("refuses what isn't a scenario, saying why", () => {
    expect(readScenarioOverlay({ scenario: { id: "", label: "x", kind: "what_if" } })).toEqual({ ok: false, reason: "a scenario's id must be a non-empty string" });
    expect(readScenarioOverlay({ scenario: { id: "s", label: "x", kind: "what_if" }, terms: [{ ref: "a", factor: "big" }] })).toEqual({ ok: false, reason: "scenario s has a term that isn't { ref, factor }" });
    expect(readScenarioOverlay([1, 2])).toEqual({ ok: false, reason: "a scenario overlay must be an object" });
  });
});
