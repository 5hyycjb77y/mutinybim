/**
 * @jest-environment node
 *
 * Round 14 wave 0: the contracts lanes K14, A14, M14, X14 and P14 build
 * against (contract 1.12.0). The add-on library rows point is known to the
 * conformance suite at version 1, refuses malformed rows in words and is
 * read, keyed by the add-on, with no kernel edit. Behaviour the lanes own
 * started as "isn't built yet" stubs; each now answers (K14 layout rows, A14
 * rated index, P14 insert on a run), and library add-on rows are advertised.
 *
 * Fails on round 13's code: the point, the readers and the features don't
 * exist, and the contract is 1.11.0.
 */
import {
  KNOWN_POINTS,
  LIBRARY_ADDON_ROWS_FEATURE,
  LIBRARY_ROWS_POINT,
  PACK_CONTRACT_VERSION,
  PackSet,
  ROUTING_INSERT_PART_FEATURE,
  ROUTING_TAP_OFFSET_FEATURE,
  contribute,
  definePack,
  insertPartOnRun,
  isPackRefusal,
  layoutRowFor,
  libraryRowsOf,
  ratedSegmentsNear,
  runPackConformance,
  withPackSet,
  type Pack,
} from "../src";
import { DIAGRAM_OPEN_KINDS_FEATURE, type ElementId } from "@permitzip/bim-kernel";
import { CLIENT_FEATURES, PROTOCOL_FEATURES, SERVER_FEATURES } from "@permitzip/bim-sync";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";

const TEST_KERNEL = "^1.12.0";

function outside(id: string, contributions: Pack["contributions"]): Pack {
  return definePack({ id, name: id.toUpperCase(), version: "1.0.0", kernel: TEST_KERNEL }, contributions);
}

const model = createDemoModel("r14-wave0");

describe("r14 wave 0 contracts", () => {
  it("is contract 1.12 or later and the conformance suite knows the library rows point at version 1", () => {
    const [major, minor] = PACK_CONTRACT_VERSION.split(".").map(Number);
    expect(major === 1 && (minor ?? 0) >= 12).toBe(true);
    const ids = new Map(KNOWN_POINTS.map((p) => [p.id, p.version] as const));
    expect(ids.get("kernel.library_rows")).toBe(1);
  });

  it("an outside add-on's library rows pass conformance and are read keyed by the add-on", () => {
    const pack = outside("zz", [
      contribute(LIBRARY_ROWS_POINT, [
        { section: "fields", item: { id: "zz:field:zz.skylight.curb_height", revision: 1, key: "curb_height", label: "Curb height", appliesTo: ["zz.skylight"], valueType: "quantity", kind: "length", unit: "in", editable: true, storage: { kind: "values" } } },
        { section: "scheduleTemplates", item: { id: "zz:schedule:skylights", revision: 1, name: "Skylight schedule", appliesTo: ["zz.skylight"], definition: {} } },
      ]),
    ]);
    expect(runPackConformance(pack).problems).toEqual([]);
    expect(libraryRowsOf().map((g) => g.packId)).not.toContain("zz");
    withPackSet(PackSet.create([pack]), () => {
      const groups = libraryRowsOf();
      // Installed first-party add-ons' rows come first; the outside add-on's are its own group, last.
      expect(groups.map((g) => g.packId).at(-1)).toBe("zz");
      expect(groups.at(-1)?.rows.map((r) => `${r.section} ${r.item.id}`)).toEqual(["fields zz:field:zz.skylight.curb_height", "scheduleTemplates zz:schedule:skylights"]);
    });
  });

  it("malformed library rows are refused in words", () => {
    const bad = outside("yy", [contribute(LIBRARY_ROWS_POINT, [{ section: "widgets" as never, item: { id: "yy:widget:a" } }])]);
    expect(runPackConformance(bad).problems.join("\n")).toMatch(/"widgets" isn't a library section/);
    // Ids and duplicates are refused when the add-on is defined, before any reader sees it.
    expect(() =>
      outside("yy", [
        contribute(LIBRARY_ROWS_POINT, [
          { section: "fields" as const, item: { id: "not an id" } },
          { section: "fields" as const, item: { id: "yy:field:b" } },
          { section: "fields" as const, item: { id: "yy:field:b" } },
        ]),
      ]),
    ).toThrow(/id "not an id" is not a registry id[\s\S]*"yy:field:b" is contributed twice/);
  });

  it("the new features are declared and advertised by both peers once the owning lanes read them", () => {
    expect(PROTOCOL_FEATURES.libraryAddonRows).toBe(LIBRARY_ADDON_ROWS_FEATURE);
    expect(PROTOCOL_FEATURES.routingTapOffset).toBe(ROUTING_TAP_OFFSET_FEATURE);
    expect(PROTOCOL_FEATURES.routingInsertPart).toBe(ROUTING_INSERT_PART_FEATURE);
    expect(PROTOCOL_FEATURES.diagramsOpenKinds).toBe(DIAGRAM_OPEN_KINDS_FEATURE);
    // K14: the library joins add-on rows after the kernel's own.
    // K14 stores `HostedOn.t` and M14's screens read it; P14's insertPartOnRun is built (existing commands, one batch).
    // K14: a view stores any kind an add-on's layout row draws (reader: the kind-id schema; writer: checkDiagramKindPatch).
    for (const feature of [LIBRARY_ADDON_ROWS_FEATURE, ROUTING_TAP_OFFSET_FEATURE, ROUTING_INSERT_PART_FEATURE, DIAGRAM_OPEN_KINDS_FEATURE]) {
      expect(SERVER_FEATURES).toContain(feature);
      expect(CLIENT_FEATURES).toContain(feature);
    }
  });

  it("behaviour the lanes own is built: each answers, and refuses in its own words, never 'isn't built yet'", () => {
    // K14 (k14-piping-layout-from-addon): a kind no add-on draws refuses in words.
    const layout = layoutRowFor("zz_unknown_diagram");
    expect(isPackRefusal(layout) ? layout.refused : "built").toMatch(/^No add-on in this model lays out zz_unknown_diagram diagrams/);
    // A14 (a14-rated-wall-not-bounding-seen): a rating kind an add-on gives answers walls near the box; an unknown one refuses.
    const box = { minX: 0, minY: 0, maxX: 1000, maxY: 1000 };
    expect(isPackRefusal(ratedSegmentsNear(model, "L1" as ElementId, box, "fire_resistance"))).toBe(false);
    const unknown = ratedSegmentsNear(model, "L1" as ElementId, box, "zz_rating");
    expect(isPackRefusal(unknown) ? unknown.refused : "built").toBe("No add-on in force gives the rating kind zz_rating");
    // P14: a run the model doesn't have refuses by name.
    const insert = insertPartOnRun(model, { runId: "r-1" as ElementId, atMm: 500, partDefinitionId: "zz.cleanout" });
    expect(isPackRefusal(insert) ? insert.refused : "built").toBe("There is no run r-1 in the model");
    for (const answer of [layout, unknown, insert]) expect(isPackRefusal(answer) ? answer.refused : "").not.toMatch(/isn't built yet/);
  });
});
