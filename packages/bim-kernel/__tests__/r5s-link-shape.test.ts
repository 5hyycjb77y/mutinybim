/**
 * @jest-environment node
 *
 * The general link shape (foundation adjustments C1): a served-from link may
 * name its registry adapter and carry design keyed by adapter id. Readers
 * tolerate any adapter, trade and role (a pack's fire alarm `fa` link with an
 * `slc_loop` role loads and round-trips, walked by no adapter here). Writers
 * emit `adapter` / `design` only to peers advertising `links:design`; to an
 * older peer a link goes out in the old shape, or is refused in plain words
 * when the old shape can't say it.
 *
 * Fails on the old code: `ServiceLink` had no adapter or design, nothing
 * read `design.electrical`, and no writer reshaped a link for its peer.
 */
import { asElementId, runEditHooks, serviceLinkName, withUpgradePolicy, type BimElement, type ServiceLink } from "../src";
import { linkAdapter } from "../src/connections/model";
import { legacyLinkShape, linkAdapterId, linkDesign } from "../src/connections/types";
import { LINKS_DESIGN_FEATURE } from "../src/services/types";
import "../src/services/write-gate";
import { DrainageBuilding } from "./drainage-fixtures";

function link(extra: Partial<ServiceLink>): ServiceLink {
  return {
    kind: "service_link",
    id: asElementId("link-1"),
    version: 1,
    authoredRev: {},
    trade: "electrical",
    role: "branch",
    source: { elementId: asElementId("facp-1"), port: "out", positions: [] },
    members: [{ elementId: asElementId("smoke-1"), connector: "slc" }],
    description: "",
    ...extra,
  };
}

const FA = link({ adapter: "fa", role: "slc_loop" as ServiceLink["role"], design: { fa: { loop: 1, class: "A" } } });

describe("readers tolerate a pack's link", () => {
  it("a link with adapter 'fa' and role 'slc_loop' round-trips and reads its own design", () => {
    const json = JSON.stringify(FA);
    const back: ServiceLink = JSON.parse(json);
    expect(JSON.stringify(back)).toBe(json);
    expect(linkAdapterId(back)).toBe("fa");
    expect(linkDesign(back, "fa")).toEqual({ loop: 1, class: "A" });
    expect(linkAdapter(back)).toBeNull();
    expect(() => serviceLinkName({ [back.id]: back }, back)).not.toThrow();
  });

  it("legacy links read as before: adapter is the trade, and electrical design is found at top level or in design", () => {
    const old = link({ electrical: { ratingA: 20 } });
    expect(linkAdapterId(old)).toBe("electrical");
    expect(linkDesign(old, "electrical")).toEqual({ ratingA: 20 });
    expect(linkDesign(link({ design: { electrical: { ratingA: 30 } }, electrical: { ratingA: 20 } }), "electrical")).toEqual({ ratingA: 30 });
    expect(linkAdapter(old)?.trade).toBe("electrical");
  });
});

describe("writers emit the new shape only to peers advertising links:design", () => {
  const decide = (next: ServiceLink, advertised: boolean): BimElement | undefined => {
    const b = new DrainageBuilding();
    const working: Record<string, BimElement> = { ...b.head.elements, [next.id]: next };
    withUpgradePolicy((f) => advertised && f === LINKS_DESIGN_FEATURE, () => runEditHooks(b.head, working, [next.id]));
    return working[next.id];
  };

  it("to a peer without the feature, an electrical link's design goes out at top level, with no adapter or design", () => {
    const out = decide(link({ adapter: "electrical", design: { electrical: { ratingA: 20 } } }), false);
    expect(out).toEqual(link({ electrical: { ratingA: 20 } }));
    expect(out && "adapter" in out).toBe(false);
    expect(out && "design" in out).toBe(false);
  });

  it("to a peer with the feature, the new shape is kept", () => {
    const next = link({ adapter: "electrical", design: { electrical: { ratingA: 20 } } });
    expect(decide(next, true)).toEqual(next);
  });

  it("a pack adapter or other design to a peer without the feature is refused in plain words", () => {
    expect(() => decide(FA, false)).toThrow("This slc loop belongs to fa, which the model server this model is open on can't store yet; try again once the server is updated");
    expect(legacyLinkShape(link({ design: { plumbing: { gpm: 5 } } }))).toBe("This link's plumbing design can't be saved yet: the model server this model is open on is an older version; try again once the server is updated");
  });

  it("an untouched legacy link is left exactly as stored", () => {
    const old = link({ electrical: { ratingA: 20 } });
    expect(decide(old, false)).toBe(old);
  });
});
