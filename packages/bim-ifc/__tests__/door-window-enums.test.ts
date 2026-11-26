/**
 * @jest-environment node
 *
 * A door's operation and a window's partitioning in IFC. The kernel stores
 * whatever text a person gives for either, so the exporter has to take any
 * of it: a value the IFC 4.3 ADD2 enumeration has is written as that value,
 * anything else as USERDEFINED with the person's words beside it, and
 * nothing stored there stops the export.
 *
 * Fails before the fix: free text stopped the whole export ("STEP
 * enumeration … must be upper case"), and an upper-case word the
 * enumeration doesn't have (POCKET) was written as if it were a member.
 */
import { asElementId, type BimElement, type ModelState } from "@permitzip/bim-kernel";
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import { ARCHITECTURE_PARAMETER_SET, DOOR_OPERATION_KEY, WINDOW_PARTITIONING_KEY } from "@permitzip/bim-pack-architecture";
import { importIfc, ownAttributes, type ReadEntity, type StepFile } from "../src";
import { twoLevels, type Log } from "../../bim-kernel/__tests__/a13a-fixtures";
import { hostModel } from "./i9-fixtures";
import { exported, ofType, text } from "./a13a-ifc-support";

/** IfcDoorTypeOperationEnum and IfcWindowTypePartitioningEnum of IFC4X3_ADD2, as IfcOpenShell 0.9.0 lists them. Kept apart from the exporter's own copy on purpose. */
const DOOR_OPERATION_ENUM = new Set(
  "DOUBLE_DOOR_DOUBLE_SWING DOUBLE_DOOR_FOLDING DOUBLE_DOOR_LIFTING_VERTICAL DOUBLE_DOOR_SINGLE_SWING DOUBLE_DOOR_SINGLE_SWING_OPPOSITE_LEFT DOUBLE_DOOR_SINGLE_SWING_OPPOSITE_RIGHT DOUBLE_DOOR_SLIDING DOUBLE_SWING_LEFT DOUBLE_SWING_RIGHT FOLDING_TO_LEFT FOLDING_TO_RIGHT LIFTING_HORIZONTAL LIFTING_VERTICAL_LEFT LIFTING_VERTICAL_RIGHT REVOLVING REVOLVING_VERTICAL ROLLINGUP SINGLE_SWING_LEFT SINGLE_SWING_RIGHT SLIDING_TO_LEFT SLIDING_TO_RIGHT SWING_FIXED_LEFT SWING_FIXED_RIGHT USERDEFINED NOTDEFINED".split(" "),
);
const WINDOW_PARTITIONING_ENUM = new Set("DOUBLE_PANEL_HORIZONTAL DOUBLE_PANEL_VERTICAL SINGLE_PANEL TRIPLE_PANEL_BOTTOM TRIPLE_PANEL_HORIZONTAL TRIPLE_PANEL_LEFT TRIPLE_PANEL_RIGHT TRIPLE_PANEL_TOP TRIPLE_PANEL_VERTICAL USERDEFINED NOTDEFINED".split(" "));

/** The choices the architecture pack offers for a parameter, read from the pack itself. */
function offered(key: string): readonly string[] {
  const choices = ARCHITECTURE_PARAMETER_SET.parameters.find((p) => p.key === key)?.choices;
  if (!choices || choices.length === 0) throw new Error(`the architecture pack offers no choices for ${key}`);
  return choices;
}

/** A named own attribute of an occurrence (8 shared attributes first) or of its type (9). */
function attr(e: ReadEntity | undefined, name: string): string | null {
  if (!e) throw new Error(`no entity to read ${name} from`);
  const i = ownAttributes(e.type).indexOf(name);
  if (i < 0) throw new Error(`${e.type} has no ${name}`);
  return text(e, (e.type.endsWith("TYPE") ? 9 : 8) + i);
}

const named = (file: StepFile, type: string, name: string): ReadEntity | undefined => ofType(file, type).find((e) => text(e, 2) === name);

let at = 0;
/** Two levels and one long wall to host the openings. */
function walled(name: string): Log {
  const m = twoLevels(name);
  m.ok({ type: "create_element", elementId: "w1", levelId: "L1", kind: "wall", size: { thicknessMm: 200, heightMm: 3000 }, placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 200_000, y: 0 } } });
  at = 0;
  return m;
}

/** A door or window by the kernel's own command, each 2 m further along the wall. */
function opening(m: Log, elementId: string, openingType: "door" | "window" | "cased_opening", extra: Readonly<Record<string, unknown>>): void {
  at += 2000;
  m.ok({ type: "create_hosted", elementId, kind: "opening", openingType, mark: elementId, hostId: "w1", s: at, side: 1, size: { widthMm: 900, heightMm: openingType === "window" ? 1200 : 2100 }, ...extra });
}

