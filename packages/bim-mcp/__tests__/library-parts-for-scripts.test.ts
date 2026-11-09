/**
 * @jest-environment node
 *
 * The open tool server hands a script run the parts the host's own library
 * offers (`library().partTypes()`), by placement type id, for the ids the
 * script's `reads.partTypes` name. The server holds no parts of its own.
 */
import { definitionTypes, exampleFloorDrain, exampleRooftopUnit, type PartTypeDefinition } from "@permitzip/bim-kernel";

/** A part with no types table: it places under its item key. */
const plain = (def: PartTypeDefinition): PartTypeDefinition => {
  const { model: _model, ...rest } = def;
  return rest;
};
import type { StoredPartTypeItem } from "../src/host";
import { libraryPartTypesFor } from "../src/scripts/library-parts";

const item = (key: string, definition: unknown): StoredPartTypeItem => ({ scope: "firm", body: { id: `item-${key}`, key, name: key, revision: 1, definition } as unknown as StoredPartTypeItem["body"] });

describe("library parts for a script run", () => {
  const items = [item("lib.floor-drain-3", plain(exampleFloorDrain())), item("lib.rtu-10", plain(exampleRooftopUnit()))];

  it("gives the named ids their definitions, under the key a placement uses", () => {
    expect(Object.keys(libraryPartTypesFor(items, ["lib.floor-drain-*"]))).toEqual(["lib.floor-drain-3"]);
    expect(Object.keys(libraryPartTypesFor(items, ["lib.*"])).sort()).toEqual(["lib.floor-drain-3", "lib.rtu-10"]);
  });

  it("a part model with a types table places one type per row, under the ids the part library gives them", () => {
    const drain = exampleFloorDrain();
    const ids = definitionTypes(drain).map((t) => t.typeId);
    expect(Object.keys(libraryPartTypesFor([item("ignored-key", drain)], ["*"])).sort()).toEqual([...ids].sort());
  });

  it("names nothing: nothing rides along", () => {
    expect(libraryPartTypesFor(items, [])).toEqual({});
  });

  it("an item whose definition no longer parses is left out, and says so", () => {
    const errors = jest.spyOn(console, "error").mockImplementation(() => undefined);
    expect(libraryPartTypesFor([item("lib.broken", { typeName: 3 })], ["lib.*"])).toEqual({});
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("leaving it out"), expect.objectContaining({ id: "item-lib.broken" }));
    errors.mockRestore();
  });
});
