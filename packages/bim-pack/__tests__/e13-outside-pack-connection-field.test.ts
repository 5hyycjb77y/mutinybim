/**
 * @jest-environment node
 *
 * Round 13 lane E: an add-on that isn't first-party adds its own field to the
 * shared connection type with zero kernel edits. A test fire-alarm add-on
 * contributes `candela` (`kernel.connection_field`); the kernel reads it, keeps
 * it on save, checks it by the add-on's row and refuses a bad value in words;
 * a record stored before the add-on existed keeps its bytes.
 *
 * Fails on round 12's code: there is no connection field point, and the
 * kernel's connection type schema drops any field it doesn't name, so
 * `candela` never reaches the stored record.
 */
import {
  CONNECTION_FIELD_POINT,
  PackSet,
  contribute,
  definePack,
  runPackConformance,
  withPackSet,
  type ConnectionFieldRow,
  type Pack,
} from "../src";
import {
  DEFAULT_SETTINGS,
  GLOBAL_PARTITION,
  canonicalJson,
  catalogRecords,
  commandSchema,
  connectionFieldRows,
  connectionFieldValue,
  executeCommand,
  withConnectionFieldDefaults,
  type BimElement,
  type ModelState,
} from "@permitzip/bim-kernel";
import { ELECTRICAL_PACK } from "@permitzip/bim-pack-electrical";

const CANDELA: ConnectionFieldRow = {
  id: "fa.candela",
  label: "Candela",
  key: "candela",
  valueType: "number",
  unit: "cd",
  defaultValue: null,
  check: (v) => (typeof v === "number" && [15, 30, 75, 95, 110, 135, 185].includes(v) ? null : "pick a listed rating (15, 30, 75, 95, 110, 135 or 185 cd)"),
};

const FIRE_ALARM: Pack = definePack({ id: "fa", name: "Fire alarm (test)", version: "1.0.0", kernel: "^1.11.0" }, [contribute(CONNECTION_FIELD_POINT, [CANDELA])]);

/** Saved in round 12 by its own schema: every field filled, no candela. */
const OLD = { type: "connection_type", designator: "E.05", description: "Reach-in freezer", connection: "", loadVa: 1320, voltage: 120, poles: 1, loadClass: "kitchen", continuous: false, comments: "" };
const model: ModelState = {
  modelId: "e13-fa",
  revision: 1 as ModelState["revision"],
  elements: { "etype:connection:E.05": { id: "etype:connection:E.05", kind: "service_catalog", version: 1, authoredRev: {}, partition: GLOBAL_PARTITION, trade: "electrical", entry: OLD } as BimElement },
  connections: [],
  settings: DEFAULT_SETTINGS,
};

function save(entry: Record<string, unknown>): { readonly entry?: Record<string, unknown>; readonly refused?: string } {
  const r = executeCommand(model, commandSchema.parse({ type: "save_connection_type", entry }));
  if (!r.ok) return { refused: r.error.message };
  const el = r.model.elements[`etype:connection:${String(entry.designator)}`];
  return el?.kind === "service_catalog" ? { entry: { ...el.entry } } : {};
}

const SET = PackSet.create([ELECTRICAL_PACK, FIRE_ALARM]);

describe("e13: an outside add-on adds a connection field with no kernel edit", () => {
  it("passes conformance", () => {
    expect(runPackConformance(FIRE_ALARM).problems).toEqual([]);
  });

  it("the kernel reads, keeps and checks candela through the point", () => {
    withPackSet(SET, () => {
      expect(connectionFieldRows().map((r) => r.id)).toEqual(expect.arrayContaining(["electrical.load_va", "fa.candela"]));
      expect(connectionFieldValue({ candela: 75 }, "candela")).toBe(75);
      expect(connectionFieldValue({}, "candela")).toBeNull();
      const s = save({ designator: "FA-S", description: "Strobe", candela: 75 });
      expect(s.entry).toMatchObject({ designator: "FA-S", candela: 75, loadVa: 0, voltage: 120, loadClass: "other" });
      expect(save({ designator: "FA-S", candela: 60 }).refused).toBe("Connection type FA-S: Candela: pick a listed rating (15, 30, 75, 95, 110, 135 or 185 cd)");
      // A null default writes nothing: a record that never named candela doesn't gain it.
      expect(save({ designator: "E.06" }).entry).not.toHaveProperty("candela");
    });
  });

  it("an old record keeps its bytes", () => {
    withPackSet(SET, () => {
      expect(withConnectionFieldDefaults(OLD)).toBe(OLD);
      expect(canonicalJson(catalogRecords(model, "connection_type").map((r) => r.entry))).toBe(canonicalJson([OLD]));
    });
  });

  it("without the add-on a stored candela is kept as stored and not checked", () => {
    withPackSet(PackSet.create([ELECTRICAL_PACK]), () => {
      expect(save({ designator: "FA-S", candela: 60 }).entry).toMatchObject({ candela: 60 });
    });
  });
});
