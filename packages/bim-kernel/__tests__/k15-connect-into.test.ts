/**
 * @jest-environment node
 *
 * K4 (round 15): `connect_into` joins one or many fixtures, terminals or open
 * ends into a chosen run, or the nearest run of the same system, as one edit.
 * The takeoff is the system's own fitting choice (the plumbing add-on's
 * defaults: combination wye and 1/8 bend into a level drain, sanitary tee into
 * a stack), the slope is the system's rule, an air device's neck gets flex.
 * Round 14 had no such command: contract 1.13.0 refused every request with
 * "Connect into isn't built yet".
 */
import { CONNECT_INTO_NOT_BUILT, ROUTING_CONNECT_INTO_FEATURE, executeCommand, isConnectIntoRefusal, planConnectInto, validateModel, withUpgradePolicy, type ConnectIntoSourcePlan } from "../src";
import { CW, DIFFUSER, FT, IN, K15Model, LAV, PVC, SA, SAN, WC } from "./k15-fixtures";

/** A 4" sanitary branch 2 ft below Level 1, along x at y = 0, and three closets 3 ft north of it. */
function toiletRoom(): K15Model {
  const m = new K15Model();
  m.ok({ type: "route_run", idPrefix: "main", levelId: "lvl-1", domain: "pipe", size: PVC(4), elevationMm: -2 * FT, system: SAN, points: [{ x: -10 * FT, y: 0 }, { x: 30 * FT, y: 0 }] });
  m.place("wc-1", WC, 0, 3 * FT, 0, "WC-1");
  m.place("wc-2", WC, 8 * FT, 3 * FT, 0, "WC-2");
  m.place("wc-3", WC, 16 * FT, 3 * FT, 0, "WC-3");
  return m;
}

const wastes = ["wc-1", "wc-2", "wc-3"].map((elementId) => ({ elementId, port: "waste" }));

describe("connect fixtures to the drain", () => {
  it("three closets into the nearest sanitary run: three combination wyes, slopes kept, one edit", () => {
    const m = toiletRoom();
    const before = m.log.length;
    m.ok({ type: "connect_into", from: wastes, into: "nearest", idPrefix: "ci" });
    expect(m.log.length).toBe(before + 1);
    for (const id of ["wc-1", "wc-2", "wc-3"]) expect(m.part(id).links?.waste?.elementId).toMatch(/^ci-\d-s/);
    const takeoffs = m.takeoffsOn("main-s1");
    expect(takeoffs.map((f) => f.family)).toEqual(["dwv.combo_wye_eighth", "dwv.combo_wye_eighth", "dwv.combo_wye_eighth"]);
    // Each arm falls towards the main.
    for (const n of [1, 2, 3]) {
      const level = m.segs(`ci-${n}-s`).find((s) => Math.hypot(s.end.x - s.start.x, s.end.y - s.start.y) > 1);
      if (!level) throw new Error(`arm ${n} has no level piece`);
      const towardMain = level.start.y > level.end.y ? level.start.z - level.end.z : level.end.z - level.start.z;
      expect(towardMain).toBeGreaterThan(0);
    }
    expect(validateModel(m.head)).toEqual([]);
  });

  it("the plan names each source's fittings and slope, and changes nothing", () => {
    const m = toiletRoom();
    const head = m.head;
    const plan = planConnectInto(m.head, { from: wastes, into: "main-s1", idPrefix: "ci" });
    expect(m.head).toBe(head);
    expect(plan.sources.every((s) => !isConnectIntoRefusal(s))).toBe(true);
    const first = plan.sources[0] as ConnectIntoSourcePlan;
    expect(first.intoRunId).toBe("main-s1");
    expect(first.fittings.map((f) => f.label)).toContain("Combination wye & 1/8 bend");
    expect(first.slope?.ratio).toBeGreaterThan(0);
    expect(first.flex).toBeNull();
    expect(plan.commands).toHaveLength(1);
    expect(plan.commands[0]?.type).toBe("batch_edits");
  });

  it("a source that can't join is named with the reason; the others still connect", () => {
    const m = toiletRoom();
    const plan = planConnectInto(m.head, { from: [...wastes, { elementId: "wc-1", port: "cw" }], into: "nearest", idPrefix: "ci" });
    const refused = plan.sources.filter(isConnectIntoRefusal);
    expect(refused).toHaveLength(1);
    expect(refused[0]?.refused).toMatch(/WC-1's cold water.*No run of the same system is within 100 ft|No run of the same system is within 100 ft of WC-1's cold water/);
    const r = withUpgradePolicy(() => true, () => executeCommand(m.head, { type: "connect_into", from: [...wastes, { elementId: "wc-1", port: "cw" }], into: "nearest", idPrefix: "ci" }));
    if (!r.ok) throw new Error(r.error.message);
    expect(r.summary?.[0]).toBe("Connected 3 of 4; 1 not connected");
    expect(r.summary?.[1]).toMatch(/cold water/);
  });

  it("nothing can join: refused in words, nothing built", () => {
    const m = toiletRoom();
    expect(m.refused({ type: "connect_into", from: [{ elementId: "wc-1", port: "cw" }], into: "nearest", idPrefix: "ci" })).toMatch(/No run of the same system/);
    expect(m.refused({ type: "connect_into", from: [{ elementId: "wc-1", port: "waste" }], into: "nope", idPrefix: "ci" })).toMatch(/There is no straight run nope/);
  });

  it("a model server that doesn't read connect-into yet: refused in words, nothing built", () => {
    const m = toiletRoom();
    expect(m.refused({ type: "connect_into", from: wastes, into: "nearest", idPrefix: "ci" }, (f) => f !== ROUTING_CONNECT_INTO_FEATURE)).toMatch(/older version/);
  });

  it("a closet already connected is named as connected", () => {
    const m = toiletRoom();
    m.ok({ type: "connect_into", from: [wastes[0] ?? { elementId: "wc-1", port: "waste" }], into: "nearest", idPrefix: "a" });
    const plan = planConnectInto(m.head, { from: wastes, into: "nearest", idPrefix: "b" });
    expect(plan.sources[0] && isConnectIntoRefusal(plan.sources[0]) && plan.sources[0].refused).toMatch(/already connected/);
  });

  it("a cold water connector into a cold water main of its own system takes the system's tee", () => {
    const m = toiletRoom();
    m.ok({ type: "route_run", idPrefix: "cwm", levelId: "lvl-1", domain: "pipe", size: { shape: "pipe", nominalMm: 1.5 * IN, material: "copper" }, elevationMm: 300, system: CW, points: [{ x: -1 * FT, y: -6 * FT }, { x: -1 * FT, y: 12 * FT }] });
    m.ok({ type: "connect_into", from: [{ elementId: "wc-1", port: "cw" }], into: "nearest", idPrefix: "cw" });
    expect(m.part("wc-1").links?.cw).toBeDefined();
    expect(m.takeoffsOn("cwm-s1")).toHaveLength(1);
  });
});