/** One door and one window stating the value themselves, and one of each taking it from a type. */
function fourWays(name: string, value: string): ModelState {
  const m = walled(name);
  m.ok({ type: "create_element_type", typeId: "dt", name: "Door type", forKinds: ["opening"], values: { [DOOR_OPERATION_KEY]: value } });
  m.ok({ type: "create_element_type", typeId: "wt", name: "Window type", forKinds: ["opening"], values: { [WINDOW_PARTITIONING_KEY]: value } });
  opening(m, "D1", "door", { values: { [DOOR_OPERATION_KEY]: value } });
  opening(m, "D2", "door", { typeId: "dt" });
  opening(m, "W1", "window", { values: { [WINDOW_PARTITIONING_KEY]: value } });
  opening(m, "W2", "window", { typeId: "wt" });
  return m.head;
}

/** A stored value no command would write (a record edited by hand, or one from an older file). */
function withValues(model: ModelState, elementId: string, values: Readonly<Record<string, unknown>>): ModelState {
  const el = model.elements[asElementId(elementId)];
  if (!el) throw new Error(`no ${elementId}`);
  return { ...model, elements: { ...model.elements, [el.id]: { ...el, values } as unknown as BimElement } };
}

beforeAll(() => installFirstPartyAddOns());

describe("every value the architecture pack offers is a member of the IFC enumeration", () => {
  it("door operations, on the door and on its type", () => {
    const operations = offered(DOOR_OPERATION_KEY);
    expect(operations.length).toBeGreaterThan(2);
    const m = walled("enum-door-offered");
    for (const op of operations) {
      opening(m, `D-${op}`, "door", { values: { [DOOR_OPERATION_KEY]: op } });
      m.ok({ type: "create_element_type", typeId: `dt-${op}`, name: `Type ${op}`, forKinds: ["opening"], values: { [DOOR_OPERATION_KEY]: op } });
      opening(m, `T-${op}`, "door", { typeId: `dt-${op}` });
    }
    const { file } = exported(m.head);
    expect(ofType(file, "IFCDOOR")).toHaveLength(operations.length * 2);
    expect(ofType(file, "IFCDOORTYPE")).toHaveLength(operations.length);
    for (const op of operations) {
      expect(DOOR_OPERATION_ENUM.has(op)).toBe(true);
      for (const e of [named(file, "IFCDOOR", `D-${op}`), named(file, "IFCDOOR", `T-${op}`), named(file, "IFCDOORTYPE", `Type ${op}`)]) {
        expect(attr(e, "OperationType")).toBe(op);
        expect(attr(e, "UserDefinedOperationType")).toBeNull();
      }
    }
  });

  it("window partitionings, on the window and on its type", () => {
    const partitionings = offered(WINDOW_PARTITIONING_KEY);
    expect(partitionings.length).toBeGreaterThan(2);
    const m = walled("enum-window-offered");
    for (const p of partitionings) {
      opening(m, `W-${p}`, "window", { values: { [WINDOW_PARTITIONING_KEY]: p } });
      m.ok({ type: "create_element_type", typeId: `wt-${p}`, name: `Type ${p}`, forKinds: ["opening"], values: { [WINDOW_PARTITIONING_KEY]: p } });
      opening(m, `T-${p}`, "window", { typeId: `wt-${p}` });
    }
    const { file } = exported(m.head);
    expect(ofType(file, "IFCWINDOW")).toHaveLength(partitionings.length * 2);
    expect(ofType(file, "IFCWINDOWTYPE")).toHaveLength(partitionings.length);
    for (const p of partitionings) {
      expect(WINDOW_PARTITIONING_ENUM.has(p)).toBe(true);
      for (const e of [named(file, "IFCWINDOW", `W-${p}`), named(file, "IFCWINDOW", `T-${p}`), named(file, "IFCWINDOWTYPE", `Type ${p}`)]) {
        expect(attr(e, "PartitioningType")).toBe(p);
        expect(attr(e, "UserDefinedPartitioningType")).toBeNull();
      }
    }
  });
});

