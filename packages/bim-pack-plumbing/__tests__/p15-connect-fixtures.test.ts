/**
 * @jest-environment node
 *
 * P15 (round 15) step 1: Plumbing › Connect › To drain / To vent / To cold
 * water on the selection. The add-on names which of each fixture's
 * connectors a target means; the kernel's `connect_into` picks the nearest
 * run, the system's takeoff fitting (combination wye and 1/8 bend into a
 * level drain) and the slope, as one edit. Selecting four closets and
 * pressing To drain connects all four with one undo.
 *
 * Fails on round 14: the add-on had no Connect (`fixtureConnectRequest`
 * didn't exist) and starter closets had no vent connector.
 */
import { executeCommand, isConnectIntoRefusal, validateModel, withUpgradePolicy } from "@permitzip/bim-kernel";
import { FIXTURE_CONNECT_WORDS, fixtureConnectBlocked, fixtureConnectRequest, fixtureConnectSources, previewFixtureConnect } from "../src";
import { CLOSETS, FT, starter, toiletRoom } from "./p15-fixtures";

describe("Plumbing › Connect on four selected closets", () => {
  it("To drain: each waste, one combination wye and 1/8 bend each, all four in one edit, one undo puts it back", () => {
    const m = toiletRoom();
    const request = fixtureConnectRequest(m.head.elements, CLOSETS, "drain", "p15d");
    if (!request) throw new Error("no request");
    expect(request.from).toEqual(CLOSETS.map((elementId) => ({ elementId, port: "w" })));
    expect(request.into).toBe("nearest");
    const preview = previewFixtureConnect(m.head, CLOSETS, "drain", "p15d");
    if ("refused" in preview) throw new Error(preview.refused);
    expect(preview.joinable).toBe(4);
    expect(preview.lines[0]?.text).toMatch(/^WC-1 waste → Sanitary: .*Combination wye & 1\/8 bend/);
    expect(preview.lines[0]?.text).toMatch(/per ft/);
    const head = m.head;
    const before = m.log.length;
    m.ok({ type: "connect_into", ...request });
    expect(m.log.length).toBe(before + 1);
    for (const id of CLOSETS) expect(m.part(id).links?.w).toBeDefined();
    expect(m.takeoffsOn("san-s1").map((f) => f.family)).toEqual(Array(4).fill("dwv.combo_wye_eighth"));
    expect(validateModel(m.head)).toEqual([]);
    // Connected now: the same button says so instead of doing it twice.
    expect(fixtureConnectBlocked(m.head.elements, CLOSETS, "drain")).toBe(FIXTURE_CONNECT_WORDS.target.drain.allConnected);
    // One undo puts the room back as it was.
    const last = m.log[m.log.length - 1];
    if (!last) throw new Error("no changeset");
    m.ok({ type: "undo", revision: last.revision });
    expect(Object.keys(m.head.elements).sort()).toEqual(Object.keys(head.elements).sort());
    for (const id of CLOSETS) expect(m.part(id).links?.w).toBeUndefined();
  });

  it("To vent: each closet's vent rises into the vent main over it, one edit", () => {
    const m = toiletRoom({ withVent: true });
    expect(fixtureConnectSources(m.head.elements, CLOSETS, "vent")).toEqual(CLOSETS.map((elementId) => ({ elementId, port: "v" })));
    // Planned as the app plans it against a current model server (a branch from a run's underside is peer-gated).
    const preview = withUpgradePolicy(() => true, () => previewFixtureConnect(m.head, CLOSETS, "vent", "p15v"));
    if ("refused" in preview) throw new Error(preview.refused);
    const refusals = preview.plan.sources.filter(isConnectIntoRefusal).map((r) => r.refused);
    expect(refusals).toEqual([]);
    const request = fixtureConnectRequest(m.head.elements, CLOSETS, "vent", "p15v");
    if (!request) throw new Error("no request");
    m.ok({ type: "connect_into", ...request });
    for (const id of CLOSETS) expect(m.part(id).links?.v).toBeDefined();
    expect(validateModel(m.head)).toEqual([]);
  });

  it("To cold water: each closet's cold water into the cold water main behind it", () => {
    const m = toiletRoom({ withWater: true });
    const request = fixtureConnectRequest(m.head.elements, CLOSETS, "cold_water", "p15c");
    if (!request) throw new Error("no request");
    expect(request.from.map((s) => s.port)).toEqual(["cw", "cw", "cw", "cw"]);
    m.ok({ type: "connect_into", ...request });
    for (const id of CLOSETS) expect(m.part(id).links?.cw).toBeDefined();
  });

  it("says why it is off: nothing selected, nothing with that connection, and a refused source is named, the rest still connect", () => {
    const m = toiletRoom();
    expect(fixtureConnectBlocked(m.head.elements, [], "drain")).toBe(FIXTURE_CONNECT_WORDS.selectFirst);
    expect(fixtureConnectBlocked(m.head.elements, ["san-s1"], "drain")).toBe(FIXTURE_CONNECT_WORDS.selectFirst);
    expect(fixtureConnectBlocked(m.head.elements, CLOSETS, "hot_water")).toBe(FIXTURE_CONNECT_WORDS.target.hot_water.noneHave);
    // A closet far from any drain (300 ft away) is refused in words; the near one still joins.
    m.place("wc-far", starter("wc-flush-tank"), 300 * FT, 300 * FT, 0, "WC-9");
    const preview = previewFixtureConnect(m.head, ["wc-1", "wc-far"], "drain", "p15x");
    if ("refused" in preview) throw new Error(preview.refused);
    expect(preview.joinable).toBe(1);
    expect(preview.lines[1]?.ok).toBe(false);
    expect(preview.lines[1]?.text.length).toBeGreaterThan(10);
    const result = withUpgradePolicy(() => true, () => executeCommand(m.head, { type: "connect_into", from: preview.plan.sources.map((s) => s.source), into: "nearest", idPrefix: "p15x" }));
    if (!result.ok) throw new Error(result.error.message);
    expect(result.summary?.[0]).toBe("Connected 1 of 2; 1 not connected");
  });
});