describe("into a stack", () => {
  it("a lavatory's waste into a sanitary stack takes the system's sanitary tee", () => {
    const m = new K15Model();
    m.place("lav", LAV, 0, 0, 0, "LAV-1");
    m.ok({ type: "route_run", idPrefix: "stk", levelId: "lvl-1", domain: "pipe", size: PVC(3), elevationMm: -600, system: SAN, points: [{ x: 0, y: 3 * FT, elevationMm: 2400 }] });
    m.ok({ type: "connect_into", from: [{ elementId: "lav", port: "waste" }], into: "stk-s1", idPrefix: "ci" });
    expect(m.part("lav").links?.waste).toBeDefined();
    expect(m.takeoffsOn("stk-s1").map((f) => f.family)).toEqual(["dwv.sanitary_tee"]);
  });
});

describe("an air device into a duct", () => {
  it("a diffuser 5 ft from a supply trunk: a tap, a short rigid piece and flex into its neck", () => {
    const m = new K15Model();
    m.ok({ type: "route_run", idPrefix: "trunk", levelId: "lvl-1", domain: "duct", size: { shape: "rect", width: 14 * IN, height: 10 * IN }, elevationMm: 10 * FT, system: SA, points: [{ x: 0, y: 0 }, { x: 30 * FT, y: 0 }] });
    m.place("sd", DIFFUSER, 10 * FT, 5 * FT, 8 * FT, "SD-1");
    const plan = planConnectInto(m.head, { from: [{ elementId: "sd", port: "neck" }], into: "nearest", idPrefix: "ci" });
    const answer = plan.sources[0];
    if (!answer || isConnectIntoRefusal(answer)) throw new Error(answer?.refused ?? "no answer");
    expect(answer.flex?.lengthMm).toBeGreaterThan(300);
    m.ok({ type: "connect_into", from: [{ elementId: "sd", port: "neck" }], into: "nearest", idPrefix: "ci" });
    expect(m.part("sd").links?.neck?.elementId).toBe("ci-1-flex");
    expect(m.takeoffsOn("trunk-s1")).toHaveLength(1);
  });
});

it("the placeholder's refusal is not returned any more", () => {
  const m = toiletRoom();
  const plan = planConnectInto(m.head, { from: wastes, into: "nearest", idPrefix: "ci" });
  expect(plan.sources.some((s) => isConnectIntoRefusal(s) && s.refused === CONNECT_INTO_NOT_BUILT)).toBe(false);
});
