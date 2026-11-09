/**
 * @jest-environment node
 *
 * Round 14 lane K14 (Bedrock gap closed in this batch): stored diagram kinds
 * are open. An outside add-on registers its own diagram on the diagram layout
 * point and a view stores that kind, with zero kernel edits. Writers are
 * strict (a row in force must draw the kind, and every peer must read open
 * kinds); readers are tolerant (without the add-on the view keeps its bytes,
 * draws empty and names what is missing).
 *
 * Fails on round 13: the view schema listed four kinds, so `create_view` with
 * `zztray.tray` (or Mechanical's `air_schematic`) was refused by the schema.
 */
import {
  DIAGRAM_GRAPH_POINT,
  DIAGRAM_KINDS,
  DIAGRAM_LAYOUT_POINT,
  DIAGRAM_OPEN_KINDS_FEATURE,
  canonicalJson,
  diagramKindLabel,
  diagramKindStoreRefusal,
  evaluateDiagram,
  layoutRowFor,
  type DiagramGraphDef,
  type DiagramLayoutRow,
  type ModelState,
} from "../src";
import { PackSet, contribute, definePack, firstPartyStoredOwner, withPackSet } from "../src/packs";
import { twoLevels, type Policy } from "./a13a-fixtures";

const KIND = "zztray.tray";

const GRAPH: DiagramGraphDef = { kind: KIND, build: () => ({ roots: [], warnings: [], reads: [] }) };
const LAYOUT: DiagramLayoutRow = {
  kind: KIND,
  label: "Tray diagram",
  check: () => null,
  layout: () => ({ refused: "drawn from the model" }),
  layoutGraph: () => ({ items: [], extent: { min: { x: 0, y: 0 }, max: { x: 0, y: 0 } }, nodes: [] }),
};
const TRAY = definePack({ id: "zztray", name: "Test cable tray", version: "1.0.0", kernel: "^1.12.0" }, [contribute(DIAGRAM_GRAPH_POINT, [GRAPH]), contribute(DIAGRAM_LAYOUT_POINT, [LAYOUT])]);
const SET = PackSet.create([TRAY]);

const OLD_SERVER: Policy = (f) => f !== DIAGRAM_OPEN_KINDS_FEATURE;
const createTray = (viewId = "v-tray") => ({ type: "create_view", viewId, name: `Tray ${viewId}`, viewType: "detail", props: { diagram: { kind: KIND } } });
const storedKind = (m: ModelState, id: string): string | undefined => {
  const v = m.elements[id];
  return v?.kind === "view" ? v.props?.diagram?.kind : undefined;
};

describe("k14 stored diagram kinds are open", () => {
  it("an outside add-on's view stores its own kind and draws through its row", () => {
    const m = twoLevels("k14-kinds");
    withPackSet(SET, () => m.ok(createTray()));
    expect(storedKind(m.head, "v-tray")).toBe(KIND);
    withPackSet(SET, () => {
      expect(diagramKindLabel(KIND)).toBe("Tray diagram");
      const view = m.head.elements["v-tray"];
      if (view?.kind !== "view") throw new Error("no view");
      expect(evaluateDiagram(m.head.elements, view)?.kind).toBe(KIND);
    });
  });

  it("writers are strict: no row in force, or a peer that can't read open kinds, refuses in words", () => {
    const m = twoLevels("k14-kinds-strict");
    expect(m.refused(createTray())).toBe("No add-on in this model draws zztray.tray diagrams, so a view of one can't be made. Turn on the add-on that adds them, then try again.");
    expect(withPackSet(SET, () => m.refused(createTray(), OLD_SERVER))).toBe("Tray diagram views can't be saved yet: the model server this model is open on is an older version. Try again once it is updated.");
    expect(m.refused({ ...createTray(), props: { diagram: { kind: "Not A Kind" } } })).toMatch(/lower case words with underscores/);
  });

  it("Mechanical's air schematic (a first-party bare id) is stored through its row; a stored one names Mechanical as its owner", () => {
    expect(diagramKindLabel("air_schematic")).toBe("Air schematic");
    expect(diagramKindStoreRefusal("air_schematic", () => true)).toBeNull();
    const m = twoLevels("k14-kinds-air");
    m.ok({ type: "create_view", viewId: "v-air", name: "Air schematic", viewType: "detail", props: { diagram: { kind: "air_schematic" } } });
    expect(storedKind(m.head, "v-air")).toBe("air_schematic");
    expect(m.refused({ type: "create_view", viewId: "v-air-2", name: "Air schematic 2", viewType: "detail", props: { diagram: { kind: "air_schematic" } } }, OLD_SERVER)).toBe("Air schematic views can't be saved yet: the model server this model is open on is an older version. Try again once it is updated.");
    expect(firstPartyStoredOwner("diagram", "air_schematic")).toBe("mechanical");
  });

  it("the four round-5 kinds write as before, on every peer and with no row in force", () => {
    for (const kind of DIAGRAM_KINDS) expect(diagramKindStoreRefusal(kind, () => false)).toBeNull();
    const m = twoLevels("k14-kinds-old");
    m.ok({ type: "create_view", viewId: "v-one", name: "One-line", viewType: "detail", props: { diagram: { kind: "one_line" } } }, OLD_SERVER);
    expect(storedKind(m.head, "v-one")).toBe("one_line");
  });

  it("readers are tolerant: without the add-on the view keeps its bytes, draws empty, names what's missing, and still renames", () => {
    const m = twoLevels("k14-kinds-read");
    withPackSet(SET, () => m.ok(createTray()));
    const before = canonicalJson(m.head.elements["v-tray"]);
    const view = m.head.elements["v-tray"];
    if (view?.kind !== "view") throw new Error("no view");
    const errors = jest.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const ev = evaluateDiagram(m.head.elements, view);
      expect(ev?.items ?? []).toEqual([]);
      expect(errors).toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
    expect(layoutRowFor(KIND)).toEqual({ refused: "No add-on in this model lays out zztray.tray diagrams" });
    expect(diagramKindLabel(KIND)).toBe(KIND);
    expect(canonicalJson(m.head.elements["v-tray"])).toBe(before);
    m.ok({ type: "rename_view", viewId: "v-tray", name: "Tray, renamed" });
    m.ok({ type: "set_view_properties", viewId: "v-tray", props: { diagram: { kind: KIND, hints: { title: "Trays" } } } }, OLD_SERVER);
    expect(storedKind(m.head, "v-tray")).toBe(KIND);
  });
});