describe("a value the IFC enumeration doesn't have", () => {
  const LONG = "Very long description ".repeat(15).trim();
  // Each is accepted by create_hosted and create_element_type today.
  it.each([
    ["free text", "Barn door"],
    ["an upper-case word that is not a member", "POCKET"],
    ["a dotted word", "A.B"],
    ["a member's name with spaces", "sliding to left"],
    ["text with an apostrophe", "Dutch 'stable' door"],
    ["text past 255 characters", LONG],
  ])("%s is written as USERDEFINED with the words kept, and the export finishes", (_case, value) => {
    const { file } = exported(fourWays("enum-free-text", value));
    const kept = value.slice(0, 255);
    for (const e of [named(file, "IFCDOOR", "D1"), named(file, "IFCDOOR", "D2"), named(file, "IFCDOORTYPE", "Door type")]) {
      expect(attr(e, "OperationType")).toBe("USERDEFINED");
      expect(attr(e, "UserDefinedOperationType")).toBe(kept);
    }
    for (const e of [named(file, "IFCWINDOW", "W1"), named(file, "IFCWINDOW", "W2"), named(file, "IFCWINDOWTYPE", "Window type")]) {
      expect(attr(e, "PartitioningType")).toBe("USERDEFINED");
      expect(attr(e, "UserDefinedPartitioningType")).toBe(kept);
    }
  });

  it("no door or window in the file names a value outside its enumeration", () => {
    for (const value of ["Barn door", "POCKET", "SINGLE_PANEL", "SLIDING_TO_LEFT", "pocket", "3"]) {
      const { file } = exported(fourWays("enum-members-only", value));
      for (const e of [...ofType(file, "IFCDOOR"), ...ofType(file, "IFCDOORTYPE")]) expect(DOOR_OPERATION_ENUM.has(attr(e, "OperationType") ?? "")).toBe(true);
      for (const e of [...ofType(file, "IFCWINDOWTYPE")]) expect(WINDOW_PARTITIONING_ENUM.has(attr(e, "PartitioningType") ?? "")).toBe(true);
      for (const e of [...ofType(file, "IFCWINDOW")]) expect(WINDOW_PARTITIONING_ENUM.has(attr(e, "PartitioningType") ?? "NOTDEFINED")).toBe(true);
    }
  });

  it("a member in another casing, or with spaces around it, is written as the member", () => {
    const m = walled("enum-casing");
    opening(m, "D1", "door", { values: { [DOOR_OPERATION_KEY]: "  sliding_to_left " } });
    opening(m, "W1", "window", { values: { [WINDOW_PARTITIONING_KEY]: "Single_Panel" } });
    const { file } = exported(m.head);
    expect(attr(named(file, "IFCDOOR", "D1"), "OperationType")).toBe("SLIDING_TO_LEFT");
    expect(attr(named(file, "IFCDOOR", "D1"), "UserDefinedOperationType")).toBeNull();
    expect(attr(named(file, "IFCWINDOW", "W1"), "PartitioningType")).toBe("SINGLE_PANEL");
    expect(attr(named(file, "IFCWINDOW", "W1"), "UserDefinedPartitioningType")).toBeNull();
  });
});

describe("a value of the wrong kind", () => {
  it("a window partitioning stated as a door's operation, and the other way round, is user-defined text", () => {
    const m = walled("enum-crossed-values");
    opening(m, "D1", "door", { values: { [DOOR_OPERATION_KEY]: "SINGLE_PANEL" } });
    opening(m, "W1", "window", { values: { [WINDOW_PARTITIONING_KEY]: "SLIDING_TO_LEFT" } });
    const { file } = exported(m.head);
    expect(attr(named(file, "IFCDOOR", "D1"), "OperationType")).toBe("USERDEFINED");
    expect(attr(named(file, "IFCDOOR", "D1"), "UserDefinedOperationType")).toBe("SINGLE_PANEL");
    expect(attr(named(file, "IFCWINDOW", "W1"), "PartitioningType")).toBe("USERDEFINED");
    expect(attr(named(file, "IFCWINDOW", "W1"), "UserDefinedPartitioningType")).toBe("SLIDING_TO_LEFT");
  });

  it("an operation on a window, a partitioning on a door and both on a cased opening are left out, free text or not", () => {
    for (const [op, part] of [
      ["SLIDING_TO_LEFT", "SINGLE_PANEL"],
      ["Barn door", "Two over two"],
    ] as const) {
      const m = walled("enum-crossed-keys");
      m.ok({ type: "create_element_type", typeId: "dt", name: "Door type", forKinds: ["opening"], values: { [WINDOW_PARTITIONING_KEY]: part } });
      m.ok({ type: "create_element_type", typeId: "wt", name: "Window type", forKinds: ["opening"], values: { [DOOR_OPERATION_KEY]: op } });
      opening(m, "D1", "door", { values: { [WINDOW_PARTITIONING_KEY]: part } });
      opening(m, "D2", "door", { typeId: "dt" });
      opening(m, "W1", "window", { values: { [DOOR_OPERATION_KEY]: op } });
      opening(m, "W2", "window", { typeId: "wt" });
      opening(m, "O1", "cased_opening", { values: { [DOOR_OPERATION_KEY]: op, [WINDOW_PARTITIONING_KEY]: part } });
      const { file } = exported(m.head);
      // A door that states no operation keeps the swing the plan draws; its type states none.
      for (const d of ["D1", "D2"]) expect(attr(named(file, "IFCDOOR", d), "OperationType")).toBe("SINGLE_SWING_LEFT");
      expect(attr(named(file, "IFCDOORTYPE", "Door type"), "OperationType")).toBe("NOTDEFINED");
      for (const w of ["W1", "W2"]) expect(attr(named(file, "IFCWINDOW", w), "PartitioningType")).toBeNull();
      expect(attr(named(file, "IFCWINDOWTYPE", "Window type"), "PartitioningType")).toBe("NOTDEFINED");
      for (const e of [...ofType(file, "IFCDOOR"), ...ofType(file, "IFCDOORTYPE")]) expect(attr(e, "UserDefinedOperationType")).toBeNull();
      for (const e of [...ofType(file, "IFCWINDOW"), ...ofType(file, "IFCWINDOWTYPE")]) expect(attr(e, "UserDefinedPartitioningType")).toBeNull();
    }
  });
});

