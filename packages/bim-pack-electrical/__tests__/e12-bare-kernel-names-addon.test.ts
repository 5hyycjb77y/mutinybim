/**
 * @jest-environment node
 * @mutinybim-bare-kernel
 *
 * Round 12 lane E: a process without the Electrical add-on keeps a model's
 * feeder types, one-lines and circuit settings as stored and says which add-on
 * draws them, instead of guessing. Saving a feeder type is refused with
 * "This model uses Electrical, which isn't loaded here"; a stored record is
 * still listed under its type with its bytes unchanged; a one-line says
 * "This one-line is drawn by Electrical, which isn't loaded here"; plans draw
 * no circuit lines. Once the add-on is installed the same bytes save and draw.
 *
 * On round 11's code the kernel carried all three itself, so a bare kernel
 * saved feeder types and drew one-lines and circuit lines with no add-on.
 */
import { canonicalJson, catalogElementId, catalogRecords, commandSchema, diagramLayoutRow, layoutOneLine, viewGraphicsRows, DEFAULT_SETTINGS, GLOBAL_PARTITION, type BimElement, type ModelState, type OneLineSpec } from "@permitzip/bim-kernel";
import { installFirstPartyPacks, installedFirstPartyPacks } from "@permitzip/bim-kernel/packs";
import { ELECTRICAL_PACK } from "@permitzip/bim-pack-electrical";

const NOT_LOADED = "This model uses Electrical, which isn't loaded here";
const ONE_LINE_NOT_LOADED = "This one-line is drawn by Electrical, which isn't loaded here";

const F225 = { type: "feeder_type", mark: "F225", ratingA: 225, poles: 3, conductors: { sets: 1, phaseSize: "4/0", groundSize: "4", material: "cu" }, insulation: "THHN", conduit: null, conduitBelowGrade: null, description: "" };
const STORED: BimElement = { id: "etype:feeder:F225", kind: "service_catalog", version: 1, authoredRev: {}, partition: GLOBAL_PARTITION, trade: "electrical", entry: F225 } as BimElement;
const model: ModelState = { modelId: "bare", revision: 1 as ModelState["revision"], elements: { [STORED.id]: STORED }, connections: [], settings: DEFAULT_SETTINGS };
const SPEC: OneLineSpec = { roots: [{ id: "u", kind: "utility", name: "Utility", children: [{ id: "p", kind: "panelboard", name: "P1" }] }] };

const saveMessages = () => {
  const r = commandSchema.safeParse({ type: "save_catalog_entry", entry: F225 });
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

describe("e12: a bare kernel keeps Electrical's records and names the add-on", () => {
  it("starts with no first-party add-on", () => {
    expect(installedFirstPartyPacks()).toEqual([]);
  });

  it("keeps a stored feeder type as stored and refuses a new one by the add-on's name", () => {
    expect(catalogRecords(model, "feeder_type").map((r) => canonicalJson(r))).toEqual([canonicalJson({ id: STORED.id, entry: F225 })]);
    expect(saveMessages()).toEqual([NOT_LOADED]);
    expect(() => catalogElementId("feeder_type", "F225")).toThrow(NOT_LOADED);
  });

  it("says which add-on draws a one-line and draws no circuit lines", () => {
    expect(diagramLayoutRow("one_line")).toBeNull();
    expect(() => layoutOneLine(SPEC)).toThrow(ONE_LINE_NOT_LOADED);
    expect(viewGraphicsRows()).toEqual([]);
  });

  it("saves and draws the same bytes once the add-on is installed", () => {
    installFirstPartyPacks([ELECTRICAL_PACK]);
    const r = commandSchema.safeParse({ type: "save_catalog_entry", entry: F225 });
    expect(r.success).toBe(true);
    expect(catalogElementId("feeder_type", "F225")).toBe(STORED.id);
    expect(layoutOneLine(SPEC).nodes.map((n) => n.name)).toEqual(["Utility", "P1"]);
    expect(viewGraphicsRows().map((row) => row.hintsKey)).toEqual(["circuitGraphics"]);
  });
});
