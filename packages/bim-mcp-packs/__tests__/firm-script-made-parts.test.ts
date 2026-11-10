/**
 * @jest-environment node
 *
 * bim_place_part with from_firm_library resolves a part type a script made
 * and saved to the firm library under its key (`acme.furn.desk-60x30`), not
 * only a drawn part found by its model id. Fails on the code before this
 * change: the lookup asked the library for the type id's first segment
 * (`acme`) only, so a script-made firm part the library listed was refused
 * as "No size … in the firm library".
 */
import { builtinPartType, definitionTypes, type PartTypeDefinition } from "@permitzip/bim-kernel";
import type { FirmPartEntry, FirmPartsSource } from "../src/parts/capabilities";
import { firmSizesFor } from "../src/parts/parts";

function definition(): PartTypeDefinition {
  const entry = builtinPartType("builtin:supply-diffuser-24@1");
  if (!entry) throw new Error("the built-in diffuser is missing");
  return entry.definition;
}

function store(entries: Record<string, FirmPartEntry>): FirmPartsSource & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async get(id) {
      asked.push(id);
      return entries[id] ?? null;
    },
  };
}

describe("firmSizesFor", () => {
  it("places a script-made firm part saved under its whole type id", async () => {
    const def = definition();
    const lib = store({ "acme.furn.desk-60x30": { definition: def, typeId: "acme.furn.desk-60x30" } });
    const sizes = await firmSizesFor(lib, "acme.furn.desk-60x30");
    expect([...sizes.keys()]).toEqual(["acme.furn.desk-60x30"]);
    expect(sizes.get("acme.furn.desk-60x30")).toBe(def);
    expect(lib.asked).toEqual(["acme", "acme.furn.desk-60x30"]);
  });

  it("still finds a drawn part by its model id, without a second read", async () => {
    const def = definition();
    const [size] = definitionTypes(def);
    if (!size) throw new Error("the diffuser has no type");
    const modelId = size.typeId.split(".")[0] ?? "";
    const lib = store({ [modelId]: { definition: def } });
    const sizes = await firmSizesFor(lib, size.typeId);
    expect(sizes.has(size.typeId)).toBe(true);
    expect(lib.asked).toEqual([modelId]);
  });

  it("answers no sizes when the library has neither", async () => {
    const lib = store({});
    expect((await firmSizesFor(lib, "acme.furn.chair")).size).toBe(0);
    expect(lib.asked).toEqual(["acme", "acme.furn.chair"]);
  });
});