describe("nothing stated, or a stored value that is not text", () => {
  it.each([
    ["an empty string", ""],
    ["only spaces", "   "],
    ["a number", 3],
    ["a boolean", true],
  ])("%s exports as nothing stated", (_case, value) => {
    const m = walled("enum-not-text");
    m.ok({ type: "create_element_type", typeId: "dt", name: "Door type", forKinds: ["opening"] });
    m.ok({ type: "create_element_type", typeId: "wt", name: "Window type", forKinds: ["opening"] });
    opening(m, "D1", "door", {});
    opening(m, "D2", "door", { typeId: "dt" });
    opening(m, "D3", "door", {});
    opening(m, "W1", "window", {});
    opening(m, "W2", "window", { typeId: "wt" });
    let model = m.head;
    model = withValues(model, "D1", { [DOOR_OPERATION_KEY]: value });
    model = withValues(model, "dt", { [DOOR_OPERATION_KEY]: value });
    model = withValues(model, "D3", { [DOOR_OPERATION_KEY]: value, "architecture.door_handing": "RH" });
    model = withValues(model, "W1", { [WINDOW_PARTITIONING_KEY]: value });
    model = withValues(model, "wt", { [WINDOW_PARTITIONING_KEY]: value });
    const { file } = exported(model);
    for (const d of ["D1", "D2"]) expect(attr(named(file, "IFCDOOR", d), "OperationType")).toBe("SINGLE_SWING_LEFT");
    expect(attr(named(file, "IFCDOOR", "D3"), "OperationType")).toBe("SINGLE_SWING_RIGHT");
    expect(attr(named(file, "IFCDOORTYPE", "Door type"), "OperationType")).toBe("NOTDEFINED");
    for (const w of ["W1", "W2"]) expect(attr(named(file, "IFCWINDOW", w), "PartitioningType")).toBeNull();
    expect(attr(named(file, "IFCWINDOWTYPE", "Window type"), "PartitioningType")).toBe("NOTDEFINED");
    for (const e of [...ofType(file, "IFCDOOR"), ...ofType(file, "IFCDOORTYPE")]) expect(attr(e, "UserDefinedOperationType")).toBeNull();
    for (const e of [...ofType(file, "IFCWINDOW"), ...ofType(file, "IFCWINDOWTYPE")]) expect(attr(e, "UserDefinedPartitioningType")).toBeNull();
  });
});

describe("read back", () => {
  it.each(["SLIDING_TO_LEFT", "Barn door"])("a file whose doors and windows state %s brings each door and window in again, in its wall", (value) => {
    const { text: ifc } = exported(fourWays("enum-read-back", value));
    const plan = importIfc(ifc, { model: hostModel(), referenceId: "ref", sourceKey: "v1", sourceId: "v1", label: "Round trip", disciplines: ["architecture"] });
    const walls = new Set(plan.records.filter((r) => r.kind === "wall").map((w) => w.id));
    const openings = plan.records.flatMap((r) => (r.kind === "opening" ? [r] : []));
    expect(openings.map((o) => `${o.openingType} ${o.mark}`).sort()).toEqual(["door D1", "door D2", "window W1", "window W2"]);
    for (const o of openings) expect(walls.has(o.hostId)).toBe(true);
    // The reader takes neither attribute today, listed or user-defined: what comes back is the same for both.
    for (const o of openings) expect(o.values?.[DOOR_OPERATION_KEY] ?? o.values?.[WINDOW_PARTITIONING_KEY]).toBeUndefined();
  });
});
