/**
 * @jest-environment node
 * @mutinybim-bare-kernel
 *
 * Round 13 lane E, step 1: the connection type's load, voltage and load class
 * are Electrical's rows (`kernel.connection_field`), not the kernel's stored
 * schema. A bare kernel keeps a stored record's values as stored, reads no
 * electrical default and writes none on save; with Electrical loaded the same
 * record reads round 12's defaults (120 V, "other", 0 VA), a save writes round
 * 12's bytes, and an out-of-range value is refused in words.
 *
 * Fails on round 12's code: the kernel schema names `loadVa`, `voltage` and
 * `loadClass` with Electrical's defaults, so a bare save writes `voltage: 120`
 * and a bare read classes the load "kitchen"; and Electrical contributes no
 * connection field rows.
 */
import {
  DEFAULT_SETTINGS,
  GLOBAL_PARTITION,
  allocationClassOf,
  canonicalJson,
  catalogRecords,
  commandSchema,
  connectionFieldRow,
  connectionFieldValue,
  connectionTypeObjectSchema,
  executeCommand,
  type BimElement,
  type ModelState,
} from "@permitzip/bim-kernel";
import { installFirstPartyPacks, installedFirstPartyPacks } from "@permitzip/bim-kernel/packs";
import { ELECTRICAL_PACK } from "@permitzip/bim-pack-electrical";

/** A record round 12 stored (its schema had filled every field) and one written with no electrical fields at all. */
const FREEZER = { type: "connection_type", designator: "E.05", description: "Reach-in freezer", connection: "", loadVa: 1320, voltage: 208, poles: 1, loadClass: "kitchen", continuous: false, comments: "" };
const BARE_WC = { type: "connection_type", designator: "WC", trade: "plumbing", description: "Water closet", connection: "", poles: 1, continuous: false, comments: "", quantities: { dfu: 4 } };

const stored = (entry: { readonly designator: string; readonly trade?: string }): BimElement =>
  ({ id: `etype:connection:${entry.designator}`, kind: "service_catalog", version: 1, authoredRev: {}, partition: GLOBAL_PARTITION, trade: entry.trade ?? "electrical", entry }) as BimElement;

const model: ModelState = {
  modelId: "e13",
  revision: 1 as ModelState["revision"],
  elements: { "etype:connection:E.05": stored(FREEZER), "etype:connection:WC": stored(BARE_WC) },
  connections: [],
  settings: DEFAULT_SETTINGS,
};

/** The record a save leaves, as stored bytes. */
function saved(entry: Record<string, unknown>): string {
  const cmd = commandSchema.parse({ type: "save_connection_type", entry });
  const r = executeCommand(model, cmd);
  if (!r.ok) throw new Error(r.error.message);
  const el = r.model.elements[`etype:connection:${String(entry.designator)}`];
  if (el?.kind !== "service_catalog") throw new Error("not saved");
  return canonicalJson(el.entry);
}

function refusal(entry: Record<string, unknown>): string {
  const cmd = commandSchema.parse({ type: "save_connection_type", entry });
  const r = executeCommand(model, cmd);
  return r.ok ? "saved" : r.error.message;
}

describe("e13: the connection type's electrical fields come from Electrical's rows", () => {
  it("the kernel's stored schema names none of them", () => {
    expect(installedFirstPartyPacks()).toEqual([]);
    const shape = Object.keys(connectionTypeObjectSchema.shape);
    for (const key of ["loadVa", "voltage", "loadClass"]) expect(shape).not.toContain(key);
  });

  it("a bare kernel keeps stored values as stored and reads no electrical default", () => {
    expect(canonicalJson(catalogRecords(model, "connection_type").map((r) => r.entry))).toBe(canonicalJson([FREEZER, BARE_WC]));
    expect(connectionFieldRow("voltage")).toBeNull();
    expect(connectionFieldValue(FREEZER, "voltage")).toBe(208);
    expect(connectionFieldValue(BARE_WC, "voltage")).toBeNull();
    expect(connectionFieldValue(BARE_WC, "loadClass")).toBeNull();
    expect(allocationClassOf(model.elements, { connectionType: "E.05" })).toBeNull();
  });

  it("a bare save keeps what was sent and writes no electrical default", () => {
    expect(JSON.parse(saved({ designator: "P01", trade: "plumbing", quantities: { dfu: 5 } }))).toEqual({ type: "connection_type", designator: "P01", trade: "plumbing", description: "", connection: "", poles: 1, continuous: false, comments: "", quantities: { dfu: 5 } });
    expect(JSON.parse(saved({ designator: "E.07", loadVa: 500, loadClass: "kitchen" }))).toMatchObject({ loadVa: 500, loadClass: "kitchen" });
  });

  it("with Electrical loaded: round 12's defaults, round 12's bytes, refusals in words", () => {
    installFirstPartyPacks([ELECTRICAL_PACK]);
    expect([connectionFieldRow("loadVa")?.id, connectionFieldRow("voltage")?.id, connectionFieldRow("loadClass")?.id]).toEqual(["electrical.load_va", "electrical.voltage", "electrical.load_class"]);
    expect(connectionFieldValue(BARE_WC, "voltage")).toBe(120);
    expect(connectionFieldValue(BARE_WC, "loadClass")).toBe("other");
    expect(connectionFieldValue(BARE_WC, "loadVa")).toBe(0);
    expect(connectionFieldValue(FREEZER, "voltage")).toBe(208);
    expect(allocationClassOf(model.elements, { connectionType: "E.05" })).toBe("kitchen");
    // A plumbing record with no load is not matched by class (round 12: electrical, or a load above 0).
    expect(allocationClassOf(model.elements, { connectionType: "WC" })).toBeNull();
    // Round 12's schema wrote exactly these bytes for this command.
    expect(saved({ designator: "P01", trade: "plumbing", quantities: { dfu: 5 } })).toBe(
      canonicalJson({ type: "connection_type", designator: "P01", trade: "plumbing", description: "", connection: "", loadVa: 0, voltage: 120, poles: 1, loadClass: "other", continuous: false, comments: "", quantities: { dfu: 5 } }),
    );
    expect(refusal({ designator: "E.09", voltage: 4000 })).toBe("Connection type E.09: Voltage: must be more than 0 and at most 1000 V");
    expect(refusal({ designator: "E.09", loadClass: "toaster" })).toMatch(/^Connection type E\.09: Load class: must be one of lighting, receptacle/);
  });
});
