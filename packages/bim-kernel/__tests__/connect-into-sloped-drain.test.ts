/**
 * @jest-environment node
 *
 * Nov 8 showcase: fixtures standing over a lower sloped drain (a 3" sanitary
 * branch 1 ft below the floor at 1/4" per ft) didn't connect: 3 of 8 were
 * refused. Water closets got no reason at all (a closet right over a sloped
 * drain had no way in), lavatories got "route the branch at that height" (a
 * waste over the drain, facing along it, was routed square into the side it
 * was already on). Both now drop into the drain's top, which a sloped drain
 * takes; what can't join says why and what to do.
 */
import { isConnectIntoRefusal, planConnectInto as planUnder, validateModel, withUpgradePolicy } from "../src";

/** Planned as a current model server decides it (every peer feature). */
const planConnectInto: typeof planUnder = (model, request) => withUpgradePolicy(() => true, () => planUnder(model, request));
import { FT, IN, K15Model, LAV, PVC, SA, SAN, WC } from "./k15-fixtures";

/** A 3" sanitary drain 1 ft below Level 1 at 1/4" per ft, along x at y = 6 ft, falling west. */
function toiletRoom(): K15Model {
  const m = new K15Model();
  m.ok({ type: "route_run", idPrefix: "drain", levelId: "lvl-1", domain: "pipe", size: PVC(3), elevationMm: -1 * FT, slopeInPerFt: 0.25, flow: "with_points", system: SAN, points: [{ x: 17 * FT, y: 6 * FT }, { x: 2 * FT, y: 6 * FT }] });
  const drain = m.seg("drain-s1");
  expect(drain.start.z - drain.end.z).toBeGreaterThan(IN);
  return m;
}

describe("fixtures over a lower sloped drain", () => {
  it("two water closets right over the drain drop into its top", () => {
    const m = toiletRoom();
    m.place("wc-1", WC, 4 * FT, 6 * FT, 0, "WC-1");
    m.place("wc-2", WC, 8 * FT, 6 * FT, 0, "WC-2");
    const plan = planConnectInto(m.head, { from: [{ elementId: "wc-1", port: "waste" }, { elementId: "wc-2", port: "waste" }], into: "drain-s1", idPrefix: "ci" });
    expect(plan.sources.filter(isConnectIntoRefusal)).toEqual([]);
    m.ok({ type: "connect_into", from: [{ elementId: "wc-1", port: "waste" }, { elementId: "wc-2", port: "waste" }], into: "drain-s1", idPrefix: "ci" });
    for (const id of ["wc-1", "wc-2"]) expect(m.part(id).links?.waste?.elementId).toMatch(/^ci-\d-s/);
    expect(validateModel(m.head)).toEqual([]);
  });

  it("a lavatory whose waste sits over the drain, facing along it, goes out and drops into its top", () => {
    const m = toiletRoom();
    // Turned so its wall-side waste faces along the drain, with the basin over the drain line.
    m.place("lav-1", LAV, 12 * FT, 6 * FT, 0, "L-1", 90);
    const answer = planConnectInto(m.head, { from: [{ elementId: "lav-1", port: "waste" }], into: "drain-s1", idPrefix: "ci" }).sources[0];
    expect(answer && isConnectIntoRefusal(answer) ? answer.refused : "joined").toBe("joined");
    m.ok({ type: "connect_into", from: [{ elementId: "lav-1", port: "waste" }], into: "drain-s1", idPrefix: "ci" });
    expect(m.part("lav-1").links?.waste?.elementId).toMatch(/^ci-1-s/);
    // Out of the basin, then straight down into the drain's top.
    const pieces = m.segs("ci-1-s");
    expect(pieces.some((seg) => Math.hypot(seg.end.x - seg.start.x, seg.end.y - seg.start.y) < 1 && seg.start.z - seg.end.z > FT)).toBe(true);
    expect(validateModel(m.head)).toEqual([]);
  });

  it("a closet over a sloped duct is refused in words that say what to do", () => {
    const m = new K15Model();
    m.ok({ type: "route_run", idPrefix: "sa", levelId: "lvl-1", domain: "duct", size: { shape: "round", diameter: 12 * IN }, elevationMm: -1 * FT, system: SA, points: [{ x: 0, y: 0 }, { x: 10 * FT, y: 0 }] });
    m.place("wc-1", WC, 4 * FT, 0, 0, "WC-1");
    const answer = planConnectInto(m.head, { from: [{ elementId: "wc-1", port: "waste" }], into: "nearest", idPrefix: "ci" }).sources[0];
    expect(answer && isConnectIntoRefusal(answer) ? answer.refused : "").toMatch(/No run of the same system/);
  });

  it("a refusal always carries its reason", () => {
    const m = toiletRoom();
    // A closet set into the floor below the drain: no way in, and it says so instead of stopping at "can't join".
    m.place("wc-low", WC, 6 * FT, 6 * FT, -3 * FT, "WC-LOW");
    const answer = planConnectInto(m.head, { from: [{ elementId: "wc-low", port: "waste" }], into: "drain-s1", idPrefix: "ci" }).sources[0];
    expect(answer && isConnectIntoRefusal(answer)).toBe(true);
    if (answer && isConnectIntoRefusal(answer)) expect(answer.refused).toMatch(/can't join the 3" PVC sanitary pipe: \S/);
  });
});
